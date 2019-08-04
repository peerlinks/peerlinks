//
//  Channel.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

class Channel {
    let context: Context
    let publicKey: Bytes
    var name: String
    var messages = [ChannelMessage]()
    var chain: Chain
    
    lazy var channelID: Bytes = {
        return self.context.sodium.genericHash.hash(message: publicKey,
                                                    key: "vowlink-channel-id".bytes,
                                                    outputLength: Channel.CHANNEL_ID_LENGTH)!
    }()
    
    var rootHash: Bytes!
    
    static let CHANNEL_ID_LENGTH = 32
    
    init(context: Context, publicKey: Bytes, name: String, rootHash: Bytes, chain: Chain) {
        self.context = context
        self.publicKey = publicKey
        self.name = name
        self.rootHash = rootHash
        self.chain = chain
    }
    
    convenience init(context: Context, proto: Proto_Channel) throws {
        let links = proto.chain.map { (link) -> Link in
            return Link(context: context, link: link)
        }
        self.init(context: context,
                  publicKey: Bytes(proto.publicKey),
                  name: proto.name,
                  rootHash: Bytes(proto.rootHash),
                  chain: Chain(context: context, links: links))
        
        for protoMessage in proto.messages {
            let message = try ChannelMessage(context: context, proto: protoMessage)
            messages.append(try! message.decrypted(withChannel: self))
        }
    }
    
    init(_ identity: Identity) throws {
        self.context = identity.context
        self.publicKey = identity.publicKey
        self.name = identity.name
        self.chain = Chain(context: identity.context, links: [])
        
        // Only a temporary measure, we should be fine
        rootHash = nil
        
        let content = try identity.signContent(chain: chain,
                                               timestamp: NSDate().timeIntervalSince1970,
                                               json: "{\"type\":\"root\"}")
        let unencryptedRoot = try! ChannelMessage(context: context,
                                                  channelID: channelID,
                                                  content: .decrypted(content),
                                                  height: 0)
        let encryptedRoot = try unencryptedRoot.encrypted(withChannel: self)
        
        rootHash = encryptedRoot.hash!
        messages.append(unencryptedRoot)
    }
    
    func toProto() -> Proto_Channel {
        return Proto_Channel.with({ (channel) in
            channel.publicKey = Data(self.publicKey)
            channel.name = self.name
            channel.rootHash = Data(self.rootHash)
            channel.messages = self.messages.map({ (message) -> Proto_ChannelMessage in
                let encrypted = try! message.encrypted(withChannel: self)
                return encrypted.toProto()!
            })
            channel.chain = chain.links.map({ (link) -> Proto_Link in
                return link.toProto()
            })
        })
    }
    
    func messageByHash(hash: Bytes) -> ChannelMessage? {
        for message in messages {
            let encrypted = try! message.encrypted(withChannel: self)
            if context.sodium.utils.equals(hash, encrypted.hash!) {
                return message
            }
        }
        
        return nil
    }
}
