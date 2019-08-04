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
    
    var rootMessage: ChannelMessage?
    
    static let CHANNEL_ID_LENGTH = 32
    
    init(context: Context, publicKey: Bytes, label: String) {
        self.context = context
        self.publicKey = publicKey
        self.label = label
    }
    
    convenience init(context: Context, proto: Proto_Channel) {
        self.init(context: context, publicKey: Bytes(proto.publicKey), label: proto.label)
    }
    
    convenience init(_ identity: Identity) {
        self.init(context: identity.context, publicKey: identity.publicKey, label: identity.name)
    
        let content = ChannelMessage.Content(chain: [],
                                             timestamp: NSDate().timeIntervalSince1970,
                                             json: "{}",
                                             signature: [])
        rootMessage = try! ChannelMessage(context: context, channel: self, content: .decrypted(content))
        messages.append(rootMessage!)
    }
    
    func toProto() -> Proto_Channel {
        return Proto_Channel.with({ (channel) in
            channel.publicKey = Data(self.publicKey)
            channel.label = self.label
        })
    }
    
    func messageByHash(hash: Bytes) -> ChannelMessage? {
        return nil
    }
}
