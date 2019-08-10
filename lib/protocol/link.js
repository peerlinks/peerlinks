import * as sodium from 'sodium-universal';
import { Link as Proto } from '../messages';

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
    return Proto.TBS.encode({
      trusteePubKey: this.trusteePubKey,
      channelId: channel.id,
    }).finish();
  }
}
