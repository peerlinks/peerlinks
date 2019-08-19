import { Buffer } from 'buffer';
import * as sodium from 'sodium-universal';
import createDebug from 'debug';
import WaitList from 'promise-waitlist';

import { now } from '../utils';
import MemoryStorage from '../storage/memory';
import { Channel as PChannel } from '../messages';

import Chain from './chain';
import Message from './message';
import StorageCache from './cache';

const debug = createDebug('vowlink:channel');

export const ID_SIZE = 32;
export const MAX_PARENT_DELTA = 30 * 24 * 3600; // 30 days
export const MAX_QUERY_LIMIT = 1024;
export const MAX_UNRESOLVED_COUNT = 256 * 1024;
export const MAX_BULK_COUNT = 128;

const ID_KEY = Buffer.from('vowlink-channel-id');
const ENC_KEY = Buffer.from('vowlink-symmetric');

const FUTURE = 5; // 5 seconds

export default class Channel {
  constructor(name, publicKey, options = {}) {
    this.name = name;
    this.publicKey = publicKey;
    this.options = Object.assign({
      maxQueryLimit: MAX_QUERY_LIMIT,
      maxUnresolvedCount: MAX_UNRESOLVED_COUNT,
      maxBulkCount: MAX_BULK_COUNT,
    }, options);

    this.id = Buffer.alloc(ID_SIZE);
    sodium.crypto_generichash(this.id, this.publicKey, ID_KEY);

    this.debugId = this.id.toString('hex').slice(0, 8) + '/' + this.name;

    this.encryptionKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
    sodium.crypto_generichash(this.encryptionKey, this.publicKey, ENC_KEY);

    this.storage = new StorageCache(
      this.id,
      this.options.storage || new MemoryStorage(),
      this.options.cache || {});

    // To be filled later with `.receive()`
    this.root = null;

    this.waitList = new WaitList();
  }

  equals(to) {
    return this.id.equals(to.id);
  }

  clear() {
    if (sodium.sodium_memzero) {
      sodium.sodium_memzero(this.encryptionKey);
    } else {
      this.encryptionKey.fill(0);
    }
  }

  // Create channel using identity and post an initial message
  static async create(identity, name, options) {
    const channel = new Channel(name, identity.publicKey, options);
    identity.addChain(channel, new Chain([]));

    const content = identity.signMessageBody(Message.root(), channel, {
      parents: [],
      height: 0,
    });
    const root = new Message({
      channel,
      parents: [],
      height: 0,
      content,
    });

    await channel.storage.addMessage(root);
    channel.root = root;

    return channel;
  }

  static async fromInvite(invite, identity, options = {}) {
    const channel = new Channel(
      options.name || invite.channelName,
      invite.channelPubKey,
      options);
    await channel.receive(Message.deserialize(invite.channelRoot));
    identity.addChain(channel, Chain.deserialize(invite.chain));
    return channel;
  }

  waitForIncomingMessage(timeout) {
    return this.waitList.waitFor('incoming', timeout);
  }

  waitForOutgoingMessage(timeout) {
    return this.waitList.waitFor('outgoing', timeout);
  }

  waitForUpdate(timeout) {
    return this.waitList.waitFor('update', timeout);
  }

  async post(body, identity) {
    if (body.root) {
      throw new Error('Posting root is not allowed');
    }

    const leaves = await this.getLeaves();
    const parents = this.filterParents(leaves);
    if (parents.length === 0) {
      throw new Error('Internal error: no leaves');
    }

    const height = this.computeHeight(parents);
    const parentHashes = parents.map((parent) => parent.hash);

    const content = identity.signMessageBody(body, this, {
      parents: parentHashes,
      height,
    });

    Channel.checkJSONLimit(body.json, content.chain.length);

    const message = new Message({
      channel: this,
      parents: parentHashes,
      height,
      content,
    });

    await this.storage.addMessage(message);
    this.debug('posted message.hash=%s', message.debugHash);

    this.waitList.resolve('outgoing', message);
    this.waitList.resolve('update');

    return message;
  }

