import * as assert from 'assert';
import { Buffer } from 'buffer';

import { Chain, Channel, Identity, Message } from '../';
import { now } from '../lib/utils';

describe('Channel', () => {
  let id = null;
  let channel = null;

  beforeEach(async () => {
    id = new Identity('test');
    channel = await Channel.create(id, 'test-channel');
  });

  afterEach(() => {
    id = null;
    channel = null;
  });

  const at = async (offset) => {
    const message = await channel.getMessageAtOffset(offset);
    if (message.content.body.root) {
      return '<root>';
    }
    return message.content.body.text.text;
  };

  describe('.post()', () => {
    it('should post messages and set parents appropriately', async () => {
      assert.strictEqual(await channel.getMessageCount(), 1);
      assert.strictEqual(await at(0), '<root>');

      const first = await channel.post(Message.text('hello'), id);
      assert.strictEqual(await channel.getMessageCount(), 2);
      assert.strictEqual(await at(0), '<root>');
      assert.strictEqual(await at(1), 'hello');
      assert.ok(first.verify(channel));

      const second = await channel.post(Message.text('world'), id);
      assert.strictEqual(await channel.getMessageCount(), 3);
      assert.strictEqual(await at(0), '<root>');
      assert.strictEqual(await at(1), 'hello');
      assert.strictEqual(await at(2), 'world');
      assert.ok(second.verify(channel));

      const root = channel.root;
      assert.ok(root.verify(channel));
      assert.strictEqual(root.parents.length, 0);
      assert.strictEqual(root.height, 0);

      assert.deepStrictEqual(first.parents.map((p) => p.toString('hex')), [
        root.hash.toString('hex')
      ]);
      assert.strictEqual(first.height, 1);

      assert.deepStrictEqual(second.parents.map((p) => p.toString('hex')), [
        first.hash.toString('hex')
      ]);
      assert.strictEqual(second.height, 2);
    });

    it('should post messages concurrently', async () => {
      assert.strictEqual(await channel.getMessageCount(), 1);
      assert.strictEqual(await at(0), '<root>');

      const middle = await Promise.all([
        channel.post(Message.text('hello'), id),
        channel.post(Message.text('hi'), id),
      ]);

      assert.strictEqual(await channel.getMessageCount(), 3);

      const last = await channel.post(Message.text('world'), id);
      assert.strictEqual(await channel.getMessageCount(), 4);
      assert.strictEqual(await at(3), 'world');
      assert.ok(last.height > 1);
      assert.ok(last.parents.length >= 1);
      assert.ok(last.verify(channel));
    });
  });

  describe('.receive()', () => {
    it('should receive root', async () => {
      const clone = new Channel('test-clone', channel.publicKey);
      await clone.receive(channel.root);
    });

    it('should ignore duplicate', async () => {
      await channel.receive(channel.root);
    });

    it('should throw on invalid root', async () => {
      const alt = await Channel.create(id, 'test-alt-channel');

      await assert.rejects(channel.receive(alt.root), {
        name: 'Error',
        message: 'Received invalid root',
      });
    });

    it('should throw on invalid signature', async () => {
      const wrong = new Message({
        channel,
        parents: [ channel.root.hash ],
        height: 1,
        content: {
          chain: [],
          timestamp: now(),
          body: {
            text: { text: 'wrong' },
          },
          signature: Buffer.alloc(64),
        },
      });

      await assert.rejects(channel.receive(wrong), {
        name: 'Error',
        message: 'Invalid message signature, or invalid chain',
      });
    });
  });
});
