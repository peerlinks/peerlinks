//
//  Link.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/30/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

enum LinkError : Error {
    case decryptError
}

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
    
    convenience init(_ encrypted: Proto_EncryptedLink, withContext context: Context, publicKey: Bytes, andSecretKey secretKey: Bytes) throws {
        guard let data = context.sodium.box.open(anonymousCipherText: Bytes(encrypted.box),
                                                 recipientPublicKey: publicKey,
                                                 recipientSecretKey: secretKey) else {
            throw LinkError.decryptError
        }
        
        let proto = try Proto_Link(serializedData: Data(data))
        
        self.init(proto)
    }
    
    func encrypt(withContext context: Context, andPubKey pubKey: Bytes) throws -> Proto_EncryptedLink {
        let data: Data = try proto.serializedData()
        let box = context.sodium.box.seal(
            message: Bytes(data),
            recipientPublicKey: pubKey)
        
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
