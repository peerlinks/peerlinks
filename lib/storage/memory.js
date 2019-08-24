import { Buffer } from 'buffer';

export default class Memory {
  /**
   * In-memory persistence.
   *
   * @class
   */
  constructor() {
    this.channelData = new Map();
    this.entities = new Map();
  }

  //
  // Messages
  //

  /**
   * Add new message to the persistent storage. Automatically recompute leafs.
   *
   * @param {Message} message - message to be added
   * @returns {Promise}
   */
  async addMessage(message) {
    const data = this.getChannelData(message.channelId, true);

    const hash = message.hash.toString('hex');
    if (data.messageByHash.has(hash)) {
      // Duplicate
      return;
    }

    const serialized = message.data;

    // CRDT order
    data.messages.push({
      height: message.height,
      hash: message.hash,
      parents: message.parents,
      serialized,
    });
    // TODO(indutny): binary insert?
    data.messages.sort((a, b) => {
      if (a.height < b.height) {
        return -1;
      } else if (a.height > b.height) {
        return 1;
      }

      return Buffer.compare(a.hash, b.hash);
    });

    data.messageByHash.set(hash, serialized);

    for (const hash of message.parents) {
      data.leaves.delete(hash.toString('hex'));
    }
    data.leaves.add(hash);
  }

  /**
   * Get message count in linearized DAG.
   *
   * @param {Buffer} channelId - id of the Channel instance
   * @returns {Promise}
   */
  async getMessageCount(channelId) {
    return this.getChannelData(channelId).messages.length;
  }

  /**
   * Get current leaves for the channel.
   *
   * @param {Buffer} channelId - id of the Channel instance
   * @returns {Promise} array of resulting hashes
   */
  async getLeafHashes(channelId) {
    const hashes = Array.from(this.getChannelData(channelId).leaves);
    const result = [];
    for (const hex of hashes) {
      const hash = Buffer.from(hex, 'hex');
      result.push(hash);
    }
    return result;
  }

  /**
   * Check if the message with `hash` is present in specified channel.
   *
   * @param {Buffer} channelId - id of the Channel instance
   * @returns {Promise} boolean value: `true` - present, `false` - not present
   */
  async hasMessage(channelId, hash) {
    const data = this.getChannelData(channelId);
    return data.messageByHash.has(hash.toString('hex'));
  }

  /**
   * Find and return the message with `hash` in specified channel.
   *
   * @param {Buffer} channelId - id of the Channel instance
   * @param {Buffer} hash - Message hash
   * @returns {Promise} `Message` instance or `undefined`
   */
  async getMessage(channelId, hash) {
    const data = this.getChannelData(channelId);
    return data.messageByHash.get(hash.toString('hex'));
  }

  /**
   * Find and return several messages with hash in `hashes` in specified
   * channel.
   *
   * @param {Buffer} channelId - id of the Channel instance
   * @param {Buffer[]} hashes - Message hashes
   * @returns {Promise} A list of `Message` instances or `undefined`s
   *     (`(Message | undefined)[]`)
   */
  async getMessages(channelId, hashes) {
    return await Promise.all(hashes.map(async (hash) => {
      return await this.getMessage(channelId, hash);
    }));
  }

  /**
   * Get hashes starting from specific integer offset using CRDT order.
   *
   * @param {Buffer} channelId - id of the Channel instance
   * @param {number} offset - Message offset. MUST be greater or equal to zero
   *    and less than `getMessageCount()` result
   * @param {limit} offset - Maximum number of messages to return
   * @returns {Promise} Array of `Message` instances
   */
  async getHashesAtOffset(channelId, offset, limit) {
    const data = this.getChannelData(channelId);
    return data.messages.slice(offset, offset + limit).map((message) => {
      return message.hash;
    });
  }

  async getReverseHashesAtOffset(channelId, offset, limit) {
    const data = this.getChannelData(channelId);
    const end = Math.max(data.messages.length - offset, 0);
    const start = Math.max(data.messages.length - offset - limit, 0);
    return data.messages.slice(start, end).reverse().map((message) => {
      return message.hash;
    });
  }

  async query(channelId, cursor, isBackward, limit) {
    // NOTE: It is hard to implement this atomically, and it is not used anyway
    if (isBackward && !cursor.hash) {
      throw new Error('Backwards query by height is not supported');
    }

    const data = this.getChannelData(channelId);

    // TODO(indutny): binary search?
    const index = data.messages.findIndex(cursor.hash ? (message) => {
      return cursor.hash.equals(message.hash);
    } : (message) => {
      return message.height === cursor.height;
    });

    // We are lenient
    if (index === -1) {
      return { abbreviatedMessages: [], forwardHash: null, backwardHash: null };
    }

    let start;
    let end;
    if (isBackward) {
      start = Math.max(0, index - limit);
      end = index;
    } else {
      start = index;
      end = Math.min(data.messages.length, index + limit);
    }

    const messages = data.messages.slice(start, end);

    const backwardHash = start === 0 ? null : messages[0].hash;
    const forwardHash = end === data.messages.length ? null :
      data.messages[end].hash;

    return {
      abbreviatedMessages: messages.map(({ hash, parents }) => {
        return { hash, parents };
      }),
      forwardHash,
      backwardHash,
    };
  }

  async removeChannelMessages(channelId) {
    const key = channelId.toString('hex');

    this.channelData.delete(key);
  }

  //
  // Entities (Identity, ChannelList, so on)
  //

  async storeEntity(prefix, id, blob) {
    let submap;
    if (this.entities.has(prefix)) {
      submap = this.entities.get(prefix);
    } else {
      submap = new Map();
      this.entities.set(prefix, submap);
    }
    submap.set(id, blob);
  }

  async retrieveEntity(prefix, id) {
    if (!this.entities.has(prefix)) {
      return;
    }
    const submap = this.entities.get(prefix);

    if (!submap.has(id)) {
      return;
    }
    return submap.get(id);
  }

  async removeEntity(prefix, id) {
    if (!this.entities.has(prefix)) {
      return;
    }
    const submap = this.entities.get(prefix);
    submap.delete(id);
  }

  async getEntityKeys(prefix) {
    if (!this.entities.has(prefix)) {
      return [];
    }
    return Array.from(this.entities.get(prefix).keys());
  }

  //
  // Miscellaneous
  //

  async clear() {
    this.channelData.clear();
    this.channels.clear();
  }

  // Private

  getChannelData(channelId, create = false) {
    const key = channelId.toString('hex');

    if (this.channelData.has(key)) {
      return this.channelData.get(key);
    }

    const data = {
      messages: [],
      messageByHash: new Map(),
      leaves: new Set(),
    };
    if (create) {
      this.channelData.set(key, data);
    }
    return data;
  }
}
