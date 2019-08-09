import XCTest
import Sodium
@testable import VowLink

extension VowLinkTests {
    private enum SyncMessage {
        case a(String)
        case b(String)
        case syncAB
        case syncBA
    }
    
    private func check(_ messages: [SyncMessage]) {
        let idA = try! Identity(context: context, name: "test:a")
        let idB = try! Identity(context: context2, name: "test:b")
        
        try! context.persistence.removeAll()
        try! context2.persistence.removeAll()
        
        let channelA = try! Channel(idA)
        let channelB = try! Channel(context: context2,
                                    publicKey: channelA.publicKey,
                                    name: channelA.name,
                                    root: channelA.root)
        
        let chain = Chain(context: context, links: [
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
            ])
        
        try! idB.addChain(chain, for: channelB)
        
        for message in messages {
            switch message {
            case .a(let text):
                try! channelA.post(message: Channel.text(text), by: idA)
            case .b(let text):
                try! channelB.post(message: Channel.text(text), by: idB)
            case .syncAB:
                channelA.sync(with: channelB)
            case .syncBA:
                channelB.sync(with: channelA)
            }
        }
        
        XCTAssertEqual(text(in: channelA), text(in: channelB))
    }
    
    func testChannelSyncTwoInATwoInB() {
        check([
            .a("hello b"),
            .b("hello a"),
            .a("how are you?"),
            .b("what's up?"),
            .syncAB,
            .syncBA
            ])
    }
    
    func testChannelSyncTwoInAOneInB() {
        check([
            .a("hello b"),
            .b("hello a"),
            .a("how are you?"),
            .syncAB,
            .syncBA
            ])
    }
    
    func testChannelSyncOneInATwoInB() {
        check([
            .a("hello b"),
            .b("hello a"),
            .b("what's up?"),
            .syncAB,
            .syncBA
            ])
    }
    
    func testChannelSyncTwoInANoneInB() {
        check([
            .a("hello b"),
            .a("how are you?"),
            .syncAB,
            .syncBA
            ])
    }
    
    func testChannelSyncNoneInATwoInB() {
        check([
            .b("hello a"),
            .b("what's up?"),
            .syncAB,
            .syncBA
            ])
    }
    
    func testChannelSyncMergeAndPost() {
        check([
            .a("hello b"),
            .b("hello a"),
            .b("what's up?"),
            .syncAB,
            
            .b("where are you?"),
            .a("all is good!"),
            
            .syncAB,
            .syncBA
            ])
    }
}
