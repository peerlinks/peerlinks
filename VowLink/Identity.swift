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
    var sodium: Sodium!
    var keychain: Keychain!

    var links: [Link] = []
    private var secretKey: Bytes!
    var publicKey: Bytes!
    
    init(sodium: Sodium, keychain: Keychain, identity: String) {
        self.sodium = sodium
        self.keychain = keychain
        
        if let secretKey = try? keychain.getData(identity + "/secret_key"),
           let publicKey = try? keychain.getData(identity + "/public_key") {
            debugPrint("[link-storage] loading existing keypair for \(identity)")
            
            self.secretKey = Bytes(secretKey)
            self.publicKey = Bytes(publicKey)
        } else {
            debugPrint("[link-storage] generating new keypair for \(identity)")
            let keyPair = sodium.sign.keyPair()!
            self.secretKey = keyPair.secretKey
            self.publicKey = keyPair.publicKey
            
            do {
                try keychain.set(Data(self.secretKey), key: identity + "/secret_key")
                try keychain.set(Data(self.publicKey), key: identity + "/public_key")
            } catch {
                fatalError("[link-storage] failed to store keypair in the keychain due to error \(error) for identity \(identity)")
            }
        }
        
        if let data = try? keychain.getData(identity + "/links") {
            let linkArray = try! LinkArray(serializedData: data)
            links = linkArray.links
        }
    }
}
