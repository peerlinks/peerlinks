//
//  ChannelList.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

class ChannelList : ChannelDelegate {
    let context: Context
    var channels = [Channel]()
    weak var channelDelegate: ChannelDelegate?
    
    // TODO(indutny): does it make sense to store this in keychain too?
    init(context: Context) {
        self.context = context
        
        do {
            guard let existing = try context.keychain.getData("channels") else {
                debugPrint("[channels] no existing channels")
                return
            }
            
            let proto = try Proto_ChannelList(serializedData: existing)
            
            for channel in proto.channels {
                let channel = try Channel(context: context, proto: channel)
                channel.delegate = self
                channels.append(channel)
            }
            
            debugPrint("[channels] loaded \(channels.count) channels")
        } catch {
            debugPrint("[channels] failed to parse channel list \(error)")
        }
    }
    
    func add(_ channel: Channel) throws {
        for existing in channels {
            if existing.publicKey.elementsEqual(channel.publicKey) {
                debugPrint("[channel] duplicate channel \(channel.publicKey)")
                return
            }
        }
        
        channel.delegate = self

        channels.append(channel)
        
        debugPrint("[channels] added new \(channel.publicKey)")
        
        try save()
    }
    
    func toProto() -> Proto_ChannelList {
        return Proto_ChannelList.with({ (channelList) in
            channelList.channels = self.channels.map({ (channel) -> Proto_Channel in
                return channel.toProto()
            })
        })
    }

    func save() throws {
        let data = try toProto().serializedData()
        
        try context.keychain.set(Data(data), key: "channels")
    }
    
    // MARK: ChannelDelegate
    
    func channel(_ channel: Channel, postedMessage message: ChannelMessage) {
        channelDelegate?.channel(channel, postedMessage: message)
    }
}
