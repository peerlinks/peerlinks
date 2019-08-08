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
                if !hashes.contains(parentHash) && message(byHash: parentHash) == nil {
                    canCommit = false
                    break
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
        var index: (Int, ChannelMessage)?
        
        switch cursor {
        case .height(let height):
            let requestHeight = min(height, minLeafHeight)
            
            // TODO(indutny): have some sort of height maps
            index = messages.enumerated().first { (param) -> Bool in
                let (_, message) = param
                return message.height == requestHeight
            }
            
        case .hash(let hash):
            // NOTE: Reverse walk is more efficient since in the best
            // case we are synchronizing just the tip
            index = messages.enumerated().reversed().first { (param) -> Bool in
                let (_, message) = param
                let encrypted = try! message.encrypted(withChannel: self)
                return context.sodium.utils.equals(encrypted.hash!, hash)
            }
        }
        
        guard let (first, _) = index else {
            debugPrint("[channel] \(channelDisplayID) query cursor not found")
            return QueryResponse(abbreviatedMessages: [], forwardHash: nil, backwardHash: nil)
        }
        
        var subset: ArraySlice<ChannelMessage>?
        var forwardIndex: Int
        if isBackward {
            let start = max(0, first - enforcedLimit)
            subset = messages[start..<first]
            forwardIndex = first
            
            debugPrint("[channel] \(channelDisplayID) query result [\(start)..<\(first)] forwardIndex=\(forwardIndex)")
        } else {
            let end = min(messages.count, first + enforcedLimit)
            subset = messages[first..<end]
            forwardIndex = end
            debugPrint("[channel] \(channelDisplayID) query result [\(first)..<\(end)] forwardIndex=\(forwardIndex)")
        }
        
        var forwardHash: Bytes?
        if forwardIndex < messages.count {
            let encrypted = try! messages[forwardIndex].encrypted(withChannel: self)
            forwardHash = encrypted.hash!
        }
        
        let result = try subset!.map { (message) -> Abbreviated in
            let encrypted = try message.encrypted(withChannel: self)
            return Abbreviated(parents: encrypted.parents, hash: encrypted.hash!)
        }
        
        return QueryResponse(abbreviatedMessages: result,
                             forwardHash: forwardHash,
                             backwardHash: result.first?.hash)
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
    
    func bulk(withHashes hashes: [Bytes]) throws -> BulkResponse {
        let limit = min(hashes.count, Channel.SYNC_LIMIT)
        var result = [ChannelMessage]()
        for hash in hashes[..<limit] {
            guard let decrypted = message(byHash: hash) else {
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
        // no-op
    }
}