  async receive(message) {
    // Duplicate
    if (await this.storage.hasMessage(message.hash)) {
      this.debug('received duplicate hash=%s', message.debugHash);

      // Set root anyway
      if (message.parents.length === 0 && !this.root) {
        message.decrypt(this);
        this.root = message;
      }
      return;
    }

    message.decrypt(this);

    //
    // Verify signature
    //
    if (!message.verify(this)) {
      throw new Error('Invalid message signature, or invalid chain');
    }

    //
    // Check parents and parent delta
    //
    const parents = await this.getMessages(message.parents);
    const missingIndex = parents.findIndex((parent) => !parent);
    if (missingIndex !== -1) {
      throw new Error('Message parent: ' +
        `${message.parents[missingIndex].toString('hex')} not found`);
    }

    if (this.filterParents(parents).length !== parents.length) {
      throw new Error('Parent timestamp delta is greater than 30 days');
    }

    //
    // Check root
    //

    if (this.root && parents.length === 0) {
      if (!this.root.hash.equals(message.hash)) {
        throw new Error('Received invalid root');
      }
    }

    //
    // Check height
    //

    const height = this.computeHeight(parents);
    if (message.height !== height) {
      throw new Error(`Invalid received message height: ${message.height}, ` +
        `expected: ${height}`);
    }

    //
    // Check timestamp
    //

    const future = now() + FUTURE;
    if (message.content.timestamp > future) {
      throw new Error('Received message is in the future');
    }

    const parentTimestamp = this.computeMaxTimestamp(parents);
    if (message.content.timestamp < parentTimestamp) {
      throw new Error('Received message is in the past');
    }

    if (!this.root && parents.length === 0) {
      if (!message.content.body.root) {
        throw new Error('Invalid root content');
      }
      this.root = message;
    }

    if (parents.length !== 0) {
      if (message.content.body.root) {
        throw new Error('Invalid non-root content');
      }

      Channel.checkJSONLimit(message.content.body.json,
        message.content.chain.length);
    }

    await this.storage.addMessage(message);
    this.debug('received message.hash=%s', message.debugHash);

    this.waitList.resolve('incoming', message);
    this.waitList.resolve('update');
  }

  async getMessageCount() {
    return await this.storage.getMessageCount();
  }

  async getMessagesAtOffset(offset, limit = 1) {
    const messages = await this.storage.getMessagesAtOffset(offset, limit);
    return messages.map((message) => {
      message.decrypt(this);
      return message;
    });
  }

  async getReverseMessagesAtOffset(offset, limit = 1) {
    const messages = await this.storage.getReverseMessagesAtOffset(
      offset, limit);
    return messages.map((message) => {
      message.decrypt(this);
      return message;
    });
  }

  async getEncryptedLeaves() {
    return await this.storage.getLeaves();
  }

  async getLeaves() {
    const leaves = await this.getEncryptedLeaves();

    return leaves.map((leaf) => {
      leaf.decrypt(this);
      return leaf;
    });
  }

  async getMessages(hashes) {
    const messages = await this.storage.getMessages(hashes);

    return messages.map((message) => {
      if (message) {
        message.decrypt(this);
      }
      return message;
    })
  }

  async getMinLeafHeight() {
    const leaves = await this.getEncryptedLeaves();
    return leaves.reduce((acc, leave) => {
      return Math.min(acc, leave.height);
    }, Number.MAX_SAFE_INTEGER);
  }

