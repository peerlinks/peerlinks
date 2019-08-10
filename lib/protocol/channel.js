import { Buffer } from 'buffer';
import * as sodium from 'sodium-universal';

import MemoryStorage from '../storage/memory';

import Message from './message';

export const ID_SIZE = 32;

const ID_KEY = Buffer.from('vowlink-channel-id');
const ENC_KEY = Buffer.from('vowlink-symmetric');

export default class Channel {
  constructor(name, publicKey, storage) {
    this.name = name;
    this.publicKey = publicKey;

    this.id = Buffer.alloc(ID_SIZE);
    sodium.crypto_generichash(this.id, this.publicKey, ID_KEY);

    this.encryptionKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
    sodium.crypto_generichash(this.encryptionKey, this.publicKey, ENC_KEY);

    this.storage = storage || new MemoryStorage();
  }

  static async create(identity, { name, publicKey, storage }) {
    const channel = new Channel(name, publicKey, storage);
    const content = identity.signMessageContent(Message.root(), channel, {
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

    return channel;
  }
}

// Convenience
Channel.ID_SIZE = ID_SIZE;
