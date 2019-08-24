/* eslint-env node, mocha */
import * as assert from 'assert';
import * as sodium from 'sodium-universal';

import { Chain, Channel, Identity, Message } from '../';

describe('Identity', () => {
  it('should be serialized/deserialized with chain', async () => {
    const id = new Identity('id', { sodium });
    const channel = await Channel.create(id, 'channel', { sodium });

    const trustee = new Identity('trustee', { sodium });

    const link = id.issueLink(channel, {
      trusteePubKey: trustee.publicKey,
      trusteeDisplayName: 'trustee',
    });

    assert.strictEqual(trustee.getChannelIds().length, 0);

    const chain = new Chain([ link ]);
    trustee.addChain(channel, chain);
    trustee.setMetadata({ ok: true });

    assert.strictEqual(trustee.getChannelIds().length, 1);
    assert.strictEqual(trustee.getChannelIds()[0].toString('hex'),
      channel.id.toString('hex'));

    const copy = Identity.deserializeData(trustee.serializeData(),
      { sodium });
    assert.strictEqual(copy.publicKey.toString('hex'),
      trustee.publicKey.toString('hex'));
    assert.deepStrictEqual(copy.getMetadata(), { ok: true });

    await channel.post(Message.json('test'), copy);
  });
});
