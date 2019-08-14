import * as sodium from 'sodium-universal';
import createDebug from 'debug';

import SocketBase from './socket-base';
import Chain from './protocol/chain';
import Channel from './protocol/channel';
import Identity from './protocol/identity';
import Link from './protocol/link';
import Message from './protocol/message';
import MemoryStorage from './storage/memory';
import Peer from './peer';
import { WaitList } from './utils';

export {
  Chain,
  Channel,
  Identity,
  Link,
  Message,

  // Storage
  MemoryStorage,

  // Networking
  Peer,
  SocketBase,
};

const debug = createDebug('vowlink:protocol');

export default class Protocol {
  /**
   * Instance of the VowLink Protocol. Responsible for managing:
   *
   * 1. List of channels (+ persistence)
   * 2. List of identities (+ persistence)
   * 3. Remote peers (+ sync)
   *
   * @class
   * @param {Object} options - configuration of the Protocol instance. May have
   *     a `.storage` key with an instance of Storage provider to
   *     be used.
   */
  constructor({ storage } = {}) {
    this.storage = storage || new MemoryStorage();

    this.peers = new Set();

    this.id = Buffer.alloc(Peer.ID_LENGTH);
    sodium.randombytes_buf(this.id);

    // See: waitForInvite()
    this.inviteWaitList = new WaitList();

    // See: waitForPeer()
    this.peerWaitList = new WaitList();

    /** @member {Channel[]} in-memory list of channels */
    this.channels = [];

    /** @member {Identity[]} in-memory list of identities */
    this.identities = [];
  }

  //
  // Persistence
  //

  /**
   * First method to be invoked on a Protocol instance. Must be awaited before
   * doing any networking or other API calls.
   *
   * @returns {Promise}
   */
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
      this.identities.push(identity);
      debug('loaded id.name=%s', identity.name);
    }

    this.channels.sort(Channel.compare);
    this.identities.sort(Identity.compare);
  }

  /**
   * Add and save to persistence a new Identity instance.
   *
   * @param {Identity} id - Identity instance to add
   * @returns {Promise}
   */
  async addIdentity(id) {
    if (this.identities.some((existing) => id.name === existing.name)) {
      throw new Error('Duplicate identity');
    }

    this.identities.push(id);
    this.identities.sort(Identity.compare);
    await this.saveIdentity(id);
  }

  /**
   * Add and save to persistence a new Channel instance.
   *
   * @param {Channel} channel - Channel instance to add
   * @returns {Promise}
   */
  async addChannel(channel) {
    this.channels.push(channel);
    this.channels.sort(Channel.compare);
    await this.saveChannel(channel);

    for (const peer of this.peers) {
      peer.onNewChannel(channel);
    }
  }

  /**
   * Save or update instance of Channel in the persistence.
   *
   * @param {Channel} channel - Channel instance to save/update
   * @returns {Promise}
   */
  async saveChannel(channel) {
    debug('saving channel.name=%s', channel.name);
    await this.storage.storeEntity('channel', channel.id.toString('hex'),
      channel);
  }

  /**
   * Save or update instance of Identity in the persistence.
   *
   * @param {Identity} id - Identity instance to save/update
   * @returns {Promise}
   */
  async saveIdentity(id) {
    debug('saving id.name=%s', id.name);
    await this.storage.storeEntity(
      'identity', id.publicKey.toString('hex'), id);
  }

  //
  // Identity
  //

  /**
   * Create new identity and a channel associated to it. Store both in
   * persistence.
   *
   * @param {string} name - Name of identity (and channel)
   * @param {boolean} [createChannel=true] - If true - create a channel
   *   associated to the newly created identity
   * @returns {Promise} A Promise with newly created Identity
   */
  async createIdentity(name, createChannel = true) {
    const identity = new Identity(name);
    await this.addIdentity(identity);

    if (createChannel) {
      const channel = await Channel.create(identity, identity.name, {
        storage: this.storage,
      });
      await this.addChannel(channel);
    }

    debug('created id.name=%', identity.name);
    return identity;
  }

  /**
   * Get identity from the in-memory list.
   * (NOTE: Mostly for testing)
   *
   * @param {string} name - Name of identity
   * @returns {Identity}
   */
  getIdentity(name) {
    return this.identities.find((id) => id.name === name);
  }

  //
  // Channels
  //

  /**
   * Get channel from the in-memory list.
   * (NOTE: Mostly for testing)
   *
   * @param {string} name - Name of identity
   * @returns {Channel}
   */
  getChannel(name) {
    return this.channels.find((channel) => channel.name === name);
  }

  /**
   * Notify connected (and ready) peers about new message on the channel.
   * (NOTE: Mandatory to call in order to synchronize messages.)
   *
   * @param {Channel} channel - A Channel instance where the message was posted
   */
  onNewMessage(channel) {
    for (const peer of this.peers) {
      peer.onNewMessage(channel);
    }
  }

  //
  // Invite
  //

  /**
   * Wait for an Invite from the remote peer.
   *
   * @param {Buffer} requestId - An unique identifier pertaining to issued and
   *     sent request
   * @returns {WaitListEntry} An object with `.promise` property and `.cancel`
   *     method
   */
  waitForInvite(requestId) {
    debug('wait for invite.id=%s', requestId.toString('hex'));
    return this.inviteWaitList.wait(requestId.toString('hex'));
  }

  //
  // Network
  //

  /**
   * Start sending and receiving data from remote connection.
   *
   * @param {SocketBase} socket - Remote connection to be used for the data
   *     transfer
   * @returns {Promise}
   */
  async connect(socket) {
    const peer = new Peer(this.id, socket, {
      channels: this.channels,
      inviteWaitList: this.inviteWaitList,
    });
    try {
      await peer.ready();

      this.peers.add(peer);
      this.peerWaitList.resolve(peer.remoteId.toString('hex'), peer);

      await peer.loop();
    } catch (e) {
      debug('got error: %s', e.stack);
      await peer.destroy(e.message);
    } finally {
      this.peers.delete(peer);
    }
  }

  /**
   * Wait for a Peer with supplied `peerId` to appear and be ready.
   *
   * @param {Buffer} peerId - Peer identifier
   * @returns {WaitListEntry} An object with `.promise` property and `.cancel`
   *     method
   */
  waitForPeer(peerId) {
    for (const existing of this.peers) {
      if (existing.remoteId.equals(peerId)) {
        debug('found existing peer.id=%s', peer.debugId);
        return WaitList.resolve(existing);
      }
    }

    debug('wait for peer.id=%s', peerId.toString('hex').slice(0, 8));
    return this.peerWaitList.wait(peerId.toString('hex'));
  }

  /**
   * Disconnect all peers.
   *
   * @returns {Promise}
   */
  async close() {
    const peers = Array.from(this.peers);
    this.peers.clear();

    return await Promise.all(peers.map(async (peer) => {
      await peer.destroy('Closed');
    }));
  }
}
