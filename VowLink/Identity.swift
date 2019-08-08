import Foundation
import Sodium
import KeychainAccess

enum IdentityError: Error {
    case signatureError
    case linkExpired
    case linkPubkeyMismatch
}

class Identity {
    let context: Context
    
    let name: String
    private var secretKey: Bytes
    let publicKey: Bytes
    var chains = [Bytes:Chain]()
    
    static let DEFAULT_EXPIRATION: TimeInterval = 99.0 * 24.0 * 3600.0 // 99 days
    
    init(context: Context, name: String) throws {
        self.name = name
        self.context = context
        
        let keychain = self.context.keychain
        
        if let data = try keychain.getData("identity/" + name) {
            let id = try Proto_Identity(serializedData: data)
            debugPrint("[identity] loading existing identity \(name)")
            
            secretKey = Bytes(id.secretKey)
            publicKey = Bytes(id.publicKey)
            for chain in id.channelChains {
                let links = try chain.links.map({ (proto) -> Link in
                    return try Link(context: context, link: proto)
                })
                chains[Bytes(chain.channelID)] = Chain(context: context, links: links)
            }
        } else {
            debugPrint("[identity] generating new keypair for \(name)")
            let keyPair = self.context.sodium.sign.keyPair()!
            secretKey = keyPair.secretKey
            publicKey = keyPair.publicKey
            
            try save()
        }
    }
    
    deinit {
        self.context.sodium.utils.zero(&secretKey)
    }
    
    func toProto() -> Proto_Identity {
        return Proto_Identity.with { (id) in
            id.secretKey = Data(self.secretKey)
            id.publicKey = Data(self.publicKey)
            id.channelChains = chains.map({ (tuple) -> Proto_Identity.ChannelChain in
                let (key: key, value: value) = tuple
                return Proto_Identity.ChannelChain.with({ (chain) in
                    chain.channelID = Data(key)
                    chain.links = value.toProto()
                })
            })
        }
    }
    
    func save() throws {
        let data = try toProto().serializedData()
        try self.context.keychain.set(data, key: "identity/" + name)
    }
    
    // MARK: Chains
    
    func issueLink(for trusteePubKey: Bytes,
                   andChannel channel: Channel,
                   withExpiration expiration: TimeInterval = Identity.DEFAULT_EXPIRATION) throws -> Link {
        var tbs = Proto_Link.TBS.with { (tbs) in
            tbs.trusteePubKey = Data(trusteePubKey)
            tbs.expiration = NSDate().timeIntervalSince1970 + expiration
            tbs.channelID = Data(channel.channelID)
        }
        let tbsData = try tbs.serializedData()
        
        guard let signature = self.context.sodium.sign.signature(message: Bytes(tbsData), secretKey: secretKey) else {
            throw IdentityError.signatureError
        }
        
        tbs.channelID = Data([])
        
        let proto = Proto_Link.with({ (link) in
            link.tbs = tbs
            
            link.signature = Data(signature)
        })
        
        return try Link(context: context, link: proto)
    }
    
    func chain(for channel: Channel) -> Chain? {
        // Empty chain for self-channel
        if context.sodium.utils.equals(channel.publicKey, publicKey) {
            return Chain(context: context, links: [])
        }
        
        return chains[channel.channelID]
    }
    
    func addChain(_ chain: Chain, for channel: Channel) throws {
        chains[channel.channelID] = chain
        try save()
    }
    
    // MARK: Channel content
    
    func signContent(chain: Chain,
                     timestamp: TimeInterval,
                     body: Proto_ChannelMessage.Body,
                     parents: [Bytes],
                     height: Int64) throws -> ChannelMessage.Content {
        let tbsProto = Proto_ChannelMessage.Content.TBS.with { (tbs) in
            tbs.chain = chain.links.map({ (link) -> Proto_Link in
                return link.toProto()
            })
            tbs.timestamp = timestamp
            tbs.body = body
            tbs.parents = parents.map({ (parent) -> Data in
                return Data(parent)
            })
            tbs.height = height
        }
        
        let tbs = try tbsProto.serializedData()
        
        guard let signature = self.context.sodium.sign.signature(message: Bytes(tbs), secretKey: secretKey) else {
            throw IdentityError.signatureError
        }
        
        return ChannelMessage.Content(chain: chain, timestamp: timestamp, body: body, signature: signature)
    }
}
