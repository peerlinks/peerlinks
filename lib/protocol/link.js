import * as sodium from 'sodium-universal';
import { Link as Proto } from '../messages';

const DAY = 24 * 3600;
export const LINK_EXPIRATION_DELTA = 99 * DAY;

export default class Link {
  constructor({ expiration, trusteePubKey, signature }) {
    this.expiration = expiration;
    this.trusteePubKey = trusteePubKey;
    this.signature = signature;
  }

  verify(channelId, identity) {
    return sodium.crypto_sign_verify_detached(
      this.signature,
      Link.tbs(channelId, {
        trusteePubKey: this.trusteePubKey,
        expiration: this.expiration,
      }),
      identity.publicKey);
  }

  static tbs(channelId, { trusteePubKey, expiration }) {
    return Proto.TBS.encode({
      trusteePubKey: this.trusteePubKey,
      channelId: channelId,
    }).finish();
  }
}
