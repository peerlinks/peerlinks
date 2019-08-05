//
//  PeerToPeer.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/28/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import MultipeerConnectivity
import KeychainAccess
import Sodium

protocol PeerToPeerDelegate: AnyObject {
    func peerToPeer(_ p2p: PeerToPeer, didReceive packet: Proto_Packet, fromPeer peer: Peer)
}

// TODO(indutny): connect randomly to peers. We should support at least a hundred of peers that are nearby.
// Connecting to all of them is not only unreasonable, but likely is not going to work: 100 * 101 / 2 = 5050 connections!
// It might be best to select 8 peers either randomly, or using some form of rendezvous hashing and work with them.
// Maybe even rotate the peers from time to time.
class PeerToPeer: NSObject, MCNearbyServiceAdvertiserDelegate, MCNearbyServiceBrowserDelegate, PeerDelegate {
    let context: Context
    let localID: MCPeerID
    let advertiser: MCNearbyServiceAdvertiser
    let browser: MCNearbyServiceBrowser
    weak var delegate: PeerToPeerDelegate?
    var peers = [MCPeerID:Peer]()
    var availablePeers = Set<MCPeerID>()
    
    // TODO(indutny): consider reasonable limit
    static let MAX_PEERS = 32
    static let RECONNECT_DELAY: TimeInterval = 1.0
    
    init(context: Context, serviceType: String) {
        self.context = context

        // NOTE: The string is always random to avoid fingerprinting
        localID = MCPeerID(displayName: NSUUID().uuidString)
        
        debugPrint("[p2p] start peer.displayName=\(localID.displayName)")
        
        advertiser = MCNearbyServiceAdvertiser(peer: localID, discoveryInfo: nil, serviceType: serviceType)
        advertiser.startAdvertisingPeer()
        
        browser = MCNearbyServiceBrowser(peer: localID, serviceType: serviceType)
        browser.startBrowsingForPeers()
        
        super.init()
        
        advertiser.delegate = self
        browser.delegate = self
    }
    
    deinit {
        advertiser.stopAdvertisingPeer()
        browser.stopBrowsingForPeers()
    }
    
    // MARK: Public API
    
    func send(_ packet: Proto_Packet, to peerID: String? = nil) throws {
        let data = try packet.serializedData()

        let realIDs = peers.keys.filter { (peer) -> Bool in
            return peerID == nil || peer.displayName == peerID
        }
        
        let peers = realIDs.map({ (id) -> Peer? in
            return self.peers[id]
        }).filter { (peer) -> Bool in
            return peer != nil
        }
        
        for peer in peers {
            if try peer?.send(data) == false {
                debugPrint("[p2p] failed to send link due to rate limiting")
            }
        }
    }
    
    private func connect(to remoteID: MCPeerID) -> Peer? {
        if peers[remoteID] != nil || remoteID == self.localID {
            debugPrint("[p2p] ignoring peer \(remoteID.displayName)")
            return nil
        }
        
        if peers.count > PeerToPeer.MAX_PEERS {
            debugPrint("[p2p] ignoring peer \(remoteID.displayName) due to max peers limit")
            return nil
        }

        let peer = Peer(context: context, localID: localID, remoteID: remoteID)
        peer.delegate = self
        self.peers[peer.remoteID] = peer
        
        return peer
    }

    // MARK: Advertiser
    
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        debugPrint("[p2p] did not start due to error \(error), retrying...")
        advertiser.startAdvertisingPeer()
    }
    
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        DispatchQueue.main.async {
            if self.peers[peerID] != nil || peerID == self.localID {
                debugPrint("[p2p] declining invitation from \(peerID.displayName)")
                invitationHandler(false, nil)
                return
            }
            
            if self.peers.count > PeerToPeer.MAX_PEERS {
                debugPrint("[p2p] declining invitation from \(peerID.displayName) due to max peers limit")
                invitationHandler(false, nil)
                return
            }
            
            debugPrint("[p2p] accepting invitation from \(peerID.displayName)")
            let peer = Peer(context: self.context, localID: self.localID, remoteID: peerID)
            peer.delegate = self
            self.peers[peer.remoteID] = peer
            
            invitationHandler(true, peer.session)
        }
    }
    
    // MARK: Browser
    
    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        DispatchQueue.main.async {
            debugPrint("[p2p] lost peer \(peerID.displayName)")
            self.availablePeers.remove(peerID)
        }
    }
    
    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        DispatchQueue.main.async {
            debugPrint("[p2p] did not start due to error \(error), retrying...")
            browser.startBrowsingForPeers()
        }
    }
    
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String : String]?) {
        DispatchQueue.main.async {
            debugPrint("[p2p] found peer \(peerID.displayName) with info \(String(describing: info))")
            self.availablePeers.insert(peerID)
            
            if peerID.displayName <= self.localID.displayName {
                debugPrint("[p2p] waiting to be invited by peer \(peerID.displayName) into session")
                return
            }

            if let peer = self.connect(to: peerID) {
                debugPrint("[p2p] inviting peer \(peerID.displayName) into session")
                browser.invitePeer(peerID, to: peer.session, withContext: nil, timeout: 300.0)
            }
        }
    }
    
    // MARK: Peer
    
    func peerConnected(_ peer: Peer) {
        // no-op
    }
    
    func peerDisconnected(_ peer: Peer) {
        self.peers.removeValue(forKey: peer.remoteID)
        peer.delegate = nil
        
        // Try to reconnect if the peer is still around
        Timer.scheduledTimer(withTimeInterval: PeerToPeer.RECONNECT_DELAY,
              repeats: false) { (_) in
            // No peers to reconnect to
            if self.availablePeers.count == 0 {
                debugPrint("[p2p] no peers to reconnect to")
                return
            }

            var remoteID = peer.remoteID
            if self.availablePeers.contains(remoteID) {
                debugPrint("[p2p] disconnected peer \(remoteID) is still there, reconnecting")
            } else {
                remoteID = self.availablePeers.randomElement()!
                debugPrint("[p2p] disconnected peer is gone, reconnecting to \(remoteID)")
            }
                
            if let peer = self.connect(to: peer.remoteID) {
                debugPrint("[p2p] inviting peer \(remoteID.displayName) into session")
                self.browser.invitePeer(peer.remoteID, to: peer.session, withContext: nil, timeout: 300.0)
            }
        }
    }
    
    func peer(_ peer: Peer, receivedPacket packet: Proto_Packet) {
        self.delegate?.peerToPeer(self, didReceive: packet, fromPeer: peer)
    }
}
