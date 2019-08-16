import * as sodium from 'sodium-universal';
import { Buffer } from 'buffer';
import WaitList from 'promise-waitlist';
import createDebug from 'debug';

import SocketBase from './socket-base';
import StreamSocket from './stream-socket';
import Chain from './protocol/chain';
import Channel from './protocol/channel';
import Identity from './protocol/identity';
import Link from './protocol/link';
import Message from './protocol/message';
import StorageCache from './protocol/cache';
import MemoryStorage from './storage/memory';
import Peer from './peer';

export {
  Chain,
  Channel,
  Identity,
  Link,
  Message,
  StorageCache,

  // Storage
  MemoryStorage,

  // Networking
  Peer,
  SocketBase,
  StreamSocket,
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
  constructor({ storage, password } = {}) {
    this.storage = storage || new MemoryStorage();

    this.peers = new Set();

    this.id = Buffer.alloc(Peer.ID_LENGTH);
    sodium.randombytes_buf(this.id);
    this.debugId = this.id.toString('hex').slice(0, 8);

    // See: waitForInvite()
    this.inviteWaitList = new WaitList();

    // See: waitForPeer()
    this.peerWaitList = new WaitList();

    /** @member {Channel[]} in-memory list of channels */
    this.channels = [];

    /** @member {Identity[]} in-memory list of identities */
    this.identities = [];

    // Channel = > WaitListEntry
    this.channelWaiters = new Map();

    this.encryptionKey = null;
    if (password) {
      this.debug('generating encryption key...');
      const salt = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES);
      sodium.crypto_generichash(salt, Buffer.from('vowlink-persistence'));

      this.encryptionKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
      sodium.crypto_pwhash(
        this.encryptionKey,
        Buffer.from(password),
        salt,
        sodium.crypto_pwhash_OPSLIMIT_SENSITIVE,
        sodium.crypto_pwhash_MEMLIMIT_SENSITIVE,
        sodium.crypto_pwhash_ALG_DEFAULT);

      this.debug('generated encryption key');
    }

    this.debug('created');
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
      const serialized = await this.storage.retrieveEntity('channel', id);
      const decrypted = this.decryptData(serialized);
      const channel = await Channel.deserializeData(decrypted, {
        storage: this.storage,
      });
      this.addChannel(channel, false);
      this.debug('loaded channel.name=%s', channel.name);
    }

    const identityNames = await this.storage.getEntityKeys('identity');
    for (const id of identityNames) {
      const serialized = await this.storage.retrieveEntity('identity', id);
      const decrypted = this.decryptData(serialized);
      const identity = Identity.deserializeData(decrypted);
      this.identities.push(identity);
      this.debug('loaded id.name=%s', identity.name);
    }

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
  async addChannel(channel, save = true) {
    this.debug('adding channel.id=%s', channel.debugId);

    this.channels.push(channel);
    this.channels.sort(Channel.compare);

    if (save) {
      await this.saveChannel(channel);
    }

    for (const peer of this.peers) {
      peer.onNewChannel(channel);
    }

    const waitLoop = () => {
      // Prevent duplicates
      if (this.channelWaiters.has(channel)) {
        return;
      }

      const waiter = channel.waitForOutgoingMessage();
      this.channelWaiters.set(channel, waiter);

      waiter.promise.then(() => {
        this.onNewMessage(channel);

        this.channelWaiters.delete(channel);
        waitLoop();
      }).catch(() => {
        this.debug('unexpected waiter promise error');
      });
    };
    waitLoop();
  }

  async removeChannel(channel) {
    this.debug('removing channel.id=%s', channel.debugId);

    const index = this.channels.indexOf(channel);
    if (index === -1) {
      return;
    }
    this.channels.splice(index, 1);

    if (this.channelWaiters.has(channel)) {
      const waiter = this.channelWaiters.get(channel);
      this.channelWaiters.delete(channel);
      waiter.cancel();
    }

    await this.storage.removeEntity('channel', channel.id.toString('hex'));
  }

  /**
   * Save or update instance of Channel in the persistence.
   *
   * @param {Channel} channel - Channel instance to save/update
   * @returns {Promise}
   */
  async saveChannel(channel) {
    this.debug('saving channel.name=%s', channel.name);
    await this.storage.storeEntity('channel', channel.id.toString('hex'),
      this.encryptData(channel.serializeData()));
  }

  /**
   * Save or update instance of Identity in the persistence.
   *
   * @param {Identity} id - Identity instance to save/update
   * @returns {Promise}
   */
  async saveIdentity(id) {
    this.debug('saving id.name=%s', id.name);
    await this.storage.storeEntity(
      'identity', id.publicKey.toString('hex'),
      this.encryptData(id.serializeData()));
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

    this.debug('created id.name=%s', identity.name);
    return identity;
  }

  /**
   * Get identity from the in-memory list.
   *
   * @param {string} name - Name of identity
   * @returns {Identity}
   */
  getIdentity(name) {
    return this.identities.find((id) => id.name === name);
  }

  /**
   * Get names of in-memory identities.
   *
   * @returns {string[]}
   */
  getIdentityNames() {
    return this.identities.map((id) => id.name);
  }

  //
  // Channels
  //

  /**
   * Get channel from the in-memory list.
   *
   * @param {string} name - Name of identity
   * @returns {Channel}
   */
  getChannel(name) {
    return this.channels.find((channel) => channel.name === name);
  }

  /**
   * Get names of in-memory identities.
   *
   * @returns {string[]}
   */
  getChannelNames() {
    return this.channels.map((channel) => channel.name);
  }

  async channelFromInvite(invite, identity, options) {
    options = Object.assign({}, options, { storage: this.storage });
    return await Channel.fromInvite(invite, identity, options);
  }

  /**
   * Notify connected (and ready) peers about new message on the channel.
   * (NOTE: Mandatory to call in order to synchronize messages.)
   *
   * @param {Channel} channel - A Channel instance where the message was posted
   */
  onNewMessage(channel) {
    this.debug('broadcasting new message on channel.id=%s', channel.debugId);
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
   * @param {Number} [timeout] - Optional timeout value in milliseconds
   * @returns {WaitListEntry} An object with `.promise` property and `.cancel`
   *     method
   */
  waitForInvite(requestId, timeout) {
    this.debug('wait for invite.id=%s', requestId.toString('hex'));
    return this.inviteWaitList.waitFor(requestId.toString('hex'), timeout);
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
    this.debug('connecting through socket');
    const peer = new Peer(this.id, socket, {
      channels: this.channels,
      inviteWaitList: this.inviteWaitList,
    });

    let reconnect = true;

    try {
      await peer.ready();

      let isDuplicate = false;

      // Self-connect
      if (this.id.equals(peer.remoteId)) {
        isDuplicate = true;
      }

      for (const existing of this.peers) {
        if (existing.remoteId.equals(peer.remoteId)) {
          isDuplicate = true;
        }
      }

      if (isDuplicate) {
        this.debug('duplicate peer.id=%s', peer.debugId);
        reconnect = false;
        throw new Error('Duplicate peer');
      }

      this.debug('new peer.id=%s', peer.debugId);
      this.peers.add(peer);
      this.peerWaitList.resolve(peer.remoteId.toString('hex'), peer);

      await peer.loop();
    } catch (e) {
      this.debug('got error: %s', e.stack);
      await peer.destroy(e.message);
    } finally {
      this.peers.delete(peer);
    }
    return reconnect;
  }

  /**
   * Wait for a Peer with supplied `peerId` to appear and be ready.
   *
   * @param {Buffer} peerId - Peer identifier
   * @param {Number} [timeout] - Optional timeout value in milliseconds
   * @returns {WaitListEntry} An object with `.promise` property and `.cancel`
   *     method
   */
  waitForPeer(peerId, timeout) {
    for (const existing of this.peers) {
      if (existing.remoteId.equals(peerId)) {
        this.debug('found existing peer.id=%s', existing.debugId);
        return WaitList.resolve(existing);
      }
    }

    this.debug('wait for peer.id=%s', peerId.toString('hex').slice(0, 8));
    return this.peerWaitList.waitFor(peerId.toString('hex'), timeout);
  }

  /**
   * Disconnect all peers. Zero private keys in identities.
   *
   * @returns {Promise}
   */
  async close() {
    const peers = Array.from(this.peers);
    this.peers.clear();

    try {
      await Promise.all(peers.map(async (peer) => {
        await peer.destroy('Closed');
      }));
    } finally {
      // Zero private keys in all identities
      for (const id of this.identities) {
        id.clear();
      }
    }
  }

  /** **(Internal)** */
  debug(fmt, ...args) {
    debug('[%s] ' + fmt, ...[ this.debugId ].concat(args));
  }

  encryptData(data) {
    if (!this.encryptionKey) {
      return data;
    }

    const result = Buffer.alloc(
      sodium.crypto_secretbox_NONCEBYTES +
      data.length +
      sodium.crypto_secretbox_MACBYTES);
    const nonce = result.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = result.slice(nonce.length);

    sodium.randombytes_buf(nonce);
    sodium.crypto_secretbox_easy(ciphertext, data, nonce,
      this.encryptionKey);

    return result;
  }

  decryptData(encrypted) {
    if (!this.encryptionKey) {
      return encrypted;
    }

    const nonce = encrypted.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = encrypted.slice(nonce.length);
    const cleartext = Buffer.alloc(ciphertext.length -
      sodium.crypto_secretbox_MACBYTES);
    const success = sodium.crypto_secretbox_open_easy(
      cleartext,
      ciphertext,
      nonce,
      this.encryptionKey);

    if (!success) {
      throw new Error('Failed to decrypt persistence blob');
    }
    return cleartext;
  }
}
