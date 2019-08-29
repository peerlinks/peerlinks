import createDebug from 'debug';
import WaitList from 'promise-waitlist';

import Channel from './protocol/channel';
import Identity from './protocol/identity';
import Message from './protocol/message';
import {
  Hello as PHello,
  Shake as PShake,
  Packet as PPacket,
} from './messages';
import SyncAgent from './sync-agent';
import { compareDistance, BanError } from './utils';

const debug = createDebug('vowlink:peer');

export const VERSION = 2;
export const MAX_ERROR_REASON_LEN = 1024;
export const ID_LENGTH = 32;
export const HANDSHAKE_TIMEOUT = 5000;

// "Unique" id for logging
let uid = 0;

export default class Peer {
  /** **(Internal)** */
  constructor(options = {}) {
    const {
      sodium,
      localId,
      socket,
      globalPeerIds = new Set(),
      channels = [],
      inviteWaitList = new WaitList(),
    } = options;

    if (!sodium) {
      throw new Error('Missing required `sodium` option');
    }
    if (!localId) {
      throw new Error('Missing required `localId` option');
    }
    if (!socket) {
      throw new Error('Missing required `socket` option');
    }

    this.sodium = sodium;

    this.localId = localId;
    this.remoteId = null;
    this.destroyed = false;

    this.debugId = '[not ready]';

    this.socket = socket;

    this.globalPeerIds = globalPeerIds;
    this.channels = channels;
    this.inviteWaitList = inviteWaitList;

    // Channel => "active" | "pending"
    this.syncAgents = new Map();
  }

  //
  // High-level protocol
  //

  /** **(Internal)** */
  async ready() {
    await this.socket.send(PHello.encode({
      version: VERSION,
      peerId: this.localId,
    }).finish());

    const first = await this.socket.receive(HANDSHAKE_TIMEOUT);
    const hello = PHello.decode(first);
    if (hello.version !== VERSION) {
      throw new BanError('Unsupported protocol version: ' + hello.version);
    }
    if (hello.peerId.length !== ID_LENGTH) {
      throw new BanError(
        'Invalid remote peer id length: ' + hello.peerId.length);
    }
    this.remoteId = hello.peerId;
    this.debugId = this.remoteId.toString('hex').slice(0, 8) + ':' + uid;
    uid = (uid + 1) >>> 0;

    this.debug('got hello');

    const compare = compareDistance(this.localId, this.remoteId);
    const shouldShake = compare < 0;

    const remoteHexId = this.remoteId.toString('hex');
    const isDuplicate = this.globalPeerIds.has(remoteHexId) || compare === 0;
    this.globalPeerIds.add(remoteHexId);

    if (shouldShake) {
      this.debug('shaking isDuplicate=%j', isDuplicate);
      await this.socket.send(PShake.encode({
        isDuplicate,
      }).finish());

      if (isDuplicate) {
        this.remoteId = null;
        await this.destroy('Duplicate');
        return false;
      }

      return true;
    }

    const second = await this.socket.receive(HANDSHAKE_TIMEOUT);
    const shake = PShake.decode(second);
    this.debug('got shake isDuplicate=%j', shake.isDuplicate);

    if (shake.isDuplicate) {
      this.remoteId = null;
      await this.destroy('Duplicate');
      return false;
    }

    return true;
  }

  /** **(Internal)** */
  async loop() {
    this.debug('starting loop');

    for (const channel of this.channels) {
      this.synchronize(channel);
    }

    for (;;) {
      const data = await this.socket.receive();
      const packet = PPacket.decode(data);
      this.debug('got packet.type=%s', packet.content);

      switch (packet.content) {
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
          throw new BanError('Unsupported packet type: ' + packet.content);
      }
    }
  }

  /**
   * Send an invite to remote peer.
   *
   * @param {Object} invite - `encryptedInvite` property of
   *     `Identity#issueInvite`
   * @returns Promise
   */
  async sendInvite(invite) {
    this.debug('sending invite');
    const packet = PPacket.encode({
      invite,
    }).finish();
    await this.socket.send(packet);
  }

  /** **(Internal)** */
  async destroy(reason) {
    if (this.destroyed) {
      throw new Error('Already destroyed');
    }

    this.destroyed = true;
    this.debug('destroying due to reason=%s', reason);

    // Cleanup
    if (this.remoteId !== null) {
      const remoteHexId = this.remoteId.toString('hex');
      this.globalPeerIds.delete(remoteHexId);
    }

    for (const agent of this.syncAgents.values()) {
      agent.destroy();
    }

    const packet = PPacket.encode({
      error: { reason },
    }).finish();

    try {
      await this.socket.send(packet);
    } catch (e) {
      // swallow error
    }
    await this.socket.close();
  }

  //
  // Miscellaneous events
  //

  /** **(Internal)** */
  onNewChannel(channel) {
    this.synchronize(channel);
  }

  /** **(Internal)** */
  async onNewMessage(channel) {
    await this.socket.send(PPacket.encode({
      notification: {
        channelId: channel.id,
      },
    }).finish());
  }

