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
        proto = link
        trusteePubKey = Bytes(link.tbs.trusteePubKey)
        displayName = link.tbs.displayName
        expiration = link.tbs.expiration
        signature = Bytes(link.signature)
    }
    
    func encrypt(withContext context: Context) throws -> Proto_EncryptedLink {
        let data: Data = try proto.serializedData()
        let box = context.sodium.box.seal(
            message: Bytes(data),
            recipientPublicKey: trusteePubKey)
        
        return Proto_EncryptedLink.with({ (encrypted) in
            if let box = box {
                encrypted.box = Data(box)
            }
        })
    }

    func verify(withContext context: Context, publicKey: Bytes) throws -> Bool {
        return context.sodium.sign.verify(message: Bytes(try self.proto.tbs.serializedData()),
                                          publicKey: publicKey,
                                          signature: self.signature)
    }
}
