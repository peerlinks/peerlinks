//
//  VowLinkTests.swift
//  VowLinkTests
//
//  Created by Indutnyy, Fedor on 7/29/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import XCTest
import Sodium
@testable import VowLink

class VowLinkTests: XCTestCase {
    let context = Context(service: "com.indutny.vowlink.test")

    override func setUp() {
        try! context.keychain.removeAll()
    }

    override func tearDown() {
        try! context.keychain.removeAll()
    }
    
    func text(in channel: Channel) -> [String] {
        return channel.messages.map({ (message) -> String in
            guard let content = message.decryptedContent else {
                return "<encrypted>"
            }
            
            let authorKey = content.chain.leafKey(withChannel: channel)
            let author = context.sodium.utils.bin2hex(authorKey)!.prefix(6)
            return "\(author): \(content.body.text.text)"
        })
    }

    func testIdentity() {
        let id = try! Identity(context: context, name: "test:identity")
        let trustee = try! Identity(context: context, name: "test:trustee")
        
        let channel = try! Channel(id)
        
        // Save should work
        try! id.save()
        
        let link = try! id.issueLink(for: trustee.publicKey, andChannel: channel)
        XCTAssert(try! link.verify(withPublicKey: id.publicKey, andChannel: channel))
        
        let keyPair = context.sodium.box.keyPair()!

        let chain = try! id.chain(for: channel)!.appendedLink(link)
        let invite = try! chain.encrypt(withPublicKey: Bytes(keyPair.publicKey), andChannel: channel)
        
        let decrypted = try! Chain(invite, withContext: context, publicKey: keyPair.publicKey, andSecretKey: keyPair.secretKey)
        
        XCTAssertEqual(decrypted.channelName, channel.name)
    }
    
    func testVerifyChain() {
        let idA = try! Identity(context: context, name: "test:a")
        let idB = try! Identity(context: context, name: "test:b")
        let idC = try! Identity(context: context, name: "test:c")
        
        let channelA = try! Channel(idA)
        let channelB = try! Channel(idB)
        
        let chain = Chain(context: context, links: [
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
        ])
        
        let now = NSDate().timeIntervalSince1970
        let YEAR: TimeInterval = 365 * 24 * 3600
        
        XCTAssertEqual(try! chain.verify(withChannel: channelA, andAgainstTimestamp: now), idC.publicKey)
        XCTAssertEqual(try! chain.verify(withChannel: channelA, andAgainstTimestamp: now + YEAR), nil)
        XCTAssertEqual(try! chain.verify(withChannel: channelB, andAgainstTimestamp: now), nil)
        
        let badChain = Chain(context: context, links: [
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
        ])
        XCTAssertEqual(try! badChain.verify(withChannel: channelA, andAgainstTimestamp: now), nil)
        
        let longChain = Chain(context: context, links: [
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
            try! idC.issueLink(for: idA.publicKey, andChannel: channelA),
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
            try! idC.issueLink(for: idA.publicKey, andChannel: channelA),
        ])
        XCTAssertEqual(try! longChain.verify(withChannel: channelA, andAgainstTimestamp: now), nil)
    }
    
    func testChannelMessageEncryptDecrypt() {
        let idA = try! Identity(context: context, name: "test:a")
        let idB = try! Identity(context: context, name: "test:b")
        let idC = try! Identity(context: context, name: "test:c")
        let channelA = try! Channel(idA)
        let channelB = try! Channel(idB)
        
        let chain = Chain(context: context, links: [
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
        ])
        
        let content = try! idC.signContent(chain: chain,
                                           timestamp: NSDate().timeIntervalSince1970,
                                           body: Proto_ChannelMessage.Body.with({ (body) in
                                               body.text.text = "okay"
                                           }),
                                           parents: [ channelA.root.hash! ],
                                           height: 1)
        let msg = try! ChannelMessage(context: context,
                                      channelID: channelA.channelID,
                                      content: .decrypted(content),
                                      height: 1,
                                      parents: [ channelA.root.hash! ])
        
        XCTAssert(try! msg.verify(withChannel: channelA))
        XCTAssert(!(try! msg.verify(withChannel: channelB)))
        
        let encrypted = try! msg.encrypted(withChannel: channelA)
        let proto = encrypted.toProto()!
        
        XCTAssert(!(try! encrypted.verify(withChannel: channelA)))
        XCTAssert(!(try! encrypted.verify(withChannel: channelB)))
        
        let copy = try! ChannelMessage(context: context, proto: proto)
        let decrypted = try! copy.decrypted(withChannel: channelA)
        
        XCTAssert(try! decrypted.verify(withChannel: channelA))
        XCTAssert(!(try! decrypted.verify(withChannel: channelB)))
        
        guard let decryptedContent = decrypted.decryptedContent else {
            XCTFail("Message not decrypted")
            return
        }
        XCTAssertEqual(content.body, decryptedContent.body)
        
        let replay = try! ChannelMessage(context: context,
                                      channelID: channelA.channelID,
                                      content: .decrypted(content),
                                      height: 0,
                                      parents: [])
        XCTAssert(!(try! replay.verify(withChannel: channelA)))
    }
    
