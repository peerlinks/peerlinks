import * as sodium from 'sodium-universal';
import { Link as PLink } from '../messages';

const DAY = 24 * 3600 * 1000;
export const LINK_EXPIRATION_DELTA = 99 * DAY;

export default class Link {
  constructor({ expiration, trusteePubKey, signature }) {
    this.expiration = expiration;
    this.trusteePubKey = trusteePubKey;
    this.signature = signature;
  }

  verify(channel, publicKey, timestamp = Date.now()) {
    if (this.expiration < timestamp) {
      return false;
    }

    return sodium.crypto_sign_verify_detached(
      this.signature,
      Link.tbs(channel, {
        trusteePubKey: this.trusteePubKey,
        expiration: this.expiration,
      }),
      publicKey);
  }

  static tbs(channel, { trusteePubKey, expiration }) {
    return PLink.TBS.encode({
      trusteePubKey: this.trusteePubKey,
      expiration: this.expiration / 1000,
      channelId: channel.id,
    }).finish();
  }

  serialize() {
    return {
      tbs: {
        trusteePubKey: this.trusteePubKey,
        expiration: this.expiration / 1000,
      },
      signature: this.signature,
    };
  }

  serializeData() {
    return PLink.encode(this.serialize()).finish();
  }

  static deserialize(decoded) {
    return new Link({
      expiration: decoded.tbs.expiration * 1000,
      trusteePubKey: decoded.tbs.trusteePubKey,
      signature: decoded.signature,
    });
  }

  static deserializeData(data) {
    return Link.deserialize(PLink.decode(data));
  }
}
