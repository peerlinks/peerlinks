import Chain from './protocol/chain';
import Channel from './protocol/channel';
import Identity from './protocol/identity';
import Link from './protocol/Link';
import Message from './protocol/message';
import MemoryStorage from './storage/memory';
import Peer from './peer';

import createDebug from 'debug';

export {
  Chain,
  Channel,
  Identity,
  Link,
  Message,

  // Storage
  MemoryStorage,
};

const debug = createDebug('vowlink:protocol');

export default class Protocol {
  constructor({ storage } = {}) {
    this.storage = storage || new MemoryStorage();

    this.channels = [];
    this.identities = [];
    this.peers = new Set();
  }

  //
  // Persistence
  //

  async load() {
    const channelIds = await this.storage.getEntityKeys('channel');
    for (const id of channelIds) {
      const channel = await this.storage.retrieveEntity(
        'channel',
        id,
        Channel,
        { storage: this.storage });
      this.channels.push(channel);
      debug('loaded channel.name=%s', channel.name);
    }

    const identityNames = await this.storage.getEntityKeys('identity');
    for (const id of identityNames) {
      const identity = await this.storage.retrieveEntity(
        'identity', id, Identity);
      this.identities.push(id);
      debug('loaded id.name=%s', id.name);
    }
  }

  // TODO(indutny): save only changed entities
  async save() {
    for (const channel of this.channels) {
      await this.storage.storeEntity('channel', channel.id.toString('hex'),
        channel);
      debug('saving channel.name=%s', channel.name);
    }

    for (const id of this.identities) {
      await this.storage.storeEntity(
        'identity', id.publicKey.toString('hex'), id);
      debug('saving id.name=%s', id.name);
    }
  }

  //
  // Identity
  //

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

    await this.save();

    debug('created id.name=%', identity.name);
    return identity;
  }

  //
  // Network
  //

  async connect(socket) {
    const peer = new Peer(socket);
    this.peers.add(peer);
    try {
      await peer.start();

      for (const channel of this.channels) {
        await peer.subscribe(channel);
      }

      await peer.loop();
    } catch (e) {
      debug('peer.id=%s error.message=%s', peer.id, e.message);

      await peer.destroy(e.message);
    } finally {
      this.peers.delete(peer);
    }
  }
}
