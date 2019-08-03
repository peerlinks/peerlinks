//
//  Peer.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/29/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import MultipeerConnectivity
import Sodium

enum PeerError: Error {
    case invalidVersion(Int32)
    case invalidNonceLength(Int)
}

protocol PeerDelegate : AnyObject {
    func peer(_ peer: Peer, receivedPacket packet: Proto_Packet)
    func peerConnected(_ peer: Peer)
    func peerDisconnected(_ peer: Peer)
}

class Peer: NSObject, MCSessionDelegate {
    let context: Context
    let session: MCSession
    let remoteID: MCPeerID
    let incoming: RateLimiter
    var outgoing: RateLimiter?
    var hello: Proto_Hello?
    let nonce: Bytes
    
    weak var delegate: PeerDelegate?

    static let PROTOCOL_VERSION: Int32 = 1
    static let RATE_LIMIT: Int32 = 1000
    static let NONCE_LENGTH: Int = 32
    
    init(context: Context, localID: MCPeerID, remoteID: MCPeerID) {
        self.context = context
        self.remoteID = remoteID
        nonce = self.context.sodium.randomBytes.buf(length: Peer.NONCE_LENGTH)!
        
        incoming = RateLimiter(limit: Peer.RATE_LIMIT)
        
        session = MCSession(peer: localID, securityIdentity: nil, encryptionPreference: .required)
        
        super.init()
        
        session.delegate = self
    }
    
    deinit {
        session.disconnect()
    }
    
    func receivePacket(data: Data) throws -> Proto_Packet? {
        if hello == nil {
            let hello = try Proto_Hello(serializedData: data)
            
            if hello.version != Peer.PROTOCOL_VERSION {
                debugPrint("[peer] id=\(remoteID.displayName) got hello \(hello)")
                throw PeerError.invalidVersion(hello.version)
            }
            
            if hello.nonce.count != Peer.NONCE_LENGTH {
                throw PeerError.invalidNonceLength(hello.nonce.count)
            }
            
            debugPrint("[peer] id=\(remoteID.displayName) got hello \(hello)")
            outgoing = RateLimiter(limit: hello.rateLimit)
            self.hello = hello
            return nil
        }
        
        if !incoming.takeOne() {
            return nil
        }
        
        return try Proto_Packet(serializedData: data)
    }
    
    func sendHello() throws {
        let hello = Proto_Hello.with({ (hello) in
            hello.version = Peer.PROTOCOL_VERSION
            hello.rateLimit = Peer.RATE_LIMIT
            hello.nonce = Data(self.nonce)
        })
        
        let data = try hello.serializedData()
        try session.send(data, toPeers: [ remoteID ], with: .reliable)
    }
    
    func send(_ data: Data) throws -> Bool {
        if !(outgoing?.takeOne() ?? false) {
            return false
        }

        try session.send(data, toPeers: [ self.remoteID ], with: .reliable)
        return true
    }
    
    // MARK: Session
    
    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        debugPrint("[peer] received from \(peerID.displayName) data \(data)")
        
        do {
            guard let packet = try receivePacket(data: data) else {
                debugPrint("[peer] reached rate limit or hello packet")
                return
            }
            
            debugPrint("[peer] packet \(packet)")
            
            DispatchQueue.main.async {
                self.delegate?.peer(self, receivedPacket: packet)
            }
        } catch  {
            debugPrint("[peer] parsing error \(error)")
            session.disconnect()
        }
    }
    
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        switch state {
        case .connecting:
            debugPrint("[peer] connecting to \(peerID.displayName)")
            return
        case .notConnected:
            debugPrint("[peer] disconnected from \(peerID.displayName)")
            DispatchQueue.main.async {
                self.delegate?.peerDisconnected(self)
            }
            return
        case .connected:
            debugPrint("[peer] connected to \(peerID.displayName)")
            
            DispatchQueue.main.async {
                self.delegate?.peerConnected(self)
            }
            break
        default:
            debugPrint("[peer] unknown state transition for \(peerID.displayName)")
            return
        }

        do {
            try sendHello()
        } catch {
            debugPrint("[peer] failed to send hello to \(peerID.displayName) due to error \(error)")
            session.disconnect()
            
            DispatchQueue.main.async {
                self.delegate?.peerDisconnected(self)
            }
        }
    }
    
    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {
        debugPrint("[peer] received from \(peerID.displayName) stream, closing immediately")
        stream.close()
    }
    
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {
        debugPrint("[peer] received from \(peerID.displayName) resource \(resourceName), cancelling")
        progress.cancel()
    }
    
    func session(_ session: MCSession, didReceiveCertificate certificate: [Any]?, fromPeer peerID: MCPeerID, certificateHandler: @escaping (Bool) -> Void) {
        debugPrint("[peer] received from \(peerID.displayName) certificates \(String(describing: certificate))")
        certificateHandler(true)
    }
    
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {
        debugPrint("[peer] finished receiving from \(peerID.displayName) resource \(resourceName)")
    }
}
