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
    var context: Context!
    
    var links: [Link] = []
    private var secretKey: Bytes!
    var publicKey: Bytes!
    
    init(context: Context, identity: String) {
        self.context = context
        
        let keychain = self.context.keychain
        
        if let data = try? keychain.getData("identity/" + identity),
           let serialized = try? SecretIdentity(serializedData: data) {
            debugPrint("[link-storage] loading existing identity \(identity)")
            
            self.secretKey = Bytes(serialized.secretKey)
            self.publicKey = Bytes(serialized.publicKey)
        } else {
            debugPrint("[link-storage] generating new keypair for \(identity)")
            let keyPair = self.context.sodium.sign.keyPair()!
            self.secretKey = keyPair.secretKey
            self.publicKey = keyPair.publicKey
            
            do {
                let data = try SecretIdentity.with { (id) in
                    id.secretKey = Data(self.secretKey)
                    id.publicKey = Data(self.publicKey)
                }.serializedData()
                try keychain.set(data, key: "identity/" + identity)
            } catch {
                fatalError("[link-storage] failed to store keypair in the keychain due to error \(error) for identity \(identity)")
            }
        }
        
        if let data = try? keychain.getData(identity + "/links") {
            let linkArray = try! LinkArray(serializedData: data)
            links = linkArray.links
        }
    }
    
    deinit {
        self.context.sodium.utils.zero(&secretKey)
    }
}
