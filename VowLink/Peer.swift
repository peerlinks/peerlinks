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
}

protocol PeerDelegate : AnyObject {
    func peer(_ peer: Peer, receivedPacket packet: Proto_Packet)
    func peerReady(_ peer: Peer)
    func peerConnected(_ peer: Peer)
    func peerDisconnected(_ peer: Peer)
}

class Peer: NSObject, MCSessionDelegate, RemoteChannel {
    let context: Context
    let session: MCSession
    let remoteID: MCPeerID
    let incoming: RateLimiter
    var outgoing: RateLimiter?
    var hello: Proto_Hello?
    
    var subscriptions = Set<Bytes>()
    var queryResponses = [Bytes:(Channel.QueryResponse) -> Void]()
    
    weak var delegate: PeerDelegate?

    static let PROTOCOL_VERSION: Int32 = 1
    static let RATE_LIMIT: Int32 = 1000
    static let MAX_SUBSCRIPTIONS: Int = 1000
    
    init(context: Context, localID: MCPeerID, remoteID: MCPeerID) {
        self.context = context
        self.remoteID = remoteID
        
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
            try receiveHello(_: data)
            return nil
        }
        
        if !incoming.takeOne() {
            return nil
        }
        
        let packet = try Proto_Packet(serializedData: data)
        
        switch packet.content {
        case .some(.error(let proto)):
            debugPrint("[peer] got remote error \(proto.reason)")
            session.disconnect()
            break
        case .some(.subscribe(let proto)):
            subscribe(to: Bytes(proto.channelID))
            break
        case .some(.queryResponse(let proto)):
            handle(queryResponse: proto)
            break
        
        default:
            return packet
        }
        
