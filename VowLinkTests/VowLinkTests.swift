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
        let id = try! Identity(context: context, name: "test-identity")
        let trustee = try! Identity(context: context, name: "trustee")
        
        // Save should work
        try! id.save()
        
        let link = try! id.issueLink(for: trustee.publicKey, displayName: "hello")
        
        XCTAssertEqual(link.displayName, "hello")
        XCTAssert(try! link.verify(withContext: context, publicKey: id.publicKey))
        
        let keyPair = context.sodium.box.keyPair()!
        
        let encrypted = try! link.encrypt(withContext: context, andPubKey: keyPair.publicKey)
        let decrypted = try! Link(encrypted, context: context, withPublicKey: keyPair.publicKey, secretKey: keyPair.secretKey)
        
        XCTAssertEqual(decrypted.displayName, link.displayName)
    }
}
