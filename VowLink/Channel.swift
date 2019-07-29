//
//  Channel.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/29/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

class Channel {
    var context: Context!
    var publicKey: Bytes!
    private var secretKey: Bytes?
    
    private var lazyChannelID: Bytes?
    var channelID: Bytes {
        get {
            if let id = lazyChannelID {
                return id
            }
            lazyChannelID = self.context.sodium.genericHash.hash(message: publicKey,
                                                                 key: "vowlink-channel-id".bytes,
                                                                 outputLength:  Channel.CHANNEL_ID_LENGTH)
            return lazyChannelID!
        }
    }
    
    static let CHANNEL_ID_LENGTH = 32
    
    init(context: Context) {
        self.context = context

        let keyPair = self.context.sodium.sign.keyPair()!
        publicKey = keyPair.publicKey
        secretKey = keyPair.secretKey
    }
    
    init(context: Context, publicKey: Bytes) {
        self.context = context

        self.publicKey = publicKey
    }
    
    init(context: Context, publicKey: Bytes, secretKey: Bytes) {
        self.context = context

        self.publicKey = publicKey
        self.secretKey = secretKey
    }
    
    deinit {
        if var secretKey = self.secretKey {
            self.context.sodium.utils.zero(&secretKey)
        }
    }
}
