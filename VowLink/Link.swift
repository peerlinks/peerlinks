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

struct LinkDetails {
    var issuerPubKey: Bytes
    var channelPubKey: Bytes
    var channelRoot: Bytes
    var label: String
}

class Link {
    let context: Context
    let trusteePubKey: Bytes
    var details: LinkDetails?
    let expiration: TimeInterval
    let signature: Bytes
    
    init(context: Context, trusteePubKey: Bytes, expiration: TimeInterval, signature: Bytes, details: LinkDetails?) {
        self.context = context
        self.trusteePubKey = trusteePubKey
        self.expiration = expiration
        self.signature = signature
        self.details = details
    }
    
    convenience init(context: Context, link: Proto_Link) {
        var details: LinkDetails? = nil
        
        if !link.details.issuerPubKey.isEmpty && !link.details.channelPubKey.isEmpty &&
            !link.details.channelRoot.isEmpty {
            details = LinkDetails(issuerPubKey: Bytes(link.details.issuerPubKey),
                                  channelPubKey: Bytes(link.details.channelPubKey),
                                  channelRoot: Bytes(link.details.channelRoot),
                                  label: link.details.label)
        }
        
        self.init(context: context,
                  trusteePubKey: Bytes(link.tbs.trusteePubKey),
                  expiration: link.tbs.expiration,
                  signature: Bytes(link.signature),
                  details: details)
    }

    
    convenience init(_ encrypted: Proto_EncryptedLink, withContext context: Context, publicKey: Bytes, andSecretKey secretKey: Bytes) throws {
        guard let data = context.sodium.box.open(anonymousCipherText: Bytes(encrypted.box),
                                                 recipientPublicKey: publicKey,
                                                 recipientSecretKey: secretKey) else {
            throw LinkError.decryptError
        }
        
        let proto = try Proto_Link(serializedData: Data(data))
        
        self.init(context: context, link: proto)
    }
    
    func encrypt(withPublicKey publicKey: Bytes) throws -> Proto_EncryptedLink {
        let data: Data = try toProto().serializedData()

        let box = context.sodium.box.seal(
            message: Bytes(data),
            recipientPublicKey: publicKey)
        
        return Proto_EncryptedLink.with({ (encrypted) in
            if let box = box {
                encrypted.box = Data(box)
            }
        })
    }

    func verify(withPublicKey publicKey: Bytes, andChannel channel: Channel) throws -> Bool {
        var tbs = toProto().tbs
        tbs.channelID = Data(channel.channelID)
        return context.sodium.sign.verify(message: Bytes(try tbs.serializedData()),
                                          publicKey: publicKey,
                                          signature: self.signature)
    }
    
    func toProto() -> Proto_Link {
        return Proto_Link.with({ (link) in
            link.tbs = Proto_Link.TBS.with({ (tbs) in
                tbs.trusteePubKey = Data(self.trusteePubKey)
                tbs.expiration = self.expiration
            })
            link.signature = Data(self.signature)
            if let details = self.details {
                link.details = Proto_Link.Details.with({ (proto) in
                    proto.channelPubKey = Data(details.channelPubKey)
                    proto.channelRoot = Data(details.channelRoot)
                    proto.issuerPubKey = Data(details.issuerPubKey)
                    proto.label = details.label
                })
            }
        })
    }
}
