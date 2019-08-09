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
        
        try createTables()
    }
    
    func append(encryptedMessage encrypted: ChannelMessage, toChannelID channelID: Bytes) throws {
        let query = messageTable.insert(
            self.channelID <- context.sodium.utils.bin2hex(channelID)!,
            hash <- encrypted.displayHash!,

            height <- Int64(encrypted.height),
            protobuf <- Blob(bytes: Bytes(try encrypted.toProto()!.serializedData()))
        )
        
        try db.run(query)
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
        
        if isBackward {
            result.reverse()
        }

        var forwardHash: Bytes?
        if result.count == fullLimit || isBackward {
            forwardHash = result.last!.hash!
            result.removeLast()
        }
        let backwardHash = result.first?.hash!

        return MessageQueryResponse(messages: result, forwardHash: forwardHash, backwardHash: backwardHash)
    }
    
    func removeAll() throws {
        try db.run(messageTable.drop(ifExists: true))
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
    }
}
