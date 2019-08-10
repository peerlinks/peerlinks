import * as sodium from 'sodium-universal';
import { Buffer } from 'buffer';

import Link, { LINK_EXPIRATION_DELTA } from './link';

// The property is ours
const kSecretKey = Symbol('secretKey');

export default class Identity {
  constructor(name, { publicKey, secretKey } = {}) {
    this.name = name;
    this.publicKey = publicKey;
    this[kSecretKey] = secretKey;
    if (!this.publicKey || !this[kSecretKey]) {
      this.publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
      this[kSecretKey] = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
      sodium.crypto_sign_keypair(this.publicKey, this[kSecretKey]);
    }

    // Channel => Chain
    this.chains = new Map();
  }

  issueLink({ channelId, expiration, trusteePubKey }) {
    if (!expiration) {
      expiration = Date.now() / 1000 + LINK_EXPIRATION_DELTA;
    }

    const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
    const tbs = Link.tbs(channelId, {
      trusteePubKey: this.trusteePubKey,
      expiration: this.expiration,
    });
    sodium.crypto_sign_detached(signature, tbs, this[kSecretKey]);

    return new Link({ expiration, trusteePubKey, signature });
  }
}
