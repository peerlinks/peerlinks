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
    case linkDecryptError
    case linkPubkeyMismatch
}

class Identity {
    let context: Context
    
    let name: String
    var links: [Link] = []
    private var secretKey: Bytes
    let publicKey: Bytes
    
    static let DEFAULT_EXPIRATION: TimeInterval = 99.0 * 24.0 * 3600.0 // 99 days
    
    init(context: Context, name: String) throws {
        self.name = name
        self.context = context
        
        let keychain = self.context.keychain
        
        if let data = try keychain.getData("identity/" + name) {
            let id = try Proto_Identity(serializedData: data)
            debugPrint("[link-storage] loading existing identity \(name)")
            
            secretKey = Bytes(id.secretKey)
            publicKey = Bytes(id.publicKey)
            for proto in id.links {
                links.append(Link(proto))
            }
        } else {
            debugPrint("[link-storage] generating new keypair for \(name)")
            let keyPair = self.context.sodium.sign.keyPair()!
            secretKey = keyPair.secretKey
            publicKey = keyPair.publicKey
            
            try save()
        }
    }
    
    deinit {
        self.context.sodium.utils.zero(&secretKey)
    }
    
    func save() throws {
        let data = try Proto_Identity.with { (id) in
            id.secretKey = Data(self.secretKey)
            id.publicKey = Data(self.publicKey)
            
            var links: [ Proto_Link ] = []
            for l in self.links {
                links.append(l.proto)
            }
            id.links = links
        }.serializedData()
        try self.context.keychain.set(data, key: "identity/" + name)
    }
    
    func issueLink(for trusteePubKey: Bytes,
                   withExpiration expiration: TimeInterval = Identity.DEFAULT_EXPIRATION,
                   displayName: String = "") throws -> Link {
        let tbs = Proto_Link.TBS.with { (tbs) in
            tbs.trusteePubKey = Data(trusteePubKey)
            tbs.expiration = expiration
            tbs.displayName = displayName
        }
        let tbsData = try tbs.serializedData()
        
        guard let signature = self.context.sodium.sign.signature(message: Bytes(tbsData), secretKey: secretKey) else {
            throw IdentityError.signatureError
        }
        
        let proto = Proto_Link.with({ (link) in
            link.tbs = tbs
            link.signature = Data(signature)
        })
        
        return Link(proto)
    }
    
    func addLink(_ encrypted: Proto_EncryptedLink) throws -> Link {
        guard let data = context.sodium.box.open(anonymousCipherText: Bytes(encrypted.box),
                                                 recipientPublicKey: publicKey,
                                                 recipientSecretKey: secretKey) else {
            throw IdentityError.linkDecryptError
        }
        
        let proto = try Proto_Link(serializedData: Data(data))
        
        let link = Link(proto)
        
        if !link.trusteePubKey.elementsEqual(publicKey) {
            throw IdentityError.linkPubkeyMismatch
        }
        
        links.append(link)
        return link
    }
}
