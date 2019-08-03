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

    private var lazyChannelID: Bytes?
    var channelID: Bytes {
        get {
            if let id = lazyChannelID {
                return id
            }
            lazyChannelID = self.context.sodium.genericHash.hash(message: publicKey,
                                                                 key: "vowlink-channel-id".bytes,
                                                                 outputLength: Channel.CHANNEL_ID_LENGTH)
            return lazyChannelID!
        }
    }
    
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
    }
    
    func toProto() -> Proto_Channel {
        return Proto_Channel.with({ (channel) in
            channel.publicKey = Data(self.publicKey)
            channel.label = self.label
        })
    }
}
