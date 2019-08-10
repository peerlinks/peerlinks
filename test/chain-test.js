import * as assert from 'assert';

import { Chain, Channel, Identity } from '../';

describe('Chain', () => {
  let idA = null;
  let idB = null;
  let idC = null;
  let idD = null;
  let channelA = null;
  let channelB = null;

  beforeEach(() => {
    idA = new Identity('a');
    idB = new Identity('b');
    idC = new Identity('c');
    idD = new Identity('d');

    channelA = new Channel('channel-a', idA.publicKey);
    channelB = new Channel('channel-b', idB.publicKey);
  });

  afterEach(() => {
    idA = null;
    idB = null;
    idC = null;
    idD = null;

    channelA = null;
    channelB = null;
  });

  it('should check length', () => {
    const links = [
      idA.issueLink(channelA, { trusteePubKey: idB.publicKey }),
      idB.issueLink(channelA, { trusteePubKey: idC.publicKey }),
      idC.issueLink(channelA, { trusteePubKey: idD.publicKey }),
      idD.issueLink(channelA, { trusteePubKey: idA.publicKey }),
    ];

    assert.throws(() => {
      const chain = new Chain(channelA, links);
    });
  });

  it('should check signatures', () => {
    const links = [
      idA.issueLink(channelA, { trusteePubKey: idB.publicKey }),
      idB.issueLink(channelA, { trusteePubKey: idC.publicKey }),
      idC.issueLink(channelA, { trusteePubKey: idD.publicKey }),
    ];

    const chain = new Chain(channelA, links);

    assert.ok(chain.verify(channelA));
    assert.ok(!chain.verify(channelB));

    const leafKey = chain.getLeafKey(channelA);
    assert.strictEqual(leafKey.toString('hex'), idD.publicKey.toString('hex'));
  });

  it('should check timestamps', () => {
    const links = [
      idA.issueLink(channelA, { trusteePubKey: idB.publicKey }),
      idB.issueLink(channelA, {
        trusteePubKey: idC.publicKey,
        expiration: Date.now() - 1000,
      }),
      idC.issueLink(channelA, { trusteePubKey: idD.publicKey }),
    ];

    const chain = new Chain(channelA, links);

    assert.ok(!chain.verify(channelA));
  });
});
