import { Buffer } from 'buffer';

import Chain from './protocol/chain';

/**
 * All timestamp has to be generated through use of this function. All stored
 * and networked timestamps are in seconds and not in milliseconds!
 *
 * @returns {number} Number of seconds since 01-01-1970 00:00:00 UTC
 */
export function now() {
  return Date.now() / 1000;
}

const METRIC_THRESHOLD = 2n ** 255n;

export function compareDistance(a, b) {
  if (a.length !== 32 || b.length !== 32) {
    throw new BanError('Invalid parameter length for `compareDistance`');
  }

  a = BigInt(`0x${a.toString('hex')}`);
  b = BigInt(`0x${b.toString('hex')}`);

  const delta = b - a;
  if (delta === 0n) {
    return 0;
  }

  const absDelta = delta < 0 ? -delta : delta;

  if (delta > 0n) {
    if (absDelta < METRIC_THRESHOLD) {
      return -1;
    } else {
      return 1;
    }
  } else {
    if (absDelta < METRIC_THRESHOLD) {
      return 1;
    } else {
      return -1;
    }
  }
}

export class BanError extends Error {
  constructor(...args) {
    super(...args);

    this.name = 'BanError';
    this.ban = true;
  }
}

const kSecretKey = Symbol('secretKey');

export class EphemeralBox {
  constructor({ sodium }) {
    this.sodium = sodium;

    this.publicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
    this[kSecretKey] = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);

    sodium.crypto_box_keypair(this.publicKey, this[kSecretKey]);
  }

  decrypt(box) {
    if (box.length < this.sodium.crypto_box_SEALBYTES) {
      throw new BanError('Invalid encrypted box length');
    }
    const cleartext = Buffer.alloc(box.length -
      this.sodium.crypto_box_SEALBYTES);

    // TODO(indutny): implement it in `sodium-javascript`
    // https://github.com/sodium-friends/sodium-javascript/pull/16
    const isSuccess = this.sodium.crypto_box_seal_open(
      cleartext, box, this.publicKey, this[kSecretKey]);

    if (!isSuccess) {
      throw new BanError('Invalid encrypted box. Failed to decrypt');
    }

    return cleartext;
  }

  static encryptFor(publicKey, data, options) {
    const { sodium } = options;
    if (!sodium) {
      throw new Error('Missing required `sodium` option');
    }

    if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
      throw new BanError('Invalid public key length');
    }

    // TODO(indutny): implement it in `sodium-javascript`
    // https://github.com/sodium-friends/sodium-javascript/pull/16
    const box = Buffer.alloc(
      data.length + sodium.crypto_box_SEALBYTES);
    sodium.crypto_box_seal(box, data, publicKey);
    return box;
  }
}

export function isSameChainMap(a, b) {
  if (a.size !== b.size) {
    return false;
  }

  for (const [ channel, chains ] of a) {
    // Disjunct channels!
    if (!b.has(channel)) {
      return false;
    }

    // Different chain count
    const otherChains = b.get(channel);
    if (chains.length !== otherChains.length) {
      return false;
    }

    // Both chain lists are ordered
    for (const [ i, chain ] of chains.entries()) {
      if (Chain.compare(chain, otherChains[i]) !== 0) {
        return false;
      }
    }
  }

  return true;
}
