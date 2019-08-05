import Foundation
import Sodium

enum LinkError : Error {
    case decryptError
    case invalidSignatureSize(Int)
    case invalidChannelIDSize(Int)
    case invalidPublicKeySize(Int)
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
        if link.signature.count != context.sodium.sign.Bytes {
            throw LinkError.invalidSignatureSize(link.signature.count)
        }
        if link.tbs.channelID.count != Channel.CHANNEL_ID_LENGTH {
            throw LinkError.invalidChannelIDSize(link.tbs.channelID.count)
        }
        if link.tbs.trusteePubKey.count != context.sodium.sign.PublicKeyBytes {
            throw LinkError.invalidPublicKeySize(link.tbs.trusteePubKey.count)
        }
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
