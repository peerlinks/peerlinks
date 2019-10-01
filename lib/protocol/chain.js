import { Buffer } from 'buffer';

import { now, BanError } from '../utils';

import Link from './link';

export const MAX_LENGTH = 3;

export default class Chain {
  constructor(links) {
    this.links = links;

    if (this.links.length > MAX_LENGTH) {
      throw new BanError(`Chain length overflow: ${this.links.length}`);
    }

    this.length = this.links.length;
  }

  getLeafKey(channel, timestamp = now()) {
    let leafKey = channel.publicKey;
    for (const link of this.links) {
      if (!link.verify(channel, leafKey, timestamp)) {
        return false;
      }

      leafKey = link.trusteePubKey;
    }
    return leafKey;
  }

  getPublicKeys() {
    return this.links.map((link) => link.trusteePubKey);
  }

  getDisplayPath() {
    return this.links.map((link) => link.trusteeDisplayName);
  }

  verify(channel, timestamp = now()) {
    return !!this.getLeafKey(channel, timestamp);
  }

  isValid(timestamp = now()) {
    return this.links.every((link) => link.isValid(timestamp));
  }

  canAppend() {
    return this.links.length < MAX_LENGTH;
  }

  isBetterThan(other) {
    if (other.links.length === 0) {
      return false;
    }

    // Root chain should not be replaced
    if (this.links.length === 0) {
      return true;
    }

    // TODO(indutny): heuristic comparison of lengths and expirations?
    return false;
  }

  serialize() {
    return this.links.map((link) => {
      return link.serialize();
    });
  }

  static append(chain, link) {
    return new Chain(chain.links.concat([ link ]));
  }

  static deserialize(list, options) {
    return new Chain(list.map((decoded) => {
      return Link.deserialize(decoded, options);
    }));
  }

  static compare(a, b) {
    if (a.length === 0 && b.length === 0) {
      return 0;
    } else if (a.length !== b.length) {
      return (a.length - b.length < 0) ? -1 : 1;
    }

    // Both chains have non-zero length
    const linkA = a.links[a.links.length - 1];
    const linkB = b.links[b.links.length - 1];

    return Buffer.compare(linkA.trusteePubKey, linkB.trusteePubKey);
  }
}

// Convenience
Chain.MAX_LENGTH = MAX_LENGTH
