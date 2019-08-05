import Foundation
import Sodium

protocol ChannelDelegate : AnyObject {
    func channel(_ channel: Channel, postedMessage message: ChannelMessage)
}

protocol RemoteChannel {
    func query(channelID: Bytes,
               withMinHeight minHeight: UInt64,
               limit: Int,
               andClosure closure: @escaping (Channel.QueryResponse) -> Void)
    func query(channelID: Bytes,
               withCursor cursor: Bytes,
               limit: Int,
               andClosure closure: @escaping (Channel.QueryResponse) -> Void)
    func destroy(reason: String)
}

enum ChannelError : Error {
    case invalidPublicKeySize(Int)
    case invalidChannelNameSize(Int)
    
    case noChainFound(Identity)
    case rootMustBeEncrypted
    case incomingMessageNotEncrypted
    case invalidSignature
    case invalidParentCount
    case parentNotFound(Bytes)
    case invalidHeight(UInt64)
    case invalidTimestamp(TimeInterval)
}

class Channel: RemoteChannel {
    struct QueryResponse {
        let messages: [ChannelMessage]
        let forwardCursor: Bytes?
        let backwardCursor: Bytes?
        let minLeafHeight: UInt64?
    }

    let context: Context
    let publicKey: Bytes
    var name: String
    
    var messages = [ChannelMessage]()
    var leafs = [ChannelMessage]()
    
    weak var delegate: ChannelDelegate? = nil
    
    lazy var channelID: Bytes = {
        return self.context.sodium.genericHash.hash(message: publicKey,
                                                    key: "vowlink-channel-id".bytes,
                                                    outputLength: Channel.CHANNEL_ID_LENGTH)!
    }()
    
    private var minLeafHeight: UInt64 {
        get {
            return leafs.reduce(UInt64.max) { (minHeight, leaf) -> UInt64 in
                return min(minHeight, leaf.height)
            }
        }
    }
    
    var root: ChannelMessage!
    
    static let CHANNEL_ID_LENGTH = 32
    static let FUTURE: TimeInterval = 10.0 // seconds
    static let SYNC_LIMIT: Int = 128 // messages per query
    static let MAX_NAME_LENGTH = 128
    
    init(context: Context, publicKey: Bytes, name: String, root: ChannelMessage) throws {
        // NOTE: Makes using `channel.root.hash!` very easy to use
        if !root.isEncrypted {
            throw ChannelError.rootMustBeEncrypted
        }

        self.context = context
        self.publicKey = publicKey
        self.name = name
        self.root = root
        
        let decryptedRoot = try root.decrypted(withChannel: self)
        self.messages = [ decryptedRoot ]
        self.leafs = [ decryptedRoot ]
        
        if publicKey.count != context.sodium.sign.PublicKeyBytes {
            throw ChannelError.invalidPublicKeySize(publicKey.count)
        }
        if name.count > Channel.MAX_NAME_LENGTH {
            throw ChannelError.invalidChannelNameSize(name.count)
        }
    }
    
    convenience init(context: Context, proto: Proto_Channel) throws {
       try self.init(context: context,
                      publicKey: Bytes(proto.publicKey),
                      name: proto.name,
                      root: try ChannelMessage(context: context, proto: proto.root))
        
        for protoMessage in proto.messages {
            let message = try ChannelMessage(context: context, proto: protoMessage)
            try self.append(try message.decrypted(withChannel: self))
        }
        
        leafs = try computeLeafs()
    }
    
    init(_ identity: Identity) throws {
        self.context = identity.context
        self.publicKey = identity.publicKey
        self.name = identity.name
        
        // Only a temporary measure, we should be fine
        root = nil
        
        let content = try identity.signContent(chain: Chain(context: context, links: []),
                                               timestamp: NSDate().timeIntervalSince1970,
                                               body: Channel.root(),
                                               parents: [],
                                               height: 0)
        let unencryptedRoot = try! ChannelMessage(context: context,
                                                  channelID: channelID,
                                                  content: .decrypted(content),
                                                  height: 0)
        let encryptedRoot = try unencryptedRoot.encrypted(withChannel: self)
        
        root = encryptedRoot
        try self.append(unencryptedRoot)
        
        leafs = try computeLeafs()
    }
    
    func toProto() -> Proto_Channel {
        return Proto_Channel.with({ (channel) in
            channel.publicKey = Data(self.publicKey)
            channel.name = self.name
            channel.root = self.root.toProto()!
            
            let nonRoot = self.messages[1...]
            
            channel.messages = nonRoot.map({ (message) -> Proto_ChannelMessage in
                let encrypted = try! message.encrypted(withChannel: self)
                return encrypted.toProto()!
            })
        })
    }
    
