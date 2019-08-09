//
//  NetworkManager.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/9/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import Sodium

protocol NetworkManagerDelegate : AnyObject {
    
}

protocol InviteNotificationDelegate: AnyObject {
    var boxPublicKey: Bytes? { get }
    var boxSecretKey: Bytes? { get }
    
    func invite(received chain: Chain)
}

protocol ChannelPeersDelegate : AnyObject {
    func channelPeers(updatedForChannel channelID: Bytes)
}

enum NetworkManagerError : Error {
    case chainNotFound
}

class NetworkManager : PeerToPeerDelegate, ChannelListDelegate, ChannelDelegate {
    let context: Context
    let channelList: ChannelList
    let p2p: PeerToPeer
    let queue = DispatchQueue(label: "network-manager")

    weak var delegate: NetworkManagerDelegate?
    weak var inviteDelegate: InviteNotificationDelegate?
    weak var channelDelegate: ChannelDelegate?
    weak var channelPeersDelegate: ChannelPeersDelegate?
    
    init(context: Context) {
        self.context = context
        p2p = PeerToPeer(context: context, queue: queue, andServiceType: "com-vowlink")
        channelList = ChannelList(context: context)
        
        p2p.delegate = self
        channelList.delegate = self
        channelList.channelDelegate = self
    }
    
    // MARK: Channels
    
    func addChannel(_ channel: Channel) throws {
        try channelList.add(channel)
    }
    
    func peerCount(for channelID: Bytes) -> Int {
        return p2p.subscribedPeers(to: channelID).count
    }

    // MARK: Invite
    
    func confirm(invite: Chain, withChannelName name: String, andIdentity identity: Identity) throws {
        guard let publicKey = invite.channelPubKey else {
            throw ChainReceivedError.invalidInvite
        }
        
        guard let root = invite.channelRoot else {
            throw ChainReceivedError.invalidInvite
        }
        
        let channel = try Channel(context: context,
                                  publicKey: publicKey,
                                  name: name,
                                  root: root)
        try identity.addChain(invite, for: channel)
        try channelList.add(channel)
    }
    
    func send(inviteWithRequest request: Proto_InviteRequest,
              andChannel channel: Channel,
              withIdentity identity: Identity) throws -> Bool {
        let peers = p2p.peers(byDisplayName: request.peerID)
        if peers.isEmpty {
            return false
        }
        
        let link = try identity.issueLink(for: Bytes(request.trusteePubKey), andChannel: channel)
        
        guard let chain = try identity.chain(for: channel)?.appendedLink(link) else {
            throw NetworkManagerError.chainNotFound
        }
        
        let encryptedInvite = try chain.encrypt(withPublicKey: Bytes(request.boxPubKey), andChannel: channel)
        
        let packet = Proto_Packet.with { (packet) in
            packet.invite = encryptedInvite
        }
        
        try p2p.send(packet, to: peers)
        return true
    }
    
    // MARK: Packet
    
    private func receive(encryptedInvite proto: Proto_EncryptedInvite, from peer: Peer) {
        guard let delegate = inviteDelegate else {
            return
        }
        
        guard let publicKey = delegate.boxPublicKey,
            let secretKey = delegate.boxSecretKey else {
            return
        }
        
        do {
            let chain = try Chain(proto,
                                  withContext: context,
                                  publicKey: publicKey,
                                  andSecretKey: secretKey)
            
            delegate.invite(received: chain)
        } catch {
            debugPrint("[network] failed to decrypt invite due to error \(error)")
            peer.destroy(reason: "failed to decrypt invite due to error \(error)")
        }
    }
    
    private func receive(notification proto: Proto_Notification, from peer: Peer) {
        guard let channel = channelList.find(byChannelID: Bytes(proto.channelID)) else {
            debugPrint("[network] channel \(proto.channelID) is unknown")
            return
        }
        
        debugPrint("[network] notification for channel \(channel.channelDisplayID)")
        channel.sync(with: peer)
    }
    
