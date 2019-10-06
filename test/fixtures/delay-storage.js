import { MemoryStorage } from '../..';

export const MAX_DELAY = 5;
export const MIN_DELAY = 2;

export default class DelayStorage extends MemoryStorage {
  constructor(options = {}) {
    super();

    this.options = {
      minDelay: MIN_DELAY,
      maxDelay: MAX_DELAY,

      ...options,
    };
  }

  delay() {
    const value = this.options.minDelay +
      Math.random() * (this.options.maxDelay - this.options.minDelay);

    return new Promise((resolve) => {
      setTimeout(resolve, value);
    });
  }

  async addMessage(...args) {
    await this.delay();
    return super.addMessage(...args);
  }

  async getMessageCount(...args) {
    await this.delay();
    return super.getMessageCount(...args);
  }

  async getLeafHashes(...args) {
    await this.delay();
    return super.getLeafHashes(...args);
  }

  async hasMessage(...args) {
    await this.delay();
    return super.hasMessage(...args);
  }

  async getMessage(...args) {
    await this.delay();
    return super.getMessage(...args);
  }

  async getMessages(...args) {
    await this.delay();
    return super.getMessages(...args);
  }

  async getHashesAtOffset(...args) {
    await this.delay();
    return super.getHashesAtOffset(...args);
  }

  async getReverseHashesAtOffset(...args) {
    await this.delay();
    return super.getReverseHashesAtOffset(...args);
  }

  async query(...args) {
    await this.delay();
    return super.query(...args);
  }

  async removeChannelMessages(...args) {
    await this.delay();
    return super.removeChannelMessages(...args);
  }

  //
  // Entities (Identity, ChannelList, so on)
  //

  async storeEntity(...args) {
    await this.delay();
    return super.storeEntity(...args);
  }

  async retrieveEntity(...args) {
    await this.delay();
    return super.retrieveEntity(...args);
  }

  async removeEntity(...args) {
    await this.delay();
    return super.removeEntity(...args);
  }

  async getEntityKeys(...args) {
    await this.delay();
    return super.getEntityKeys(...args);
  }

  async clear() {
    await this.delay();
    return super.clear();
  }
}
