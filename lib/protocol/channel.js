import { Buffer } from 'buffer';
import * as sodium from 'sodium-universal';

import { now } from '../utils';
import MemoryStorage from '../storage/memory';

import Chain from './chain';
import Message from './message';

export const ID_SIZE = 32;
export const MAX_PARENT_DELTA = 30 * 24 * 3600; // 30 days
export const MAX_QUERY_LIMIT = 1024;
export const MAX_UNRESOLVED = 256 * 1024;

const ID_KEY = Buffer.from('vowlink-channel-id');
const ENC_KEY = Buffer.from('vowlink-symmetric');

const FUTURE = 5; // 5 seconds

export default class Channel {
  constructor(name, publicKey, storage) {
    this.name = name;
    this.publicKey = publicKey;

    this.id = Buffer.alloc(ID_SIZE);
    sodium.crypto_generichash(this.id, this.publicKey, ID_KEY);

    this.encryptionKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
    sodium.crypto_generichash(this.encryptionKey, this.publicKey, ENC_KEY);

    this.storage = storage || new MemoryStorage();

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

    return message;
  }

  async receive(message) {
    // Duplicate
    if (await this.storage.hasMessage(this.id, message.hash)) {
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

    await this.storage.addMessage(message);
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
    limit = Math.min(limit || 0, MAX_QUERY_LIMIT);
    if (!cursor.hash) {
      cursor = {
        height: Math.min(cursor.height, await this.getMinLeafHeight()),
      };
    }

    const full = await this.storage.query(this.id, cursor, isBackward, limit);
    return {
      abbreviatedMessages: full.messages.map((message) => {
        return {
          parents: message.parents,
          hash: message.hash,
        };
      }),
      forwardHash: full.forwardHash,
      backwardHash: full.backwardHash,
    };
  }

  async bulk() {
  }

  async sync(remote, isFull) {
    // Starting cursor: height = minLeafHeight
    let cursor = isFull ? {
      hash: this.root.hash,
    } : {
      height: await this.getMinLeafHeight(),
    };

    // Currently unresolved parents
    const unresolvedParents = new Set();

    for (;;) {
      const isBackward = unresolvedParents.size !== 0;
      const response = await remote.query(cursor, isBackward, MAX_QUERY_LIMIT);

      // No more messages!
      if (!isBackward && response.abbreviatedMessages.length === 0) {
        break;
      }

      // Parents introduced in this response
      const responseParents = new Set();

      // Messages with known parents
      let known = [];
      for (const abbr of response.abbreviatedMessages) {
        responseParents.add(abbr.hash.toString('hex'));

        const maybeParents = await this.storage.getMessages(
          this.id, abbr.parents);
        const parents = maybeParents.map((maybeParent, i) => {
          const hash = abbr.parents[i];
          if (maybeParent) {
            return { resolved: true, hash };
          }

          if (responseParents.has(hash.toString('hex'))) {
            return { resolved: true, hash };
          }

          return { resolved: false, hash };
        });

        let isFullyResolved = true;
        for (const { resolved, hash } of parents) {
          if (resolved) {
            continue;
          }

          unresolvedParents.add(hash.toString('hex'));

          // Optimized sync is not possible
          if (unresolvedParents.count > MAX_UNRESOLVED) {
            return await this.sync(remote, true);
          }
        }

        // All parents known, prepare to request the message
        if (isFullyResolved) {
          known.push(abbr.hash);
        }
      }

      // Bulk-load messages
      while (known.length !== 0) {
        const { messages, forwardIndex } = await remote.bulk(known);
        known = known.slice(forwardIndex);

        // NOTE: Do it sequentially, so that next messages can use previous as
        // their parents.
        for (const message of messages) {
          await this.receive(message);

          // Found the parent!
          unresolvedParents.delete(message.hash.toString('hex'));
        }
      }

      // Update cursor
      if (unresolvedParents.count !== 0) {
        cursor = { hash: response.backwardHash };
      } else {
        cursor = { hash: response.forwardHash };
      }
    }
  }

  // Private
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
}

// Convenience
Channel.ID_SIZE = ID_SIZE;
Channel.MAX_PARENT_DELTA = MAX_PARENT_DELTA;
Channel.MAX_QUERY_LIMIT = MAX_QUERY_LIMIT;
Channel.MAX_UNRESOLVED = MAX_UNRESOLVED;
