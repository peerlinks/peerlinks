import Foundation
import Sodium

protocol RemoteChannel {
    func remoteChannel(performQueryFor channelID: Bytes,
                       withCursor cursor: Channel.Cursor,
                       isBackward: Bool,
                       limit: Int,
                       andClosure closure: @escaping (Channel.QueryResponse) -> Void)
    func remoteChannel(fetchBulkFor channelID: Bytes,
                       withHashes hashes: [Bytes],
                       andClosure closure: @escaping (Channel.BulkResponse) -> Void)
    
    func destroy(reason: String)
}

extension Channel: RemoteChannel {
    struct Abbreviated {
        let parents: [Bytes]
        let hash: Bytes
    }
    
    struct QueryResponse {
        let abbreviatedMessages: [Abbreviated]
        let forwardHash: Bytes?
        let backwardHash: Bytes?
    }
    
    enum Cursor {
        case height(Int64)
        case hash(Bytes)
    }
    
    struct BulkResponse {
        let messages: [ChannelMessage]
        let forwardIndex: Int
    }
    
    private var minLeafHeight: Int64 {
        get {
            return leafs.reduce(Int64.max) { (minHeight, leaf) -> Int64 in
                return min(minHeight, leaf.height)
            }
        }
    }
    
    static let SYNC_LIMIT: Int = 128 // messages per query
    
    func sync(with remote: RemoteChannel) {
        debugPrint("[channel] \(channelDisplayID) starting sync")
        
        remote.remoteChannel(performQueryFor: channelID,
                             withCursor: .height(minLeafHeight),
                             isBackward: false,
                             limit: Channel.SYNC_LIMIT) { (response) in
                                self.handle(queryResponse: response, from: remote)
        }
    }
    
    private func handle(queryResponse response: QueryResponse, from remote: RemoteChannel) {
        if response.abbreviatedMessages.count > Channel.SYNC_LIMIT {
            remote.destroy(reason: "message count overflow")
            return
        }
        
        var missing: Bool = false
        
        // NOTE: messages are assumed to be ordered
        var hashes = Set<Bytes>()
        var hashList = [Bytes]()
        for abbr in response.abbreviatedMessages {
            var canCommit = true
            for parentHash in abbr.parents {
                do {
                    if !hashes.contains(parentHash), !(try contains(messageWithHash: parentHash)) {
                        canCommit = false
                        break
                    }
                } catch {
                    remote.destroy(reason: "lookup error \(error)")
                    return
                }
            }
            
            if !canCommit {
                missing = true
                continue
            }
            
            hashes.insert(abbr.hash)
            
            // NOTE: Set<> is unordered
            hashList.append(abbr.hash)
        }
        
        var cursor: Bytes? = nil
        
        if missing {
            cursor = response.backwardHash
            
            if cursor == nil {
                remote.destroy(reason: "empty backward cursor when messages are missing")
                return
            }
        } else {
            cursor = response.forwardHash
        }
        
        remote.remoteChannel(fetchBulkFor: channelID, withHashes: hashList) { (response) in
            self.handle(bulkResponse: response, from: remote, withHashes: hashList)
        }
        
        if let cursor = cursor {
            remote.remoteChannel(performQueryFor: channelID,
                                 withCursor: .hash(cursor),
                                 isBackward: missing,
                                 limit: Channel.SYNC_LIMIT) { (response) in
                                    self.handle(queryResponse: response, from: remote)
            }
            return
        }
        
        debugPrint("[channel] \(channelDisplayID) sync complete")
    }
    
    func query(withCursor cursor: Cursor, isBackward: Bool, andLimit limit: Int) throws -> QueryResponse {
        debugPrint("[channel] \(channelDisplayID) query isBackward=\(isBackward)")
        
        let enforcedLimit = min(limit, Channel.SYNC_LIMIT)
        
        let response = try context.persistence.messages(startingFrom: cursor,
                                                        isBackward: isBackward,
                                                        channelID: channelID,
                                                        andLimit: enforcedLimit)
        
        let abbreviated = response.messages.map { (message) -> Abbreviated in
            return Abbreviated(parents: message.parents, hash: message.hash!)
        }
        
        return QueryResponse(abbreviatedMessages: abbreviated,
                             forwardHash: response.forwardHash,
                             backwardHash: response.backwardHash)
    }
    
    func handle(bulkResponse response: BulkResponse, from remote: RemoteChannel, withHashes hashes: [Bytes]) {
        if response.messages.count > hashes.count {
            return
        }
        
        let set = Set<Bytes>(hashes)
        
        for message in response.messages {
            if !set.contains(message.hash!) {
                return remote.destroy(reason: "unexpected message in bulk response with hash \(message.hash!)")
            }
            
            do {
                let _ = try self.receive(encrypted: message)
            } catch {
                return remote.destroy(reason: "invalid encrypted message in bulk response due to error \(error)")
            }
        }
        
        if response.forwardIndex >= hashes.count {
            return
        }
        
        let remainingHashes = [Bytes](hashes[response.forwardIndex...])
        remote.remoteChannel(fetchBulkFor: channelID, withHashes: remainingHashes) { (response) in
            self.handle(bulkResponse: response, from: remote, withHashes: remainingHashes)
        }
    }

    // TODO(indutny): implement bulk in persistence
    func bulk(withHashes hashes: [Bytes]) throws -> BulkResponse {
        let limit = min(hashes.count, Channel.SYNC_LIMIT)
        var result = [ChannelMessage]()
        for hash in hashes[..<limit] {
            guard let decrypted = try message(withHash: hash) else {
                continue
            }
            let encrypted = try decrypted.encrypted(withChannel: self)
            
            result.append(encrypted)
        }
        
        return BulkResponse(messages: result, forwardIndex: limit)
    }
    
    
    // MARK: RemoteChannel (mostly for testing)
    
    func remoteChannel(performQueryFor channelID: Bytes,
                       withCursor cursor: Cursor,
                       isBackward: Bool,
                       limit: Int,
                       andClosure closure: @escaping (Channel.QueryResponse) -> Void) {
        let response = try! query(withCursor: cursor, isBackward: isBackward, andLimit: limit)
        closure(response)
    }
    
    func remoteChannel(fetchBulkFor channelID: Bytes,
                       withHashes hashes: [Bytes],
                       andClosure closure: @escaping (Channel.BulkResponse) -> Void) {
        let response = try! bulk(withHashes: hashes)
        closure(response)
    }
    
    func destroy(reason: String) {
        debugPrint("[channel] \(channelDisplayID) (test) destroy with reason=\(reason)")
    }
}
