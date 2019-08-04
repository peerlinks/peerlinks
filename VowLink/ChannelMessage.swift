//
//  ChannelMessage.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/3/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

enum ChannelMessageError : Error {
    case failedToComputeEncryptionKey
    case encryptionFailed
    case decryptionFailed
    case parentNotFound(Bytes)
}

class ChannelMessage {
    struct Content {
        let chain: Chain
        let timestamp: TimeInterval
        let json: String
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
    let content: EitherContent
    
    var isEncrypted: Bool {
        get {
            switch content {
            case .decrypted(_): return false
            case .encrypted(_): return true
            }
        }
    }
    
    // Decrypted message for Encrypted message, or vice versa
    private var counterpart: ChannelMessage? = nil
    
    lazy var hash: Bytes? = {
        guard let proto = toProto() else {
            return nil
        }
        return self.context.sodium.genericHash.hash(message: Bytes(try! proto.serializedData()),
                                                    key: "vowlink-message".bytes,
                                                    outputLength: ChannelMessage.MESSAGE_HASH_LENGTH)!
    }()

    static let MESSAGE_HASH_LENGTH = 32
    
    init(context: Context, channelID: Bytes, content: EitherContent, height: UInt64, parents: [Bytes] = []) throws {
        self.context = context
        self.channelID = channelID
        self.parents = parents
        self.height = height
        self.content = content
    }
    
    convenience init(context: Context, proto: Proto_ChannelMessage) throws {
        try self.init(context: context,
                      channelID: Bytes(proto.channelID),
                      content: .encrypted(Bytes(proto.encryptedContent)),
                      height: proto.height,
                      parents: proto.parents.map({ (parent) -> Bytes in
                        return Bytes(parent)
                      }))
    }
    
    func verify(withChannel channel: Channel) throws -> Bool {
        guard case .decrypted(let content) = self.content else {
            return false
        }
        
        guard let publicKey = try content.chain.verify(withChannel: channel,
                                                       andAgainstTimestamp: content.timestamp) else {
            debugPrint("[channel-message] invalid chain for message \(String(describing: hash))")
            return false
        }
        
        let tbs = try tbsProto()!.serializedData()
        
        return context.sodium.sign.verify(message: Bytes(tbs),
                                          publicKey: publicKey,
                                          signature: content.signature)
    }
    
    func encrypted(withChannel channel: Channel) throws -> ChannelMessage {
        // Already encrypted
        if case .encrypted(_) = content {
            return self
        }

        // NOTE: We cache counterpart because `secretBox.seal` generates nonce randomly. Thus the
        // hash of encrypted message would be different every time.
        if let counterpart = counterpart {
            return counterpart
        }
        
        let content = try contentProto()!.serializedData()
        
        let encryptionKey = try computeEncryptionKey(channel: channel)
        
        // XXX(indutny): use `nonce` when https://github.com/jedisct1/swift-sodium/pull/188 lands
        guard let box: Bytes = context.sodium.secretBox.seal(message: Bytes(content), secretKey: encryptionKey) else {
            throw ChannelMessageError.encryptionFailed
        }
        
        counterpart = try ChannelMessage(context: context,
                                         channelID: channel.channelID,
                                         content: .encrypted(box),
                                         height: height,
                                         parents: parents)
        counterpart?.counterpart = self
        return counterpart!
    }
    
    func decrypted(withChannel channel: Channel) throws -> ChannelMessage {
        guard case .encrypted(let encrypted) = content else {
            // Already decrypted
            return self
        }
        
        if let counterpart = counterpart {
            return counterpart
        }

        let encryptionKey = try computeEncryptionKey(channel: channel)
        
        guard let decrypted = context.sodium.secretBox.open(nonceAndAuthenticatedCipherText: encrypted,
                                                            secretKey: encryptionKey) else {
            throw ChannelMessageError.decryptionFailed
        }
        
        let contentProto = try Proto_ChannelMessage.Content(serializedData: Data(decrypted))
        
        // Check that JSON can be parsed
        let _ = try JSONSerialization.jsonObject(with: Data(contentProto.json.bytes),
                                                 options: JSONSerialization.ReadingOptions(arrayLiteral: []))
        let links = contentProto.chain.map({ (link) -> Link in
            return Link(context: self.context, link: link)
        })
        
        let content = Content(chain: Chain(context: context, links: links),
                              timestamp: contentProto.timestamp,
                              json: contentProto.json,
                              signature: Bytes(contentProto.signature))
        
        counterpart = try ChannelMessage(context: context,
                                         channelID: channel.channelID,
                                         content: .decrypted(content),
                                         height: height,
                                         parents: parents)
        counterpart?.counterpart = self
        return counterpart!
    }
    
    func toProto() -> Proto_ChannelMessage? {
        guard case .encrypted(let encrypted) = content else {
            return nil
        }
        
        return Proto_ChannelMessage.with({ (proto) in
            proto.channelID = Data(self.channelID)
            proto.parents = self.parents.map({ (parent) -> Data in
                return Data(parent)
            })
            proto.height = self.height
            
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
        guard case .decrypted(let content) = self.content else {
            return nil
        }
        
        return Proto_ChannelMessage.Content.with({ (proto) in
            proto.chain = content.chain.links.map({ (link) -> Proto_Link in
                link.toProto()
            })
            proto.timestamp = content.timestamp
            proto.json = content.json
            proto.signature = Data(content.signature)
        })
    }
    
    private func tbsProto() -> Proto_ChannelMessage.Content.TBS? {
        guard case .decrypted(let content) = self.content else {
            return nil
        }
        
        return Proto_ChannelMessage.Content.TBS.with({ (proto) in
            proto.chain = content.chain.links.map({ (link) -> Proto_Link in
                link.toProto()
            })
            proto.timestamp = content.timestamp
            proto.json = content.json
            proto.parents = self.parents.map({ (parent) -> Data in
                return Data(parent)
            })
            proto.height = self.height
        })
    }
}
