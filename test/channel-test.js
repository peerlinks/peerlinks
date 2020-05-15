/* eslint-env node, mocha */
import * as assert from 'assert';
import { Buffer } from 'buffer';
import * as sodium from 'sodium-native';

import { Chain, Channel, Identity, Message } from '../';
import { now } from '../lib/utils';

import DelayStorage from './fixtures/delay-storage';

describe('Channel', () => {
  let identity = null;
  let channel = null;
  let root = null;

  beforeEach(async () => {
    identity = new Identity('test', { sodium });
    channel = await Channel.fromIdentity(identity, {
      name: 'test-channel',
      sodium,
    });
    root = await channel.getRoot();
  });

  afterEach(() => {
    identity = null;
    channel = null;
    root = null;
  });

  const at = async (offset, limit) => {
    const messages = await channel.getMessagesAtOffset(offset, limit);
    return messages.map((message) => {
      if (message.isRoot) {
        return '<root>';
      }
      return message.json;
    });
  };

  const msg = (text, parents, height, timestamp, id = identity) => {
    return new Message({
      ...id.signMessageBody(Message.json(text), channel, {
        height,
        parents: parents.map((p) => p.hash),
        timestamp,
      }),
      sodium,
    });
  };

  describe('.post()', () => {
    it('should post messages and set parents appropriately', async () => {
      assert.strictEqual(await channel.getMessageCount(), 1);
      assert.deepStrictEqual(await at(0), [ '<root>' ]);
      assert.strictEqual(await channel.getMinLeafHeight(), 0);

      const first = await channel.post(Message.json('hello'), identity);
      assert.strictEqual(await channel.getMessageCount(), 2);
      assert.deepStrictEqual(await at(0, 2), [
        '<root>',
        'hello',
      ]);
      assert.ok(first.verify(channel));
      assert.strictEqual(await channel.getMinLeafHeight(), 1);

      const second = await channel.post(Message.json('world'), identity);
      assert.strictEqual(await channel.getMessageCount(), 3);
      assert.deepStrictEqual(await at(0, 3), [
        '<root>',
        'hello',
        'world',
      ]);
      assert.ok(second.verify(channel));
      assert.strictEqual(await channel.getMinLeafHeight(), 2);

      assert.ok(root.verify(channel));
      assert.strictEqual(root.parents.length, 0);
      assert.strictEqual(root.height, 0);

      assert.deepStrictEqual(first.parents.map((p) => p.toString('hex')), [
        root.hash.toString('hex'),
      ]);
      assert.strictEqual(first.height, 1);

      assert.deepStrictEqual(second.parents.map((p) => p.toString('hex')), [
        first.hash.toString('hex'),
      ]);
      assert.strictEqual(second.height, 2);
    });

    it('should post messages concurrently', async () => {
      assert.strictEqual(await channel.getMessageCount(), 1);
      assert.deepStrictEqual(await at(0), [ '<root>' ]);

      await Promise.all([
        channel.post(Message.json('hello'), identity),
        channel.post(Message.json('hi'), identity),
      ]);

      assert.strictEqual(await channel.getMessageCount(), 3);

      const last = await channel.post(Message.json('world'), identity);
      assert.strictEqual(await channel.getMessageCount(), 4);
      assert.deepStrictEqual(await at(3, 1), [ 'world' ]);
      assert.ok(last.height > 1);
      assert.ok(last.parents.length >= 1);
      assert.ok(last.verify(channel));
      assert.ok((await channel.getMinLeafHeight()) >= 1);
    });

    it('should disallow posting root', async () => {
      await assert.rejects(channel.post(Message.root(), identity), {
        name: 'Error',
        message: 'Posting root is not allowed',
      });
    });

    it('should notify message waiters', async () => {
      const [ message, same ] = await Promise.all([
        channel.waitForOutgoingMessage(),
        channel.waitForOutgoingMessage(),
        channel.waitForUpdate(),
        channel.post(Message.json('hello'), identity),
      ]);

      assert.strictEqual(message, same);
      assert.strictEqual(message.json, 'hello');
    });

    it('should adjust timestamp when leaves are in the future', async () => {
      const timestamp = now();

      const start = await channel.post(Message.json('hello'), identity, {
        timestamp: timestamp + 1000,
      });
      const end = await channel.post(Message.json('world'), identity, {
        timestamp: timestamp + 2000,
      });
      const middle = await channel.post(Message.json('dear'), identity, {
        timestamp: timestamp + 1500,
      });

      assert.strictEqual(middle.parents.length, 1);
      assert.strictEqual(middle.parents[0].toString('hex'),
        end.hash.toString('hex'));
      assert.strictEqual(middle.timestamp, end.timestamp);

      assert.strictEqual(end.parents.length, 1);
      assert.strictEqual(end.parents[0].toString('hex'),
        start.hash.toString('hex'));
      assert.strictEqual(end.timestamp, timestamp + 2000);
    });
  });

  describe('.receive()', () => {
    it('should receive root', async () => {
      const clone = new Channel({
        name: 'test-clone',
        publicKey: channel.publicKey,
        sodium,
      });
      await clone.receive(root);
      assert.strictEqual(await clone.getMinLeafHeight(), 0);
    });

    it('should ignore duplicate', async () => {
      await channel.receive(root);
    });

    it('should throw on invalid signature', async () => {
      const content = {
        parents: [ root.hash ],
        height: 1,
        chain: new Chain([]),
        timestamp: now(),
        body: Message.json('wrong'),
        signature: Buffer.alloc(sodium.crypto_sign_BYTES),
      };
      const wrong = new Message({
        ...content,
        sodium,
      });

      await assert.rejects(channel.receive(wrong), {
        name: 'BanError',
        message: 'Invalid message signature, or invalid chain',
      });
    });

    it('should throw on too many parents', async () => {
      const parents = [];
      for (let i = 0; i < 1024; i++) {
        parents.push(root.hash);
      }

      const wrong = new Message({
        ...identity.signMessageBody(Message.json('wrong'), channel, {
          height: 1,
          parents,
        }),
        sodium,
      });

      await assert.rejects(channel.receive(wrong), {
        name: 'BanError',
        message: /Invalid parent count: 1024/,
      });
    });

    it('should throw on unknown parents', async () => {
      const alt = await Channel.fromIdentity(identity, {
        name: 'test-alt',
        sodium,

        // Make sure that `alt` has different hash
        timestamp: now() - 3600,
      });

      const altRoot = await alt.getRoot();

      const wrong = new Message({
        ...identity.signMessageBody(Message.json('wrong'), channel, {
          height: 1,
          parents: [ altRoot.hash ],
        }),
        sodium,
      });

      await assert.rejects(channel.receive(wrong), {
        name: 'BanError',
        message: /Message parent: .* not found/,
      });
    });

    it('should check height', async () => {
      const left = msg('left', [ root ], 1);
      const right = msg('right', [ root ], 1);
      const grand = msg('grand', [ right ], 2);

      await channel.receive(left);
      await channel.receive(right);
      await channel.receive(grand);

      // minLeafHeight=1, because left branch is of height=1
      assert.strictEqual(await channel.getMinLeafHeight(), 1);

      const wrong = msg('wrong', [ left, grand ], 1);

      await assert.rejects(channel.receive(wrong), {
        name: 'BanError',
        message: 'Invalid received message height: 1, expected: 3',
      });

      const correct = msg('correct', [ left, grand ], 3);

      await channel.receive(correct);
    });

    it('should check timestamp', async () => {
      const future = msg('future', [ root ], 1, now() + 3600);

      await assert.rejects(channel.receive(future), {
        name: 'BanError',
        message: 'Received message is in the future',
      });

      const past = msg('future', [ root ], 1, now() - 3600);

      await assert.rejects(channel.receive(past), {
        name: 'BanError',
        message: 'Received message is in the past',
      });
    });

    it('should disallow receiving root from non-root', async () => {
      const trustee = new Identity('trustee', { sodium });
      const link = identity.issueLink(channel, {
        trusteePubKey: trustee.publicKey,
        trusteeDisplayName: 'trustee',
      });

      const chain = new Chain([ link ]);
      trustee.addChain(channel, chain);

      const invalid = new Message({
        ...identity.signMessageBody(Message.root(), channel, {
          height: 1,
          parents: [ root.hash ],
          timestamp: now(),
        }),
        sodium,
      });

      await assert.rejects(channel.receive(invalid), {
        name: 'BanError',
        message: 'Invalid non-root content',
      });
    });

    it('should notify message waiters', async () => {
      const clone = new Channel({
        name: 'test-clone',
        publicKey: channel.publicKey,
        sodium,
      });
      await clone.receive(root);

      const remote = await clone.post(Message.json('okay'), identity);

      const [ message ] = await Promise.all([
        channel.waitForIncomingMessage(),
        channel.waitForUpdate(),
        channel.receive(remote),
      ]);

      assert.strictEqual(message.json, 'okay');
    });
  });

  describe('sync()', () => {
    it('should synchronize channel lagging behind the other', async () => {
      const clone = new Channel({
        name: 'test-clone',
        publicKey: channel.publicKey,
        sodium,

        // Force low limits to trigger more branches
        maxQueryLimit: 5,
        maxBulkCount: 2,
      });
      await clone.receive(root);

      // Post three times the query limit
      for (let i = 0; i < 15; i++) {
        await clone.post(Message.json(`message: ${i}`), identity);
      }

      await channel.sync(clone);
      assert.strictEqual(await channel.getMessageCount(), 15 + 1);
    });

    it('should concurrently synchronize the channel', async function() {
      this.timeout(200000);

      const source = await Channel.fromIdentity(identity, {
        name: 'source',
        storage: new DelayStorage(),
        sodium,

        // Force low limits to trigger more branches
        maxQueryLimit: 5,
        maxBulkCount: 2,
      });

      // Post three times the query limit
      for (let i = 0; i < 15; i++) {
        await source.post(Message.json(`message: ${i}`), identity);
      }

      const targetA = await Channel.fromPublicKey(source.publicKey, {
        name: 'target:a',
        storage: new DelayStorage(),
        sodium,
      });

      await targetA.sync(source);
      assert.strictEqual(await targetA.getMessageCount(), 15 + 1);

      const targetB = await Channel.fromPublicKey(source.publicKey, {
        name: 'target:b',
        storage: new DelayStorage(),
        sodium,
      });

      await Promise.all([
        targetB.sync(source),
        targetB.sync(targetA),
      ]);

      assert.strictEqual(await targetB.getMessageCount(), 15 + 1);
    });

    it('should synchronize diverging branches', async () => {
      const clone = new Channel({
        name: 'test-clone',
        publicKey: channel.publicKey,
        sodium,

        // Force low limits to trigger more branches
        maxQueryLimit: 5,
        maxBulkCount: 2,
      });
      await clone.receive(root);

      // Post three times the query limit
      for (let i = 0; i < 15; i++) {
        await channel.post(Message.json(`original: ${i}`), identity);
      }
      for (let i = 0; i < 15; i++) {
        await clone.post(Message.json(`clone: ${i}`), identity);
      }

      await channel.sync(clone);
      assert.strictEqual(await channel.getMessageCount(), 31);

      const merge = await channel.post(Message.json('merge'), identity);

      await clone.sync(channel);
      assert.strictEqual(await channel.getMessageCount(), 32);

      const last = await channel.getMessagesAtOffset(31, 1);
      assert.strictEqual(last[0].hash.toString('hex'),
        merge.hash.toString('hex'));

      // Do a final clone

      const final = new Channel({
        name: 'test-final',
        publicKey: channel.publicKey,
        sodium,

        maxQueryLimit: 5,
        maxBulkCount: 2,
      });
      await final.receive(root);

      await final.sync(clone);
      assert.strictEqual(await final.getMessageCount(), 32);
    });

    it('should resort to full sync', async () => {
      const clone = new Channel({
        name: 'test-clone',
        publicKey: channel.publicKey,
        sodium,

        // Force low limits to trigger more branches
        maxQueryLimit: 5,
        maxUnresolvedCount: 0,
        maxBulkCount: 2,
      });
      await clone.receive(root);

      // Post three times the query limit
      for (let i = 0; i < 15; i++) {
        await channel.post(Message.json(`original: ${i}`), identity);
      }
      for (let i = 0; i < 15; i++) {
        await clone.post(Message.json(`message: ${i}`), identity);
      }

      await clone.sync(channel);
      assert.strictEqual(await clone.getMessageCount(), 15 + 15 + 1);
    });
  });

  describe('json limit', () => {
    let trustee = null;
    beforeEach(() => {
      trustee = new Identity('trustee', { sodium });

      const link = identity.issueLink(channel, {
        trusteePubKey: trustee.publicKey,
        trusteeDisplayName: 'trustee',
      });

      const chain = new Chain([ link ]);
      trustee.addChain(channel, chain);
    });

    afterEach(() => {
      trustee = null;
    });

    describe('post()', () => {
      it('should be unlimited for root\'s messages', async () => {
        await channel.post(Message.json('x'.repeat(1024 * 1024)), identity);
      });

      it('should be limited for non-root\'s messages', async () => {
        const body = Message.json('x'.repeat(5 * 1024 * 1024));
        await assert.rejects(channel.post(body, trustee), {
          name: 'BanError',
          message: 'Message body length overflow. Expected less or equal to: ' +
            '2097152. Got: 5242882',
        });
      });
    });

    describe('receive()', () => {
      it('should be unlimited for root\'s messages', async () => {
        const big = msg('x'.repeat(1024 * 1024), [ root ], 1);
        await channel.receive(big);
      });

      it('should be limited for non-root\'s messages', async () => {
        const invalid = msg('x'.repeat(5 * 1024 * 1024), [ root ], 1,
          now(), trustee);
        await assert.rejects(channel.receive(invalid), {
          name: 'BanError',
          message: 'Message body length overflow. Expected less or equal to: ' +
            '2097152. Got: 5242882',
        });
      });
    });
  });

  it('should serialize/deserialize', async () => {
    channel.setMetadata({ ok: true });
    const copy = await Channel.deserializeData(channel.serializeData(), {
      sodium,
      storage: channel.cache.backend,
    });
    assert.deepStrictEqual(copy.metadata, { ok: true });

    await copy.post(Message.json('hello'), identity);
    assert.ok(copy.equals(channel));
    assert.ok(channel.equals(copy));
  });

  it('should get reverse messages by offset/limit', async () => {
    await channel.post(Message.json('a'), identity);
    await channel.post(Message.json('b'), identity);
    await channel.post(Message.json('c'), identity);
    await channel.post(Message.json('d'), identity);

    assert.strictEqual(await channel.getMessageCount(), 5);

    const messages = await channel.getReverseMessagesAtOffset(0, 2);
    assert.deepStrictEqual(messages.map((m) => m.json), [
      'd',
      'c',
    ]);

    const messages2 = await channel.getReverseMessagesAtOffset(2, 1000);
    assert.deepStrictEqual(messages2.map((m) => m.json || '<root>'), [
      'b',
      'a',
      '<root>',
    ]);

    const messages3 = await channel.getReverseMessagesAtOffset(100);
    assert.strictEqual(messages3.length, 0);
  });
});
