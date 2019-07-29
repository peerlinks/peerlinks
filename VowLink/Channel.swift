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
    var sodium: Sodium!
    var publicKey: Bytes!
    var secretKey: Bytes?
    
    private var lazyChannelID: Bytes?
    var channelID: Bytes {
        get {
            if let id = lazyChannelID {
                return id
            }
            lazyChannelID = sodium.genericHash.hash(message: publicKey,
                                                    key: "vowlink-channel-id".bytes,
                                                    outputLength: Channel.CHANNEL_ID_LENGTH)
            return lazyChannelID!
        }
    }
    
    static let CHANNEL_ID_LENGTH = 32
    
    init(sodium: Sodium) {
        self.sodium = sodium

        let keyPair = sodium.sign.keyPair()!
        publicKey = keyPair.publicKey
        secretKey = keyPair.secretKey
    }
    
    init(sodium: Sodium, publicKey: Bytes) {
        self.sodium = sodium

        self.publicKey = publicKey
    }
    
    init(sodium: Sodium, publicKey: Bytes, secretKey: Bytes) {
        self.sodium = sodium

        self.publicKey = publicKey
        self.secretKey = secretKey
    }
}
