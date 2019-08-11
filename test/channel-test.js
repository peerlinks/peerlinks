import * as assert from 'assert';
import { Buffer } from 'buffer';
import * as sodium from 'sodium-universal';

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

  const msg = (text, parents, height, timestamp) => {
    return new Message({
      channel,
      parents: parents.map((p) => p.hash),
      height,
      content: id.signMessageBody(Message.text(text), channel, {
        height,
        parents: parents.map((p) => p.hash),
        timestamp,
      }),
    });
  };

  describe('.post()', () => {
    it('should post messages and set parents appropriately', async () => {
      assert.strictEqual(await channel.getMessageCount(), 1);
      assert.strictEqual(await at(0), '<root>');
      assert.strictEqual(await channel.getMinLeafHeight(), 0);

      const first = await channel.post(Message.text('hello'), id);
      assert.strictEqual(await channel.getMessageCount(), 2);
      assert.strictEqual(await at(0), '<root>');
      assert.strictEqual(await at(1), 'hello');
      assert.ok(first.verify(channel));
      assert.strictEqual(await channel.getMinLeafHeight(), 1);

      const second = await channel.post(Message.text('world'), id);
      assert.strictEqual(await channel.getMessageCount(), 3);
      assert.strictEqual(await at(0), '<root>');
      assert.strictEqual(await at(1), 'hello');
      assert.strictEqual(await at(2), 'world');
      assert.ok(second.verify(channel));
      assert.strictEqual(await channel.getMinLeafHeight(), 2);

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
      assert.ok((await channel.getMinLeafHeight()) >= 1);
    });
  });

  describe('.receive()', () => {
    it('should receive root', async () => {
      const clone = new Channel('test-clone', channel.publicKey);
      await clone.receive(channel.root);
      assert.strictEqual(await clone.getMinLeafHeight(), 0);
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
          signature: Buffer.alloc(sodium.crypto_sign_BYTES),
        },
      });

      await assert.rejects(channel.receive(wrong), {
        name: 'Error',
        message: 'Invalid message signature, or invalid chain',
      });
    });

    it('should throw on unknown parents', async () => {
      const alt = await Channel.create(id, 'test-alt');

      const wrong = new Message({
        channel,
        parents: [ alt.root.hash ],
        height: 1,
        content: id.signMessageBody(Message.text('wrong'), channel, {
          height: 1,
          parents: [ alt.root.hash ],
        }),
      });

      await assert.rejects(channel.receive(wrong), {
        name: 'Error',
        message: /Message parent: .* not found/,
      });
    });

    it('should check height', async () => {
      const left = msg('left', [ channel.root ], 1);
      const right = msg('right', [ channel.root ], 1);
      const grand = msg('grand', [ right ], 2);

      await channel.receive(left);
      await channel.receive(right);
      await channel.receive(grand);

      // minLeafHeight=1, because left branch is of height=1
      assert.strictEqual(await channel.getMinLeafHeight(), 1);

      const wrong = msg('wrong', [ left, grand ], 1);

      await assert.rejects(channel.receive(wrong), {
        name: 'Error',
        message: 'Invalid received message height: 1, expected: 3',
      });

      const correct = msg('correct', [ left, grand ], 3);

      await channel.receive(correct);
    });

    it('should check timestamp', async () => {
      const future = msg('future', [ channel.root ], 1, now() + 3600);

      await assert.rejects(channel.receive(future), {
        name: 'Error',
        message: 'Received message is in the future',
      });

      const past = msg('future', [ channel.root ], 1, now() - 3600);

      await assert.rejects(channel.receive(past), {
        name: 'Error',
        message: 'Received message is in the past',
      });
    });
  });
});
