import createDebug from 'debug';
import WaitList from 'promise-waitlist';

import Identity from './protocol/identity';
import Message from './protocol/message';
import {
  Packet as PPacket,
  SyncRequest as PSyncRequest,
} from './messages';
import { BanError, EphemeralBox } from './utils';

const debug = createDebug('peerlinks:sync-agent');

const DEFAULT_TIMEOUT = 15 * 1000; // 15 seconds

export default class SyncAgent {
  constructor(options = {}) {
    this.state = 'idle';
    this.options = {
      timeout: DEFAULT_TIMEOUT,
      peerDebugId: '',
      ...options,
    };

    this.sodium = this.options.sodium;
    this.peerDebugId = this.options.peerDebugId;
    this.channel = this.options.channel;
    this.identities = this.options.identities;
    this.socket = this.options.socket;

    if (!this.sodium) {
      throw new Error('Missing required `sodium` option');
    }
    if (!this.channel) {
      throw new Error('Missing required `channel` option');
    }
    if (!this.identities) {
      throw new Error('Missing required `identities` option');
    }
    if (!this.socket) {
      throw new Error('Missing required `socket` option');
    }

    this.destroyed = false;

    this.debugId = this.peerDebugId + '/' + this.channel.debugId;

    this.waitList = new WaitList();

    this.seq = 0;

    // seq => { type, identity, resolve() }
    this.pendingRequests = new Map();
  }

  destroy() {
    if (this.destroyed) {
      return;
    }

    this.debug('destroy()');
    this.destroyed = true;
    this.waitList.close(new Error('SyncAgent destroyed'));
  }

  async synchronize() {
    if (this.destroyed) {
      return 0;
    }

    this.debug('synchronize() state=%s', this.state);
    if (this.state === 'idle') {
      this.state = 'active';
    } else if (this.state === 'active') {
      this.state = 'pending';
    } else {
      // Already pending
      return 0;
    }

    this.debug('synchronize() starting sync');
    const delta = await this.channel.sync(this);
    this.debug('synchronize() sync complete');

    const isPending = this.state === 'pending';
    this.state = 'idle';

    // Repeat synchronization if it was pending
    if (isPending) {
      this.debug('synchronize() restarting sync');
      return delta + await this.synchronize();
    }

    return delta;
  }

  getRequestBox(seq) {
    const entry = this.pendingRequests.get(seq);
    return entry && entry.requestBox;
  }

  async receiveQuery(seq, query) {
    this.debug('receiveQuery() seq=%d', seq);
    const cursor = query.cursor === 'hash' ? { hash: query.hash } :
      { height: query.height };

    const result = await this.channel.query(
      cursor, query.isBackward, query.limit);

    const queryResponse = {
      channelId: query.channelId,
      ...result,
    };

    return { queryResponse };
  }

  async receiveBulk(seq, bulk) {
    this.debug('receiveBulk() seq=%d', seq);
    const result = await this.channel.bulk(bulk.hashes);

    const bulkResponse = {
      channelId: bulk.channelId,
      messages: result.messages.map((message) => message.serialize()),
      forwardIndex: result.forwardIndex,
    };

    return { bulkResponse };
  }

  async receiveEmptyResponse(seq) {
    this.debug('receiveEmptyResponse() seq=%d', seq);

    const entry = this.pendingRequests.get(seq);
    if (!entry) {
      throw new BanError('Unexpected empty response');
    }

    this.waitList.resolve(`${this.debugId}/${entry.type}/${seq}`, null);
  }

  async receiveQueryResponse(seq, response) {
    this.debug('receiveQueryResponse() seq=%d', seq);
    const entry = this.pendingRequests.get(seq);
    if (!entry) {
      throw new BanError('Unexpected QueryResponse');
    }
    if (entry.type !== 'query') {
      throw new BanError('Expected QueryResponse for this seq');
    }

    this.waitList.resolve(`${this.debugId}/query/${seq}`, response);
  }

