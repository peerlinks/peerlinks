/* eslint-env node, mocha */
import * as assert from 'assert';

import { Chain, Channel, Identity } from '../';
import { now } from '../lib/utils';

describe('Chain', () => {
  let idA = null;
  let idB = null;
  let idC = null;
  let idD = null;
  let channelA = null;
  let channelB = null;
  let dataA = null;
  let dataB = null;
  let dataC = null;
  let dataD = null;

  beforeEach(() => {
    idA = new Identity('a');
    idB = new Identity('b');
    idC = new Identity('c');
    idD = new Identity('d');

    channelA = new Channel('channel-a', idA.publicKey);
    channelB = new Channel('channel-b', idB.publicKey);

    dataA = {
      trusteePubKey: idA.publicKey,
      trusteeDisplayName: 'a',
    }
    dataB = {
      trusteePubKey: idB.publicKey,
      trusteeDisplayName: 'b',
    }
    dataC = {
      trusteePubKey: idC.publicKey,
      trusteeDisplayName: 'c',
    }
    dataD = {
      trusteePubKey: idD.publicKey,
      trusteeDisplayName: 'd',
    }
  });

  afterEach(() => {
    idA = null;
    idB = null;
    idC = null;
    idD = null;

    channelA = null;
    channelB = null;

    dataA = null;
    dataB = null;
    dataC = null;
    dataD = null;
  });

  it('should check length', () => {
    const links = [
      idA.issueLink(channelA, dataB),
      idB.issueLink(channelA, dataC),
      idC.issueLink(channelA, dataD),
      idD.issueLink(channelA, dataA),
    ];

    assert.throws(() => {
      new Chain(links);
    }, {
      name: 'Error',
      message: 'Chain length overflow: 4',
    });
  });

  it('should check signatures', () => {
    const links = [
      idA.issueLink(channelA, dataB),
      idB.issueLink(channelA, dataC),
      idC.issueLink(channelA, dataD),
    ];

    const chain = new Chain(links);

    assert.ok(chain.verify(channelA));
    assert.ok(!chain.verify(channelB));

    const leafKey = chain.getLeafKey(channelA);
    assert.strictEqual(leafKey.toString('hex'), idD.publicKey.toString('hex'));
  });

  it('should give display path', () => {
    const links = [
      idA.issueLink(channelA, dataB),
      idB.issueLink(channelA, dataC),
      idC.issueLink(channelA, dataD),
    ];

    const chain = new Chain(links);

    assert.deepStrictEqual(chain.getDisplayPath(), [ 'b', 'c', 'd' ]);
    assert.deepStrictEqual(chain.getPublicKeys(), [
      idB.publicKey,
      idC.publicKey,
      idD.publicKey,
    ]);
  });

  it('should check timestamps', () => {
    const links = [
      idA.issueLink(channelA, dataB),
      idB.issueLink(channelA, Object.assign(dataC, {
        expiration: now() - 1,
      })),
      idC.issueLink(channelA, dataD),
    ];

    const chain = new Chain(links);

    assert.ok(!chain.verify(channelA));
  });
});
