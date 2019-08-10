import { Buffer } from 'buffer';
import * as sodium from 'sodium-universal';

export const ID_SIZE = 32;
const ID_KEY = Buffer.from('vowlink-channel-id');

export default class Channel {
  constructor(name, publicKey) {
    this.name = name;
    this.publicKey = publicKey;

    this.id = Buffer.alloc(ID_SIZE);
    sodium.crypto_generichash(this.id, this.publicKey, ID_KEY);
  }
}

// Convenience
Channel.ID_SIZE = ID_SIZE;
