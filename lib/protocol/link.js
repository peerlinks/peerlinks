import { Link as PLink } from '../messages';
import { now } from '../utils';

const DAY = 24 * 3600;
export const EXPIRATION_DELTA  = 99 * DAY;
export const MAX_DISPLAY_NAME_LENGTH = 128;

export default class Link {
  constructor(options) {
    const {
      sodium,
      validFrom,
      validTo,
      trusteePubKey,
      trusteeDisplayName,
      signature,
    } = options;

    if (!sodium) {
      throw new Error('Missing required `sodium` option');
    }

    if (!trusteeDisplayName) {
      throw new Error('`trusteeDisplayName` is mandatory for the Link');
    }

    if (trusteeDisplayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new Error('Invalid trusteeDisplayName length: ' +
        trusteeDisplayName.length);
    }

    this.sodium = sodium;

    this.validFrom = validFrom;
    this.validTo = validTo;
    this.trusteePubKey = trusteePubKey;
    this.trusteeDisplayName = trusteeDisplayName;
    this.signature = signature;
  }

  verify(channel, publicKey, timestamp = now()) {
    if (!this.isValid(timestamp)) {
      return false;
    }

    const tbs = Link.tbs(channel, {
      trusteePubKey: this.trusteePubKey,
      validFrom: this.validFrom,
      validTo: this.validTo,
      trusteeDisplayName: this.trusteeDisplayName,
    });

    const sodium = this.sodium;
    return sodium.crypto_sign_verify_detached(this.signature, tbs, publicKey);
  }

  isValid(timestamp = now()) {
    return this.validFrom <= timestamp && timestamp < this.validTo;
  }

  static tbs(channel, options) {
    const { trusteePubKey, validFrom, validTo, trusteeDisplayName } = options;
    return PLink.TBS.encode({
      trusteePubKey,
      validFrom,
      validTo,
      trusteeDisplayName,
      channelId: channel.id,
    }).finish();
  }

  serialize() {
    return {
      tbs: {
        trusteePubKey: this.trusteePubKey,
        trusteeDisplayName: this.trusteeDisplayName,
        validFrom: this.validFrom,
        validTo: this.validTo,
      },
      signature: this.signature,
    };
  }

  serializeData() {
    return PLink.encode(this.serialize()).finish();
  }

  static deserialize(decoded, options) {
    return new Link({
      sodium: options.sodium,
      validFrom: decoded.tbs.validFrom,
      validTo: decoded.tbs.validTo,
      trusteePubKey: decoded.tbs.trusteePubKey,
      trusteeDisplayName: decoded.tbs.trusteeDisplayName,
      signature: decoded.signature,
    });
  }

  static deserializeData(data, options) {
    return Link.deserialize(PLink.decode(data), options);
  }
}
