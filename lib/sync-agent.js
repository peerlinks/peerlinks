import Message from './protocol/message';
import { Packet as PPacket } from './messages';

const DEFAULT_TIMEOUT = 15 * 1000; // 15 seconds

export default class SyncAgent {
  constructor(channel, socket, { timeout } = {}) {
    this.state = 'idle';
    this.timeout = timeout || DEFAULT_TIMEOUT;

    this.channel = channel;
    this.socket = socket;

    this.resolveResponse = {
      query: [],
      bulk: [],
    };
  }

  async synchronize() {
    if (this.state === 'idle') {
      this.state = 'active';
    } else if (this.state === 'active') {
      this.state = 'pending';
    } else {
      // Already pending
      return;
    }

    await this.channel.sync(this);

    const isPending = this.state === 'pending';
    this.state = 'idle';

    // Repeat synchronization if it was pending
    if (isPending) {
      return await this.synchronize();
    }
  }

  async receiveQuery(query) {
    const cursor = query.cursor === 'hash' ? { hash: query.hash } :
      { height: query.height };

    const result = await this.channel.query(
      cursor, query.isBackward, query.limit);

    const queryResponse = Object.assign({
      channelId: query.channelId,
    }, result);

    await this.socket.send(PPacket.encode({
      queryResponse,
    }).finish());
  }

  async receiveBulk(bulk) {
    const result = await this.channel.bulk(bulk.hashes);

    const bulkResponse = Object.assign({
      channelId: bulk.channelId,
    }, result);

    await this.socket.send(PPacket.encode({
      bulkResponse,
    }).finish());
  }

  async receiveQueryResponse(response) {
    const resolve = this.resolveResponse.query.shift();
    if (!resolve) {
      throw new Error('Unexpected QueryResponse');
    }

    resolve(response);
  }

  async receiveBulkResponse(response) {
    const resolve = this.resolveResponse.bulk.shift();
    if (!resolve) {
      throw new Error('Unexpected BulkResponse');
    }

    resolve(response);
  }

  //
  // Synchronization methods for Channel remote
  //

  async query(cursor, isBackward, limit) {
    const packet = Object.assign({
      channelId: this.channel.id,
      isBackward,
      limit,
    }, cursor.hash ? { hash: cursor.hash } : { height: cursor.height });

    const response = await this.sendAndWait('query', { query: packet });

    return {
      abbreviatedMessages: response.abbreviatedMessages,
      forwardHash: response.forwardHash.length === 0 ? null :
        response.forwardHash,
      backwardHash: response.backwardHash.length === 0 ? null :
        response.backwardHash,
    };
  }

  async bulk(hashes) {
    const packet = {
      channelId: this.channel.id,
      hashes,
    };

    const response = await this.sendAndWait('bulk', { bulk: packet });

    return {
      messages: response.messages.map((decoded) => {
        return Message.deserialize(decoded);
      }),
      forwardIndex: response.forwardIndex,
    };
  }

  //
  // Utils
  //

  async sendAndWait(type, packet) {
    let queueElem;

    const queryResponse = new Promise((resolve) => {
      queueElem = resolve;
      this.resolveResponse[type].push(queueElem);
    });

    this.debug('sendAndWait %s waiting=%d', type,
      this.resolveResponse[type].length);

    await this.socket.send(PPacket.encode(packet).finish());

    const timeout = this.socket.timeout(
      `SyncAgent.sendAndWait(${type})`,
      this.timeout);

    try {
      return await Promise.race([
        queryResponse,
        timeout.promise,
      ]);
    } catch (e) {
      this.debug('sendAndWait %s error=%s', type, e.stack);

      const index = this.resolveResponse[type].indexOf(queueElem);
      if (index !== -1) {
        this.resolveResponse[type].splice(index, 1);
      }
      throw e;
    } finally {
      timeout.cancel();
    }
  }
}
