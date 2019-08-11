import * as sodium from 'sodium-universal';

import { ChannelMessage as PChannelMessage } from '../messages';

import { ID_SIZE as CHANNEL_ID_SIZE } from './channel';
import Chain from './chain';
import Link from './link';

export const HASH_SIZE = 32;

export default class Message {
  constructor(options) {
    const {
      // NOTE: `channel` MUST be supplied with `content`
      // `channelId` MAY be supplied instead for `encryptedContent`
      channel,
      channelId,

      parents,
      height,
      nonce,
      content,
      encryptedContent,
    } = options;

    this.channelId = channelId || channel.id;
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

    if (content && !channel) {
      throw new Error(
        '`options.channel` is mandatory when `options.content` is present');
    }

    if (encryptedContent &&
        encryptedContent.length < sodium.crypto_secretbox_MACBYTES) {
      throw new Error('Invalid encrypted content');
    }

    this.content = content;
    this.encryptedContent = encryptedContent;

    this.cachedChain = null;

    // Message MUST have valid hash
    if (content) {
      this.encrypt(channel);
    }

    this.hash = Buffer.alloc(HASH_SIZE);
    sodium.crypto_generichash(this.hash, this.serializeData());
  }

  get chain() {
    if (!this.content) {
      throw new Error('Message must be decrypted first');
    }

    if (this.cachedChain) {
      return this.cachedChain;
    }

    this.cachedChain = new Chain(
      this.content.chain.map((link) => Link.deserialize(link)));
    return this.cachedChain;
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
    if (this.content) {
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

  verify(channel) {
    this.decrypt(channel);

    const leafKey = this.chain.getLeafKey(channel);

    return sodium.crypto_sign_verify_detached(
      this.content.signature,
      Message.tbs({
        chain: this.content.chain,
        timestamp: this.content.timestamp,
        body: this.content.body,
        parents: this.parents,
        height: this.height,
      }),
      leafKey);
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

  static deserialize(decoded) {
    return new Message({
      channelId: decoded.channelId,

      parents: decoded.parents,
      // NOTE: 53bits of precision is more than enough
      height: decoded.height.toNumber(),
      nonce: decoded.nonce,
      encryptedContent: decoded.encryptedContent,
    });
  }

  static deserializeData(data) {
    return Message.deserialize(PChannelMessage.decode(data));
  }

  static tbs({ chain, timestamp, body, parents, height }) {
    return PChannelMessage.Content.TBS.encode({
      chain,
      timestamp,
      body,
      parents,
      height,
    }).finish()
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
