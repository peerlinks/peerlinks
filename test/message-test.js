/* eslint-env node, mocha */
import * as assert from 'assert';

import { Chain, Channel, Identity, Message } from '../';

describe('Message', () => {
  let id = null;
  let channel = null;

  beforeEach(() => {
    id = new Identity('test');
    channel = new Channel('test-channel', id.publicKey);

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
      channel,
      parents: [],
      height: 0,
      content,
    });
    assert.ok(message.verify(channel));

    const copy = new Message({
      channelId: channel.id,
      parents: [],
      height: 0,
      nonce: message.nonce,
      encryptedContent: message.encryptedContent,
    });

    copy.decrypt(channel);
    assert.ok(copy.verify(channel));

    assert.strictEqual(copy.content.body.json, 'okay');
    assert.strictEqual(copy.hash.toString('hex'), message.hash.toString('hex'));

    const invalid = new Message({
      channelId: channel.id,
      parents: [],
      height: 0,
      // NOTE: Random nonce here
      nonce: null,
      encryptedContent: message.encryptedContent,
    });

    assert.throws(() => invalid.decrypt(channel), {
      name: 'Error',
      message: 'Failed to decrypt message content',
    });
  });

  it('should be signed/verified', () => {
    const second = new Identity('second');
    const chain = new Chain([
      id.issueLink(channel, { trusteePubKey: second.publicKey }),
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
      channel,
      parents: [],
      height: 1,
      content,
    });

    const data = message.serializeData();
    const copy = Message.deserializeData(data);
    assert.strictEqual(copy.channelId.toString('hex'),
      message.channelId.toString('hex'));
    assert.strictEqual(copy.height, message.height);
    assert.strictEqual(copy.parents.length, message.parents.length);

    // Should not throw
    copy.decrypt(channel);
  });

  it('should use different encryption keys for different levels', () => {
    const rootKey = Message.encryptionKeyFor(channel, 0);
    const rootKey2 = Message.encryptionKeyFor(channel, 0);
    assert.strictEqual(rootKey.toString('hex'), rootKey2.toString('hex'));

    const nonRoot = Message.encryptionKeyFor(channel, 1);
    assert.notStrictEqual(rootKey.toString('hex'), nonRoot.toString('hex'));
  });
});
