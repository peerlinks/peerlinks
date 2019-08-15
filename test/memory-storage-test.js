/* eslint-env node, mocha */
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
      parents: parents.map((hash) => Buffer.from(hash)),
      data: Buffer.from(`${height}: ${hash}`),
    };
  };

  const at = async (offset, limit) => {
    const hashes = await storage.getHashesAtOffset(channelId, offset,
      limit);
    const blobs = await storage.getMessages(channelId, hashes);
    return blobs.map((blob) => blob.toString());
  };

  const leaves = async () => {
    const result = await storage.getLeafHashes(channelId);
    return result.map((message) => message.toString()).sort();
  };

  it('should store and retrieve messages', async () => {
    const fake = {
      channelId,
      hash: randomBytes(32),
      height: 0,
      parents: [],
      data: Buffer.from('fake'),
    };

    assert.strictEqual(await storage.getMessageCount(channelId), 0);
    assert.strictEqual((await storage.getLeafHashes(channelId)).length, 0);
    assert.ok(!await storage.hasMessage(channelId, fake.hash));

    await storage.addMessage(fake);
    assert.strictEqual(await storage.getMessageCount(channelId), 1);

    const leaves = await storage.getLeafHashes(channelId);
    assert.strictEqual(leaves.length, 1);
    assert.strictEqual(leaves[0].toString('hex'), fake.hash.toString('hex'));

    assert.ok(await storage.hasMessage(channelId, fake.hash));
    const getFake = await storage.getMessage(channelId, fake.hash);
    assert.strictEqual(getFake.toString(), 'fake');

    // NOTE: should not fail, even though fake is already in database
    await storage.addMessage(fake);
  });

  it('should order messages in CRDT order', async () => {
    await storage.addMessage(msg('a', 0));
    await storage.addMessage(msg('c', 1));
    await storage.addMessage(msg('b', 1));
    await storage.addMessage(msg('d', 2));

    assert.deepStrictEqual(await at(0, 4), [
      '0: a',
      '1: b',
      '1: c',
      '2: d',
    ]);
  });

  it('should query messages by height', async () => {
    await storage.addMessage(msg('a', 0));
    await storage.addMessage(msg('c', 1));
    await storage.addMessage(msg('b', 1));
    await storage.addMessage(msg('d', 2));

    {
      const result = await storage.query(channelId, { height: 1 }, false, 2);
      assert.strictEqual(result.abbreviatedMessages.length, 2);
      assert.strictEqual(result.abbreviatedMessages[0].hash.toString(), 'b');
      assert.strictEqual(result.abbreviatedMessages[1].hash.toString(), 'c');
      assert.strictEqual(result.backwardHash.toString(), 'b');
      assert.strictEqual(result.forwardHash.toString(), 'd');
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
      assert.strictEqual(result.abbreviatedMessages.length, 2);
      assert.strictEqual(result.abbreviatedMessages[0].hash.toString(), 'b');
      assert.strictEqual(result.abbreviatedMessages[1].hash.toString(), 'c');
      assert.strictEqual(result.backwardHash.toString(), 'b');
      assert.strictEqual(result.forwardHash.toString(), 'd');
    }

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('b') },
        true,
        2);
      assert.strictEqual(result.abbreviatedMessages.length, 1);
      assert.strictEqual(result.abbreviatedMessages[0].hash.toString(), 'a');
      assert.strictEqual(result.backwardHash, null);
      assert.strictEqual(result.forwardHash.toString(), 'b');
    }

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('d') },
        false,
        2);
      assert.strictEqual(result.abbreviatedMessages.length, 1);
      assert.strictEqual(result.abbreviatedMessages[0].hash.toString(), 'd');
      assert.strictEqual(result.backwardHash.toString(), 'd');
      assert.strictEqual(result.forwardHash, null);
    }

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('x') },
        false,
        2);
      assert.strictEqual(result.abbreviatedMessages.length, 0);
      assert.strictEqual(result.backwardHash, null);
      assert.strictEqual(result.forwardHash, null);
    }
  });

  it('should compute leaves through parent hashes', async () => {
    assert.deepStrictEqual(await leaves(), []);

    await storage.addMessage(msg('a', 0, []));
    assert.deepStrictEqual(await leaves(), [ 'a' ]);

    await storage.addMessage(msg('c', 1, [ 'a' ]));
    assert.deepStrictEqual(await leaves(), [ 'c' ]);

    await storage.addMessage(msg('b', 1, [ 'a' ]));
    assert.deepStrictEqual(await leaves(), [ 'b', 'c' ]);

    await storage.addMessage(msg('d', 2, [ 'b', 'c' ]));
    assert.deepStrictEqual(await leaves(), [ 'd' ]);
  });

  it('should store and retrieve entities', async () => {
    class Fake {
      constructor(text) {
        this.text = text;
      }

      static deserializeData(data) {
        return new Fake(data.toString());
      }
    }

    assert.ok(!await storage.retrieveEntity('fake', 'id'));
    await storage.storeEntity('fake', 'id', Buffer.from('hello'));

    assert.deepStrictEqual(await storage.getEntityKeys('fake'), [ 'id' ]);

    const blob = await storage.retrieveEntity('fake', 'id', Fake);
    assert.strictEqual(Fake.deserializeData(blob).text, 'hello');

    const missing = await storage.retrieveEntity('fake', randomBytes(32), Fake);
    assert.ok(!missing);
  });
});
