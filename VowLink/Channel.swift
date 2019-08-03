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
    var proto: Proto_Channel
    let publicKey: Bytes
    var label: String? {
        get {
            if proto.label.isEmpty {
                return nil
            }
            return proto.label
        }
        
        set {
            proto.label = newValue ?? ""
        }
    }
    
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
    
    init(context: Context, proto: Proto_Channel) {
        self.context = context
        self.proto = proto
        self.publicKey = Bytes(proto.publicKey)
    }
}
