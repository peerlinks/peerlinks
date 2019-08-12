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
  constructor({ storage }) {
    this.storage = storage || new MemoryStorage();

    this.channels = [];
  }

  async init() {
    const channelIds = await this.storage.getEntityKeys('channel');
    for (const id of channelIds) {
      await this.storage.retrieveEntity('channel', id, Channel, {
        storage: this.storage,
      });
    }
  }
}
