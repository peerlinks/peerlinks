//
//  IdentityController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/30/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation

protocol IdentityManagerDelegate {
    func identityManager(_ manager: IdentityManager, createdIdentity identity: Identity)
}

class IdentityManager {
    let context: Context
    var current: Identity? = nil
    var identities = [String]()
    var delegate: IdentityManagerDelegate?
    
    init(context: Context) {
        self.context = context
        
        let keys = context.keychain.allKeys().filter { (key) -> Bool in
            return key.starts(with: "identity/")
        }
        
        for key in keys {
            let index = key.index(key.startIndex, offsetBy: 9)
            identities.append(String(key[index...]))
        }
    }
    
    func selectIdentity(name: String) throws {
        // TODO(indutny): check that identity exists
        let id = try Identity(context: context, name: name)
        current = id
    }
    
    func createIdentity(name: String) throws {
        // TODO(indutny): avoid duplicates by throwing
        let id = try Identity(context: context, name: name)
        identities.append(name)
        self.delegate?.identityManager(self, createdIdentity: id)
        current = id
    }
}
