import createDebug from 'debug';

import Channel from './protocol/channel';
import {
  Hello as PHello,
  Packet as PPacket,
} from './messages';

const debug = createDebug('vowlink:peer');

export const VERSION = 1;
export const MAX_ERROR_REASON_LEN = 1024;
export const MAX_SUBSCRIPTIONS = 1024;

export default class Peer {
  constructor(socket) {
    this.id = socket.id;
    this.socket = socket;

    this.subscriptions = new Set();
  }

  //
  // High-level protocol
  //

  addSubscription(channelId) {
    this.subscriptions.add(channelId.toString('hex'));

    if (this.subscriptions.length <= MAX_SUBSCRIPTIONS) {
      return;
    }

    // Trim subscriptions randomly on overflow
    const keys = Array.from(this.subscriptions);
    const random = keys[Math.floor(Math.random() * keys.length)];
    this.subscriptions.delete(random);
  }

  async start() {
    this.debug('connected');

    await this.socket.send(PHello.encode({
      version: VERSION,
    }).finish());

    const first = await this.socket.receive();
    const hello = PHello.decode(first);
    if (hello.version !== VERSION) {
      throw new Error('Unsupported protocol version: ' + hello.version);
    }

    this.debug('got hello');
  }

  async subscribe(channel) {
    this.debug('sending subscription channel.id=%s', channel.debugId);
    const packet = PPacket.encode({
      subscribe: { channelId: channel.id },
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

  async loop() {
    for (;;) {
      const data = await this.socket.receive();
      const packet = PPacket.decode(data);

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

  //
  // Handling packets
  //

  async onSubscribe(packet) {
    if (packet.channelId.length !== Channel.ID_SIZE) {
      throw new Error('Invalid channelId in Subscribe');
    }

    this.debug('adding subscription to channel.id=%s',
      packet.channelId.toString('hex').slice(0, 8));
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
    debug('id=%s ' + fmt, ...[ this.id ].concat(args));
  }
}

// Convenience
Peer.VERSION = VERSION;
Peer.MAX_ERROR_REASON_LEN = MAX_ERROR_REASON_LEN;
Peer.MAX_SUBSCRIPTIONS = MAX_SUBSCRIPTIONS;
