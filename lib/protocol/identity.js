import * as sodium from 'sodium-universal';
import { Buffer } from 'buffer';

import Link, { LINK_EXPIRATION_DELTA } from './link';
import Message from './message';

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

  issueLink(channel, { expiration, trusteePubKey }) {
    if (!expiration) {
      expiration = Date.now() + LINK_EXPIRATION_DELTA;
    }

    const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
    const tbs = Link.tbs(channel, {
      trusteePubKey: this.trusteePubKey,
      expiration: this.expiration,
    });
    sodium.crypto_sign_detached(signature, tbs, this[kSecretKey]);

    return new Link({ expiration, trusteePubKey, signature });
  }

  addChain(channel, chain) {
    this.chains.set(channel.id.toString('hex'), chain);
  }

  getChain(channel) {
    return this.chains.get(channel.id.toString('hex'));
  }

  signMessageBody(body, channel, options) {
    const {
      timestamp = Date.now(),
      height,
      parents,
    } = options;

    const chain = this.getChain(channel);
    if (!chain) {
      throw new Error(
        `No chain available for a channel ${channel.id.toString('hex')}`);
    }

    const tbs = Message.tbs({
      chain: chain.serialize(),
      timestamp: timestamp / 1000,
      body,
      parents,
      height,
    });

    const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
    sodium.crypto_sign_detached(signature, tbs, this[kSecretKey]);

    return {
      chain: chain.serialize(),
      timestamp: timestamp / 1000,
      body,
      signature,
    };
  }
}
