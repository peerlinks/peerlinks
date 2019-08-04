//
//  Channel.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

class Channel {
    let context: Context
    let publicKey: Bytes
    var label: String
    var messages = [ChannelMessage]()
    
    lazy var channelID: Bytes = {
        return self.context.sodium.genericHash.hash(message: publicKey,
                                                    key: "vowlink-channel-id".bytes,
                                                    outputLength: Channel.CHANNEL_ID_LENGTH)!
    }()
    
    var rootHash: Bytes!
    
    static let CHANNEL_ID_LENGTH = 32
    
    init(context: Context, publicKey: Bytes, label: String, rootHash: Bytes) {
        self.context = context
        self.publicKey = publicKey
        self.label = label
        self.rootHash = rootHash
    }
    
    convenience init(context: Context, proto: Proto_Channel) throws {
        self.init(context: context,
                  publicKey: Bytes(proto.publicKey),
                  label: proto.label,
                  rootHash: Bytes(proto.rootHash))
    }
    
    init(_ identity: Identity) throws {
        self.context = identity.context
        self.publicKey = identity.publicKey
        self.label = identity.name
        
        // Only a temporary measure, we should be fine
        rootHash = nil
        
        let content = ChannelMessage.Content(chain: [],
                                             timestamp: NSDate().timeIntervalSince1970,
                                             json: "{}",
                                             signature: [])
        let unencryptedRoot = try! ChannelMessage(context: context, channelID: channelID, content: .decrypted(content), height: 0)
        let encryptedRoot = try unencryptedRoot.encrypted(withChannel: self)
        
        rootHash = encryptedRoot.hash!
        messages.append(unencryptedRoot)
    }
    
    func toProto() -> Proto_Channel {
        return Proto_Channel.with({ (channel) in
            channel.publicKey = Data(self.publicKey)
            channel.label = self.label
            channel.rootHash = Data(self.rootHash)
        })
    }
    
    func messageByHash(hash: Bytes) -> ChannelMessage? {
        return nil
    }
}
