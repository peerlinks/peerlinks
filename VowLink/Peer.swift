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
    var hello: Proto_Hello?
    var isReady: Bool = false
    
    var subscriptions = Set<Bytes>()
    var queryResponses = [Bytes:[(Channel.QueryResponse) -> Void]]()
    var bulkResponses = [Bytes:[(Channel.BulkResponse) -> Void]]()
    
    weak var delegate: PeerDelegate?
    
    static let PROTOCOL_VERSION: UInt32 = 1
    static let MAX_SUBSCRIPTIONS: Int = 1000
    static let MAX_PEER_ID_LENGTH: Int = 64
    
    init(context: Context, localID: MCPeerID, remoteID: MCPeerID) {
        self.context = context
        self.remoteID = remoteID
        
        session = MCSession(peer: localID, securityIdentity: nil, encryptionPreference: .required)
        
        super.init()
        
        session.delegate = self
    }
    
    deinit {
        debugPrint("[peer] \(remoteID.displayName) disconnecting due to deinit")
        session.disconnect()
    }
    
    func receivePacket(data: Data) throws -> Proto_Packet? {
        if hello == nil {
            try receiveHello(_: data)
            return nil
        }
        
        let packet = try Proto_Packet(serializedData: data)
        try packet.validate(context: context)
        
        switch packet.content {
        case .some(.error(let proto)):
            debugPrint("[peer] id=\(remoteID.displayName) got remote error \(proto.reason)")
            session.disconnect()
        case .some(.subscribe(let proto)):
            debugPrint("[peer] id=\(remoteID.displayName) got subscription packet")
            subscribe(to: Bytes(proto.channelID))
        case .some(.queryResponse(let proto)):
            debugPrint("[peer] id=\(remoteID.displayName) got query response packet")
            handle(queryResponse: proto)
        case .some(.bulkResponse(let proto)):
            debugPrint("[peer] id=\(remoteID.displayName) got bulk response packet")
            handle(bulkResponse: proto)

        default:
            return packet
        }
        
        // Internal packets handled above
        return nil
    }
    
    func send(_ data: Data) throws -> Bool {
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
        let abbreviatedMessages = response.abbreviatedMessages.map({ (abbr) -> Proto_QueryResponse.Abbreviated in
            return Proto_QueryResponse.Abbreviated.with({ (proto) in
                proto.hash = Data(abbr.hash)
                proto.parents = abbr.parents.map({ (parent) -> Data in
                    return Data(parent)
                })
            })
        })
        
        let proto = Proto_Packet.with { (proto) in
            proto.queryResponse = Proto_QueryResponse.with({ (proto) in
                proto.channelID = Data(channel.channelID)
                proto.abbreviatedMessages = abbreviatedMessages
                
                if let forward = response.forwardHash {
                    proto.forwardHash = Data(forward)
                }
                if let backward = response.backwardHash {
                    proto.backwardHash = Data(backward)
                }
            })
        }
        
        let data = try proto.serializedData()
        
        return try send(data)
    }
    
    func send(bulkResponse response: Channel.BulkResponse, from channel: Channel) throws -> Bool {
        let proto = Proto_Packet.with { (proto) in
            proto.bulkResponse = Proto_BulkResponse.with({ (proto) in
                proto.channelID = Data(channel.channelID)
                proto.messages = response.messages.map({ (message) -> Proto_ChannelMessage in
                    return message.toProto()!
                })
                proto.forwardIndex = UInt32(response.forwardIndex)
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
        debugPrint("[peer] id=\(remoteID.displayName) destroying due to error: \(reason)")
        session.disconnect()
    }
    
    private func receiveHello(_ data: Data) throws {
        let hello = try Proto_Hello(serializedData: data)
        
        if hello.version != Peer.PROTOCOL_VERSION {
            debugPrint("[peer] id=\(remoteID.displayName) got hello \(hello)")
            return destroy(reason: "Invalid protocol version \(hello.version), expected \(Peer.PROTOCOL_VERSION)")
        }
        
        debugPrint("[peer] id=\(remoteID.displayName) got hello \(hello)")
        self.hello = hello
        
        self.isReady = true
        delegate?.peerReady(self)
    }
    
    private func sendHello() throws {
        let hello = Proto_Hello.with({ (hello) in
            hello.version = Peer.PROTOCOL_VERSION
        })
        
        let data = try hello.serializedData()
        try session.send(data, toPeers: [ remoteID ], with: .reliable)
    }
    
    private func subscribe(to channelID: Bytes) {
        if channelID.count != Channel.CHANNEL_ID_LENGTH {
            debugPrint("[peer] received invalid channelID length in Subscribe")
            return destroy(reason: "Invalid channelID length in Subscribe")
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
            return destroy(reason: "Invalid channel ID size in query response")
        }
        
        guard var closures = queryResponses[channelID] else {
            debugPrint("[peer] unexpected query response, ignoring")
            return
        }
        
        let closure = closures.removeFirst()
        if closures.count == 0 {
            queryResponses.removeValue(forKey: channelID)
        }
        
        let messages = proto.abbreviatedMessages.map { (proto) -> Channel.Abbreviated in
            let parents = proto.parents.map({ (parent) -> Bytes in
                return Bytes(parent)
            })
            let hash = Bytes(proto.hash)
            return Channel.Abbreviated(parents: parents, hash: hash)
        }
        
        var forwardHash: Bytes?
        var backwardHash: Bytes?
        
        if !proto.forwardHash.isEmpty {
            forwardHash = Bytes(proto.forwardHash)
        }
        if !proto.backwardHash.isEmpty {
            backwardHash = Bytes(proto.backwardHash)
        }
        
        // NOTE: `closure` has to be invoked there because it interacts with UX
        // TODO(indutny): reconsider doing it here
        DispatchQueue.main.async {
            closure(Channel.QueryResponse(abbreviatedMessages: messages,
                                          forwardHash: forwardHash,
                                          backwardHash: backwardHash))
        }
    }
    
    private func handle(bulkResponse proto: Proto_BulkResponse) {
        let channelID = Bytes(proto.channelID)
        if channelID.count != Channel.CHANNEL_ID_LENGTH {
            return destroy(reason: "Invalid channel ID size in query response")
        }
        
        guard var closures = bulkResponses[channelID] else {
            debugPrint("[peer] unexpected query response, ignoring")
            return
        }
        
        // TODO(indutny): DRY
        let closure = closures.removeFirst()
        if closures.count == 0 {
            bulkResponses.removeValue(forKey: channelID)
        }
        
        var messages: [ChannelMessage]!
        do {
            messages = try proto.messages.map { (proto) -> ChannelMessage in
                return try ChannelMessage(context: self.context, proto: proto)
            }
        } catch {
            return destroy(reason: "invalid message in bulk response, error \(error)")
        }
        
        // NOTE: `closure` has to be invoked there because it interacts with UX
        // TODO(indutny): reconsider doing it here
        DispatchQueue.main.async {
            closure(Channel.BulkResponse(messages: messages, forwardIndex: Int(proto.forwardIndex)))
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
        } catch {
            debugPrint("[peer] id=\(remoteID.displayName) parsing error \(error)")
            session.disconnect()
        }
    }
    
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        switch state {
        case .connecting:
            debugPrint("[peer] id=\(remoteID.displayName) connecting")
            return
        case .notConnected:
            debugPrint("[peer] id=\(remoteID.displayName) disconnected")
            delegate?.peerDisconnected(self)
            return
        case .connected:
            debugPrint("[peer] id=\(remoteID.displayName) connected")
        default:
            debugPrint("[peer] id=\(remoteID.displayName) unknown state transition")
            return
        }
        
        do {
            try sendHello()
        } catch {
            debugPrint("[peer] id=\(remoteID.displayName) failed to send hello due to error \(error)")
            session.disconnect()
            
            delegate?.peerDisconnected(self)
            return
        }
        
        delegate?.peerConnected(self)
    }
    
    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {
        debugPrint("[peer] id=\(peerID.displayName) received stream, closing immediately")
        stream.close()
    }
    
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {
        debugPrint("[peer] id=\(peerID.displayName) received resource \(resourceName), cancelling")
        progress.cancel()
    }
    
    func session(_ session: MCSession, didReceiveCertificate certificate: [Any]?, fromPeer peerID: MCPeerID, certificateHandler: @escaping (Bool) -> Void) {
        debugPrint("[peer] id=\(peerID.displayName) received certificates \(String(describing: certificate))")
        certificateHandler(true)
    }
    
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {
        debugPrint("[peer] id=\(peerID.displayName) finished receiving resource \(resourceName)")
    }
    
    // Mark: RemoteChannel
    
    func remoteChannel(performQueryFor channelID: Bytes,
                       withCursor cursor: Channel.Cursor,
                       isBackward: Bool,
                       limit: Int,
                       andClosure closure: @escaping (Channel.QueryResponse) -> Void) {
        let proto = Proto_Packet.with { (packet) in
            packet.query = Proto_Query.with({ (query) in
                query.channelID = Data(channelID)
                switch cursor {
                case .hash(let hash):
                    query.hash = Data(hash)
                case .height(let height):
                    query.height = height
                }
                query.isBackward = isBackward
                query.limit = UInt32(limit)
            })
        }
        
        do {
            let data = try proto.serializedData()
            let _ = try send(data)
        } catch {
            debugPrint("[peer] id=\(remoteID.displayName) query error \(error)")
        }
        
        if var list = queryResponses[channelID] {
            list.append(closure)
        } else {
            queryResponses[channelID] = [ closure ]
        }
    }
    
    func remoteChannel(fetchBulkFor channelID: Bytes,
                       withHashes hashes: [Bytes],
                       andClosure closure: @escaping (Channel.BulkResponse) -> Void) {
        let proto = Proto_Packet.with { (packet) in
            packet.bulk = Proto_Bulk.with({ (bulk) in
                bulk.channelID = Data(channelID)
                bulk.hashes = hashes.map({ (hash) -> Data in
                    return Data(hash)
                })
            })
        }
        
        do {
            let data = try proto.serializedData()
            let _ = try send(data)
        } catch {
            debugPrint("[peer] id=\(remoteID.displayName) query error \(error)")
        }
        
        if var list = bulkResponses[channelID] {
            list.append(closure)
        } else {
            bulkResponses[channelID] = [ closure ]
        }
    }
}
