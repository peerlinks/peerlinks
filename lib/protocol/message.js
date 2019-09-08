import { Buffer } from 'buffer';

import { ChannelMessage as PChannelMessage } from '../messages';
import { BanError, now } from '../utils';

import Chain from './chain';

export const HASH_SIZE = 32;

export default class Message {
  constructor(options) {
    const {
      sodium, parents, height, chain, timestamp = now(), body, signature,
    } = options;
    if (!sodium) {
      throw new Error('Missing required `sodium` option');
    }

    this.sodium = sodium;

    parents.forEach((hash) => {
      Message.checkHash(hash, 'Invalid parent hash');
    });
    if (height < 0) {
      throw new BanError('Invalid height');
    }
    if (signature.length !== sodium.crypto_sign_BYTES) {
      throw new BanError('Invalid signature length');
    }
    if (!body.root) {
      try {
        JSON.parse(body.json);
      } catch (e) {
        throw new BanError('Invalid JSON content. ' + e.message);
      }
    }

    this.parents = parents;
    this.height = height;
    this.chain = chain;
    this.timestamp = timestamp;
    this.body = body;

    this.signature = signature;

    this.hash = Buffer.alloc(HASH_SIZE);
    sodium.crypto_generichash(this.hash, this.serializeData());

    this.debugHash = this.hash.toString('hex').slice(0, 8);

    this.cachedJSON = null;
  }

  get isRoot() {
    return !!this.body.root;
  }

  get json() {
    if (this.isRoot) {
      return undefined;
    }

    if (!this.cachedJSON) {
      this.cachedJSON = JSON.parse(this.body.json);
    }
    return this.cachedJSON;
  }

  getAuthor() {
    return {
      displayPath: this.chain.getDisplayPath(),
      publicKeys: this.chain.getPublicKeys(),
    };
  }

  verify(channel) {
    const sodium = this.sodium;
    const leafKey = this.chain.getLeafKey(channel);

    return sodium.crypto_sign_verify_detached(
      this.signature,
      Message.tbs(this.serializeTBS()),
      leafKey);
  }

  serialize() {
    return {
      tbs: this.serializeTBS(),
      signature: this.signature,
    };
  }

  serializeData() {
    return PChannelMessage.encode(this.serialize()).finish();
  }

  serializeTBS() {
    return {
      parents: this.parents,
      height: this.height,
      chain: this.chain.serialize(),
      timestamp: this.timestamp,
      body: this.body,
    };
  }

  static deserialize(decoded, options) {
    const chain = Chain.deserialize(decoded.tbs.chain);

    return new Message({
      sodium: options.sodium,
      parents: decoded.tbs.parents,
      height: decoded.tbs.height.toNumber(),
      chain,
      timestamp: decoded.tbs.timestamp,
      body: decoded.tbs.body,

      signature: decoded.signature,
    });
  }

  static deserializeData(data, options) {
    return Message.deserialize(PChannelMessage.decode(data), options);
  }

  // Helpers

  static root() {
    return { root: {} };
  }

  static json(value) {
    return { json: JSON.stringify(value) };
  }

  static checkHash(hash, message) {
    if (!hash || hash.length !== HASH_SIZE) {
      throw new BanError(message);
    }
  }

  static tbs({ chain, timestamp, body, parents, height }) {
    return PChannelMessage.TBS.encode({
      chain,
      timestamp,
      body,
      parents,
      height,
    }).finish();
  }
}

Message.HASH_SIZE = HASH_SIZE;
