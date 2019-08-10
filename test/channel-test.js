import * as assert from 'assert';

import { Channel, Identity, Message } from '../';

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

  it('should post messages and set parents appropriately', async () => {
    assert.strictEqual(await channel.getMessageCount(), 1);
    assert.strictEqual(await at(0), '<root>');

    const first = await channel.post(Message.text('hello'), id);
    assert.strictEqual(await channel.getMessageCount(), 2);
    assert.strictEqual(await at(0), '<root>');
    assert.strictEqual(await at(1), 'hello');

    const second = await channel.post(Message.text('world'), id);
    assert.strictEqual(await channel.getMessageCount(), 3);
    assert.strictEqual(await at(0), '<root>');
    assert.strictEqual(await at(1), 'hello');
    assert.strictEqual(await at(2), 'world');

    const root = channel.root;
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
});
