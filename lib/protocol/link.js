import * as sodium from 'sodium-universal';

import { Link as PLink } from '../messages';
import { now } from '../utils';

const DAY = 24 * 3600;
export const EXPIRATION_DELTA  = 99 * DAY;
export const MAX_DISPLAY_NAME_LENGTH = 128;

export default class Link {
  constructor(options) {
    const {
      expiration,
      trusteePubKey,
      trusteeDisplayName,
      signature,
    } = options;

    if (!trusteeDisplayName) {
      throw new Error('`trusteeDisplayName` is mandatory for the Link');
    }

    if (trusteeDisplayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new Error('Invalid trusteeDisplayName length: ' +
        trusteeDisplayName.length);
    }

    this.expiration = expiration;
    this.trusteePubKey = trusteePubKey;
    this.trusteeDisplayName = trusteeDisplayName;
    this.signature = signature;
  }

  verify(channel, publicKey, timestamp = now()) {
    if (this.expiration < timestamp) {
      return false;
    }

    const tbs = Link.tbs(channel, {
      trusteePubKey: this.trusteePubKey,
      expiration: this.expiration,
      trusteeDisplayName: this.trusteeDisplayName,
    });

    return sodium.crypto_sign_verify_detached(this.signature, tbs, publicKey);
  }

  static tbs(channel, { trusteePubKey, expiration, trusteeDisplayName }) {
    return PLink.TBS.encode({
      trusteePubKey,
      expiration,
      trusteeDisplayName,
      channelId: channel.id,
    }).finish();
  }

  serialize() {
    return {
      tbs: {
        trusteePubKey: this.trusteePubKey,
        trusteeDisplayName: this.trusteeDisplayName,
        expiration: this.expiration,
      },
      signature: this.signature,
    };
  }

  serializeData() {
    return PLink.encode(this.serialize()).finish();
  }

  static deserialize(decoded) {
    return new Link({
      expiration: decoded.tbs.expiration,
      trusteePubKey: decoded.tbs.trusteePubKey,
      trusteeDisplayName: decoded.tbs.trusteeDisplayName,
      signature: decoded.signature,
    });
  }

  static deserializeData(data) {
    return Link.deserialize(PLink.decode(data));
  }
}
