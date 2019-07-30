//
//  Link.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/30/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

class Link {
    let proto: Proto_Link
    let trusteePubKey: Bytes
    let displayName: String
    let expiration: TimeInterval
    let signature: Bytes
    
    init(_ link: Proto_Link) {
        self.proto = link
        self.trusteePubKey = Bytes(link.tbs.trusteePubKey)
        self.displayName = link.tbs.displayName
        self.expiration = link.tbs.expiration
        self.signature = Bytes(link.signature)
    }
    
    func verify(withContext context: Context, publicKey: Bytes) throws -> Bool {
        return context.sodium.sign.verify(message: Bytes(try self.proto.tbs.serializedData()),
                                          publicKey: publicKey,
                                          signature: self.signature)
    }
}
