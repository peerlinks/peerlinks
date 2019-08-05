//
//  Chain.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/4/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

enum ChainError : Error {
    case maximumChainLengthReached
    case invalidChain
}

class Chain {
    let context: Context
    let channelPubKey: Bytes?
    let channelRoot: ChannelMessage?
    let channelName: String?
    let links: [Link]
    
    static let MAX_LENGTH = 5
    
    init(_ encrypted: Proto_EncryptedInvite, withContext context: Context, publicKey: Bytes, andSecretKey secretKey: Bytes) throws {
        guard let data = context.sodium.box.open(anonymousCipherText: Bytes(encrypted.box),
                                                 recipientPublicKey: publicKey,
                                                 recipientSecretKey: secretKey) else {
                                                    throw LinkError.decryptError
        }
        
        let proto = try Proto_Invite(serializedData: Data(data))
        
        self.context = context
    
        var links = [Link]()
        for protoLink in proto.links {
            let link = Link(context: context, link: protoLink)
            links.append(link)
        }
        self.links = links
        
        self.channelPubKey = Bytes(proto.channelPubKey)
        self.channelRoot = try ChannelMessage(context: context, proto: proto.channelRoot)
        self.channelName = proto.channelName
    }
    
    init(context: Context, links: [Link]) {
        self.context = context
        self.links = links
        self.channelPubKey = nil
        self.channelRoot = nil
        self.channelName = nil
    }
    
    func toInviteProto(withChannel channel: Channel) -> Proto_Invite {
        return Proto_Invite.with({ (proto) in
            proto.links = self.links.map({ (link) -> Proto_Link in
                return link.toProto()
            })
            proto.channelPubKey = Data(channel.publicKey)
            proto.channelRoot = channel.root.toProto()!
            proto.channelName = channel.name
        })
    }
    
    func encrypt(withPublicKey publicKey: Bytes, andChannel channel: Channel) throws -> Proto_EncryptedInvite {
        let data: Data = try toInviteProto(withChannel: channel).serializedData()
        
        let box = context.sodium.box.seal(
            message: Bytes(data),
            recipientPublicKey: publicKey)
        
        return Proto_EncryptedInvite.with({ (encrypted) in
            if let box = box {
                encrypted.box = Data(box)
            }
        })
    }
    
    func leafKey(withChannel channel: Channel) -> Bytes {
        return links.reduce(channel.publicKey) { (_, link) -> Bytes in
            return link.trusteePubKey
        }
    }
    
    func verify(withChannel channel: Channel, andAgainstTimestamp timestamp: TimeInterval) throws -> Bytes? {
        if links.count > Chain.MAX_LENGTH {
            return nil
        }
        
        var last = channel.publicKey
        var expiration: TimeInterval = TimeInterval.infinity
        
        for link in links {
            if !(try link.verify(withPublicKey: last, andChannel: channel)) {
                return nil
            }
            last = link.trusteePubKey
            expiration = min(expiration, link.expiration)
        }
        
        if expiration < timestamp {
            return nil
        }
        
        return last
    }
    
    func appendedLink(_ link: Link) throws -> Chain {
        if links.count >= Chain.MAX_LENGTH {
            throw ChainError.maximumChainLengthReached
        }
        
        return Chain(context: context, links: links + [ link ])
    }
    
    func toProto() -> [Proto_Link] {
        return links.map({ (link) -> Proto_Link in
            return link.toProto()
        })
    }
}
