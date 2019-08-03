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
    let context: Context
    let channel: Channel
    let nonce: Bytes
    let height: UInt64
    var parents = [ChannelMessage]()
    
    lazy var hash: Bytes = {
        let message = try! toProto().serializedData()
        return self.context.sodium.genericHash.hash(message: Bytes(message),
                                                    key: "vowlink-message".bytes,
                                                    outputLength: Channel.CHANNEL_ID_LENGTH)!
    }()
    
    static let NONCE_LENGTH = 32
    
    init(context: Context, channel: Channel, nonce: Bytes?, parents: [ChannelMessage]?) {
        self.context = context
        self.channel = channel
        self.nonce = nonce ?? context.sodium.randomBytes.buf(length: ChannelMessage.NONCE_LENGTH)!
        self.parents = parents ?? []
        self.height = self.parents.reduce(0, { (result, parent) -> UInt64 in
            min(result, parent.height + 1)
        })
    }
    
    func toProto() -> Proto_ChannelMessage {
        return Proto_ChannelMessage.with({ (proto) in
            proto.channelID = Data(self.channel.channelID)
            proto.nonce = Data(self.nonce)
            proto.height = height
            proto.parents = self.parents.map({ (parent) -> Data in
                return Data(parent.hash)
            })
        })
    }
}