    func testChannelMessagePostReceive() {
        let idA = try! Identity(context: context, name: "test:a")
        let idB = try! Identity(context: context, name: "test:b")
        
        let channelA = try! Channel(idA)
        let chain = Chain(context: context, links: [
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
        ])
        
        let channelCopy = try! Channel(context: context,
                                       publicKey: channelA.publicKey,
                                       name: channelA.name,
                                       root: channelA.root)
        
        try! idB.addChain(chain, for: channelCopy)
        
        let root = channelA.leafs[0]
        let encryptedRoot = try! root.encrypted(withChannel: channelA)
        XCTAssertEqual(encryptedRoot.hash, channelA.root.hash)
        
        let encrypted = try! channelCopy.post(message: Proto_ChannelMessage.Body.with({ (body) in
            body.text.text = "hello"
        }), by: idB)
        
        let decrypted = try! channelA.receive(encrypted: encrypted)
        
        guard let decryptedContent = decrypted.decryptedContent else {
            XCTFail("Message not decrypted")
            return
        }
        XCTAssertEqual(decryptedContent.body.text.text, "hello")
        
        // Invalid timestamp
        func message(withTimeDelta delta: TimeInterval) -> ChannelMessage {
            let content = try! idA.signContent(chain: Chain(context: context, links: []),
                                               timestamp: NSDate().timeIntervalSince1970 + delta,
                                               body: Proto_ChannelMessage.Body.with({ (body) in
                                                   body.text.text = "time delta"
                                               }),
                                               parents: [ channelA.root.hash! ],
                                               height: 1)
            let decrypted = try! ChannelMessage(context: context,
                                                channelID: channelA.channelID,
                                                content: .decrypted(content),
                                                height: 1,
                                                parents: [ channelA.root.hash! ])
            let encrypted = try! decrypted.encrypted(withChannel: channelA)
            
            return encrypted
        }
        
        let futureEncrypted = message(withTimeDelta: +3600.0)
        
        XCTAssertThrowsError(try channelCopy.receive(encrypted: futureEncrypted)) { (error) in
            switch error {
            case ChannelError.invalidTimestamp(_): break
            default: XCTFail("Expected message with timestamp in the future to fail")
            }
        }
        
        let pastEncrypted = message(withTimeDelta: -3600.0)
        
        XCTAssertThrowsError(try channelCopy.receive(encrypted: pastEncrypted)) { (error) in
            switch error {
            case ChannelError.invalidTimestamp(_): break
            default: XCTFail("Expected message with timestamp in the past to fail")
            }
        }
        
        let invalidRootContent = try! idB.signContent(chain: chain,
                                                      timestamp: NSDate().timeIntervalSince1970,
                                                      body: Proto_ChannelMessage.Body.with({ (body) in
                                                        body.root = Proto_ChannelMessage.Root()
                                                      }),
                                                      parents: [],
                                                      height: 0)
        let decryptedInvalidRoot = try! ChannelMessage(context: context,
                                                       channelID: channelA.channelID,
                                                       content: .decrypted(invalidRootContent),
                                                       height: 0,
                                                       parents: [])
        let encryptedInvalidRoot = try! decryptedInvalidRoot.encrypted(withChannel: channelA)
        
        XCTAssertThrowsError(try channelCopy.receive(encrypted: encryptedInvalidRoot)) { (error) in
            switch error {
            case ChannelError.invalidParentCount: break
            default: XCTFail("Expected alternative root to fail")
            }
        }
    }
    
    func testChannelSync() {
        let idA = try! Identity(context: context, name: "test:a")
        let idB = try! Identity(context: context, name: "test:b")

        enum TestMessage {
            case a(String)
            case b(String)
            case syncAB
            case syncBA
        }
        
        func check(_ messages: [TestMessage]) {
            let channelA = try! Channel(idA)
            let channelB = try! Channel(context: context,
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
                    let _ = try! channelA.post(message: Channel.text(text), by: idA)
                case .b(let text):
                    let _ = try! channelB.post(message: Channel.text(text), by: idB)
                case .syncAB:
                    channelA.sync(with: channelB)
                case .syncBA:
                    channelB.sync(with: channelA)
                }
            }
            
            XCTAssertEqual(text(in: channelA), text(in: channelB))
        }
        
        check([
            .a("hello b"),
            .b("hello a"),
            .a("how are you?"),
            .b("what's up?"),
            .syncAB,
            .syncBA
        ])
        
        check([
            .a("hello b"),
            .b("hello a"),
            .a("how are you?"),
            .syncAB,
            .syncBA
            ])
        
        check([
            .a("hello b"),
            .b("hello a"),
            .b("what's up?"),
            .syncAB,
            .syncBA
            ])
    }
}