  async query(cursor, isBackward, limit) {
    if (cursor.hash) {
      Message.checkHash(cursor.hash, 'Invalid cursor.hash length in query()');

      this.debug('got query cursor.hash=%s isBackward=%j limit=%d',
        cursor.hash.toString('hex').slice(0, 8), isBackward, limit);
    } else {
      this.debug('got query cursor.height=%d isBackward=%j limit=%d',
        cursor.height, isBackward, limit);
    }

    limit = Math.min(limit || 0, this.options.maxQueryLimit);
    if (!cursor.hash) {
      cursor = {
        height: Math.min(cursor.height, await this.getMinLeafHeight()),
      };
    }

    const {
      abbreviatedMessages,
      forwardHash,
      backwardHash
    } = await this.storage.query(cursor, isBackward, limit);

    this.debug('query result messages.count=%d backward=%s forward=%s',
      abbreviatedMessages.length,
      backwardHash && backwardHash.toString('hex').slice(0, 8),
      forwardHash && forwardHash.toString('hex').slice(0, 8));

    return {
      abbreviatedMessages,
      forwardHash,
      backwardHash,
    };
  }

  async bulk(hashes) {
    this.debug('bulk request hashes.length=%d', hashes.length);
    hashes = hashes.slice(0, this.options.maxBulkCount);

    hashes.forEach((hash) => {
      Message.checkHash(hash, 'Invalid hash size in bulk()');
    });

    const maybeMessages = await this.getMessages(hashes);
    const messages = maybeMessages.filter((message) => {
      return !!message;
    });

    this.debug('bulk response messages.length=%d', messages.length);

    return {
      messages,
      forwardIndex: hashes.length,
    };
  }

  async sync(remote, isFull = false) {
    if (!this.root) {
      throw new Error('Can\'t synchronize without root');
    }
    this.debug('starting sync to remote isFull=%j', isFull);

    // Starting cursor: height = minLeafHeight
    let cursor = isFull ? {
      hash: this.root.hash,
    } : {
      height: await this.getMinLeafHeight(),
    };

    const unresolved = new Set();
    for (;;) {
      const isBackward = unresolved.size !== 0;
      const response = await remote.query(cursor, isBackward,
        this.options.maxQueryLimit);
      if (response.abbreviatedMessages.length > this.options.maxQueryLimit) {
        throw new Error('Query response overflow: ' +
          `${response.messages.length} > ${this.options.maxQueryLimit}`);
      }

      if (cursor.hash) {
        this.debug('sync cursor.hash=%j isBackward=%j count=%d',
          cursor.hash.toString('hex').slice(0, 8),
          isBackward,
          response.abbreviatedMessages.length);
      } else {
        this.debug('sync cursor.height=%j isBackward=%j count=%d',
          cursor.height,
          isBackward,
          response.abbreviatedMessages.length);
      }

      let { external, known } = await this.computePartialDAG(response);
      this.debug('partial dag external.count=%d known.count=%d',
        external.length, known.length);

      for (const abbr of response.abbreviatedMessages) {
        // Message is included in response, remove it from unresolved parents
        unresolved.delete(abbr.hash.toString('hex'));
      }

      // Request messages with known parents
      const expected = new Set(known.map((hash) => hash.toString('hex')));
      while (known.length !== 0) {
        const { messages, forwardIndex } = await remote.bulk(known);

        for (const message of messages) {
          const hexHash = message.hash.toString('hex');
          if (!expected.has(hexHash)) {
            throw new Error(`Unexpected message in bulk response: ${hexHash}`);
          }

          await this.receive(message);
        }

        known = known.slice(forwardIndex);
      }

      if (isFull && external.length !== 0) {
        throw new Error('Synchronization failed. Missing parent in full sync');
      }

      // Add external dependencies to unresolved
      for (const hash of external) {
        unresolved.add(hash.toString('hex'));

        if (unresolved.size > this.options.maxUnresolvedCount) {
          this.debug('fallback to full sync');
          return await this.sync(remote, true);
        }
      }
      this.debug('unresolved.size=%d', unresolved.size);

      if (unresolved.size === 0) {
        // Everything resolved - go forward
        cursor = { hash: response.forwardHash };
      } else {
        cursor = { hash: response.backwardHash };
      }

      if (!cursor.hash) {
        break;
      }
    }

    this.debug('completed sync to remote isFull=%j', isFull);
  }

