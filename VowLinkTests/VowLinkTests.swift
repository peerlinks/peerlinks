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
        // Put setup code here. This method is called before the invocation of each test method in the class.
    }

    override func tearDown() {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    func testIdentity() {
        let id = try! Identity(context: context, name: "test:identity")
        let trustee = try! Identity(context: context, name: "test:trustee")
        
        let channel = Channel(id)
        
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
        
        let channelA = Channel(idA)
        let channelB = Channel(idB)
        
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
}