    private func receive(query proto: Proto_Query, from peer: Peer) {
        let channelID = Bytes(proto.channelID)
        
        guard let channel = channelList.find(byChannelID: channelID) else {
            debugPrint("[network] channel \(channelID) not found for query")
            return
        }
        
        do {
            var response: Channel.QueryResponse?
            
            var cursor: Channel.Cursor?
            switch proto.cursor {
            case .some(.hash(let hash)):
                cursor = .hash(Bytes(hash))
            case .some(.height(let height)):
                cursor = .height(height)
            case .none:
                return peer.destroy(reason: "invalid cursor in query response")
            }
            response = try channel.query(withCursor: cursor!,
                                         isBackward: proto.isBackward,
                                         andLimit: Int(proto.limit))
            
            let _ = try peer.send(queryResponse: response!, from: channel)
        } catch {
            return peer.destroy(reason: "channel query failed due to \(error)")
        }
    }
    
    private func receive(bulk proto: Proto_Bulk, from peer: Peer) {
        let channelID = Bytes(proto.channelID)
        
        guard let channel = channelList.find(byChannelID: channelID) else {
            debugPrint("[network] channel \(channelID) not found for query")
            return
        }
        
        do {
            let response = try channel.bulk(withHashes: proto.hashes.map({ (hash) -> Bytes in
                return Bytes(hash)
            }))
            
            let _ = try peer.send(bulkResponse: response, from: channel)
        } catch {
            return peer.destroy(reason: "channel bulk failed due to error \(error)")
        }
    }
    
    // MARK: PeerToPeerDelegate
    
    func peerToPeer(_ p2p: PeerToPeer, peerReady peer: Peer) {
        // no-op
    }
    
    func peerToPeer(_ p2p: PeerToPeer, connectedTo peer: Peer) {
        debugPrint("[network] new peer \(peer), syncing and subscribing to channels.count=\(channelList.channels.count)")
        for channel in channelList.channels {
            do {
                let _ = try peer.send(subscribeTo: channel.channelID)
            } catch {
                debugPrint("[network] failed to send subscribe to \(channel.channelID) due to error \(error)")
            }
            
            channel.sync(with: peer)
        }
    }
    
    func peerToPeer(_ p2p: PeerToPeer, disconnectedFrom peer: Peer) {
        for channelID in peer.subscriptions {
            channelPeersDelegate?.channelPeers(updatedForChannel: channelID)
        }
    }
    
    func peerToPeer(_ p2p: PeerToPeer, peer: Peer, subscribedToChannel channelID: Bytes) {
        channelPeersDelegate?.channelPeers(updatedForChannel: channelID)
    }
    
    func peerToPeer(_ p2p: PeerToPeer, didReceive packet: Proto_Packet, fromPeer peer: Peer) {
        debugPrint("[network] got packet \(packet) from peer \(peer)")
        
        switch packet.content {
        case .some(.invite(let encryptedInvite)):
            self.receive(encryptedInvite: encryptedInvite, from: peer)
        case .some(.notification(let notification)):
            self.receive(notification: notification, from: peer)
        case .some(.query(let query)):
            self.receive(query: query, from: peer)
        case .some(.bulk(let bulk)):
            self.receive(bulk: bulk, from: peer)
        default:
            debugPrint("[network] unhandled packet \(packet)")
        }
    }
    
    // MARK: ChannelListDelegate
    
    func channelList(added channel: Channel) {
        for peer in p2p.readyPeers {
            do {
                let _ = try peer.send(subscribeTo: channel.channelID)
            } catch {
                debugPrint("[network] failed to send subscribe to new \(channel.channelID) due to error \(error)")
            }
            
            channel.sync(with: peer)
        }
    }
    
    // MARK: ChannelDelegate
    
    func channel(_ channel: Channel, postedMessage message: ChannelMessage) {
        channelDelegate?.channel(channel, postedMessage: message)
        
        do {
            try p2p.send(Proto_Packet.with({ (proto) in
                proto.notification = Proto_Notification.with({ (proto) in
                    proto.channelID = Data(channel.channelID)
                })
            }), to: p2p.readyPeers)
        } catch {
            debugPrint("[network] failed to broadcast message due to error \(error)")
        }
    }
}
