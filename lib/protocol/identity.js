import * as sodium from 'sodium-universal';
import { Buffer } from 'buffer';

import { now } from '../utils';
import {
  Invite as PInvite,
  InviteRequest as PInviteRequest,
  EncryptedInvite as PEncryptedInvite,
} from '../messages';

import Link, { LINK_EXPIRATION_DELTA } from './link';
import Message from './message';
import Chain from './chain';

// The property is ours
const kSecretKey = Symbol('secretKey');

export default class Identity {
  constructor(name, { publicKey, secretKey } = {}) {
    this.name = name;
    this.publicKey = publicKey;
    this[kSecretKey] = secretKey;
    if (!this.publicKey || !this[kSecretKey]) {
      this.publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
      this[kSecretKey] = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
      sodium.crypto_sign_keypair(this.publicKey, this[kSecretKey]);
    }

    // Channel => Chain
    this.chains = new Map();

    this.debugHash = this.publicKey.toString('hex').slice(0, 8);
  }

  //
  // Chains
  //

  issueLink(channel, { expiration, trusteePubKey }) {
    if (!expiration) {
      expiration = now() + LINK_EXPIRATION_DELTA;
    }

    const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
    const tbs = Link.tbs(channel, {
      trusteePubKey: trusteePubKey,
      expiration: expiration,
    });
    sodium.crypto_sign_detached(signature, tbs, this[kSecretKey]);

    return new Link({ expiration, trusteePubKey, signature });
  }

  addChain(channel, chain) {
    const leafKey = chain.getLeafKey(channel);
    if (Buffer.compare(leafKey, this.publicKey) !== 0) {
      throw new Error('Invalid leaf key in the chain');
    }
    this.chains.set(channel.id.toString('hex'), chain);
  }

  getChain(channel) {
    return this.chains.get(channel.id.toString('hex'));
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

    const tbs = Message.tbs({
      chain: chain.serialize(),
      timestamp,
      body,
      parents,
      height,
    });

    const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
    sodium.crypto_sign_detached(signature, tbs, this[kSecretKey]);

    return {
      chain: chain.serialize(),
      timestamp,
      body,
      signature,
    };
  }

  //
  // Invites
  //

  requestInvite(peerId) {
    const boxPubKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
    const boxSecretKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
    sodium.crypto_box_keypair(boxPubKey, boxSecretKey);

    const request = PInviteRequest.encode({
      peerId,
      trusteePubKey: this.publicKey,
      boxPubKey,
    }).finish();

    const decrypt = (response) => {
      const encrypted = PEncryptedInvite.decode(response).box;

      const cleartext = Buffer.alloc(
        encrypted.length - sodium.crypto_box_SEALBYTES);

      // TODO(indutny): implement it in `sodium-javascript`
      const isSuccess = sodium.crypto_box_seal_open(
        cleartext, encrypted, boxPubKey, boxSecretKey)

      if (!isSuccess) {
        throw new Error('Invalid encrypted invite. Failed to decrypt');
      }

      return PInvite.decode(cleartext);
    };

    return { request, decrypt };
  }

  canInvite(channel) {
    const chain = this.getChain(channel);
    if (!chain) {
      return false;
    }
    return chain.verify(channel);
  }

  issueInvite(channel, requestData) {
    const request = PInviteRequest.decode(requestData);

    if (request.trusteePubKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
      throw new Error('Invalid `trusteePubKey` length');
    }
    if (request.boxPubKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
      throw new Error('Invalid `boxPubKey` length');
    }

    if (!this.canInvite(channel)) {
      throw new Error(
        'Can\'t invite to the channel without having write access to it');
    }

    const link = this.issueLink(channel, {
      trusteePubKey: request.trusteePubKey,
    });

    const chain = this.getChain(channel);
    const inviteChain = Chain.append(chain, link);

    const invite = PInvite.encode({
      channelPubKey: channel.publicKey,
      channelName: channel.name,
      channelRoot: channel.root.serialize(),
      chain: inviteChain.serialize(),
    }).finish();

    const ciphertext = Buffer.alloc(
      invite.length + sodium.crypto_box_SEALBYTES);
    sodium.crypto_box_seal(ciphertext, invite, request.boxPubKey);

    return {
      encryptedInvite: PEncryptedInvite.encode({
        box: ciphertext,
      }).finish(),
      peerId: request.peerId,
    };
  }
}