    func message(byHash hash: Bytes) -> ChannelMessage? {
        for message in messages {
            let encrypted = try! message.encrypted(withChannel: self)
            if context.sodium.utils.equals(hash, encrypted.hash!) {
                return message
            }
        }
        
        return nil
    }

    func post(message body: Proto_ChannelMessage.Body, by identity: Identity) throws -> ChannelMessage {
        let parents = try leafs.map({ (leaf) -> Bytes in
            return try leaf.encrypted(withChannel: self).hash!
        })
        let height = leafs.reduce(0) { (acc, leaf) -> UInt64 in
            return max(acc, leaf.height)
        } + 1
        
        guard let chain = identity.chain(for: self) else {
            throw ChannelError.noChainFound(identity)
        }
        
        let content = try identity.signContent(chain: chain,
                                               timestamp: NSDate().timeIntervalSince1970,
                                               body: body,
                                               parents: parents,
                                               height: height)
        
        let decrypted = try ChannelMessage(context: context,
                                           channelID: channelID,
                                           content: .decrypted(content),
                                           height: height,
                                           parents: parents)
        
        let encrypted = try decrypted.encrypted(withChannel: self)
        
        self.leafs = [ decrypted ]
        try self.append(decrypted)
        
        self.delegate?.channel(self, postedMessage: encrypted)
        
        return encrypted
    }
    
    // NOTE: It is important to receive encrypted message, so that its hash won't change
    func receive(encrypted: ChannelMessage) throws -> ChannelMessage {
        if !encrypted.isEncrypted {
            throw ChannelError.incomingMessageNotEncrypted
        }
        
        let decrypted = try encrypted.decrypted(withChannel: self)
        let isValid = try decrypted.verify(withChannel: self)
        
        if !isValid {
            throw ChannelError.invalidSignature
        }
        
        guard let content = decrypted.decryptedContent else {
            fatalError("Unexpected content")
        }
        
        // Only one root is allowed at the moment
        if decrypted.parents.count == 0 {
            throw ChannelError.invalidParentCount
        }
        
        var height: UInt64 = 0
        var parentTimestamp: TimeInterval = 0.0
        for parentHash in decrypted.parents {
            guard let parent = self.message(byHash: parentHash) else {
                throw ChannelError.parentNotFound(parentHash)
            }
            
            guard let parentContent = parent.decryptedContent else {
                fatalError("Unexpected parent content")
            }
            
            height = max(height, parent.height + 1)
            parentTimestamp = max(parentTimestamp, parentContent.timestamp)
        }
        if height != decrypted.height {
            throw ChannelError.invalidHeight(decrypted.height)
        }
        
        let now = NSDate().timeIntervalSince1970
        let future = now + Channel.FUTURE
        if content.timestamp >= future || content.timestamp < parentTimestamp {
            throw ChannelError.invalidTimestamp(content.timestamp)
        }
        
        if let _ = message(byHash: encrypted.hash!) {
            return decrypted
        }
        
        try self.append(decrypted)
        self.leafs = try computeLeafs()
        
        self.delegate?.channel(self, postedMessage: encrypted)
        
        return decrypted
    }
    
    // MARK: Sync
    
    func sync(with remote: RemoteChannel) {
        let requestedHeight = minLeafHeight
        remote.query(channelID: channelID,
                     withMinHeight: requestedHeight,
                     limit: Channel.SYNC_LIMIT) {
            (response) in
            self.handle(queryResponse: response, from: remote, andRequestedHeight: requestedHeight)
        }
    }
    
