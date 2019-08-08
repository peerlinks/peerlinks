import Foundation
import Sodium

protocol ChannelDelegate : AnyObject {
    func channel(_ channel: Channel, postedMessage message: ChannelMessage)
}

enum ChannelError : Error {
    case invalidPublicKeySize(Int)
    case invalidChannelNameSize(Int)
    case invalidRoot
    
    case noChainFound(Identity)
    case rootMustBeEncrypted
    case incomingMessageNotEncrypted
    case invalidSignature
    case invalidParentCount
    case parentNotFound(Bytes)
    case invalidHeight(UInt64)
    case invalidTimestamp(TimeInterval)
    case parentTooFarInThePast
    case expectedDecryptedMessage
}

class Channel {
    let context: Context
    let publicKey: Bytes
    var name: String
    
    var messages = [ChannelMessage]()
    var messagesByHash = [Bytes:ChannelMessage]()
    var leafs = [ChannelMessage]()
    
    weak var delegate: ChannelDelegate? = nil
    
    lazy var channelID: Bytes = {
        return context.sodium.genericHash.hash(message: publicKey,
                                               key: "vowlink-channel-id".bytes,
                                               outputLength: Channel.CHANNEL_ID_LENGTH)!
    }()
    
    lazy var channelDisplayID: String = {
        return context.sodium.utils.bin2hex(channelID)!
    }()
    
    var root: ChannelMessage!
    
    static let CHANNEL_ID_LENGTH = 32
    static let FUTURE: TimeInterval = 10.0 // seconds
    static let MAX_NAME_LENGTH = 128
    static let MAX_PARENT_DELTA: TimeInterval = 30 * 24 * 3600; // 30 days
    
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
        
        try append(decryptedRoot)
        leafs = try computeLeafs()
        
        if publicKey.count != context.sodium.sign.PublicKeyBytes {
            throw ChannelError.invalidPublicKeySize(publicKey.count)
        }
        if name.count > Channel.MAX_NAME_LENGTH {
            throw ChannelError.invalidChannelNameSize(name.count)
        }
        
        let isValid = try decryptedRoot.verify(withChannel: self, andPublicKey: publicKey)
        if !isValid {
            throw ChannelError.invalidRoot
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
        return messagesByHash[hash]
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
        if decrypted.parents.count == 0 && !context.sodium.utils.equals(encrypted.hash!, root.hash!) {
            throw ChannelError.invalidParentCount
        }
        
        var height: UInt64 = 0
        var parentMinTimestamp: TimeInterval = 0.0
        var parentTimestamp: TimeInterval = 0.0
        for parentHash in decrypted.parents {
            guard let parent = self.message(byHash: parentHash) else {
                throw ChannelError.parentNotFound(parentHash)
            }
            
            guard let parentContent = parent.decryptedContent else {
                fatalError("Unexpected parent content")
            }
            
            height = max(height, parent.height + 1)
            parentMinTimestamp = max(parentMinTimestamp, parentContent.timestamp)
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
        
        if parentTimestamp - parentMinTimestamp > Channel.MAX_PARENT_DELTA {
            throw ChannelError.parentTooFarInThePast
        }
        
        if let _ = message(byHash: encrypted.hash!) {
            return decrypted
        }
        
        try self.append(decrypted)
        self.leafs = try computeLeafs()
        
        self.delegate?.channel(self, postedMessage: encrypted)
        
        return decrypted
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
        
        var maxTimestamp: TimeInterval = 0.0
        for message in messages {
            // NOTE: This is actually cached
            let encrypted = try message.encrypted(withChannel: self)
            
            if !parents.contains(encrypted.hash!) {
                result.append(message)
                maxTimestamp = max(maxTimestamp, message.decryptedContent!.timestamp)
            }
        }
        
        let threshold = maxTimestamp - Channel.MAX_PARENT_DELTA
        return result.filter({ (leaf) -> Bool in
            return leaf.decryptedContent!.timestamp >= threshold
        })
    }
    
    private func append(_ decrypted: ChannelMessage) throws {
        if decrypted.isEncrypted {
            throw ChannelError.expectedDecryptedMessage
        }
        
        let encrypted = try decrypted.encrypted(withChannel: self)
        if messagesByHash[encrypted.hash!] != nil {
            return
        }
        messagesByHash[encrypted.hash!] = decrypted
        
        self.messages.append(decrypted)
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
}
