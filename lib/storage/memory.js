import { Buffer } from 'buffer';

export default class Memory {
  constructor() {
    this.channels = new Map();
  }

  addMessage(message, leaves) {
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

    data.leaves = leaves;
  }

  getMessageCount(channelId) {
    return this.getChannelData(channelId).messages.length;
  }

  getLeaves(channelId) {
    return this.getChannelData(channelId).leaves;
  }

  hasMessage(channelId, hash) {
    const data = this.getChannelData(channelId);
    return data.messageByHash.has(hash.toString('hex'));
  }

  getMessage(channelId, hash) {
    const data = this.getChannelData(channelId);
    return data.messageByHash.get(hash.toString('hex'));
  }

  getMessageAtOffset(channelId, offset) {
    const data = this.getChannelData(channelId);
    return data.messages[offset];
  }

  query(channelId, cursor, isBackward, limit) {
    const data = this.getChannelData(channelId);

    // TODO(indutny): binary search?
    const index = data.messages.findIndex(cursor.hash ? (message) => {
      return Buffer.compare(cursor.hash, message.hash) === 0;
    } : (message) => {
      return message.height === cursor.height;
    });

    // We are lenient
    if (index === undefined) {
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

  clear() {
    this.channels = new Map();
  }

  // Private

  getChannelData(channelId, create = false) {
    const key = channelId.toString('hex');

    if (this.channels.has(key)) {
      return this.channels.get(key);
    }

    const data = {
      messages: [],
      messageByHash: new Map(),
      leaves: [],
    };
    if (create) {
      this.channels.set(key, data);
    }
    return data;
  }
}
