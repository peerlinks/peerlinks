//
//  ChannelList.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

class ChannelList {
    let context: Context
    private var proto: Proto_ChannelList
    var channels = [Channel]()
    
    // TODO(indutny): does it make sense to store this in keychain too?
    init(context: Context) {
        self.context = context
        
        proto = Proto_ChannelList.with({ (list) in
            list.channels = []
        })
        
        do {
            guard let existing = try context.keychain.getData("channels") else {
                debugPrint("[channels] no existing channels")
                return
            }
            
            proto = try Proto_ChannelList(serializedData: existing)
            
            for channel in proto.channels {
                channels.append(Channel(context: context, proto: channel))
            }
            
            debugPrint("[channels] loaded \(channels.count) channels")
        } catch {
            debugPrint("[channels] failed to parse channel list")
        }
    }
    
    func add(_ channel: Channel) throws {
        for existing in channels {
            if existing.publicKey.elementsEqual(channel.publicKey) {
                debugPrint("[channel] duplicate channel \(channel.publicKey)")
                return
            }
        }

        channels.append(channel)
        proto.channels.append(channel.proto)
        
        debugPrint("[channels] added new \(channel.publicKey)")
        
        try save()
    }
    
    func save() throws {
        let data = try proto.serializedData()
        
        try context.keychain.set(Data(data), key: "channels")
    }
}
