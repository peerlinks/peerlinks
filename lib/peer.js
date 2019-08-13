import createDebug from 'debug';

import Channel from './protocol/channel';
import {
  Hello as PHello,
  Packet as PPacket,
} from './messages';

const debug = createDebug('vowlink:peer');

export const VERSION = 1;
export const MAX_ERROR_REASON_LEN = 1024;
export const ID_LENGTH = 32;

export default class Peer {
  constructor(localId, socket, channels = []) {
    this.localId = localId;
    this.remoteId = null;

    this.debugId = '[not ready]';

    this.socket = socket;
    this.channels = channels;

    // Set<Channel>
    this.subscriptions = new Set();
  }

  //
  // High-level protocol
  //

  addSubscription(channelId) {
    const channel = this.channels.find((channel) => {
      return channel.id.equals(channelId);
    });
    if (!channel) {
      return;
    }
    this.subscriptions.add(channel);
    this.debug('adding subscription to channel.id=%s', channel.debugId);
  }

  async ready() {
    await this.socket.send(PHello.encode({
      version: VERSION,
      peerId: this.localId,
    }).finish());

    const first = await this.socket.receive();
    const hello = PHello.decode(first);
    if (hello.version !== VERSION) {
      throw new Error('Unsupported protocol version: ' + hello.version);
    }
    if (hello.peerId.length !== ID_LENGTH) {
      throw new Error('Invalid remote peer id length: ' + hello.peerId.length);
    }
    this.remoteId = hello.peerId;
    this.debugId = this.remoteId.toString('hex').slice(0, 8);

    this.debug('got hello');

    for (const channel of this.channels) {
      await this.subscribe(channel);
    }
  }

  async loop() {
    this.debug('starting loop');

    for (;;) {
      const data = await this.socket.receive();
      const packet = PPacket.decode(data);
      this.debug('got packet.type=%s', packet.content);

      switch (packet.content) {
        case 'subscribe':
          await this.onSubscribe(packet.subscribe);
          break;
        case 'error':
          throw new Error('Got error: ' +
            packet.error.reason.slice(0, MAX_ERROR_REASON_LEN));
        case 'invite':
          await this.onInvite(packet.invite);
          break;
        case 'query':
          await this.onQuery(packet.query);
          break;
        case 'queryResponse':
          await this.onQueryResponse(packet.queryResponse);
          break;
        case 'bulk':
          await this.onBulk(packet.bulk);
          break;
        case 'bulkResponse':
          await this.onBulkResponse(packet.bulkResponse);
          break;
        case 'notification':
          await this.onNotification(packet.notification);
          break;
        default:
          throw new Error('Unsupported packet type: ' + packet.content);
      }
    }
  }

  async subscribe(channel) {
    this.debug('sending subscription channel.id=%s', channel.debugId);
    const packet = PPacket.encode({
      subscribe: { channelId: channel.id },
    }).finish();
    await this.socket.send(packet);
  }

  async sendInvite(encryptedInvite) {
    this.debug('sending invite', channel.debugId);
    const packet = PPacket.encode({
      encryptedInvite,
    }).finish();
    await this.socket.send(packet);
  }

  async destroy(reason) {
    this.debug('destroying due to reason=%s', reason);

    const packet = PPacket.encode({
      error: { reason },
    }).finish();

    try {
      await this.socket.send(packet);
    } catch {
      // swallow error
    }
    await this.socket.close();
  }

  //
  // Handling packets
  //

  async onSubscribe(packet) {
    if (packet.channelId.length !== Channel.ID_SIZE) {
      throw new Error('Invalid channelId in Subscribe');
    }

    this.addSubscription(packet.channelId);
  }

  async onInvite(packet) {
    throw new Error('TODO(indutny): implement me');
  }

  async onQuery(packet) {
    throw new Error('TODO(indutny): implement me');
  }

  async onQueryResponse(packet) {
    throw new Error('TODO(indutny): implement me');
  }

  async onBulk(packet) {
    throw new Error('TODO(indutny): implement me');
  }

  async onBulkResponse(packet) {
    throw new Error('TODO(indutny): implement me');
  }

  async onNotification(packet) {
    throw new Error('TODO(indutny): implement me');
  }

  //
  // Utils
  //
  debug(fmt, ...args) {
    debug('id=%s ' + fmt, ...[ this.debugId ].concat(args));
  }
}

// Convenience
Peer.VERSION = VERSION;
Peer.MAX_ERROR_REASON_LEN = MAX_ERROR_REASON_LEN;
Peer.ID_LENGTH = ID_LENGTH;
