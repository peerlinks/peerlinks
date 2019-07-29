//
//  Peer.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/29/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import MultipeerConnectivity

class Peer: NSObject {
    var peerID: MCPeerID!
    var incoming: RateLimiter!
    var outgoing: RateLimiter?
    var hello: Hello?
    
    init(peerID: MCPeerID, rateLimit: Int32) {
        super.init()
        
        self.peerID = peerID
        incoming = RateLimiter(limit: rateLimit)
    }
    
    func receivePacket(data: Data) throws -> Packet? {
        if hello == nil {
            hello = try Hello(serializedData: data)
            
            debugPrint("[peer] id=\(peerID.displayName) got hello \(hello!)")
            outgoing = RateLimiter(limit: hello!.rateLimit)
            return nil
        }
        
        if !incoming.takeOne() {
            return nil
        }
        
        return try Packet(serializedData: data)
    }
    
    func sendPacket(data: Data) -> Bool {
        return outgoing?.takeOne() ?? false
    }
}
