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
    
    init(context: Context, publicKey: Bytes) {
        self.context = context
        self.publicKey = publicKey
    }
}
