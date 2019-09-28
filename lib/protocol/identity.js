import { Buffer } from 'buffer';
import createDebug from 'debug';

import { now, BanError, EphemeralBox } from '../utils';
import {
  Identity as PIdentity,
  Invite as PInvite,
  InviteRequest as PInviteRequest,
} from '../messages';
import Peer from '../peer';

import Link, {
  EXPIRATION_DELTA as LINK_EXPIRATION_DELTA,
  EXPIRATION_LEEWAY as LINK_EXPIRATION_LEEWAY,
} from './link';
import Message from './message';
import Chain from './chain';

const debug = createDebug('peerlinks:identity');

export const MAX_INVITE_NAME_LENGTH = 128;
export const INVITE_REQUEST_ID_LENGTH = 32;

// The property is ours. The symbol prevents uncontrolled use from other
// internal modules.
const kSecretKey = Symbol('secretKey');

export default class Identity {
  constructor(name, { publicKey, secretKey, sodium } = {}) {
    if (!sodium) {
      throw new Error('Missing required `sodium` option');
    }

    this.name = name;
    this.sodium = sodium;

    if (!this.sodium) {
      throw new Error('Missing required `sodium` option');
    }

    this.publicKey = publicKey;
    this[kSecretKey] = secretKey;
    if (!this.publicKey || !this[kSecretKey]) {
      this.publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
      // TODO(indutny): use sodium_malloc
      this[kSecretKey] = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
      sodium.crypto_sign_keypair(this.publicKey, this[kSecretKey]);
    }

    // Channel => Chain
    this.chains = new Map();

    // To be JSON stringified and stored in persistence
    this.metadata = null;

    this.debugHash = this.publicKey.toString('hex').slice(0, 8);
  }

  clear() {
    const sodium = this.sodium;
    if (sodium.sodium_memzero) {
      sodium.sodium_memzero(this[kSecretKey]);
    } else {
      this[kSecretKey].fill(0);
    }
  }

  getMetadata() {
    return this.metadata;
  }

  setMetadata(metadata) {
    this.metadata = metadata;
  }

  //
  // Chains
  //

  issueLink(channel, options) {
    const {
      validFrom = now() - LINK_EXPIRATION_LEEWAY,
      validTo = now() + LINK_EXPIRATION_DELTA,
      trusteePubKey,
      trusteeDisplayName,
    } = options;

    const sodium = this.sodium;

    const tbs = Link.tbs(channel, {
      trusteePubKey: trusteePubKey,
      trusteeDisplayName,
      validFrom: validFrom,
      validTo: validTo,
    });
    const signature = this.sign(tbs);

    return new Link({
      sodium,
      validFrom,
      validTo,
      trusteePubKey,
      trusteeDisplayName,
      signature,
    });
  }

  addChain(channel, chain) {
    if (!chain.verify(channel)) {
      throw new Error('Invalid chain');
    }

    const leafKey = chain.getLeafKey(channel);
    if (!leafKey.equals(this.publicKey)) {
      throw new Error('Invalid leaf key in the chain');
    }

    const key = channel.id.toString('hex');
    if (this.chains.has(key)) {
      const existing = this.chains.get(key);

      // Do not replace better chains with worse chains
      if (existing.isBetterThan(chain)) {
        return;
      }
    }
    this.chains.set(key, chain);
  }

  getChain(channel, timestamp = now()) {
    const chain = this.chains.get(channel.id.toString('hex'));
    if (!chain) {
      return;
    }

    // Purge invalid chains
    if (!chain.isValid(timestamp + LINK_EXPIRATION_LEEWAY)) {
      return false;
    }

    return chain;
  }

  removeChain(channel) {
    const key = channel.id.toString('hex');
    if (!this.chains.has(key)) {
      return false;
    }
    this.chains.delete(key);
    return true;
  }

  getChannelIds(timestamp = now()) {
    const result = [];
    for (const [ key, chain ] of this.chains) {
      // TODO(indutny): why do you add leeway?
      if (chain.isValid(timestamp + LINK_EXPIRATION_LEEWAY)) {
        result.push(Buffer.from(key, 'hex'));
      }
    }
    return result;
  }

  //
  // Messages
  //

  signMessageBody(body, channel, options) {
    const {
      timestamp = now(),
      height,
      parents,
    } = options;

    const chain = this.getChain(channel);
    if (!chain) {
      throw new Error(
        `No chain available for a channel ${channel.id.toString('hex')}`);
    }

    if (!this.canPost(channel, timestamp)) {
      throw new Error(
        `Cannot post to the channel ${channel.id.toString('hex')}`);
    }

    const tbs = Message.tbs({
      chain: chain.serialize(),
      timestamp,
      body,
      parents,
      height,
    });

    const signature = this.sign(tbs);

    return {
      parents,
      height,
      chain,
      timestamp,
      body,
      signature,
    };
  }

  //
  // Sign/verify
  //

  sign(tbs) {
    const sodium = this.sodium;
    const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
    sodium.crypto_sign_detached(signature, tbs, this[kSecretKey]);
    return signature;
  }

