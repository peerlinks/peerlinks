//
//  Peer.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/29/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation
import MultipeerConnectivity

let ONE_HOUR = 3600.0

class Peer: NSObject {
    var peerID: MCPeerID!
    var rateLimit: Int32!
    var requestsLeft: Int32 = 0
    var replenishTimer: Timer?
    
    init(peerID: MCPeerID, rateLimit: Int32) {
        super.init()
        
        self.peerID = peerID
        self.rateLimit = rateLimit
        requestsLeft = rateLimit
    }
    
    func acceptPacket() -> Bool {
        if requestsLeft == 0 {
            return false
        }
        
        requestsLeft -= 1
        debugPrint("[peer] id=\(peerID.displayName) requests left=\(requestsLeft)")
        
        if replenishTimer == nil {
            replenishTimer = Timer.scheduledTimer(withTimeInterval: ONE_HOUR, repeats: false, block: { _ in
                debugPrint("[peer] id=\(self.peerID.displayName) replenish rate limit")
                self.requestsLeft = self.rateLimit
                self.replenishTimer = nil
            })
        }
        
        return true
    }
}
