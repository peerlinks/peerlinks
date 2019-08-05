import Foundation
import Sodium
import KeychainAccess

class Context {
    let sodium = Sodium()
    let keychain: Keychain
    
    init(service: String = "com.indutny.vowlink") {
        keychain = Keychain(service: service)
            .synchronizable(true)
    }
}
