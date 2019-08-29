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

  it('should be encrypted/decrypted', () => {
    const content = id.signMessageBody(
      Message.json('okay'),
      channel,
      {
        height: 0,
        parents: [],
      });

    const message = new Message({
      sodium,
      channel,
      parents: [],
      height: 0,
      content,
    });
    assert.ok(message.verify(channel));

    const copy = new Message({
      sodium,
      channelId: channel.id,
      parents: [],
      height: 0,
      nonce: message.nonce,
      encryptedContent: message.encryptedContent,
    });

    copy.decrypt(channel);
    assert.ok(copy.verify(channel));

    assert.strictEqual(copy.json, 'okay');
    assert.strictEqual(copy.hash.toString('hex'), message.hash.toString('hex'));

    const invalid = new Message({
      sodium,
      channelId: channel.id,
      parents: [],
      height: 0,
      // NOTE: Random nonce here
      nonce: null,
      encryptedContent: message.encryptedContent,
    });

    assert.throws(() => invalid.decrypt(channel), {
      name: 'BanError',
      message: 'Failed to decrypt message content',
    });
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
      sodium,
      channel,
      parents: [],
      height: 0,
      content,
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
      sodium,
      channel,
      parents: [],
      height: 1,
      content,
    });

    const data = message.serializeData();
    const copy = Message.deserializeData(data, { sodium });
    assert.strictEqual(copy.channelId.toString('hex'),
      message.channelId.toString('hex'));
    assert.strictEqual(copy.height, message.height);
    assert.strictEqual(copy.parents.length, message.parents.length);

    // Should not throw
    copy.decrypt(channel);
  });

  it('should throw on decrypting bad JSON', () => {
    const content = id.signMessageBody(
      { body: { json: 'not-json' } },
      channel,
      {
        height: 0,
        parents: [],
      });

    const message = new Message({
      sodium,
      channel,
      parents: [],
      height: 1,
      content,
    });

    const data = message.serializeData();
    const copy = Message.deserializeData(data, { sodium });

    assert.throws(() => {
      copy.decrypt(channel);
    }, {
      name: 'BanError',
      message: 'Invalid JSON content. Unexpected end of JSON input',
    });
  });
});
