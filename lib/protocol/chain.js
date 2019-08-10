export const MAX_CHAIN_LENGTH = 3;

export default class Chain {
  constructor(channel, links) {
    this.channel = channel;
    this.links = links;

    if (this.links.length > MAX_CHAIN_LENGTH) {
      throw new Error(`Chain length overflow: ${this.links.length}`);
    }
  }
}