  //
  // Private
  //

  computeHeight(parents) {
    return parents.reduce((acc, parent) => {
      return Math.max(acc, parent.height + 1);
    }, 0);
  }

  computeMaxTimestamp(parents) {
    return parents.reduce((acc, parent) => {
      return Math.max(acc, parent.content.timestamp);
    }, 0);
  }

  filterParents(parents) {
    const max = this.computeMaxTimestamp(parents);
    const min = max - MAX_PARENT_DELTA;

    return parents.filter((parent) => {
      return parent.content.timestamp >= min;
    });
  }

  async computePartialDAG(response) {
    // Hashes of parents outside of the response and storage
    const external = new Set();

    // Hashes of parents either in the response or in the storage
    const local = new Set();

    // Messages with known parents (including parents in response)
    const known = [];

    // Messages with some of parents unknown
    const unknown = new Set();

    for (const abbr of response.abbreviatedMessages) {
      local.add(abbr.hash.toString('hex'));

      let missingParents = 0;
      for (const parentHash of abbr.parents) {
        const parentHexHash = parentHash.toString('hex');
        if (unknown.has(parentHexHash)) {
          missingParents++;
          continue;
        }

        if (local.has(parentHexHash)) {
          continue;
        }

        const isKnown = await this.storage.hasMessage(parentHash);
        if (isKnown) {
          continue;
        }

        external.add(parentHexHash);
        missingParents++;
      }

      if (missingParents === 0) {
        const isPresent = await this.storage.hasMessage(abbr.hash);
        if (!isPresent) {
          known.push(abbr.hash);
        }
      } else {
        unknown.add(abbr.hash.toString('hex'));
      }
    }

    const externalHashes = Array.from(external).map((hex) => {
      return Buffer.from(hex, 'hex');
    });

    return { external: externalHashes, known };
  }

  //
  // Serialize/deserialize (for storage)
  //

  serialize() {
    if (!this.root) {
      throw new Error('Can\'t serialize without root');
    }

    return {
      publicKey: this.publicKey,
      name: this.name,
      root: this.root.serialize(),
    };
  }

  serializeData() {
    return PChannel.encode(this.serialize()).finish();
  }

  static async deserialize(decoded, options) {
    const channel = new Channel(decoded.name, decoded.publicKey, options);
    await channel.receive(Message.deserialize(decoded.root));
    return channel;
  }

  static async deserializeData(data, options) {
    return await Channel.deserialize(PChannel.decode(data), options);
  }

  static compare(a, b) {
    if (a.name > b.name) {
      return 1;
    } else if (a.name < b.name) {
      return -1;
    } else {
      return 0;
    }
  }

  static checkId(id, message) {
    if (id.length !== ID_SIZE) {
      throw new Error(message);
    }
  }

  static jsonLimit(chainLength) {
    switch (chainLength) {
      case 0: return Infinity;
      case 1: return 262144;
      case 2: return 8192;
      case 3: return 256;
      default: throw new Error('Unexpected chain length: ' + chainLength);
    }
  }

  static checkJSONLimit(json = '', chainLength) {
    const limit = Channel.jsonLimit(chainLength);
    if (json.length > limit) {
      throw new Error('Message body length overflow. ' +
        `Expected less or equal to: ${limit}. ` +
        `Got: ${json.length}`);
    }
  }

  //
  // Debug
  //

  debug(format, ...args) {
    if (!debug.enabled) {
      return;
    }
    debug('[%s] ' + format, ...[ this.debugId ].concat(args));
  }
}

// Convenience
Channel.ID_SIZE = ID_SIZE;
Channel.MAX_PARENT_DELTA = MAX_PARENT_DELTA;
Channel.MAX_QUERY_LIMIT = MAX_QUERY_LIMIT;
Channel.MAX_UNRESOLVED_COUNT = MAX_UNRESOLVED_COUNT;
Channel.MAX_BULK_COUNT = MAX_BULK_COUNT;
