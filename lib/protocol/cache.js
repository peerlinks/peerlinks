import { Buffer } from 'buffer';

import LRU from 'quick-lru';
import createDebug from 'debug';

import Message from './message';

export const MAX_LRU_SIZE = 16 * 1024;

const debug = createDebug('vowlink:cache');

export default class StorageCache {
  constructor(options) {
    options = {
      maxLRUSize: MAX_LRU_SIZE,
      ...options,
    };

    this.sodium = options.sodium;
    this.channel = options.channel;
    this.backend = options.backend;
    if (!this.sodium) {
      throw new Error('Missing required `sodium` option');
    }
    if (!this.channel) {
      throw new Error('Missing required `channel` option');
    }
    if (!this.backend) {
      throw new Error('Missing required `backend` option');
    }

    this.debugId = this.channel.id.toString('hex').slice(0, 8);

    this.lru = new LRU({ maxSize: options.maxLRUSize });

    this.lastCount = null;
    this.leaves = null;
  }

  async addMessage(message) {
    const { nonce, box } = this.channel.encrypt(message.serializeData());

    const result = await this.backend.addMessage({
      channelId: this.channel.id,
      hash: message.hash,
      parents: message.parents,
      height: message.height,
      data: Buffer.concat([ nonce, box ]),
    });

    // Invalidate caches
    this.debug('invalidating cache');
    this.lastCount = null;
    this.leaves = null;

    this.lru.set(message.hash.toString('hex'), message);

    return result;
  }

  async getMessageCount() {
    if (this.lastCount === null) {
      this.debug('message count miss');
      this.lastCount = await this.backend.getMessageCount(this.channel.id);
    } else {
      this.debug('message count hit %d', this.lastCount);
    }
    return this.lastCount;
  }

  async getLeaves() {
    if (this.leaves === null) {
      this.debug('getLeaves() miss');
      const leafHashes = await this.backend.getLeafHashes(this.channel.id);
      this.leaves = await this.getMessages(leafHashes);
    } else {
      this.debug('getLeaves() hit');
    }
    return this.leaves.slice();
  }

  async hasMessage(hash) {
    if (this.lru.has(hash.toString('hex'))) {
      this.debug('hasMessage() hit');
      return true;
    }
    this.debug('hasMessage() miss');
    return await this.backend.hasMessage(this.channel.id, hash);
  }

  async getMessage(hash) {
    const cacheKey = hash.toString('hex');
    const cached = this.lru.get(cacheKey);
    if (cached) {
      this.debug('getMessage() hit');
      return cached;
    }

    this.debug('getMessage() miss');
    const data = await this.backend.getMessage(this.channel.id, hash);
    const message = this.deserializeMessage(data);
    this.lru.set(cacheKey, message);
    return message;
  }

  async getMessages(hashes) {
    const result = hashes.map((hash) => {
      return this.lru.get(hash.toString('hex'));
    });

    const missing = result.map((cached, i) => {
      if (cached) {
        return false;
      }
      return { hash: hashes[i], index: i };
    }).filter((entry) => entry);

    this.debug('getMessages() hit=%d miss=%d',
      hashes.length - missing.length, missing.length);

    const fetched = await this.backend.getMessages(this.channel.id,
      missing.map((entry) => entry.hash));
    for (const [ i, data ] of fetched.entries()) {
      if (!data) {
        continue;
      }
      const message = this.deserializeMessage(data);
      result[missing[i].index] = message;

      this.lru.set(message.hash.toString('hex'), message);
    }
    return result;
  }

  async getMessagesAtOffset(offset, limit) {
    const hashes = await this.backend.getHashesAtOffset(
      this.channel.id, offset, limit);
    return await this.getMessages(hashes);
  }

  async getReverseMessagesAtOffset(offset, limit) {
    const hashes = await this.backend.getReverseHashesAtOffset(
      this.channel.id, offset, limit);
    return await this.getMessages(hashes);
  }

  async query(...args) {
    return await this.backend.query(this.channel.id, ...args);
  }

  async removeChannelMessages() {
    // NOTE: We do not need to invalidate LRU since `Cache` is already per
    // Channel.
    await this.backend.removeChannelMessages(this.channel.id);
  }

  //
  // Entities
  //

  async storeEntity(...args) {
    return await this.backend.storeEntity(...args);
  }

  async retrieveEntity(...args) {
    return await this.backend.retrieveEntity(...args);
  }

  async removeEntity(...args) {
    return await this.backend.removeEntity(...args);
  }

  async getEntityKeys(...args) {
    return await this.backend.getEntityKeys(...args);
  }

  async clear() {
    this.lru.clear();
    this.lastCount = null;
    this.leaves = null;
    return await this.backend.clear();
  }

  //
  // Internal
  //

  deserializeMessage(box) {
    const nonce = box.slice(0, this.sodium.crypto_secretbox_NONCEBYTES);
    box = box.slice(nonce.length);

    const data = this.channel.decrypt(box, nonce);

    return Message.deserializeData(data, { sodium: this.sodium });
  }

  debug(fmt, ...args) {
    return debug('[%s] ' + fmt, ...[ this.debugId ].concat(args));
  }
}

// Convenience
StorageCache.MAX_LRU_SIZE = MAX_LRU_SIZE;
