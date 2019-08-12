import { Buffer } from 'buffer';
import * as sodium from 'sodium-universal';
import createDebug from 'debug';

import { now } from '../utils';
import MemoryStorage from '../storage/memory';

import Chain from './chain';
import Message from './message';

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

    this.debugId = this.id.toString('hex').slice(0, 8);

    this.encryptionKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
    sodium.crypto_generichash(this.encryptionKey, this.publicKey, ENC_KEY);

    this.storage = this.options.storage || new MemoryStorage();

    this.root = null;
  }

  // Create channel using identity and post an initial message
  static async create(identity, name, storage) {
    const channel = new Channel(name, identity.publicKey, storage);
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

  async post(body, identity) {
    if (body.root) {
      throw new Error('Posting root is not allowed');
    }

    const leaves = await this.storage.getLeaves(this.id);
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

    const message = new Message({
      channel: this,
      parents: parentHashes,
      height,
      content,
    });

    await this.storage.addMessage(message);
    this.debug('posted message.hash=%s', message.debugHash);

    return message;
  }

  async receive(message) {
    // Duplicate
    if (await this.storage.hasMessage(this.id, message.hash)) {
      this.debug('received duplicate hash=%s', message.debugHash);
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
    const parents = await this.storage.getMessages(this.id, message.parents);
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
      if (Buffer.compare(this.root.hash, message.hash) !== 0) {
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
      this.root = message;
    }

    await this.storage.addMessage(message);

    this.debug('received message.hash=%s', message.debugHash);
  }

  async getMessageCount() {
    return await this.storage.getMessageCount(this.id);
  }

  async getMessageAtOffset(offset) {
    const message = await this.storage.getMessageAtOffset(this.id, offset);
    message.decrypt(this);
    return message;
  }

  async getMinLeafHeight() {
    const leaves = await this.storage.getLeaves(this.id);

    return leaves.reduce((acc, leave) => {
      return Math.min(acc, leave.height);
    }, Number.MAX_SAFE_INTEGER);
  }

  async query(cursor, isBackward, limit) {
    if (cursor.hash) {
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

    const full = await this.storage.query(this.id, cursor, isBackward, limit);
    const forwardHash = full.forwardHash;
    const backwardHash = full.backwardHash;

    this.debug('query result messages.count=%d backward=%s forward=%s',
      full.messages.length,
      backwardHash && backwardHash.toString('hex').slice(0, 8),
      forwardHash && forwardHash.toString('hex').slice(0, 8));

    return {
      abbreviatedMessages: full.messages.map((message) => {
        return {
          parents: message.parents,
          hash: message.hash,
        };
      }),
      forwardHash,
      backwardHash,
    };
  }

  async bulk(hashes) {
    this.debug('bulk request hashes.length=%d', hashes.length);
    hashes = hashes.slice(0, this.options.maxBulkCount);

    const maybeMessages = await this.storage.getMessages(this.id, hashes);
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

        const isKnown = await this.storage.hasMessage(this.id, parentHash);
        if (isKnown) {
          continue;
        }

        external.add(parentHexHash);
        missingParents++;
      }

      if (missingParents === 0) {
        const isPresent = await this.storage.hasMessage(this.id, abbr.hash);
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

  debug(format, ...args) {
    if (!debug.enabled) {
      return;
    }
    debug('[%s/%s] ' + format, ...[ this.name, this.debugId ].concat(args));
  }
}

// Convenience
Channel.ID_SIZE = ID_SIZE;
Channel.MAX_PARENT_DELTA = MAX_PARENT_DELTA;
Channel.MAX_QUERY_LIMIT = MAX_QUERY_LIMIT;
Channel.MAX_UNRESOLVED_COUNT = MAX_UNRESOLVED_COUNT;
Channel.MAX_BULK_COUNT = MAX_BULK_COUNT;
