import Foundation
import Sodium

enum ChannelMessageError : Error {
    case failedToComputeEncryptionKey
    case encryptionFailed
    case decryptionFailed
}

class ChannelMessage {
    struct Content {
        let chain: Chain
        let timestamp: TimeInterval
        let body: Proto_ChannelMessage.Body
        var signature: Bytes
    }
    
    enum EitherContent {
        case decrypted(Content)
        case encrypted(Bytes)
    }
    
    let context: Context
    let channelID: Bytes
    let height: UInt64
    let parents: [Bytes]
    let nonce: Bytes
    let content: EitherContent
    
    var isEncrypted: Bool {
        get {
            switch content {
            case .decrypted(_): return false
            case .encrypted(_): return true
            }
        }
    }
    
    var decryptedContent: Content? {
        get {
            if case .decrypted(let content) = content {
                return content
            }
            return nil
        }
    }
    
    var encryptedContent: Bytes? {
        get {
            if case .encrypted(let content) = content {
                return content
            }
            return nil
        }
    }
    
    // Decrypted message for Encrypted message, or vice versa
    private var counterpart: ChannelMessage? = nil
    
    lazy var hash: Bytes? = {
        guard let proto = toProto() else {
            return nil
        }
        return context.sodium.genericHash.hash(message: Bytes(try! proto.serializedData()),
                                               key: "vowlink-message".bytes,
                                               outputLength: ChannelMessage.MESSAGE_HASH_LENGTH)!
    }()
    
    lazy var displayHash: String? = {
        if let hash = self.hash {
            return context.sodium.utils.bin2hex(hash)
        } else {
            return nil
        }
    }()
    
    static let MESSAGE_HASH_LENGTH = 32
    static let MAX_TEXT_LENGTH = 256
    
    init(context: Context, channelID: Bytes, content: EitherContent, height: UInt64, nonce: Bytes? = nil, parents: [Bytes] = []) throws {
        self.context = context
        self.channelID = channelID
        self.parents = parents
        self.height = height
        self.content = content
        
        self.nonce = nonce ?? context.sodium.secretBox.nonce()
    }
    
    convenience init(context: Context, proto: Proto_ChannelMessage) throws {
        try proto.validate(context: context)
        
        try self.init(context: context,
                      channelID: Bytes(proto.channelID),
                      content: .encrypted(Bytes(proto.encryptedContent)),
                      height: proto.height,
                      nonce: Bytes(proto.nonce),
                      parents: proto.parents.map({ (parent) -> Bytes in
                        return Bytes(parent)
                      }))
    }
    
    func verify(withChannel channel: Channel, andPublicKey publicKey: Bytes? = nil) throws -> Bool {
        guard let content = decryptedContent else {
            return false
        }
        
        let maybeLeaf = try content.chain.verify(withChannel: channel,
                                                 andAgainstTimestamp: content.timestamp)
        
        guard let leafKey = maybeLeaf else {
            debugPrint("[channel-message] invalid chain for message \(String(describing: displayHash))")
            return false
        }
        
        if let publicKey = publicKey, !context.sodium.utils.equals(leafKey, publicKey) {
            debugPrint("[channel-message] invalid leaf key for message \(String(describing: displayHash))")
            return false
        }
        
        let tbs = try tbsProto()!.serializedData()
        
        return context.sodium.sign.verify(message: Bytes(tbs),
                                          publicKey: leafKey,
                                          signature: content.signature)
    }
    
    func encrypted(withChannel channel: Channel) throws -> ChannelMessage {
        // Already encrypted
        if isEncrypted {
            return self
        }
        
        // NOTE: We cache counterpart because `secretBox.seal` generates nonce randomly. Thus the
        // hash of encrypted message would be different every time.
        if let counterpart = counterpart {
            return counterpart
        }
        
        let content = try contentProto()!.serializedData()
        
        let encryptionKey = try computeEncryptionKey(channel: channel)
        
        guard let box: Bytes = context.sodium.secretBox.seal(message: Bytes(content),
                                                             secretKey: encryptionKey,
                                                             nonce: nonce) else {
                                                                throw ChannelMessageError.encryptionFailed
        }
        
        counterpart = try ChannelMessage(context: context,
                                         channelID: channel.channelID,
                                         content: .encrypted(box),
                                         height: height,
                                         nonce: nonce,
                                         parents: parents)
        counterpart?.counterpart = self
        return counterpart!
    }
    
    func decrypted(withChannel channel: Channel) throws -> ChannelMessage {
        guard let encrypted = encryptedContent else {
            // Already decrypted
            return self
        }
        
        if let counterpart = counterpart {
            return counterpart
        }
        
        let encryptionKey = try computeEncryptionKey(channel: channel)
        
        guard let decrypted = context.sodium.secretBox.open(authenticatedCipherText: encrypted,
                                                            secretKey: encryptionKey,
                                                            nonce: nonce) else {
                                                                throw ChannelMessageError.decryptionFailed
        }
        
        let contentProto = try Proto_ChannelMessage.Content(serializedData: Data(decrypted))
        try contentProto.validate(context: context)
        
        let links = try contentProto.chain.map({ (link) -> Link in
            return try Link(context: self.context, link: link)
        })
        
        let content = Content(chain: Chain(context: context, links: links),
                              timestamp: contentProto.timestamp,
                              body: contentProto.body,
                              signature: Bytes(contentProto.signature))
        
        counterpart = try ChannelMessage(context: context,
                                         channelID: channel.channelID,
                                         content: .decrypted(content),
                                         height: height,
                                         nonce: nonce,
                                         parents: parents)
        counterpart?.counterpart = self
        return counterpart!
    }
    
    func toProto() -> Proto_ChannelMessage? {
        guard let encrypted = encryptedContent else {
            return nil
        }
        
        return Proto_ChannelMessage.with({ (proto) in
            proto.channelID = Data(self.channelID)
            proto.parents = self.parents.map({ (parent) -> Data in
                return Data(parent)
            })
            proto.height = self.height
            proto.nonce = Data(self.nonce)
            
            proto.encryptedContent = Data(encrypted)
        })
    }
    
    private func computeEncryptionKey(channel: Channel) throws -> Bytes {
        let inputData = channel.publicKey
        
        let maybeKey = self.context.sodium.genericHash.hash(message: Bytes(inputData),
                                                            key: "vowlink-symmetric".bytes,
                                                            outputLength: context.sodium.secretBox.KeyBytes)
        guard let key = maybeKey else {
            throw ChannelMessageError.failedToComputeEncryptionKey
        }
        return key
    }
    
    private func contentProto() -> Proto_ChannelMessage.Content? {
        guard let content = decryptedContent else {
            return nil
        }
        
        return Proto_ChannelMessage.Content.with({ (proto) in
            proto.chain = content.chain.links.map({ (link) -> Proto_Link in
                link.toProto()
            })
            proto.timestamp = content.timestamp
            proto.body = content.body
            proto.signature = Data(content.signature)
        })
    }
    
    private func tbsProto() -> Proto_ChannelMessage.Content.TBS? {
        guard let content = decryptedContent else {
            return nil
        }
        
        return Proto_ChannelMessage.Content.TBS.with({ (proto) in
            proto.chain = content.chain.links.map({ (link) -> Proto_Link in
                link.toProto()
            })
            proto.timestamp = content.timestamp
            proto.body = content.body
            proto.parents = self.parents.map({ (parent) -> Data in
                return Data(parent)
            })
            proto.height = self.height
        })
    }
}
