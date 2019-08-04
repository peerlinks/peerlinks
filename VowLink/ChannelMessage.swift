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
    case incompleteParent(ChannelMessage)
    case failedToComputeEncryptionKey
    case decryptionFailed
    case parentNotFound(Bytes)
}

class ChannelMessage {
    struct Content {
        let chain: [Link]
        let timestamp: TimeInterval
        let json: String
        var signature: Bytes
    }

    let context: Context
    let channel: Channel
    let nonce: Bytes
    let height: UInt64
    let parents: [ChannelMessage]
    var content: Content?

    lazy var hash: Bytes? = {
        guard let message = try? encrypt()?.serializedData() else {
            return nil
        }
        return self.context.sodium.genericHash.hash(message: Bytes(message),
                                                    key: "vowlink-message".bytes,
                                                    outputLength: ChannelMessage.MESSAGE_HASH_LENGTH)!
    }()
    
    private var parentHashes: [Data] {
        get {
            return parents.map({ (parent) -> Data in
                return Data(parent.hash!)
            })
        }
    }

    static let MESSAGE_HASH_LENGTH = 32
    static let NONCE_LENGTH = 32
    
    init(context: Context, channel: Channel, content: Content? = nil, nonce: Bytes? = nil, parents: [ChannelMessage] = []) throws {
        for parent in parents {
            if parent.content == nil {
                throw ChannelMessageError.incompleteParent(parent)
            }
        }
        self.context = context
        self.channel = channel
        self.nonce = nonce ?? context.sodium.randomBytes.buf(length: ChannelMessage.NONCE_LENGTH)!
        self.parents = parents
        self.height = self.parents.reduce(0, { (result, parent) -> UInt64 in
            max(result, parent.height + 1)
        })
        self.content = content
    }
    
    convenience init(context: Context, channel: Channel, proto: Proto_ChannelMessage) throws {
        let parents = try proto.parents.map { (parentHash) -> ChannelMessage in
            guard let parent = channel.messageByHash(hash: Bytes(parentHash)) else {
                throw ChannelMessageError.parentNotFound(Bytes(parentHash))
            }
            return parent
        }
        try self.init(context: context, channel: channel, content: nil, nonce: Bytes(proto.nonce), parents: parents)
        
        let encryptionKey = try computeEncryptionKey()
        
        guard let decrypted = context.sodium.secretBox.open(nonceAndAuthenticatedCipherText: Bytes(proto.encryptedContent),
                                                          secretKey: encryptionKey) else {
            throw ChannelMessageError.decryptionFailed
        }
        
        let content = try Proto_ChannelMessage.Content(serializedData: Data(decrypted))

        // Check that JSON can be parsed
        let _ = try JSONSerialization.jsonObject(with: Data(content.tbs.json.bytes),
                                                 options: JSONSerialization.ReadingOptions(arrayLiteral: []))
        
        self.content = Content(chain: content.tbs.chain.map({ (link) -> Link in
            return Link(context: self.context, link: link)
        }), timestamp: content.tbs.timestamp, json: content.tbs.json, signature: Bytes(content.signature))
    }
    
    func verify() throws -> Bool {
        guard let content = self.content else {
            return false
        }
        
        guard let publicKey = try Link.verify(chain: content.chain,
                                              withChannel: channel,
                                              andAgainstTimestamp: content.timestamp) else {
            debugPrint("[channel-message] invalid chain for message \(String(describing: hash))")
            return false
        }
        
        return context.sodium.sign.verify(message: Bytes(try toProto()!.tbs.serializedData()),
                                          publicKey: publicKey,
                                          signature: content.signature)
    }
    
    func toProto() -> Proto_ChannelMessage.Content? {
        guard let content = self.content else {
            return nil
        }
        return Proto_ChannelMessage.Content.with({ (proto) in
            proto.tbs.chain = content.chain.map({ (link) -> Proto_Link in
                link.toProto()
            })
            proto.tbs.timestamp = content.timestamp
            proto.tbs.json = content.json
            proto.signature = Data(content.signature)
        })
    }
    
    func encrypt() throws -> Proto_ChannelMessage? {
        guard let content = try toProto()?.serializedData() else {
            return nil
        }
        
        let encryptionKey = try computeEncryptionKey()
        
        guard let box: Bytes = context.sodium.secretBox.seal(message: Bytes(content), secretKey: encryptionKey) else {
            debugPrint("failed to encrypt message")
            return nil
        }
        
        return Proto_ChannelMessage.with({ (message) in
            message.channelID = Data(self.channel.channelID)
            message.parents = self.parentHashes
            message.nonce = Data(self.nonce)
            message.height = self.height
            
            message.encryptedContent = Data(box)
        })
    }
    
    private func computeEncryptionKey() throws -> Bytes {
        let input = Proto_ChannelMessage.EncryptionKeyInput.with({ (input) in
            input.channelID = Data(self.channel.channelID)
            input.parents = self.parentHashes
            input.nonce = Data(self.nonce)
            input.height = self.height
        })
        
        let inputData = try input.serializedData()
    
        let maybeKey = self.context.sodium.genericHash.hash(message: Bytes(inputData),
            key: "vowlink-symmetric".bytes,
            outputLength: context.sodium.secretBox.KeyBytes)
        guard let key = maybeKey else {
            throw ChannelMessageError.failedToComputeEncryptionKey
        }
        return key
    }
}
