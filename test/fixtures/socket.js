export default class Socket {
  constructor(name) {
    this.id = name;
    this.remote = null;

    this.closed = false;
    this.queue = [];
    this.receiveQueue = [];

    this.timers = new Set();
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

  timeout(ms) {
    let timer;

    const promise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Timed out'));
      }, ms);
    });

    this.timers.add(timer);

    return {
      promise,
      cancel: () => {
        clearTimeout(timer);
        this.timers.delete(timer);
      },
    };
  }

  async close() {
    while (this.receiveQueue.length !== 0) {
      const elem = this.receiveQueue.shift();
      return elem.reject(new Error('Closed'));
    }

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