  static verify({ sodium, signature, tbs, publicKey }) {
    if (signature.length !== sodium.crypto_sign_BYTES) {
      throw new BanError('Invalid signature length');
    }

    if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
      throw new BanError('Invalid public key length');
    }

    return sodium.crypto_sign_verify_detached(
      signature,
      tbs,
      publicKey);
  }

  //
  // Invites
  //

  requestInvite(peerId) {
    const sodium = this.sodium;
    const box = new EphemeralBox({ sodium });

    const request = PInviteRequest.encode({
      peerId,
      trusteePubKey: this.publicKey,
      boxPubKey: box.publicKey,
    }).finish();

    const requestId = this.inviteRequestIdFor(box.publicKey);

    const decrypt = (encrypted) => {
      if (encrypted.requestId.length !== INVITE_REQUEST_ID_LENGTH) {
        throw new BanError('Invalid invite request id length');
      }
      if (!encrypted.requestId.equals(requestId)) {
        throw new BanError('Invalid invite request id');
      }

      const cleartext = box.decrypt(encrypted.box);
      const invite = PInvite.decode(cleartext);

      if (invite.channelName.length > MAX_INVITE_NAME_LENGTH) {
        throw new BanError('Invalid invite channel name length: ' +
          invite.channelName.length);
      }

      if (invite.channelPubKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
        throw new BanError('Invalid invite channel public key length: ' +
          invite.channelPubKey.length);
      }

      return invite;
    };

    return { requestId, request, decrypt };
  }

  canPost(channel, timestamp = now()) {
    const chain = this.getChain(channel);
    if (!chain) {
      return false;
    }
    return chain.verify(channel, timestamp);
  }

  canInvite(channel, timestamp = now()) {
    if (!this.canPost(channel, timestamp)) {
      return false;
    }

    return this.getChain(channel).canAppend();
  }

  issueInvite(channel, requestData, trusteeDisplayName) {
    const sodium = this.sodium;
    const request = PInviteRequest.decode(requestData);

    if (request.trusteePubKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
      throw new BanError('Invalid `trusteePubKey` length');
    }
    if (request.peerId.length > Peer.ID_LENGTH) {
      throw new BanError('Invalid `peerId` length');
    }

    if (!this.canPost(channel)) {
      throw new Error(
        'Can\'t invite to the channel without having write access to it');
    }

    if (!this.canInvite(channel)) {
      throw new Error(
        'Can\'t invite to the channel due to maximum trust chain length');
    }

    const link = this.issueLink(channel, {
      trusteePubKey: request.trusteePubKey,
      trusteeDisplayName,
    });

    const chain = this.getChain(channel);
    const inviteChain = Chain.append(chain, link);

    const invite = PInvite.encode({
      channelPubKey: channel.publicKey,
      channelName: channel.name.slice(0, MAX_INVITE_NAME_LENGTH),
      chain: inviteChain.serialize(),
    }).finish();

    const box = EphemeralBox.encryptFor(request.boxPubKey, invite, {
      sodium,
    });

    const requestId = this.inviteRequestIdFor(request.boxPubKey);

    return {
      encryptedInvite: {
        requestId,
        box,
      },
      peerId: request.peerId,
    };
  }

  // Internal
  inviteRequestIdFor(publicKey) {
    const requestId = Buffer.alloc(INVITE_REQUEST_ID_LENGTH);
    this.sodium.crypto_generichash(requestId, publicKey, 'peerlinks-invite');
    return requestId;
  }

  //
  // Serialize/Deserialize
  //

  serialize() {
    const channelChains = [];
    // Channel => Chain
    for (const [ channelId, chain ] of this.chains) {
      channelChains.push({
        channelId: Buffer.from(channelId, 'hex'),
        links: chain.serialize(),
      });
    }

    return {
      name: this.name,
      publicKey: this.publicKey,
      secretKey: this[kSecretKey],
      channelChains,

      metadata: this.metadata ? JSON.stringify(this.metadata) : '',
    };
  }

  serializeData() {
    return PIdentity.encode(this.serialize()).finish();
  }

  static deserialize(decoded, options) {
    const id = new Identity(decoded.name, {
      sodium: options.sodium,
      publicKey: decoded.publicKey,
      secretKey: decoded.secretKey,
    });

    // NOTE: a bit of internals of `Identity`, but we have to skip the
    // validation in `addChain()`.
    for (const { channelId, links } of decoded.channelChains) {
      const chain = Chain.deserialize(links, {
        sodium: options.sodium,
      });
      id.chains.set(channelId.toString('hex'), chain);
    }
    if (decoded.metadata) {
      try {
        id.setMetadata(JSON.parse(decoded.metadata));
      } catch (e) {
        debug('id=%s failed to parse stored metadata', this.debugHash);
      }
    }
    return id;
  }

  static deserializeData(data, options) {
    return Identity.deserialize(PIdentity.decode(data), options);
  }

  static compare(a, b) {
    if (a.name > b.name) {
      return 1;
    } else if (a.name < b.name) {
      return -1;
    } else {
      return 0;
    }
  }
}

// Convenience:
Identity.MAX_INVITE_NAME_LENGTH = MAX_INVITE_NAME_LENGTH;
Identity.INVITE_REQUEST_ID_LENGTH = INVITE_REQUEST_ID_LENGTH;
