export const MAX_LENGTH = 3;

export default class Chain {
  constructor(channel, links) {
    this.channel = channel;
    this.links = links;

    if (this.links.length > MAX_LENGTH) {
      throw new Error(`Chain length overflow: ${this.links.length}`);
    }
  }

  getLeafKey(channel, timestamp) {
    let leafKey = channel.publicKey;
    for (const link in links) {
      if (!link.verify(channel, leafKey, timestamp)) {
        return false;
      }

      leafKey = link.trusteePubKey;
    }
    return leafKey;
  }

  verify(channel, timestamp) {
    return !!getLeafKey(channel);
  }
}

// Convenience
Chain.MAX_LENGTH = MAX_LENGTH
