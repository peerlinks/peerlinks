import Foundation
import Sodium

enum LinkError : Error {
    case decryptError
}

class Link {
    let context: Context
    let trusteePubKey: Bytes
    let expiration: TimeInterval
    let signature: Bytes
    
    init(context: Context, trusteePubKey: Bytes, expiration: TimeInterval, signature: Bytes) {
        self.context = context
        self.trusteePubKey = trusteePubKey
        self.expiration = expiration
        self.signature = signature
    }
    
    convenience init(context: Context, link: Proto_Link) throws {
        try link.validate(context: context)
        self.init(context: context,
                  trusteePubKey: Bytes(link.tbs.trusteePubKey),
                  expiration: link.tbs.expiration,
                  signature: Bytes(link.signature))
    }

    func verify(withPublicKey publicKey: Bytes, andChannel channel: Channel) throws -> Bool {
        var tbs = toProto().tbs
        tbs.channelID = Data(channel.channelID)
        return context.sodium.sign.verify(message: Bytes(try tbs.serializedData()),
                                          publicKey: publicKey,
                                          signature: self.signature)
    }
    
    func toProto() -> Proto_Link {
        return Proto_Link.with({ (link) in
            link.tbs = Proto_Link.TBS.with({ (tbs) in
                tbs.trusteePubKey = Data(self.trusteePubKey)
                tbs.expiration = self.expiration
            })
            link.signature = Data(self.signature)
        })
    }
}
