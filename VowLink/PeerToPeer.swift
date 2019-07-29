//
//  PeerToPeer.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/28/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import MultipeerConnectivity
import Sodium

class PeerToPeer: NSObject, MCNearbyServiceAdvertiserDelegate, MCNearbyServiceBrowserDelegate, MCSessionDelegate {
    var peer: MCPeerID!
    var advertiser: MCNearbyServiceAdvertiser!
    var browser: MCNearbyServiceBrowser!
    var session: MCSession!
    let sodium = Sodium()
    
    init(serviceType: String) {
        super.init()
        
        let defaults = UserDefaults.standard
        if let raw_peer = defaults.data(forKey: "peer-id") {
            peer = try! NSKeyedUnarchiver.unarchivedObject(ofClass: MCPeerID.self, from: raw_peer)
        } else {
            peer = MCPeerID(displayName: NSUUID().uuidString)
            let data = try! NSKeyedArchiver.archivedData(withRootObject: peer as Any,
                                                         requiringSecureCoding: true)
            defaults.set(data, forKey: "peer-id")
            defaults.synchronize()
        }
        debugPrint("[p2p] start peer.displayName=\(peer.displayName)")
        
        session = MCSession(peer: peer, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        
        advertiser = MCNearbyServiceAdvertiser(peer: peer, discoveryInfo: nil, serviceType: serviceType)
        advertiser.delegate = self
        advertiser.startAdvertisingPeer()
        
        browser = MCNearbyServiceBrowser(peer: peer, serviceType: serviceType)
        browser.delegate = self
        browser.startBrowsingForPeers()
    }
    
    deinit {
        advertiser.stopAdvertisingPeer()
        browser.stopBrowsingForPeers()
    }
    
    // MARK: Public API

    func broadcast() {
        let packet = Packet.with { (packet) in
            packet.hello = Hello.with({ hello in
                hello.rateLimit = 10
            })
        }
        
        // TODO(indutny): exceptions
        try! session.send(try! packet.serializedData(), toPeers: session.connectedPeers, with: .unreliable)
    }
    
    // MARK: Advertiser
    
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        debugPrint("[advertiser] did not start due to error \(error), retrying...")
        advertiser.startAdvertisingPeer()
    }
    
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        debugPrint("[advertiser] received invitation from \(peerID.displayName)")
        invitationHandler(true, session)
    }
    
    // MARK: Browser
    
    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        debugPrint("[browser] lost peer \(peerID.displayName)")
    }
    
    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        debugPrint("[browser] did not start due to error \(error), retrying...")
        browser.startBrowsingForPeers()
    }
    
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String : String]?) {
        debugPrint("[browser] found peer \(peerID.displayName) with info \(String(describing: info))")
        
        if peerID.displayName > peer.displayName {
            debugPrint("[browser] inviting peer \(peerID.displayName) into session")
            browser.invitePeer(peerID, to: session, withContext: nil, timeout: 300.0)
        }
    }
    
    // MARK: Session
    
    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        debugPrint("[session] received from \(peerID.displayName) data \(data)")
        do {
            let packet = try Packet(serializedData: data)
            debugPrint("[session] packet \(packet)")
        } catch  {
            debugPrint("[session] parsing error \(error)")
        }
    }
    
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        debugPrint("[session] change state of \(peerID.displayName) to \(state.rawValue)")
    }
    
    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {
        debugPrint("[session] received from \(peerID.displayName) stream")
    }
    
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {
        debugPrint("[session] received from \(peerID.displayName) resource \(resourceName)")
    }
    
    func session(_ session: MCSession, didReceiveCertificate certificate: [Any]?, fromPeer peerID: MCPeerID, certificateHandler: @escaping (Bool) -> Void) {
        debugPrint("[session] received from \(peerID.displayName) certificates \(String(describing: certificate))")
        certificateHandler(true)
    }
    
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {
        debugPrint("[session] finished receiving from \(peerID.displayName) resource \(resourceName)")
    }
}
