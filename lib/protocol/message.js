import * as sodium from 'sodium-universal';

import { ChannelMessage as PChannelMessage } from '../messages';

import { ID_SIZE as CHANNEL_ID_SIZE } from './channel';

export const HASH_SIZE = 32;

export default class Message {
  constructor(options) {
    const {
      channelId,
      parents,
      height,
      nonce,
      content,
      encryptedContent,
    } = options;

    this.channelId = channelId;
    this.parents = parents;
    this.height = height;
    this.nonce = nonce;

    if (!this.nonce) {
      this.nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
      sodium.randombytes_buf(this.nonce);
    }

    if (this.channelId.length !== CHANNEL_ID_SIZE) {
      throw new Error('Invalid channel id size');
    }
    if (this.parents.some((hash) => hash.length !== HASH_SIZE)) {
      throw new Error('Invalid parent hash');
    }
    if (this.height < 0) {
      throw new Error('Invalid height');
    }
    if (this.nonce.length !== sodium.crypto_secretbox_NONCEBYTES) {
      throw new Error('Invalid nonce size');
    }

    if (!content && !encryptedContent) {
      throw new Error('Either decrypted or encrypted content must be present');
    }

    this.content = content;
    this.encryptedContent = encryptedContent;

    if (this.encryptedContent &&
        this.encryptedContent.length < sodium.crypto_secretbox_MACBYTES) {
      throw new Error('Invalid encrypted content');
    }

    this.cachedHash = null;
  }

  get hash() {
    if (this.cachedHash) {
      return this.cachedHash;
    }

    const hash = Buffer.alloc(HASH_SIZE);
    sodium.crypto_generichash(hash, this.serializeData());
    this.cachedHash = hash;
    return hash;
  }

  encrypt(channel) {
    if (this.encryptedContent) {
      return;
    }

    const cleartext = PChannelMessage.Content.encode(this.content).finish();
    const ciphertext = Buffer.alloc(
      cleartext.length + sodium.crypto_secretbox_MACBYTES);
    sodium.crypto_secretbox_easy(ciphertext, cleartext, this.nonce,
      channel.encryptionKey);

    this.encryptedContent = ciphertext;
  }

  decrypt(channel) {
    if (this.decryptedContent) {
      return;
    }

    const cleartext = Buffer.alloc(this.encryptedContent.length -
      sodium.crypto_secretbox_MACBYTES);
    const success = sodium.crypto_secretbox_open_easy(
      cleartext,
      this.encryptedContent,
      this.nonce,
      channel.encryptionKey);
    if (!success) {
      throw new Error('Failed to decrypt message content');
    }
    this.content = PChannelMessage.Content.decode(cleartext);
  }

  serialize() {
    if (!this.encryptedContent) {
      throw new Error('Message has to be encrypted first');
    }

    return {
      channelId: this.channelId,
      parents: this.parents,
      height: this.height,
      nonce: this.nonce,
      encryptedContent: this.encryptedContent,
    };
  }

  serializeData() {
    return PChannelMessage.encode(this.serialize()).finish();
  }

  // Helpers

  static root() {
    return { root: {} };
  }

  static text(message) {
    return { text: { text: message } };
  }
}

Message.HASH_SIZE = HASH_SIZE;
