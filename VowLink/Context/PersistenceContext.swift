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
    private let channelID = Expression<Blob>("channelID")
    private let hash = Expression<Blob>("hash")
    private let height = Expression<Int64>("height")
    private let protobuf = Expression<Blob>("protobuf")
    
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
            self.channelID <- Blob(bytes: channelID),
            hash <- Blob(bytes: encrypted.hash!),

            height <- Int64(encrypted.height),
            protobuf <- Blob(bytes: Bytes(try encrypted.toProto()!.serializedData()))
        )
        
        try db.run(query)
    }
    
    func contains(messageWithHash hash: Bytes, andChannelID channelID: Bytes) throws -> Bool {
        let count = try db.scalar(messageTable
            .filter(self.hash == Blob(bytes: hash) && self.channelID == Blob(bytes: channelID))
            .count)
        return count != 0
    }
    
    func message(withHash hash: Bytes, andChannelID channelID: Bytes) throws -> ChannelMessage? {
        let query = messageTable.select(protobuf)
            .filter(self.hash == Blob(bytes: hash) && self.channelID == Blob(bytes: channelID))
        
        guard let first = try db.pluck(query) else {
            return nil
        }
        
        let proto = try Proto_ChannelMessage(serializedData: Data(first.get(protobuf).bytes))
        return try ChannelMessage(context: context, proto: proto)
    }
    
    func messages(withMinHeight minHeight: Int64, andChannelID channelID: Bytes) throws -> [ChannelMessage] {
        let query = messageTable.select(protobuf)
            .filter(self.channelID == Blob(bytes: channelID) && height >= Int64(minHeight))
        
        var result = [ChannelMessage]()
        for message in try db.prepare(query) {
            let raw = try message.get(protobuf).bytes
            let proto = try Proto_ChannelMessage(serializedData: Data(raw))
            result.append(try ChannelMessage(context: context, proto: proto))
        }
        return result
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
