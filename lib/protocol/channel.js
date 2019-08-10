import { Buffer } from 'buffer';
import * as sodium from 'sodium-universal';

import MemoryStorage from '../storage/memory';

import Chain from './chain';
import Message from './message';

export const ID_SIZE = 32;

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

  async post(body, identity) {
    if (body.root) {
      throw new Error('Posting root is not allowed');
    }

    const leaves = await this.storage.getLeaves(this.id);
    const height = await this.computeHeight(leaves);

    const content = identity.signMessageBody(body, this, {
      parents: leaves,
      height,
    });

    const message = new Message({
      channel: this,
      parents: leaves,
      height,
      content,
    });

    await this.storage.addMessage(message);

    return message;
  }

  async receive(message) {
    message.decrypt(this);

    // NOTE: This checks parents too
    const height = await this.computeHeight(message.parents);
    if (message.height !== height) {
      throw new Error(`Invalid received message height: ${message.height}, ` +
        `expected: ${height}`);
    }

    throw new Error('TODO(indutny): implement me');
  }

  async getMessageCount() {
    return await this.storage.getMessageCount(this.id);
  }

  async getMessageAtOffset(offset) {
    const message = await this.storage.getMessageAtOffset(this.id, offset);
    message.decrypt(this);
    return message;
  }

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

  // Private

  async computeHeight(hashes) {
    const parents = await Promise.all(hashes.map(async (hash) => {
      const parent = await this.storage.getMessage(this.id, hash);
      if (!parent) {
        throw new Error(`Parent: ${hash.toString('hex')} not found`);
      }
      return parent;
    }));

    return parents.reduce((acc, parent) => {
      return Math.max(acc, parent.height + 1);
    }, 0);
  }
}

// Convenience
Channel.ID_SIZE = ID_SIZE;
