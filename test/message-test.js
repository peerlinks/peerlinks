import * as assert from 'assert';

import { Chain, Channel, Identity, Link, Message } from '../';

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
    const content = id.signMessageContent(
      Message.text('okay'),
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

    assert.strictEqual(copy.content.body.text.text, 'okay');
    assert.strictEqual(copy.hash.toString('hex'), message.hash.toString('hex'));

    const invalid = new Message({
      channelId: channel.id,
      parents: [],
      height: 0,
      // NOTE: Random nonce here
      nonce: null,
      encryptedContent: message.encryptedContent,
    });

    assert.throws(() => invalid.decrypt(channel));
  });

  it('should be signed/verified', () => {
    const second = new Identity('second');
    const chain = new Chain([
      id.issueLink(channel, { trusteePubKey: second.publicKey }),
    ]);

    second.addChain(channel, chain);

    const content = second.signMessageContent(
      Message.text('okay'),
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
});
