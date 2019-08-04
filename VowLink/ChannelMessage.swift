//
//  ChannelMessage.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/3/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

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
    var content: Content

    // TODO(indutny): this should be a method of EncryptedMessage?
    lazy var hash: Bytes = {
        let message = try! toProto().serializedData()
        return self.context.sodium.genericHash.hash(message: Bytes(message),
                                                    key: "vowlink-message".bytes,
                                                    outputLength: ChannelMessage.MESSAGE_HASH_LENGTH)!
    }()

    static let MESSAGE_HASH_LENGTH = 32
    static let NONCE_LENGTH = 32
    
    init(context: Context, channel: Channel, content: Content, nonce: Bytes? = nil, parents: [ChannelMessage] = []) {
        self.context = context
        self.channel = channel
        self.nonce = nonce ?? context.sodium.randomBytes.buf(length: ChannelMessage.NONCE_LENGTH)!
        self.parents = parents
        self.height = self.parents.reduce(0, { (result, parent) -> UInt64 in
            max(result, parent.height + 1)
        })
        self.content = content
    }
    
    func verify() throws -> Bool {
        guard let publicKey = try Link.verify(chain: content.chain, withChannel: channel) else {
            debugPrint("[channel-message] invalid chain for message \(hash)")
            return false
        }
        
        return context.sodium.sign.verify(message: Bytes(try toProto().tbs.serializedData()),
                                          publicKey: publicKey,
                                          signature: content.signature)
    }
    
    func toProto() -> Proto_ChannelMessage.Content {
        return Proto_ChannelMessage.Content.with({ (content) in
            content.tbs.chain = self.content.chain.map({ (link) -> Proto_Link in
                link.toProto()
            })
            content.tbs.timestamp = self.content.timestamp
            content.tbs.json = self.content.json
            content.signature = Data(self.content.signature)
        })
    }
}
