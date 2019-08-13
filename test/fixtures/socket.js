export default class Socket {
  constructor(name) {
    this.id = name;
    this.remote = null;

    this.queue = [];
    this.receiveQueue = [];
  }

  async send(data) {
    this.remote.push(data);
  }

  async receive() {
    if (this.queue.length !== 0) {
      const elem = this.queue.shift();
      if (elem.resolve !== null) {
        return elem.resolve;
      }
      throw new Error('Closed');
    }

    return await new Promise((resolve, reject) => {
      this.receiveQueue.push({ resolve, reject });
    });
  }

  async close() {
    if (this.receiveQueue.length !== 0) {
      const elem = this.receiveQueue.shift();
      return elem.reject(new Error('Closed'));
    }

    this.queue.push({ resolve: null, reject: true });
  }

  // Internal

  push(data) {
    if (this.receiveQueue.length !== 0) {
      return this.receiveQueue.shift().resolve(data);
    }

    this.queue.push({ resolve: data, reject: null });
  }

  static pair() {
    const a = new Socket('a');
    const b = new Socket('b');

    a.remote = b;
    b.remote = a;

    return [ a, b ];
  }
}
