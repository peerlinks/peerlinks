import * as assert from 'assert';

import { Chain, Channel, Identity, Link, Message } from '../';

describe('Link', () => {
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
      channelId: channel.id,
      parents: [],
      height: 0,
      content,
    });

    message.encrypt(channel);

    const copy = new Message({
      channelId: channel.id,
      parents: [],
      height: 0,
      nonce: message.nonce,
      encryptedContent: message.encryptedContent,
    });

    copy.decrypt(channel);

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
});
