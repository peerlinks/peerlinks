import Chain from './protocol/chain';
import Channel from './protocol/channel';
import Identity from './protocol/identity';
import Link from './protocol/Link';
import Message from './protocol/message';
import MemoryStorage from './storage/memory';

export {
  Chain,
  Channel,
  Identity,
  Link,
  Message,

  // Storage
  MemoryStorage,
};

export default class Protocol {
  constructor({ storage } = {}) {
    this.storage = storage || new MemoryStorage();

    this.channels = [];
    this.identities = [];
  }

  async load() {
    const channelIds = await this.storage.getEntityKeys('channel');
    for (const id of channelIds) {
      const channel = await this.storage.retrieveEntity(
        'channel',
        id,
        Channel,
        { storage: this.storage });
      this.channels.push(channel);
    }

    const identityNames = await this.storage.getEntityKeys('identity');
    for (const id of identityNames) {
      const identity = await this.storage.retrieveEntity(
        'identity', id, Identity);
      this.identities.push(id);
    }
  }

  async save() {
    for (const channel of this.channels) {
      await this.storage.storeEntity('channel', channel.id.toString('hex'),
        channel);
    }

    for (const id of this.identities) {
      await this.storage.storeEntity('identity', id.name, id);
    }
  }

  async createIdentity(name) {
    if (this.identities.some((id) => id.name === name)) {
      throw new Error('Duplicate identity');
    }

    const identity = new Identity(name);
    this.identities.push(identity);

    const channel = await Channel.create(identity, identity.name, {
      storage: this.storage,
    });
    this.channels.push(channel);

    return identity;
  }
}