  async receiveBulkResponse(seq, response) {
    this.debug('receiveBulkResponse() seq=%d', seq);
    const entry = this.pendingRequests.get(seq);
    if (!entry) {
      throw new BanError('Unexpected BulkResponse');
    }
    if (entry.type !== 'bulk') {
      throw new BanError('Expected BulkResponse for this seq');
    }

    this.waitList.resolve(`${this.debugId}/bulk/${seq}`, response);
  }

  //
  // Synchronization methods for Channel remote
  //

  async query(cursor, isBackward, limit) {
    const seq = this.getNextSeq();
    const packet = Object.assign({
      channelId: this.channel.id,
      seq,
      isBackward,
      limit,
    }, cursor.hash ? { hash: cursor.hash } : { height: cursor.height });

    const response = await this.sendAndWait('query', seq, { query: packet });
    if (!response) {
      return { abbreviatedMessages: [], forwardHash: null, backwardHash: null };
    }

    return {
      abbreviatedMessages: response.abbreviatedMessages,
      forwardHash: response.forwardHash.length === 0 ? null :
        response.forwardHash,
      backwardHash: response.backwardHash.length === 0 ? null :
        response.backwardHash,
    };
  }

  async bulk(hashes) {
    const seq = this.getNextSeq();
    const packet = {
      channelId: this.channel.id,
      seq,
      hashes,
    };

    const response = await this.sendAndWait('bulk', seq, { bulk: packet });
    if (!response) {
      return { messages: [], forwardIndex: 0 };
    }

    return {
      messages: response.messages.map((decoded) => {
        return Message.deserialize(decoded, { sodium: this.sodium });
      }),
      forwardIndex: response.forwardIndex,
    };
  }

  //
  // Utils
  //

  findIdentityAndChain() {
    // Do not reveal our identity to feeds
    if (this.channel.isFeed) {
      return {
        identity: new Identity('(feed-requestor)', { sodium: this.sodium }),
        chain: null,
      };
    }

    // TODO(indutny): this seems somewhat unoptimal?
    const pairs = this.identities.map((identity) => {
      return { identity, chain: identity.getChain(this.channel) };
    }).filter(({ chain }) => !!chain).sort((a, b) => {
      if (a.chain.isBetterThan(b.chain)) {
        return -1;
      } else {
        return 1;
      }
    });

    if (pairs.length === 0) {
      throw new Error('No valid identities to sync to the channel');
    }

    return pairs[0];
  }

  async sendAndWait(type, seq, packet) {
    // NOTE: We have no control over channel that syncs using us as remote
    if (this.destroyed) {
      throw new Error('Destroyed');
    }

    const sodium = this.sodium;

    const { identity, chain } = this.findIdentityAndChain();
    const requestBox = new EphemeralBox({ sodium });

    this.pendingRequests.set(seq, {
      type,
      identity,
      requestBox,
    });

    this.debug('sendAndWait %s seq=%d waiting=%d',
      type,
      seq,
      this.pendingRequests.size);

    const queryResponse = this.waitList.waitFor(
      `${this.debugId}/${type}/${seq}`, this.options.timeout);

    const tbs = {
      ...packet,

      ...(chain ? {
        chain: chain.serialize(),
      } : {}),

      responsePubKey: requestBox.publicKey,
    };

    const signature = identity.sign(PSyncRequest.TBS.encode(tbs).finish());

    const content = {
      tbs,
      signature,
    };

    const clear = PSyncRequest.Content.encode(content).finish();
    const { box, nonce } = this.channel.encrypt(clear);

    const send = this.socket.send(PPacket.encode({
      syncRequest: {
        channelId: this.channel.id,
        seq,
        nonce,
        box,
      },
    }).finish());

    try {
      const [ _, response ] = await Promise.all([ send, queryResponse ]);
      return response;
    } finally {
      this.pendingRequests.delete(seq);
    }
  }

  getNextSeq() {
    const result = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    return result;
  }

  debug(fmt, ...args) {
    debug('sync-agent.id=%s ' + fmt, ...[ this.debugId ].concat(args));
  }
}