  //
  // Handling packets
  //

  /** **(Internal)** */
  async onInvite(packet) {
    if (packet.requestId.length !== Identity.INVITE_REQUEST_ID_LENGTH) {
      throw new BanError('Invalid requestId in EncryptedInvite');
    }

    this.debug('got invite.id=%s',
      packet.requestId.toString('hex').slice(0, 8));
    this.inviteWaitList.resolve(packet.requestId.toString('hex'), packet);
  }

  /** **(Internal)** */
  async onQuery(packet) {
    Channel.checkId(packet.channelId, 'Invalid channelId in Query');
    if (packet.cursor === 'hash') {
      Message.checkHash(packet.hash, 'Invalid cursor.hash in Query');
    }

    const channel = this.getChannel(packet.channelId);
    if (!channel) {
      this.debug('responding to query for unknown channel');
      await this.socket.send(PPacket.encode({
        queryResponse: {
          channelId: packet.channelId,
          abbreviatedMessages: [],
          forwardHash: null,
          backwardHash: null,
        },
      }).finish());
      return;
    }

    this.debug('query for channel.id=%s', channel.debugId);
    return await this.getSyncAgent(channel).receiveQuery(packet);
  }

  /** **(Internal)** */
  async onQueryResponse(packet) {
    Channel.checkId(packet.channelId, 'Invalid channelId in QueryResponse');
    for (const abbr of packet.abbreviatedMessages) {
      Message.checkHash(abbr.hash, 'Invalid abbreviated message hash');
      for (const hash of abbr.parents) {
        Message.checkHash(hash, 'Invalid abbreviated message parent hash');
      }
    }
    if (packet.forwardHash.length !== 0) {
      Message.checkHash(packet.forwardHash, 'Invalid forward hash');
    }
    if (packet.backwardHash.length !== 0) {
      Message.checkHash(packet.backwardHash, 'Invalid backward hash');
    }

    const channel = this.getChannel(packet.channelId);
    if (!channel) {
      this.debug('ignoring query response for unknown channel');
      return;
    }

    return await this.getSyncAgent(channel).receiveQueryResponse(packet);
  }

  /** **(Internal)** */
  async onBulk(packet) {
    Channel.checkId(packet.channelId, 'Invalid channelId in Bulk');
    for (const hash of packet.hashes) {
      Message.checkHash(hash, 'Invalid message hash in Bulk');
    }

    const channel = this.getChannel(packet.channelId);
    if (!channel) {
      this.debug('responding bulk for unknown channel');
      await this.socket.send(PPacket.encode({
        bulkResponse: {
          channelId: packet.channelId,
          messages: [],
          forwardIndex: packet.hashes.length,
        },
      }).finish());
      return;
    }

    this.debug('bulk for channel.id=%s hashes.length=%d', channel.debugId,
      packet.hashes.length);
    return await this.getSyncAgent(channel).receiveBulk(packet);
  }

  /** **(Internal)** */
  async onBulkResponse(packet) {
    Channel.checkId(packet.channelId, 'Invalid channelId in BulkResponse');

    const channel = this.getChannel(packet.channelId);
    if (!channel) {
      this.debug('ignoring bulk response for unknown channel');
      return;
    }

    // NOTE: `Message` constructor will check each message
    return await this.getSyncAgent(channel).receiveBulkResponse(packet);
  }

  /** **(Internal)** */
  async onNotification(packet) {
    Channel.checkId(packet.channelId, 'Invalid channelId in Notification');

    const channel = this.getChannel(packet.channelId);
    if (!channel) {
      return;
    }

    this.debug('notification for channel.id=%s', channel.debugId);
    this.synchronize(channel);
  }

  //
  // Synchronization
  //

  /** **(Internal)** */
  synchronize(channel) {
    this.debug('channel.id=%s sync start', channel.debugId);
    this.getSyncAgent(channel).synchronize().catch((e) => {
      this.debug('channel.id=%s sync error.message=%s', channel.debugId,
        e.stack);
    });
  }

  //
  // Utils
  //

  /** **(Internal)** */
  getChannel(channelId) {
    return this.channels.find((channel) => {
      return channel.id.equals(channelId);
    });
  }

  /** **(Internal)** */
  getSyncAgent(channel) {
    let agent;
    if (this.syncAgents.has(channel)) {
      agent = this.syncAgents.get(channel);
    } else {
      agent = new SyncAgent({
        channel,
        socket: this.socket,
        sodium: this.sodium,
      });
      this.syncAgents.set(channel, agent);
    }
    return agent;
  }

  /** **(Internal)** */
  debug(fmt, ...args) {
    debug('id=%s ' + fmt, ...[ this.debugId ].concat(args));
  }
}

// Convenience
Peer.VERSION = VERSION;
Peer.MAX_ERROR_REASON_LEN = MAX_ERROR_REASON_LEN;
Peer.ID_LENGTH = ID_LENGTH;
