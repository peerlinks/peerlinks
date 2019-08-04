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
        
        return context.sodium.sign.verify(message: Bytes(try contentProto()!.tbs.serializedData()),
                                          publicKey: publicKey,
                                          signature: content.signature)
    }
    
    func encrypted(withChannel channel: Channel) throws -> ChannelMessage {
        // NOTE: We cache counterpart because `secretBox.seal` generates nonce randomly. Thus the
        // hash of encrypted message would be different every time.
        if let counterpart = counterpart {
            return counterpart
        }
        
        if case .encrypted(_) = content {
            return self
        }
        
        let content = try contentProto()!.serializedData()
        
        let encryptionKey = try computeEncryptionKey(channel: channel)
        
        guard let box: Bytes = context.sodium.secretBox.seal(message: Bytes(content), secretKey: encryptionKey) else {
            throw ChannelMessageError.encryptionFailed
        }
        
        counterpart = try ChannelMessage(context: context,
                                         channelID: channel.channelID,
                                         content: .encrypted(box),
                                         height: height,
                                         parents: parents)
        
        return counterpart!
    }
    
    func decrypted(withChannel channel: Channel) throws -> ChannelMessage {
        if let counterpart = counterpart {
            return counterpart
        }
        
        guard case .encrypted(let encrypted) = content else {
            return self
        }
        
        let encryptionKey = try computeEncryptionKey(channel: channel)
        
        guard let decrypted = context.sodium.secretBox.open(nonceAndAuthenticatedCipherText: encrypted,
                                                            secretKey: encryptionKey) else {
            throw ChannelMessageError.decryptionFailed
        }
        
        let contentProto = try Proto_ChannelMessage.Content(serializedData: Data(decrypted))
        
        // Check that JSON can be parsed
        let _ = try JSONSerialization.jsonObject(with: Data(contentProto.tbs.json.bytes),
                                                 options: JSONSerialization.ReadingOptions(arrayLiteral: []))
        let links = contentProto.tbs.chain.map({ (link) -> Link in
            return Link(context: self.context, link: link)
        })
        
        let content = Content(chain: Chain(context: context, links: links),
                              timestamp: contentProto.tbs.timestamp,
                              json: contentProto.tbs.json,
                              signature: Bytes(contentProto.signature))
        
        counterpart = try ChannelMessage(context: context,
                                         channelID: channel.channelID,
                                         content: .decrypted(content),
                                         height: height,
                                         parents: parents)
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
            proto.tbs.chain = content.chain.links.map({ (link) -> Proto_Link in
                link.toProto()
            })
            proto.tbs.timestamp = content.timestamp
            proto.tbs.json = content.json
            proto.signature = Data(content.signature)
        })
    }
}
