import { Buffer } from 'buffer';

export default class Memory {
  constructor() {
    this.channelData = new Map();
    this.entities = new Map();
  }

  //
  // Messages
  //

  async addMessage(message) {
    const data = this.getChannelData(message.channelId, true);

    const hash = message.hash.toString('hex');
    if (data.messageByHash.has(hash)) {
      // Duplicate
      return;
    }

    // CRDT order
    data.messages.push(message);
    // TODO(indutny): binary insert?
    data.messages.sort((a, b) => {
      if (a.height < b.height) {
        return -1;
      } else if (a.height > b.height) {
        return 1;
      }

      return Buffer.compare(a.hash, b.hash);
    });

    data.messageByHash.set(hash, message);

    for (const hash of message.parents) {
      data.leaves.delete(hash.toString('hex'));
    }
    data.leaves.add(hash);
  }

  async getMessageCount(channelId) {
    return this.getChannelData(channelId).messages.length;
  }

  async getLeaves(channelId) {
    const hashes = Array.from(this.getChannelData(channelId).leaves);
    const result = [];
    for (const hex of hashes) {
      const hash = Buffer.from(hex, 'hex');

      result.push(await this.getMessage(channelId, hash));
    }
    return result;
  }

  async hasMessage(channelId, hash) {
    const data = this.getChannelData(channelId);
    return data.messageByHash.has(hash.toString('hex'));
  }

  async getMessage(channelId, hash) {
    const data = this.getChannelData(channelId);
    return data.messageByHash.get(hash.toString('hex'));
  }

  async getMessages(channelId, hashes) {
    return await Promise.all(hashes.map(async (hash) => {
      return await this.getMessage(channelId, hash);
    }));
  }

  async getMessageAtOffset(channelId, offset) {
    const data = this.getChannelData(channelId);
    return data.messages[offset];
  }

  async query(channelId, cursor, isBackward, limit) {
    const data = this.getChannelData(channelId);

    // TODO(indutny): binary search?
    const index = data.messages.findIndex(cursor.hash ? (message) => {
      return cursor.hash.equals(message.hash);
    } : (message) => {
      return message.height === cursor.height;
    });

    // We are lenient
    if (index === -1) {
      return { messages: [], forwardHash: null, backwardHash: null };
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

    return { messages, forwardHash, backwardHash };
  }

  //
  // Entities (Identity, ChannelList, so on)
  //

  async storeEntity(prefix, id, entity) {
    let submap;
    if (this.entities.has(prefix)) {
      submap = this.entities.get(prefix);
    } else {
      submap = new Map();
      this.entities.set(prefix, submap);
    }
    submap.set(id, await entity.serializeData());
  }

  async retrieveEntity(prefix, id, constructor, options) {
    if (!this.entities.has(prefix)) {
      return;
    }
    const submap = this.entities.get(prefix);

    if (!submap.has(id)) {
      return;
    }
    return await constructor.deserializeData(submap.get(id), options);
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
