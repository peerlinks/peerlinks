export default class SocketBase {
  /**
   * Base class for all remote connections.
   *
   * @class
   */
  constructor() {
    this.timers = new Set();
  }

  /**
   * Send data to remote peer.
   *
   * @param {Buffer} data
   * @returns {Promise}
   */
  async send(data) {
    throw new Error('Not implemented');
  }

  /**
   * Receive data from remote peer.
   *
   * @returns {Promise} A Promise with a `Buffer` value
   */
  async receive() {
    throw new Error('Not implemented');
  }

  /**
   * Create a timeout promise that automatically invalidates at `.close()` call.
   *
   * @params {number} ms - number of milliseconds to wait
   * @returns {Object} Object with `promise` property and `cancel` method
   */
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

  /**
   * Close remote connection.
   *
   * @returns {Promise}
   */
  async close() {
    while (this.receiveQueue.length !== 0) {
      const elem = this.receiveQueue.shift();
      return elem.reject(new Error('Closed'));
    }
  }
}
