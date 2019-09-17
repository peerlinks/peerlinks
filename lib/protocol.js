import { Buffer } from 'buffer';
import WaitList from 'promise-waitlist';
import createDebug from 'debug';

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
};

const debug = createDebug('peerlinks:protocol');

export default class Protocol {
  /**
   * Instance of the PeerLinks Protocol. Responsible for managing:
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
  constructor({ sodium, storage, passphrase } = {}) {
    if (!sodium) {
      throw new Error('Missing required `sodium` option');
    }

    this.sodium = sodium;
    this.storage = storage || new MemoryStorage();

    this.peers = new Set();

    this.id = Buffer.alloc(Peer.ID_LENGTH);
    sodium.randombytes_buf(this.id);
    this.debugId = this.id.toString('hex').slice(0, 8);

    // See: waitForInvite()
    // See: waitForPeer()
    this.waitList = new WaitList();

    // See: Peer#ready
    this.globalPeerIds = new Set();

    /** @member {Channel[]} in-memory list of channels */
    this.channels = [];

    /** @member {Identity[]} in-memory list of identities */
    this.identities = [];

    // Channel = > WaitListEntry
    this.channelWaiters = new Map();

    this.encryptionKey = null;
    if (passphrase) {
      this.debug('generating encryption key...');
      const salt = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES);
      sodium.crypto_generichash(salt, Buffer.from('peerlinks-persistence'));

