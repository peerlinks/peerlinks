import * as sodium from 'sodium-universal';
import { Buffer } from 'buffer';

import { now } from '../utils';
import {
  Identity as PIdentity,
  Invite as PInvite,
  InviteRequest as PInviteRequest,
} from '../messages';
import Peer from '../peer';

import Link, { LINK_EXPIRATION_DELTA } from './link';
import Message from './message';
import Chain from './chain';

export const MAX_INVITE_NAME_LENGTH = 128;
export const INVITE_REQUEST_ID_LENGTH = sodium.crypto_box_PUBLICKEYBYTES;

// The property is ours. The symbol prevents uncontrolled use from other
// internal modules.
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

  clear() {
    if (sodium.sodium_memzero) {
      sodium.sodium_memzero(this[kSecretKey]);
    } else {
      this[kSecretKey].fill(0);
    }
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
    if (!leafKey.equals(this.publicKey)) {
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

    const decrypt = (encrypted) => {
      if (encrypted.requestId.length !== INVITE_REQUEST_ID_LENGTH) {
        throw new Error('Invalid invite request id length');
      }
      if (!encrypted.requestId.equals(boxPubKey)) {
        throw new Error('Invalid invite request id');
      }

      const cleartext = Buffer.alloc(
        encrypted.box.length - sodium.crypto_box_SEALBYTES);

      // TODO(indutny): implement it in `sodium-javascript`
      // https://github.com/sodium-friends/sodium-javascript/pull/16
      const isSuccess = sodium.crypto_box_seal_open(
        cleartext, encrypted.box, boxPubKey, boxSecretKey)

      if (!isSuccess) {
        throw new Error('Invalid encrypted invite. Failed to decrypt');
      }

      const invite = PInvite.decode(cleartext);

      if (invite.channelName.length > MAX_INVITE_NAME_LENGTH) {
        throw new Error('Invalid invite channel name length: ' +
          invite.channelName.length);
      }

      if (invite.channelPubKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
        throw new Error('Invalid invite channel public key length: ' +
          invite.channelPubKey.length);
      }

      return invite;
    };

    return { requestId: boxPubKey, request, decrypt };
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
    if (request.peerId.length > Peer.ID_LENGTH) {
      throw new Error('Invalid `peerId` length');
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
      channelName: channel.name.slice(0, MAX_INVITE_NAME_LENGTH),
      channelRoot: channel.root.serialize(),
      chain: inviteChain.serialize(),
    }).finish();

    const ciphertext = Buffer.alloc(
      invite.length + sodium.crypto_box_SEALBYTES);

    // TODO(indutny): implement it in `sodium-javascript`
    // https://github.com/sodium-friends/sodium-javascript/pull/16
    sodium.crypto_box_seal(ciphertext, invite, request.boxPubKey);

    return {
      encryptedInvite: {
        requestId: request.boxPubKey,
        box: ciphertext,
      },
      peerId: request.peerId,
    };
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
    };
  }

  serializeData() {
    return PIdentity.encode(this.serialize()).finish();
  }

  static deserialize(decoded) {
    const id = new Identity(decoded.name, {
      publicKey: decoded.publicKey,
      secretKey: decoded.secretKey,
    });

    // NOTE: a bit of internals of `Identity`, but we have to skip the
    // validation in `addChain()`.
    for (const { channelId, links } of decoded.channelChains) {
      id.chains.set(channelId.toString('hex'), Chain.deserialize(links));
    }
    return id;
  }

  static deserializeData(data) {
    return Identity.deserialize(PIdentity.decode(data));
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
