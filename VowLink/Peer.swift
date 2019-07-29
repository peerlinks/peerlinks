//
//  Peer.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/29/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import MultipeerConnectivity

enum PeerError: Error {
    case invalidVersion(Int32)
}

class Peer: NSObject {
    var session: MCSession!
    var peerID: MCPeerID!
    var incoming: RateLimiter!
    var outgoing: RateLimiter?
    var hello: Hello?
    
    init(session: MCSession, peerID: MCPeerID, rateLimit: Int32) {
        super.init()
        
        self.session = session
        self.peerID = peerID
        incoming = RateLimiter(limit: rateLimit)
    }
    
    func receivePacket(data: Data) throws -> Packet? {
        if hello == nil {
            let hello = try Hello(serializedData: data)
            
            if hello.version != PeerToPeer.PROTOCOL_VERSION {
                debugPrint("[peer] id=\(peerID.displayName) got hello \(hello)")
                throw PeerError.invalidVersion(hello.version)
            }
            
            debugPrint("[peer] id=\(peerID.displayName) got hello \(hello)")
            outgoing = RateLimiter(limit: hello.rateLimit)
            self.hello = hello
            return nil
        }
        
        if !incoming.takeOne() {
            return nil
        }
        
        return try Packet(serializedData: data)
    }
    
    func sendPacket(data: Data) throws -> Bool {
        if !(outgoing?.takeOne() ?? false) {
            return false
        }

        try session.send(data, toPeers: [ self.peerID ], with: .reliable)
        return true
    }
}
