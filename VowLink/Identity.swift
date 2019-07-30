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

class Identity {
    let context: Context
    
    let identity: String
    var links: [Link] = []
    private var secretKey: Bytes
    let publicKey: Bytes
    
    init(context: Context, identity: String) throws {
        self.identity = identity
        self.context = context
        
        let keychain = self.context.keychain
        
        if let data = try keychain.getData("identity/" + identity) {
            let id = try SecretIdentity(serializedData: data)
            debugPrint("[link-storage] loading existing identity \(identity)")
            
            secretKey = Bytes(id.secretKey)
            publicKey = Bytes(id.publicKey)
            links = id.links
        } else {
            debugPrint("[link-storage] generating new keypair for \(identity)")
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
        let data = try SecretIdentity.with { (id) in
            id.secretKey = Data(self.secretKey)
            id.publicKey = Data(self.publicKey)
            id.links = []
        }.serializedData()
        try self.context.keychain.set(data, key: "identity/" + identity)
    }
}
