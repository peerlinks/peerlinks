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
    
    // TODO(indutny): does it make sense to store this in keychain too?
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
                subscriptions.append(Channel(context: context, proto: subscription))
            }
            
            debugPrint("[subscriptions] loaded \(subscriptions.count) subscriptions")
        } catch {
            debugPrint("[subscriptions] failed to parse subscription list")
        }
        
        
    }
    
    func add(publicKey: Bytes, label: String?) throws {
        for channel in subscriptions {
            if channel.publicKey.elementsEqual(publicKey) {
                debugPrint("[subscriptions] duplicate \(publicKey)")
                return
            }
        }
        
        let sub = Proto_Subscription.with({ (sub) in
            sub.label = label ?? ""
            sub.publicKey = Data(publicKey)
        })

        let channel = Channel(context: context, proto: sub)
        subscriptions.append(channel)
        proto.subscriptions.append(sub)
        
        debugPrint("[subscriptions] added new \(publicKey)")
        
        try save()
    }
    
    func save() throws {
        let data = try proto.serializedData()
        
        try context.keychain.set(Data(data), key: "subscriptions")
    }
}
