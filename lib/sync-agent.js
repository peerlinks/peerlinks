import createDebug from 'debug';
import WaitList from 'promise-waitlist';

import Message from './protocol/message';
import { Packet as PPacket } from './messages';

const debug = createDebug('vowlink:sync-agent');

const DEFAULT_TIMEOUT = 15 * 1000; // 15 seconds

export default class SyncAgent {
  constructor(options = {}) {
    this.state = 'idle';
    this.options = {
      timeout: DEFAULT_TIMEOUT,
      ...options,
    };

    this.sodium = this.options.sodium;
    this.channel = this.options.channel;
    this.socket = this.options.socket;

    if (!this.sodium) {
      throw new Error('Missing required `sodium` option');
    }
    if (!this.channel) {
      throw new Error('Missing required `channel` option');
    }
    if (!this.socket) {
      throw new Error('Missing required `socket` option');
    }

    this.timeoutWaitList = new WaitList();

    this.seq = 0;
    this.resolveResponse = {
      // seq => Function
      query: new Map(),
      // seq => Function
      bulk: new Map(),
    };
  }

  destroy() {
    this.timeoutWaitList.close(new Error('SyncAgent destroyed'));
  }

  async synchronize() {
    this.debug('synchronize() state=%s', this.state);
    if (this.state === 'idle') {
      this.state = 'active';
    } else if (this.state === 'active') {
      this.state = 'pending';
    } else {
      // Already pending
      return;
    }

    this.debug('synchronize() starting sync');
    await this.channel.sync(this);
    this.debug('synchronize() starting sync complete');

    const isPending = this.state === 'pending';
    this.state = 'idle';

    // Repeat synchronization if it was pending
    if (isPending) {
      this.debug('synchronize() restarting sync');
      return await this.synchronize();
    }
  }

  async receiveQuery(query) {
    this.debug('receiveQuery() seq=%d', query.seq);
    const cursor = query.cursor === 'hash' ? { hash: query.hash } :
      { height: query.height };

    const result = await this.channel.query(
      cursor, query.isBackward, query.limit);

    const queryResponse = {
      channelId: query.channelId,
      seq: query.seq,
      ...result,
    };

    await this.socket.send(PPacket.encode({
      queryResponse,
    }).finish());
  }

  async receiveBulk(bulk) {
    this.debug('receiveBulk() seq=%d', bulk.seq);
    const result = await this.channel.bulk(bulk.hashes);

    const bulkResponse = {
      channelId: bulk.channelId,
      seq: bulk.seq,
      ...result,
    };

    await this.socket.send(PPacket.encode({
      bulkResponse,
    }).finish());
  }

  async receiveQueryResponse(response) {
    this.debug('receiveQueryResponse() seq=%d', response.seq);
    const resolve = this.resolveResponse.query.get(response.seq);
    if (!resolve) {
      throw new Error('Unexpected QueryResponse');
    }

    resolve(response);
  }

  async receiveBulkResponse(response) {
    this.debug('receiveBulkResponse() seq=%d', response.seq);
    const resolve = this.resolveResponse.bulk.get(response.seq);
    if (!resolve) {
      throw new Error('Unexpected BulkResponse');
    }

    resolve(response);
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

  async sendAndWait(type, seq, packet) {
    const queryResponse = new Promise((resolve) => {
      this.resolveResponse[type].set(seq, resolve);
    });

    this.debug('sendAndWait %s seq=%d waiting=%d',
      type,
      seq,
      this.resolveResponse[type].size);

    await this.socket.send(PPacket.encode(packet).finish());

    const entry = this.timeoutWaitList.waitFor(null, this.options.timeout);

    try {
      return await Promise.race([
        queryResponse,
        entry.promise,
      ]);
    } finally {
      this.resolveResponse[type].delete(seq);
      entry.cancel();
    }
  }

  getNextSeq() {
    const result = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    return result;
  }

  debug(fmt, ...args) {
    debug('channel.id=%s ' + fmt, ...[ this.channel.debugId ].concat(args));
  }
}
