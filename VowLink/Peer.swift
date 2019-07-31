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
    let context: Context
    let session: MCSession
    let peerID: MCPeerID
    let incoming: RateLimiter
    var outgoing: RateLimiter?
    var hello: Proto_Hello?

    static let PROTOCOL_VERSION: Int32 = 1
    static let RATE_LIMIT: Int32 = 1000
    
    init(context: Context, session: MCSession, peerID: MCPeerID) {
        self.context = context
        self.session = session
        self.peerID = peerID
        incoming = RateLimiter(limit: Peer.RATE_LIMIT)

        super.init()
    }
    
    func receivePacket(data: Data) throws -> Proto_Packet? {
        if hello == nil {
            let hello = try Proto_Hello(serializedData: data)
            
            if hello.version != Peer.PROTOCOL_VERSION {
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
        
        return try Proto_Packet(serializedData: data)
    }
    
    func sendHello() throws {
        let hello = Proto_Hello.with({ (hello) in
            hello.version = Peer.PROTOCOL_VERSION
            hello.rateLimit = Peer.RATE_LIMIT
        })
        
        let data = try hello.serializedData()
        try session.send(data, toPeers: [ peerID ], with: .reliable)
    }
    
    func send(_ data: Data) throws -> Bool {
        if !(outgoing?.takeOne() ?? false) {
            return false
        }

        try session.send(data, toPeers: [ self.peerID ], with: .reliable)
        return true
    }
}
