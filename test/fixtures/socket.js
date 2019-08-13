import { SocketBase } from '../../';

export default class Socket extends SocketBase {
  constructor(name) {
    super();

    this.id = name;
    this.remote = null;

    this.closed = false;
    this.queue = [];
    this.receiveQueue = [];
  }

  async send(data) {
    if (this.closed) {
      throw new Error('Socket closed');
    }
    this.remote.push(data);
  }

  async receive() {
    if (this.closed) {
      throw new Error('Socket closed');
    }
    if (this.queue.length !== 0) {
      return this.queue.shift();
    }

    return await new Promise((resolve, reject) => {
      this.receiveQueue.push({ resolve, reject });
    });
  }

  async close() {
    super.close();

    for (const timer of this.timers) {
      clearTimeout(timer);
    }
  }

  // Internal

  push(data) {
    if (this.receiveQueue.length !== 0) {
      return this.receiveQueue.shift().resolve(data);
    }

    this.queue.push(data);
  }

  static pair() {
    const a = new Socket('a');
    const b = new Socket('b');

    a.remote = b;
    b.remote = a;

    return [ a, b ];
  }
}
