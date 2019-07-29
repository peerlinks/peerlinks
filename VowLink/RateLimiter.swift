//
//  RateLimiter.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/29/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import Foundation

class RateLimiter {
    var replenishTimer: Timer?
    var limit: Int32!
    var left: Int32 = 0
    
    static let DEFAULT_TIMEOUT = 3600.0
    
    init(limit: Int32) {
        self.limit = limit
    }
    
    func takeOne() -> Bool {
        if limit == 0 {
            return false
        }
        
        limit -= 1
        
        if replenishTimer == nil {
            replenishTimer = Timer.scheduledTimer(withTimeInterval: RateLimiter.DEFAULT_TIMEOUT, repeats: false, block: { _ in
                self.left = self.limit
                self.replenishTimer = nil
            })
        }
        
        return true
    }
}
