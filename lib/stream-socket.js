import { Buffer } from 'buffer';

import SocketBase from './socket-base';

export default class StreamSocket extends SocketBase {
  constructor(stream) {
    super();

    this.stream = stream;
    this.stream.on('readable', () => this.maybeRead());
    this.stream.once('error', (error) => {
      this.close().catch(() => {});

      this.error = error;

      for (const pending of this.receiveQueue) {
        pending.reject(error);
      }
    });
    const onClose = () => {
      this.error = new Error('Closed');
      for (const pending of this.receiveQueue) {
        pending.reject(this.error);
      }
    };
    this.stream.once('end', onClose);
    this.stream.once('close', onClose);

    this.error = null;
    this.receiveQueue = [];
    this.buffer = Buffer.alloc(0);
  }

  async send(data) {
    const packet = Buffer.alloc(4 + data.length);
    packet.writeUInt32BE(data.length, 0);
    data.copy(packet, 4);

    this.stream.write(packet);
  }

  async receive() {
    if (this.error) {
      throw this.error;
    }

    const result = new Promise((resolve, reject) => {
      this.receiveQueue.push({ resolve, reject });
    });

    this.maybeRead();

    return await result;
  }

  async close() {
    super.close();

    while (this.receiveQueue.length !== 0) {
      const elem = this.receiveQueue.shift();
      elem.reject(new Error('Closed'));
    }

    if (this.stream.destroy) {
      this.stream.destroy();
    } else if (this.stream.close) {
      this.stream.close();
    } else {
      this.stream.end();
    }
  }

  //
  // Internal
  //

  maybeRead() {
    while (this.receiveQueue.length !== 0) {
      // `this.buffer` might have multiple packets in it
      while (this.receiveQueue.length !== 0) {
        if (this.buffer.length < 4) {
          break;
        }
        const len = this.buffer.readUInt32BE(0);
        if (this.buffer.length < 4 + len) {
          break;
        }

        const data = this.buffer.slice(4, 4 + len);
        this.buffer = this.buffer.slice(4 + len);

        this.receiveQueue.shift().resolve(data);
      }

      const chunk = this.stream.read();
      if (!chunk) {
        break;
      }

      this.buffer = Buffer.concat([ this.buffer, chunk ]);
    }
  }
}
