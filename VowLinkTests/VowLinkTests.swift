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
    let context = Context()

    override func setUp() {
        try! context.keychain.removeAll()
    }

    override func tearDown() {
        try! context.keychain.removeAll()
    }

    func testIdentity() {
        let id = try! Identity(context: context, name: "test:identity")
        let trustee = try! Identity(context: context, name: "test:trustee")
        
        let channel = try! Channel(id)
        
        // Save should work
        try! id.save()
        
        let link = try! id.issueLink(for: trustee.publicKey, andChannel: channel)
        
        XCTAssertEqual(link.details?.label, "test:identity")
        XCTAssert(try! link.verify(withPublicKey: id.publicKey, andChannel: channel))
        
        let keyPair = context.sodium.box.keyPair()!
        
        let encrypted = try! link.encrypt(withPublicKey: keyPair.publicKey)
        let decrypted = try! Link(encrypted, withContext: context, publicKey: keyPair.publicKey, andSecretKey: keyPair.secretKey)
        
        XCTAssertEqual(decrypted.details?.label, link.details?.label)
    }
    
    func testVerifyChain() {
        let idA = try! Identity(context: context, name: "test:a")
        let idB = try! Identity(context: context, name: "test:b")
        let idC = try! Identity(context: context, name: "test:c")
        
        let channelA = try! Channel(idA)
        let channelB = try! Channel(idB)
        
        let chain = [
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
        ]
        
        let now = NSDate().timeIntervalSince1970
        let YEAR: TimeInterval = 365 * 24 * 3600
        
        XCTAssertEqual(try! Link.verify(chain: chain, withChannel: channelA, andAgainstTimestamp: now), idC.publicKey)
        XCTAssertEqual(try! Link.verify(chain: chain, withChannel: channelA, andAgainstTimestamp: now + YEAR), nil)
        XCTAssertEqual(try! Link.verify(chain: chain, withChannel: channelB, andAgainstTimestamp: now), nil)
        
        let badChain = [
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
        ]
        XCTAssertEqual(try! Link.verify(chain: badChain, withChannel: channelA, andAgainstTimestamp: now), nil)
        
        let longChain = [
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
            try! idC.issueLink(for: idA.publicKey, andChannel: channelA),
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
            try! idC.issueLink(for: idA.publicKey, andChannel: channelA),
        ]
        XCTAssertEqual(try! Link.verify(chain: longChain, withChannel: channelA, andAgainstTimestamp: now), nil)
    }
    
    func testChannelMessageEncryptDecrypt() {
        let idA = try! Identity(context: context, name: "test:a")
        let idB = try! Identity(context: context, name: "test:b")
        let idC = try! Identity(context: context, name: "test:c")
        let channelA = try! Channel(idA)
        let channelB = try! Channel(idB)
        
        let chain = [
            try! idA.issueLink(for: idB.publicKey, andChannel: channelA),
            try! idB.issueLink(for: idC.publicKey, andChannel: channelA),
        ]
        
        let content = try! idC.signContent(chain: chain,
                                           timestamp: NSDate().timeIntervalSince1970,
                                           json: "{\"hello\":\"world\"}")
        let msg = try! ChannelMessage(context: context,
                                 channelID: channelA.channelID,
                                 content: .decrypted(content),
                                 height: 1,
                                 parents: [ channelA.rootHash ])
        
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
        
        guard case .decrypted(let decryptedContent) = decrypted.content else {
            XCTAssert(false, "Message not decrypted")
            return
        }
        XCTAssertEqual(content.json, decryptedContent.json)
    }
}
