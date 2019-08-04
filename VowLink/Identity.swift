//
//  LinkStorage.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/29/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium
import KeychainAccess

enum IdentityError: Error {
    case signatureError
    case linkExpired
    case linkPubkeyMismatch
}

class Identity {
    let context: Context
    
    let name: String
    private var secretKey: Bytes
    let publicKey: Bytes
    
    static let DEFAULT_EXPIRATION: TimeInterval = 99.0 * 24.0 * 3600.0 // 99 days
    
    init(context: Context, name: String) throws {
        self.name = name
        self.context = context
        
        let keychain = self.context.keychain
        
        if let data = try keychain.getData("identity/" + name) {
            let id = try Proto_Identity(serializedData: data)
            debugPrint("[identity] loading existing identity \(name)")
            
            secretKey = Bytes(id.secretKey)
            publicKey = Bytes(id.publicKey)
        } else {
            debugPrint("[identity] generating new keypair for \(name)")
            let keyPair = self.context.sodium.sign.keyPair()!
            secretKey = keyPair.secretKey
            publicKey = keyPair.publicKey
            
            try save()
        }
    }
    
    deinit {
        self.context.sodium.utils.zero(&secretKey)
    }
    
    func toProto() -> Proto_Identity {
        return Proto_Identity.with { (id) in
            id.secretKey = Data(self.secretKey)
            id.publicKey = Data(self.publicKey)
        }
    }
    
    func save() throws {
        let data = try toProto().serializedData()
        try self.context.keychain.set(data, key: "identity/" + name)
    }
    
    func issueLink(for trusteePubKey: Bytes,
                   andChannel channel: Channel,
                   withExpiration expiration: TimeInterval = Identity.DEFAULT_EXPIRATION) throws -> Link {
        let tbs = Proto_Link.TBS.with { (tbs) in
            tbs.trusteePubKey = Data(trusteePubKey)
            tbs.expiration = NSDate().timeIntervalSince1970 + expiration
            tbs.channelID = Data(channel.channelID)
        }
        let tbsData = try tbs.serializedData()
        
        guard let signature = self.context.sodium.sign.signature(message: Bytes(tbsData), secretKey: secretKey) else {
            throw IdentityError.signatureError
        }
        
        let proto = Proto_Link.with({ (link) in
            link.tbs = tbs
            
            link.signature = Data(signature)
        })
        
        return Link(context: context, link: proto)
    }
    
    func signContent(chain: Chain, timestamp: TimeInterval, json: String) throws -> ChannelMessage.Content {
        let tbs = Proto_ChannelMessage.Content.TBS.with { (tbs) in
            tbs.chain = chain.links.map({ (link) -> Proto_Link in
                return link.toProto()
            })
            tbs.timestamp = timestamp
            tbs.json = json
        }
        
        let data = try tbs.serializedData()
        
        guard let signature = self.context.sodium.sign.signature(message: Bytes(data), secretKey: secretKey) else {
            throw IdentityError.signatureError
        }
        
        return ChannelMessage.Content(chain: chain, timestamp: timestamp, json: json, signature: signature)
    }
}
