import Foundation
import SQLite
import Sodium

extension Connection {
    public var userVersion: Int32 {
        get { return Int32(try! scalar("PRAGMA user_version") as! Int64)}
        set { try! run("PRAGMA user_version = \(newValue)") }
    }
}

class PersistenceContext {
    let context: Context
    let db: Connection
    
    private let messageTable = Table("messages")
    
    private let channelID = Expression<String>("channelID")
    private let hash = Expression<String>("hash")
    private let height = Expression<Int64>("height")
    private let protobuf = Expression<Blob>("protobuf")
    
    private let leafTable = Table("leafs")
    private let leafHash = Expression<String>("leafHash")
    
    private static let DEBUG = false
    
    struct MessageQueryResponse {
        let messages: [ChannelMessage]
        let forwardHash: Bytes?
        let backwardHash: Bytes?
    }
    
    init(context: Context, service: String) throws {
        self.context = context
        
        let path = NSSearchPathForDirectoriesInDomains(
            .documentDirectory, .userDomainMask, true
            ).first!
        db = try Connection("\(path)/\(service).sqlite3")
        if PersistenceContext.DEBUG {
            db.trace { print($0) }
        }
        
        try createTables()
    }
    
    func messageCount(forChannelID channelID: Bytes) throws -> Int {
        return try db.scalar(messageTable
            .filter(self.channelID == context.sodium.utils.bin2hex(channelID)!)
            .count)
    }
    
    func append(encryptedMessage encrypted: ChannelMessage,
                toChannelID channelID: Bytes,
                withNewLeafs leafs: [Bytes] = []) throws {
        // TODO(indutny): store leafs
        let insertMessage = messageTable.insert(
            self.channelID <- context.sodium.utils.bin2hex(channelID)!,
            hash <- encrypted.displayHash!,

            height <- Int64(encrypted.height),
            protobuf <- Blob(bytes: Bytes(try encrypted.toProto()!.serializedData()))
        )
        
        try db.transaction {
            try db.run(insertMessage)
            try db.run(leafTable.delete())
            
            for leafHash in leafs {
                let leafHashHex = context.sodium.utils.bin2hex(leafHash)!
                try db.run(leafTable.insert(self.leafHash <- leafHashHex))
            }
        }
    }
    
    func leafs(forChannelID channelID: Bytes) throws -> [ChannelMessage] {
        let query = leafTable.select(protobuf)
            .join(messageTable, on: leafHash == hash)
        
        // TODO(indutny): DRY
        var result = [ChannelMessage]()
        for message in try db.prepare(query) {
            let raw = try message.get(protobuf).bytes
            let proto = try Proto_ChannelMessage(serializedData: Data(raw))
            result.append(try ChannelMessage(context: context, proto: proto))
        }
        return result
    }

    // TODO(indutny): LRU cache
    func contains(messageWithHash hash: Bytes, andChannelID channelID: Bytes) throws -> Bool {
        let hashHex = context.sodium.utils.bin2hex(hash)!
        let channelIDHex = context.sodium.utils.bin2hex(channelID)!

        let count = try db.scalar(messageTable
            .filter(self.channelID == channelIDHex)
            .filter(self.hash == hashHex)
            .count)
        return count != 0
    }
    
    // TODO(indutny): LRU cache
    func message(withHash hash: Bytes, andChannelID channelID: Bytes) throws -> ChannelMessage? {
        let hashHex = context.sodium.utils.bin2hex(hash)!
        let channelIDHex = context.sodium.utils.bin2hex(channelID)!

        let query = messageTable.select(protobuf)
            .filter(self.channelID == channelIDHex)
            .filter(self.hash == hashHex)
        
        guard let first = try db.pluck(query) else {
            return nil
        }
        
        let proto = try Proto_ChannelMessage(serializedData: Data(first.get(protobuf).bytes))
        return try ChannelMessage(context: context, proto: proto)
    }
    
