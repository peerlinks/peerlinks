//
//  SubscriptionList.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

class SubscriptionList {
    let context: Context
    private var proto: Proto_SubscriptionList
    var subscriptions = [Channel]()
    
    init(context: Context) {
        self.context = context
        
        proto = Proto_SubscriptionList.with({ (list) in
            list.subscriptions = []
        })
        
        do {
            guard let existing = try context.keychain.getData("subscriptions") else {
                debugPrint("[subscriptions] no existing subscriptions")
                return
            }
            
            proto = try Proto_SubscriptionList(serializedData: existing)
            
            for subscription in proto.subscriptions {
                subscriptions.append(Channel(context: context, publicKey: Bytes(subscription.publicKey)))
            }
            
            debugPrint("[subscriptions] loaded \(subscriptions.count) subscriptions")
        } catch {
            debugPrint("[subscriptions] failed to parse subscription list")
        }
        
        
    }
    
    // TODO(indutny): prevent duplicates
    func add(publicKey: Bytes) throws {
        let channel = Channel(context: context, publicKey: publicKey)
        subscriptions.append(channel)
        proto.subscriptions.append(Proto_Subscription.with({ (sub) in
            sub.publicKey = Data(publicKey)
        }))
        
        try save()
    }
    
    func save() throws {
        let data = try proto.serializedData()
        
        try context.keychain.set(Data(data), key: "subscriptions")
    }
}
