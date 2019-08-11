import { Buffer } from 'buffer';
import * as sodium from 'sodium-universal';

import { now } from '../utils';
import MemoryStorage from '../storage/memory';

import Chain from './chain';
import Message from './message';

export const ID_SIZE = 32;
export const MAX_PARENT_DELTA = 30 * 24 * 3600; // 30 days

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
    const parents = await this.bulkGet(message.parents);
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
    if (!cursor.hash) {
      cursor = {
        height: Math.min(cursor.height, await this.getMinLeafHeight()),
      };
    }

    return await this.storage.query(this.id, cursor, isBackward, limit);
  }

  async sync(remote) {
  }

  // Private
  async bulkGet(hashes) {
    return await Promise.all(hashes.map(async (hash) => {
      const parent = await this.storage.getMessage(this.id, hash);
      if (!parent) {
        throw new Error(`Message: ${hash.toString('hex')} not found`);
      }
      return parent;
    }));
  }

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