    func handle(queryResponse response: QueryResponse, from remote: RemoteChannel, andRequestedHeight requestedHeight: UInt64? = nil) {
        if let suggestedHeight = response.minLeafHeight,
           let requestedHeight = requestedHeight,
           suggestedHeight < requestedHeight {
            remote.query(channelID: channelID,
                         withMinHeight: suggestedHeight,
                         limit: Channel.SYNC_LIMIT) { (response) in
                self.handle(queryResponse: response, from: remote)
            }
            return
        }
        
        if response.messages.count > Channel.SYNC_LIMIT {
            remote.destroy(reason: "message count overflow")
            return
        }
        
        var missing: Bool = false
        
        // NOTE: messages are assumed to be ordered
        for encrypted in response.messages {
            do {
                let _ = try self.receive(encrypted: encrypted)
            } catch ChannelError.parentNotFound(_) {
                missing = true
            } catch {
                remote.destroy(reason: "invalid message \(encrypted.hash!), error: \(error)")
                return
            }
        }
        
        var cursor: Bytes? = nil
        
        if missing {
            cursor = response.backwardCursor
            
            if cursor == nil {
                remote.destroy(reason: "empty backward cursor when messages are missing")
                return
            }
        } else {
            cursor = response.forwardCursor
        }
        
        if let cursor = cursor {
            remote.query(channelID: channelID,
                         withCursor: cursor,
                         limit: Channel.SYNC_LIMIT) {
                (response) in
                self.handle(queryResponse: response, from: remote)
            }
            return
        }
        
        debugPrint("[channel] sync complete")
    }
    
    func query(withMinHeight minHeight: UInt64, andLimit limit: Int) throws -> QueryResponse {
        let enforcedLimit = min(limit, Channel.SYNC_LIMIT)

        var filtered = [ChannelMessage]()
        var backward: Bytes?
        var forward: Bytes?
        for message in messages {
            let encrypted = try message.encrypted(withChannel: self)
            
            if message.height < minHeight {
                backward = encrypted.hash!
                continue
            }
            
            if filtered.count == enforcedLimit {
                forward = encrypted.hash!
                break
            }
            
            filtered.append(encrypted)
        }
        
        return QueryResponse(messages: filtered, forwardCursor: forward, backwardCursor: backward, minLeafHeight: minLeafHeight)
    }
    
    func query(withCursor cursor: Bytes, andLimit limit: Int) throws -> QueryResponse {
        let enforcedLimit = min(limit, Channel.SYNC_LIMIT)
        
        var filtered = [ChannelMessage]()
        var backward: Bytes?
        var forward: Bytes?
        var found = false
        for message in messages {
            let encrypted = try message.encrypted(withChannel: self)

            if !found && !context.sodium.utils.equals(encrypted.hash!, cursor) {
                backward = encrypted.hash!
                continue
            }
            
            found = true
            
            if filtered.count == enforcedLimit {
                forward = encrypted.hash!
                break
            }
            
            filtered.append(encrypted)
        }
        
        return QueryResponse(messages: filtered, forwardCursor: forward, backwardCursor: backward, minLeafHeight: nil)
    }
    
    // MARK: Utils
    
    private func computeLeafs() throws -> [ChannelMessage] {
        var parents = Set<Bytes>()
        for message in messages {
            for parentHash in message.parents {
                parents.insert(parentHash)
            }
        }
        
        var result = [ChannelMessage]()
        
        for message in messages {
            // NOTE: This is actually cached
            let encrypted = try message.encrypted(withChannel: self)
            
            if !parents.contains(encrypted.hash!) {
                result.append(message)
            }
        }
        
        return result
    }
    
    private func append(_ message: ChannelMessage) throws {
        self.messages.append(try message.decrypted(withChannel: self))
        try self.messages.sort { (a, b) -> Bool in
            if a.height < b.height {
                return true
            } else if a.height > b.height {
                return false
            }

            // TODO(indutny): cache hashes in the storage, perhaps?
            let encryptedA = try a.encrypted(withChannel: self)
            let encryptedB = try b.encrypted(withChannel: self)
            
            return self.context.sodium.utils.compare(encryptedA.hash!, encryptedB.hash!) == -1
        }
    }
    
    // MARK: Helpers
    
    static func root() -> Proto_ChannelMessage.Body {
        return Proto_ChannelMessage.Body.with({ (body) in
            body.root = Proto_ChannelMessage.Root()
        })
    }
    
    static func text(_ message: String) -> Proto_ChannelMessage.Body {
        return Proto_ChannelMessage.Body.with { (body) in
            body.text.text = message
        }
    }
    
    // MARK: RemoteChannel (mostly for testing)
    
    func query(channelID: Bytes,
               withCursor cursor: Bytes,
               limit: Int,
               andClosure closure: @escaping (Channel.QueryResponse) -> Void) {
        let response = try! query(withCursor: cursor, andLimit: limit)
        closure(response)
    }
    
    func query(channelID: Bytes,
               withMinHeight minHeight: UInt64,
               limit: Int,
               andClosure closure: @escaping (Channel.QueryResponse) -> Void) {
        let response = try! query(withMinHeight: minHeight, andLimit: limit)
        closure(response)
    }

    func destroy(reason: String) {
        // no-op
    }
}
