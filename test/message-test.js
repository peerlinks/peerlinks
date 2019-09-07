/* eslint-env node, mocha */
import * as assert from 'assert';
import * as sodium from 'sodium-universal';

import { Chain, Channel, Identity, Message } from '../';

describe('Message', () => {
  let id = null;
  let channel = null;

  beforeEach(() => {
    id = new Identity('test', { sodium });
    channel = new Channel({
      name: 'test-channel',
      publicKey: id.publicKey,
      sodium,
    });

    id.addChain(channel, new Chain([]));
  });

  afterEach(() => {
    id = null;
    channel = null;
  });

  it('should be signed/verified', () => {
    const second = new Identity('second', { sodium });
    const chain = new Chain([
      id.issueLink(channel, {
        trusteePubKey: second.publicKey,
        trusteeDisplayName: 'second',
      }),
    ]);

    second.addChain(channel, chain);

    const content = second.signMessageBody(
      Message.json('okay'),
      channel,
      {
        height: 0,
        parents: [],
      });

    const message = new Message({
      ...content,
      sodium,
    });
    assert.ok(message.verify(channel));

    assert.strictEqual(message.chain.getLeafKey(channel).toString('hex'),
      second.publicKey.toString('hex'));
  });

  it('should be serialized/deserialized', () => {
    const content = id.signMessageBody(
      Message.json('okay'),
      channel,
      {
        height: 0,
        parents: [],
      });

    const message = new Message({
      ...content,
      sodium,
    });

    const data = message.serializeData();
    const copy = Message.deserializeData(data, { sodium });

    assert.strictEqual(copy.height, message.height);
    assert.strictEqual(copy.parents.length, message.parents.length);
  });

  it('should throw on decrypting bad JSON', () => {
    const content = id.signMessageBody(
      { json: 'not-json' },
      channel,
      {
        height: 0,
        parents: [],
      });

    assert.throws(() => {
      const _ = new Message({
        ...content,
        sodium,
      });
    }, {
      name: 'BanError',
      message: 'Invalid JSON content. Unexpected token o in JSON at position 1',
    });
  });
});