    // TODO(indutny): LRU
    func message(atOffset offset: Int, andChannelID channelID: Bytes) throws -> ChannelMessage? {
        let query = messageTable
            .select(protobuf)
            .filter(self.channelID == context.sodium.utils.bin2hex(channelID)!)
            .order(height.asc, hash.asc)
            .limit(1, offset: offset)
        
        // TODO(indutny): DRY
        guard let first = try db.pluck(query) else {
            return nil
        }
        let proto = try Proto_ChannelMessage(serializedData: Data(first.get(protobuf).bytes))
        return try ChannelMessage(context: context, proto: proto)
    }
    
    func messages(startingFrom cursor: Channel.Cursor,
                  isBackward: Bool,
                  channelID: Bytes,
                  andLimit limit: Int) throws -> MessageQueryResponse {
        var minHeight: Int64!
        var minHashHex: String?

        switch cursor {
        case .hash(let hash):
            guard let message = try message(withHash: hash, andChannelID: channelID) else {
                return MessageQueryResponse(messages: [], forwardHash: nil, backwardHash: nil)
            }
            
            minHeight = message.height
            minHashHex = message.displayHash!
        case .height(let height):
            minHeight = height
        }
        
        let channelIDHex = context.sodium.utils.bin2hex(channelID)!
        var filter: Expression<Bool>!
        
        if let minHashHex = minHashHex {
            // NOTE: Filter is inclusive for `isBackward = true`, because we want to include the
            // forward message.
            // TODO(indutny): the comment above might need to be revisited in the future
            // if optimization is needed
            if isBackward {
                filter = height < minHeight || (height == minHeight && self.hash <= minHashHex)
            } else {
                filter = height > minHeight || (height == minHeight && self.hash >= minHashHex)
            }
        } else {
            if isBackward {
                filter = height <= minHeight
            } else {
                filter = height >= minHeight
            }
        }
        
        var query = messageTable.select(protobuf)
            .filter(self.channelID == channelIDHex)
            .filter(filter)
        
        if isBackward {
            query = query.order(height.desc, self.hash.desc)
        } else {
            query = query.order(height.asc, self.hash.asc)
        }
        
        // Request one more message to get non-inclusive `forwardHash`
        let fullLimit = max(0, limit) + 1
        query = query.limit(fullLimit)
        
        var result = [ChannelMessage]()
        for message in try db.prepare(query) {
            let raw = try message.get(protobuf).bytes
            let proto = try Proto_ChannelMessage(serializedData: Data(raw))
            result.append(try ChannelMessage(context: context, proto: proto))
        }
        
        var hasExtraBackward = false
        if isBackward {
            result.reverse()
            
            // Only if the last message is inclusive - consider it to be the
            // forward hash
            let last = result.last!
            switch cursor {
            case .hash(let hash):
                hasExtraBackward = last.hash! == hash
            case .height(let height):
                hasExtraBackward = last.height == height
            }
        }

        var forwardHash: Bytes?
        if result.count == fullLimit || hasExtraBackward {
            forwardHash = result.last!.hash!
            result.removeLast()
        }
        let backwardHash = result.first?.hash!

        return MessageQueryResponse(messages: result, forwardHash: forwardHash, backwardHash: backwardHash)
    }
    
    func removeAll() throws {
        try db.run(messageTable.drop(ifExists: true))
        try db.run(leafTable.drop(ifExists: true))
        try createTables()
    }
    
    private func createTables() throws {
        try db.run(messageTable.create(ifNotExists: true) { (t) in
            t.column(channelID)
            t.column(hash)
            t.column(height)
            t.column(protobuf)
        })
        
        try db.run(messageTable.createIndex(channelID, unique: false, ifNotExists: true))
        try db.run(messageTable.createIndex(hash, unique: true, ifNotExists: true))
        try db.run(messageTable.createIndex(height, unique: false, ifNotExists: true))
        
        try db.run(leafTable.create(ifNotExists: true) { (t) in
            t.column(leafHash)
        })
        
        try db.run(leafTable.createIndex(leafHash, unique: true, ifNotExists: true))
    }
}
