import Foundation
import Sodium
import KeychainAccess

class Context {
    let sodium = Sodium()
    let keychain: Keychain
    var persistence: PersistenceContext!
    
    init(service: String = "com.indutny.vowlink") throws {
        keychain = Keychain(service: service)
            .synchronizable(true)
        
        persistence = try PersistenceContext(context: self, service: service)
    }
}