      this.encryptionKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
      sodium.crypto_pwhash(
        this.encryptionKey,
        Buffer.from(passphrase),
        salt,
        sodium.crypto_pwhash_OPSLIMIT_MODERATE,
        sodium.crypto_pwhash_MEMLIMIT_MODERATE,
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
   * @returns {Promise} boolean value. If `false` - the decryption has failed.
   */
  async load() {
    const channelIds = await this.storage.getEntityKeys('channel');
    for (const id of channelIds) {
      const serialized = await this.storage.retrieveEntity('channel', id);
      const decrypted = this.decryptData(serialized);
      if (!decrypted) {
        return false;
      }
      const channel = await Channel.deserializeData(decrypted, {
        sodium: this.sodium,
        storage: this.storage,
      });
      this.addChannel(channel, false);
      this.debug('loaded channel.name=%s', channel.name);
    }

    const identityNames = await this.storage.getEntityKeys('identity');
    for (const id of identityNames) {
      const serialized = await this.storage.retrieveEntity('identity', id);
      const decrypted = this.decryptData(serialized);
      if (!decrypted) {
        return false;
      }
      const identity = Identity.deserializeData(decrypted, {
        sodium: this.sodium,
      });
      this.identities.push(identity);
      this.debug('loaded id.name=%s', identity.name);
    }

    this.identities.sort(Identity.compare);
    return true;
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

  async removeIdentity(identity) {
    this.debug('removing identity.id=%s', identity.debugHash);

    const index = this.identities.indexOf(identity);
    if (index === -1) {
      return;
    }
    this.identities.splice(index, 1);

    await this.storage.removeEntity('identity',
      identity.publicKey.toString('hex'));
  }

  /**
   * Add and save to persistence a new Channel instance.
   *
   * @param {Channel} channel - Channel instance to add
   * @returns {Promise} Promise that resolves to either existing channel or
   *   supplied channel
   */
  async addChannel(channel, save = true) {
    let existing = this.getChannel(channel.name) ||
      this.channels.find((existing) => existing.equals(channel));
    if (existing) {
      if (existing.equals(channel)) {
        this.debug('updating existing channel.id=%s', channel.debugId);
        return existing;
      }

      throw new Error(`Channel with a duplicate name: "${channel.name}"`);
    }

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

      waiter.then(() => {
        this.onNewMessage(channel, null);

        this.channelWaiters.delete(channel);
        waitLoop();
      }).catch((err) => {
        this.debug('channel waiter promise error=%j', err.message);
      });
    };
    waitLoop();

    return channel;
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
    await this.storage.removeChannelMessages(channel.id);

    // Cleanup chains
    for (const identity of this.identities) {
      if (identity.removeChain(channel)) {
        await this.saveIdentity(identity);
      }
    }
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
    this.channels.sort(Channel.compare);
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
    this.identities.sort(Identity.compare);
  }

  //
  // Identity
  //

  /**
   * Create new identity and a channel associated to it. Store both in
   * persistence.
   *
   * @param {string} name - Name of identity (and channel)
   * @returns {Promise} A Promise with a tuple of newly created Identity and
   *   Channel
   */
  async createIdentityPair(name, options) {
    const identity = new Identity(name, { sodium: this.sodium });

    const channel = await Channel.fromIdentity(identity, {
      ...options,

      name: identity.name,
      sodium: this.sodium,
      storage: this.storage,
    });
    await this.addChannel(channel);

    // NOTE: Save identity after the channel to save the chain
    await this.addIdentity(identity);

    this.debug('created id.name=%s', identity.name);
    return [ identity, channel ];
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
    options = {
      ...options,
      sodium: this.sodium,
      storage: this.storage,
    };
    const channel = await Channel.fromInvite(invite, {
      ...options,
      identity
    });

    // Save updated chain
    await this.saveIdentity(identity);

    // Save channel
    // NOTE: we return value here to handle duplicates
    return await this.addChannel(channel);
  }

  async feedFromPublicKey(publicKey, options) {
    options = {
      ...options,
      sodium: this.sodium,
      storage: this.storage,
      isFeed: true,
    };
    const channel = await Channel.fromPublicKey(publicKey, options);

    // Save channel
    // NOTE: we return value here to handle duplicates
    return await this.addChannel(channel);
  }

  /**
   * Notify connected (and ready) peers about new message on the channel.
   * (NOTE: Mandatory to call in order to synchronize messages.)
   *
   * @param {Channel} channel - A Channel instance where the message was posted
   * @param {Peer} [source] - Optional originator of the update
   */
  onNewMessage(channel, source) {
    this.debug('broadcasting new message on channel.id=%s source=%j',
      channel.debugId, source && source.debugId);
    for (const peer of this.peers) {
      if (peer !== source) {
        peer.onNewMessage(channel);
      }
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
    this.debug('wait for invite.id=%s', requestId.toString('hex').slice(0, 8));
    return this.waitList.waitFor(
      `invite ${requestId.toString('hex')}`, timeout);
  }

  /**
   * Resolve the awaited Invite when issuing access to ourselves.
   *
   * @param {Buffer} encryptedInvite - Encrypted invite from `id.issueInvite`
   * @returns {boolean} `true` if there was a waiter for invite with this
   *   `requestId`
   */
  resolveInvite(encryptedInvite) {
    const { requestId } = encryptedInvite;
    this.debug('resolve invite.id=%s', requestId.toString('hex').slice(0, 8));
    return this.waitList.resolve(
      `invite ${requestId.toString('hex')}`, encryptedInvite);
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
    const peer = new Peer({
      localId: this.id,
      socket,
      sodium: this.sodium,
      globalPeerIds: this.globalPeerIds,
      identities: this.identities,
      channels: this.channels,
      inviteWaitList: this.waitList,
      chainWaitList: this.waitList,
    });

    const syncLoop = async () => {
      for (;;) {
        let channel;
        try {
          channel = await peer.waitForSync();
        } catch (e) {
          return;
        }

        this.onNewMessage(channel, peer);
      }
    };

    try {
      const isNotDuplicate = await peer.ready();

      // NOTE: Already disconnected
      if (!isNotDuplicate) {
        return false;
      }

      // NOTE: We could attempt to handle duplicates here, but the malicious
      // entity could try to evict peers by using their ids.

      this.debug('new peer.id=%s', peer.debugId);
      this.peers.add(peer);
      this.waitList.resolve(
        `peer ${peer.remoteId.toString('hex')}`, peer);
      this.waitList.resolve('peer', peer);

      this.debug('running peer.id=%s loop', peer.debugId);
      await Promise.race([
        peer.loop(),
        peer.pingLoop(),
        syncLoop(),
      ]);

      this.debug('deleting peer.id=%s', peer.debugId);
      this.peers.delete(peer);
      await peer.destroy();
    } catch (e) {
      this.debug('got error: %s', e.stack);
      this.peers.delete(peer);
      await peer.destroy(e);
      this.waitList.resolve('peer leave', peer);
      throw e;
    }

    this.waitList.resolve('peer leave', peer);
    return true;
  }

  /**
   * Wait for a Peer with supplied `peerId` to appear and be ready.
   *
   * @param {Buffer} [peerId] - Peer identifier
   * @param {Number} [timeout] - Optional timeout value in milliseconds
   * @returns {WaitListEntry} An object with `.promise` property and `.cancel`
   *     method
   */
  waitForPeer(peerId, timeout) {
    // `.waitForPeer(timeout)`
    if (typeof peerId === 'number' || typeof peerId === 'undefined') {
      timeout = peerId;
      peerId = undefined;
    }

    if (!peerId) {
      return this.waitList.waitFor('peer', timeout);
    }

    for (const existing of this.peers) {
      if (existing.remoteId.equals(peerId)) {
        this.debug('found existing peer.id=%s', existing.debugId);
        return WaitList.resolve(existing);
      }
    }

    this.debug('wait for peer.id=%s', peerId.toString('hex').slice(0, 8));
    return this.waitList.waitFor(
      `peer ${peerId.toString('hex')}`, timeout);
  }

  /**
   * Wait for a Peer with supplied `peerId` to appear and be ready.
   *
   * @param {Number} [timeout] - Optional timeout value in milliseconds
   * @returns {WaitListEntry} An object with `.promise` property and `.cancel`
   *     method
   */
  waitForChainMapUpdate(timeout) {
    this.debug('waitForChainUpdate start');

    const entries = [
      // Wait for new chains
      this.waitList.waitFor('chain'),
      // ...or for leaving peers
      this.waitList.waitFor('peer leave'),
    ];

    const cancel = (err) => {
      for (const entry of entries) {
        entry.cancel(err);
      }
    };

    const promise = Promise.race(entries).finally(() => {
      cancel();
    });

    return Object.assign(promise, {
      promise,
      cancel,
    });
  }

  computeChainMap() {
    const result = new Map();

    for (const peer of this.peers) {
      for (const [ channel, chain ] of peer.chains) {
        if (result.has(channel)) {
          result.get(channel).push(chain);
        } else {
          result.set(channel, [ chain ]);
        }
      }
    }

    return result;
  }

  get peerCount() {
    return this.peers.size;
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
        await peer.destroy(new Error('Closed'));
      }));
    } finally {
      // Zero private keys in all identities
      for (const id of this.identities) {
        id.clear();
      }
      // Zero encryption keys in all identities
      for (const channel of this.channels) {
        channel.clear();
      }
    }

    this.waitList.close();
  }

  /** **(Internal)** */
  debug(fmt, ...args) {
    debug('[%s] ' + fmt, ...[ this.debugId ].concat(args));
  }

  encryptData(data) {
    if (!this.encryptionKey) {
      return data;
    }

    const sodium = this.sodium;

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

    const sodium = this.sodium;

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
      return undefined;
    }
    return cleartext;
  }
}
