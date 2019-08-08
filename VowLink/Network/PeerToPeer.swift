import Foundation
import MultipeerConnectivity
import KeychainAccess
import Sodium

protocol PeerToPeerDelegate: AnyObject {
    func peerToPeer(_ p2p: PeerToPeer, connectedTo peer: Peer)
    func peerToPeer(_ p2p: PeerToPeer, peerReady peer: Peer)
    func peerToPeer(_ p2p: PeerToPeer, didReceive packet: Proto_Packet, fromPeer peer: Peer)
}

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
    
    var readyPeers: [Peer] {
        get {
            return peers.values.filter({ (peer) -> Bool in
                return peer.isReady
            })
        }
    }
    
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
    
    func send(_ packet: Proto_Packet, to peers: [Peer]) throws {
        let data = try packet.serializedData()
        
        for peer in peers {
            if try peer.send(data) == false {
                debugPrint("[p2p] failed to send link due to rate limiting")
            }
        }
    }
    
    func subscribedPeers(to channelID: Bytes) -> [Peer] {
        return peers.values.filter({ (peer) -> Bool in
            return peer.subscriptions.contains(channelID)
        })
    }
    
    func peers(byDisplayName displayName: String) -> [Peer] {
        let realIDs = peers.keys.filter { (peer) -> Bool in
            return peer.displayName == displayName
        }
        
        return realIDs.map({ (id) -> Peer? in
            return self.peers[id]
        }).filter({ (peer) -> Bool in
            return peer?.isReady ?? false
        }).map({ (peer) -> Peer in
            return peer!
        })
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
        if peers[peerID] != nil || peerID == localID {
            debugPrint("[p2p] declining invitation from \(peerID.displayName)")
            invitationHandler(false, nil)
            return
        }
        
        if peers.count > PeerToPeer.MAX_PEERS {
            debugPrint("[p2p] declining invitation from \(peerID.displayName) due to max peers limit")
            invitationHandler(false, nil)
            return
        }
        
        debugPrint("[p2p] accepting invitation from \(peerID.displayName)")
        let peer = Peer(context: self.context, localID: localID, remoteID: peerID)
        peer.delegate = self
        peers[peer.remoteID] = peer
        
        invitationHandler(true, peer.session)
    }
    
    // MARK: Browser
    
    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        debugPrint("[p2p] lost peer \(peerID.displayName)")
        self.availablePeers.remove(peerID)
    }
    
    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        debugPrint("[p2p] did not start due to error \(error), retrying...")
        browser.startBrowsingForPeers()
    }
    
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String : String]?) {
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
    
    // MARK: Peer
    
    func peerConnected(_ peer: Peer) {
        self.delegate?.peerToPeer(self, connectedTo: peer)
    }
    
    func peerReady(_ peer: Peer) {
        self.delegate?.peerToPeer(self, peerReady: peer)
    }
    
    func peerDisconnected(_ peer: Peer) {
        debugPrint("[p2p] peer disconnected \(peer.remoteID.displayName)")
        self.peers.removeValue(forKey: peer.remoteID)
        peer.delegate = nil
        
        // Try to reconnect to any other peers
        let timer = Timer(timeInterval: PeerToPeer.RECONNECT_DELAY, repeats: false) { (timer) in
            let connectedPeers = Set<MCPeerID>(self.peers.keys)
            let notConnectedPeers = self.availablePeers.subtracting(connectedPeers)
            
            guard let remoteID = notConnectedPeers.randomElement() else {
                debugPrint("[p2p] no peers to reconnect")
                return
            }
            
            if let peer = self.connect(to: remoteID) {
                debugPrint("[p2p] inviting peer \(remoteID.displayName) into session")
                self.browser.invitePeer(peer.remoteID, to: peer.session, withContext: nil, timeout: 300.0)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
    }
    
    func peer(_ peer: Peer, receivedPacket packet: Proto_Packet) {
        self.delegate?.peerToPeer(self, didReceive: packet, fromPeer: peer)
    }
}
