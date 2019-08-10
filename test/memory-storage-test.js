import * as assert from 'assert';
import { Buffer } from 'buffer';
import { randomBytes } from 'crypto';

import { MemoryStorage } from '../';

describe('MemoryStorage', () => {
  let channelId = null;
  let storage = null;

  beforeEach(() => {
    channelId = randomBytes(32);
    storage = new MemoryStorage();
  });

  afterEach(() => {
    channelId = null;
    storage = null;
  });

  const msg = (hash, height, parents = []) => {
    return {
      channelId,
      hash: Buffer.from(hash),
      height,
      parents,
    };
  };

  const str = (message) => {
    return `${message.height}: ${message.hash.toString()}`;
  };

  const at = async (offset) => {
    const message = await storage.getMessageAtOffset(channelId, offset);
    return str(message);
  };

  it('should store and retrieve messages', async () => {
    const fake = {
      channelId,
      hash: randomBytes(32),
      height: 0,
      parents: [],
    };

    assert.strictEqual(await storage.getMessageCount(channelId), 0);
    assert.strictEqual((await storage.getLeaves(channelId)).length, 0);
    assert.ok(!await storage.hasMessage(channelId, fake.hash));

    storage.addMessage(fake, []);
    assert.strictEqual(await storage.getMessageCount(channelId), 1);

    const leaves = await storage.getLeaves(channelId);
    assert.strictEqual(leaves.length, 1);
    assert.strictEqual(leaves[0].toString('hex'), fake.hash.toString('hex'));

    assert.ok(await storage.hasMessage(channelId, fake.hash));
    const getFake = await storage.getMessage(channelId, fake.hash);
    assert.strictEqual(getFake.hash.toString('hex'), fake.hash.toString('hex'));
  });

  it('should order messages in CRDT order', async () => {
    await storage.addMessage(msg('a', 0));
    await storage.addMessage(msg('c', 1));
    await storage.addMessage(msg('b', 1));
    await storage.addMessage(msg('d', 2));

    assert.strictEqual(await at(0), '0: a');
    assert.strictEqual(await at(1), '1: b');
    assert.strictEqual(await at(2), '1: c');
    assert.strictEqual(await at(3), '2: d');
  });

  it('should query messages by height', async () => {
    await storage.addMessage(msg('a', 0));
    await storage.addMessage(msg('c', 1));
    await storage.addMessage(msg('b', 1));
    await storage.addMessage(msg('d', 2));

    {
      const result = await storage.query(channelId, { height: 1 }, false, 2);
      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(str(result.messages[0]), '1: b');
      assert.strictEqual(str(result.messages[1]), '1: c');
      assert.strictEqual(result.backwardHash.toString(), 'b');
      assert.strictEqual(result.forwardHash.toString(), 'd');
    }

    {
      const result = await storage.query(channelId, { height: 1 }, true, 2);
      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(str(result.messages[0]), '0: a');
      assert.strictEqual(result.backwardHash, null);
      assert.strictEqual(result.forwardHash.toString(), 'b');
    }
  });

  it('should query messages by hash', async () => {
    await storage.addMessage(msg('a', 0));
    await storage.addMessage(msg('c', 1));
    await storage.addMessage(msg('b', 1));
    await storage.addMessage(msg('d', 2));

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('b') },
        false,
        2);
      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(str(result.messages[0]), '1: b');
      assert.strictEqual(str(result.messages[1]), '1: c');
      assert.strictEqual(result.backwardHash.toString(), 'b');
      assert.strictEqual(result.forwardHash.toString(), 'd');
    }

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('b') },
        true,
        2);
      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(str(result.messages[0]), '0: a');
      assert.strictEqual(result.backwardHash, null);
      assert.strictEqual(result.forwardHash.toString(), 'b');
    }

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('d') },
        false,
        2);
      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(str(result.messages[0]), '2: d');
      assert.strictEqual(result.backwardHash.toString(), 'd');
      assert.strictEqual(result.forwardHash, null);
    }
  });
});
