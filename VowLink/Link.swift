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
    struct Details {
        var issuerPubKey: Bytes
        var channelPubKey: Bytes
        var channelRootHash: Bytes
        var label: String
    }
    
    let context: Context
    let trusteePubKey: Bytes
    var details: Details?
    let expiration: TimeInterval
    let signature: Bytes
    
    static let MAX_CHAIN_LENGTH = 5
    
    init(context: Context, trusteePubKey: Bytes, expiration: TimeInterval, signature: Bytes, details: Details?) {
        self.context = context
        self.trusteePubKey = trusteePubKey
        self.expiration = expiration
        self.signature = signature
        self.details = details
    }
    
    convenience init(context: Context, link: Proto_Link) {
        var details: Details? = nil
        
        if !link.details.issuerPubKey.isEmpty && !link.details.channelPubKey.isEmpty &&
            !link.details.channelRootHash.isEmpty {
            details = Details(issuerPubKey: Bytes(link.details.issuerPubKey),
                              channelPubKey: Bytes(link.details.channelPubKey),
                              channelRootHash: Bytes(link.details.channelRootHash),
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
    
    static func verify(chain: [Link], withChannel channel: Channel, andAgainstTimestamp timestamp: TimeInterval) throws -> Bytes? {
        if chain.count > Link.MAX_CHAIN_LENGTH {
            return nil
        }

        var last = channel.publicKey
        var expiration: TimeInterval = TimeInterval.infinity
        
        for link in chain {
            if !(try link.verify(withPublicKey: last, andChannel: channel)) {
                return nil
            }
            last = link.trusteePubKey
            expiration = min(expiration, link.expiration)
        }
        
        if expiration < timestamp {
            return nil
        }
        
        return last
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
                    proto.channelRootHash = Data(details.channelRootHash)
                    proto.issuerPubKey = Data(details.issuerPubKey)
                    proto.label = details.label
                })
            }
        })
    }
}