        // Internal packets handled above
        return nil
    }
    
    func send(_ data: Data) throws -> Bool {
        if !(outgoing?.takeOne() ?? false) {
            return false
        }

        try session.send(data, toPeers: [ self.remoteID ], with: .reliable)
        return true
    }
    
    func send(subscribeTo channelID: Bytes) throws -> Bool {
        let proto = Proto_Packet.with { (proto) in
            proto.subscribe.channelID = Data(channelID)
        }
        
        let data = try proto.serializedData()
        
        return try send(data)
    }
    
    func send(queryResponse response: Channel.QueryResponse, from channel: Channel) throws -> Bool {
        let proto = Proto_Packet.with { (proto) in
            proto.queryResponse = Proto_QueryResponse.with({ (proto) in
                proto.channelID = Data(channel.channelID)
                proto.messages = response.messages.map({ (message) -> Proto_ChannelMessage in
                    return message.toProto()!
                })

                if let forward = response.forwardCursor {
                    proto.forwardCursor = Data(forward)
                }
                if let backward = response.backwardCursor {
                    proto.backwardCursor = Data(backward)
                }
                if let minHeight = response.minLeafHeight {
                    proto.minLeafHeight = minHeight
                }
            })
        }
        
        let data = try proto.serializedData()
        
        return try send(data)
    }
    
    func destroy(reason: String) {
        let packet = Proto_Packet.with { (packet) in
            packet.error.reason = reason
        }
        if let data = try? packet.serializedData() {
            let _ = try? send(data)
        }
        session.disconnect()
    }
    
    private func receiveHello(_ data: Data) throws {
        let hello = try Proto_Hello(serializedData: data)
        
        if hello.version != Peer.PROTOCOL_VERSION {
            debugPrint("[peer] id=\(remoteID.displayName) got hello \(hello)")
            throw PeerError.invalidVersion(hello.version)
        }
        
        debugPrint("[peer] id=\(remoteID.displayName) got hello \(hello)")
        outgoing = RateLimiter(limit: hello.rateLimit)
        self.hello = hello
        
        delegate?.peerReady(self)
    }
    
    private func sendHello() throws {
        let hello = Proto_Hello.with({ (hello) in
            hello.version = Peer.PROTOCOL_VERSION
            hello.rateLimit = Peer.RATE_LIMIT
        })
        
        let data = try hello.serializedData()
        try session.send(data, toPeers: [ remoteID ], with: .reliable)
    }
    
    private func subscribe(to channelID: Bytes) {
        if channelID.count != Channel.CHANNEL_ID_LENGTH {
            debugPrint("[peer] received invalid channelID length in Subscribe")
            destroy(reason: "Invalid channelID length in Subscribe")
            return
        }
        
        // Distribute subscription through peers
        if subscriptions.count == Peer.MAX_SUBSCRIPTIONS {
            subscriptions.remove(subscriptions.randomElement()!)
        }
        
        debugPrint("[peer] adding subscription to \(channelID)")
        subscriptions.insert(channelID)
    }
    
    private func handle(queryResponse proto: Proto_QueryResponse) {
        let channelID = Bytes(proto.channelID)
        if channelID.count != Channel.CHANNEL_ID_LENGTH {
            destroy(reason: "Invalid channel ID size in query response")
            return
        }
        
        guard let closure = queryResponses[channelID] else {
            debugPrint("[peer] unexpected query response, ignoring")
            return
        }
        
        do {
            let messages = try proto.messages.map { (proto) -> ChannelMessage in
                return try ChannelMessage(context: self.context, proto: proto)
            }
            
            var forwardCursor: Bytes?
            var backwardCursor: Bytes?
            var minLeafHeight: UInt64?
            
            if !proto.forwardCursor.isEmpty {
                forwardCursor = Bytes(proto.forwardCursor)
            }
            if !proto.backwardCursor.isEmpty {
                backwardCursor = Bytes(proto.backwardCursor)
            }
            if proto.minLeafHeight != 0 {
                minLeafHeight = proto.minLeafHeight
            }
            
            queryResponses.removeValue(forKey: channelID)
            
            // NOTE: `closure` has to be invoked there because it interacts with UX
            // TODO(indutny): reconsider doing it here
            DispatchQueue.main.async {
                closure(Channel.QueryResponse(messages: messages,
                                              forwardCursor: forwardCursor,
                                              backwardCursor: backwardCursor,
                                              minLeafHeight: minLeafHeight))
            }
        } catch {
            destroy(reason: "Failed to parse messages due to error \(error)")
        }
    }
    
    // MARK: Session
    
    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        debugPrint("[peer] received from \(peerID.displayName) data \(data)")
        
        do {
            guard let packet = try receivePacket(data: data) else {
                debugPrint("[peer] ignoring internal packet")
                return
            }
            
            debugPrint("[peer] packet \(packet)")
            
            delegate?.peer(self, receivedPacket: packet)
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
            delegate?.peerDisconnected(self)
            return
        case .connected:
            debugPrint("[peer] connected to \(peerID.displayName)")
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
            
            delegate?.peerDisconnected(self)
            return
        }

        delegate?.peerConnected(self)
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
    
    // Mark: RemoteChannel
    
    func query(channelID: Bytes, withCursor cursor: Bytes, limit: Int, andClosure closure: @escaping (Channel.QueryResponse) -> Void) {
        let proto = Proto_Packet.with { (packet) in
            packet.query = Proto_Query.with({ (query) in
                query.channelID = Data(channelID)
                query.cursor = Data(cursor)
                query.limit = UInt32(limit)
            })
        }
        
        do {
            let data = try proto.serializedData()
            let _ = try send(data)
            
            queryResponses[channelID] = closure
        } catch {
            debugPrint("[peer] query error \(error)")
        }
    }
    
    func query(channelID: Bytes, withMinHeight minHeight: UInt64, limit: Int, andClosure closure: @escaping (Channel.QueryResponse) -> Void) {
        let proto = Proto_Packet.with { (packet) in
            packet.query = Proto_Query.with({ (query) in
                query.channelID = Data(channelID)
                query.minHeight = minHeight
                query.limit = UInt32(limit)
            })
        }
        
        do {
            let data = try proto.serializedData()
            let _ = try send(data)

            queryResponses[channelID] = closure
        } catch {
            debugPrint("[peer] query error \(error)")
        }
    }
}
