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
    let context = try! Context(service: "com.indutny.vowlink.test")
    let context2 = try! Context(service: "com.indutny.vowlink.test-copy")

    override func setUp() {
        try! context.keychain.removeAll()
        try! context.persistence.removeAll()
        try! context2.keychain.removeAll()
        try! context2.persistence.removeAll()
    }

    override func tearDown() {
        try! context.keychain.removeAll()
        try! context.persistence.removeAll()
        try! context2.keychain.removeAll()
        try! context2.persistence.removeAll()
    }
    
    func text(in channel: Channel) -> [String] {
        var result = [String]()
        for i in 0..<channel.messageCount {
            let message = try! channel.message(atOffset: i)!
            let content = message.decryptedContent!
            
            let authorKey = content.chain.leafKey(withChannel: channel)
            let author = context.sodium.utils.bin2hex(authorKey)!.prefix(6)
            result.append("\(author): \(content.body.text.text)")
        }
        return result
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
        let idB = try! Identity(context: context2, name: "test:b")
        
        let channelA = try! Channel(idA)
        let chain = Chain(context: context, links: [
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
        ])
        
        let channelCopy = try! Channel(context: context2,
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
        let idB = try! Identity(context: context2, name: "test:b")

        enum TestMessage {
            case a(String)
            case b(String)
            case syncAB
            case syncBA
        }
        
        func check(_ messages: [TestMessage], message: String) {
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
            
            XCTAssertEqual(text(in: channelA), text(in: channelB), message)
        }
        
        check([
            .a("hello b"),
            .b("hello a"),
            .a("how are you?"),
            .b("what's up?"),
            .syncAB,
            .syncBA
            ], message: "2 in a, 2 in b")

        check([
            .a("hello b"),
            .b("hello a"),
            .a("how are you?"),
            .syncAB,
            .syncBA
            ], message: "2 in a, 1 in b")
        
        check([
            .a("hello b"),
            .b("hello a"),
            .b("what's up?"),
            .syncAB,
            .syncBA
            ], message: "1 in a, 2 in b")
    }
    
    func testContextPersistenceMessages() {
        let idA = try! Identity(context: context, name: "test:a")
        let channelA = try! Channel(idA)
        
        let messages = [
            try! channelA.post(message: Channel.text("1"), by: idA),
            try! channelA.post(message: Channel.text("2"), by: idA),
            try! channelA.post(message: Channel.text("3"), by: idA),
            try! channelA.post(message: Channel.text("4"), by: idA)
        ]
        
        // Clean-up
        try! context.persistence.removeAll()
        
        for message in messages {
            try! context.persistence.append(encryptedMessage: message, toChannelID: channelA.channelID)
        }
        
        // Start with height=0 query
        let first = try! context.persistence.messages(startingFrom: .height(0),
                                                      isBackward: false,
                                                      channelID: channelA.channelID,
                                                      andLimit: 2)
        XCTAssertEqual(first.messages.count, 2)
        XCTAssertEqual(first.messages[0].displayHash!, messages[0].displayHash!)
        XCTAssertEqual(first.messages[1].displayHash!, messages[1].displayHash!)
        
        XCTAssertEqual(first.backwardHash, messages[0].hash!)
        XCTAssertEqual(first.forwardHash, messages[2].hash!)
        
        // Continue query forward
        let next = try! context.persistence.messages(startingFrom: .hash(first.forwardHash!),
                                                     isBackward: false,
                                                     channelID: channelA.channelID,
                                                     andLimit: 2)
        XCTAssertEqual(next.messages.count, 2)
        XCTAssertEqual(next.messages[0].displayHash!, messages[2].displayHash!)
        XCTAssertEqual(next.messages[1].displayHash!, messages[3].displayHash!)
        
        XCTAssertEqual(next.backwardHash, messages[2].hash!)
        XCTAssertEqual(next.forwardHash, nil)
        
        // Step backward with hash cursor
        let first2 = try! context.persistence.messages(startingFrom: .hash(next.backwardHash!),
                                                       isBackward: true,
                                                       channelID: channelA.channelID,
                                                       andLimit: 2)
        XCTAssertEqual(first2.messages.count, 2)
        XCTAssertEqual(first2.messages[0].displayHash!, messages[0].displayHash!)
        XCTAssertEqual(first2.messages[1].displayHash!, messages[1].displayHash!)
        
        XCTAssertEqual(first2.backwardHash, messages[0].hash!)
        XCTAssertEqual(first2.forwardHash, messages[2].hash!)
        
        // Further backward step should return zero messages
        let empty = try! context.persistence.messages(startingFrom: .hash(first2.backwardHash!),
                                                      isBackward: true,
                                                      channelID: channelA.channelID,
                                                      andLimit: 2)
        XCTAssertEqual(empty.messages.count, 0)
        XCTAssertEqual(empty.backwardHash, nil)
        XCTAssertEqual(empty.forwardHash, first2.backwardHash)
    }
    
    func testContextPersistenceLeafs() {
        let idA = try! Identity(context: context, name: "test:a")
        let channelA = try! Channel(idA)
        
        let fakeLeafs = [
            try! channelA.post(message: Channel.text("1"), by: idA),
            try! channelA.post(message: Channel.text("2"), by: idA),
            try! channelA.post(message: Channel.text("3"), by: idA)
        ]
        
        let main = try! channelA.post(message: Channel.text("4"), by: idA)
        
        try! context.persistence.removeAll()
        
        for leaf in fakeLeafs {
            try! context.persistence.append(encryptedMessage: leaf, toChannelID: channelA.channelID)
        }
        
        let fakeLeafHashes = fakeLeafs.map({ (leaf) -> Bytes in
            return leaf.hash!
        })
        try! context.persistence.append(encryptedMessage: main,
                                        toChannelID: channelA.channelID,
                                        withNewLeafs: fakeLeafHashes)
        
        let leafs = try! context.persistence.leafs(forChannelID: channelA.channelID)
        XCTAssertEqual(leafs.count, fakeLeafs.count)
    }
}
