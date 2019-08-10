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

  const msg = (hash, height) => {
    return {
      channelId,
      hash: Buffer.from(hash),
      height,
    };
  };

  const str = (message) => {
    return `${message.height}: ${message.hash.toString()}`;
  };

  const at = (offset) => {
    const message = storage.getMessageAtOffset(channelId, offset);
    return str(message);
  };

  it('should store and retrieve messages', () => {
    const fake = {
      channelId,
      hash: randomBytes(32),
      height: 0,
    };

    assert.strictEqual(storage.getMessageCount(channelId), 0);
    assert.strictEqual(storage.getLeaves(channelId).length, 0);
    assert.ok(!storage.hasMessage(channelId, fake.hash));

    storage.addMessage(fake, [ fake.hash ]);
    assert.strictEqual(storage.getMessageCount(channelId), 1);

    const leaves = storage.getLeaves(channelId);
    assert.strictEqual(leaves.length, 1);
    assert.strictEqual(leaves[0].toString('hex'), fake.hash.toString('hex'));

    assert.ok(storage.hasMessage(channelId, fake.hash));
    assert.strictEqual(
      storage.getMessage(channelId, fake.hash).hash.toString('hex'),
      fake.hash.toString('hex'));
  });

  it('should order messages in CRDT order', () => {
    storage.addMessage(msg('a', 0));
    storage.addMessage(msg('c', 1));
    storage.addMessage(msg('b', 1));
    storage.addMessage(msg('d', 2));

    assert.strictEqual(at(0), '0: a');
    assert.strictEqual(at(1), '1: b');
    assert.strictEqual(at(2), '1: c');
    assert.strictEqual(at(3), '2: d');
  });

  it('should query messages by height', () => {
    storage.addMessage(msg('a', 0));
    storage.addMessage(msg('c', 1));
    storage.addMessage(msg('b', 1));
    storage.addMessage(msg('d', 2));

    {
      const result = storage.query(channelId, { height: 1 }, false, 2);
      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(str(result.messages[0]), '1: b');
      assert.strictEqual(str(result.messages[1]), '1: c');
      assert.strictEqual(result.backwardHash.toString(), 'b');
      assert.strictEqual(result.forwardHash.toString(), 'd');
    }

    {
      const result = storage.query(channelId, { height: 1 }, true, 2);
      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(str(result.messages[0]), '0: a');
      assert.strictEqual(result.backwardHash, null);
      assert.strictEqual(result.forwardHash.toString(), 'b');
    }
  });

  it('should query messages by hash', () => {
    storage.addMessage(msg('a', 0));
    storage.addMessage(msg('c', 1));
    storage.addMessage(msg('b', 1));
    storage.addMessage(msg('d', 2));

    {
      const result = storage.query(
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
      const result = storage.query(
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
      const result = storage.query(
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
