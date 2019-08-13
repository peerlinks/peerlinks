/* eslint-env node, mocha */
import * as assert from 'assert';

import Protocol, { Channel } from '../';

import Socket from './fixtures/socket';

describe('Protocol', () => {
  let a = null;
  let b = null;
  let socketA = null;
  let socketB = null;

  beforeEach(async () => {
    a = new Protocol();
    await a.load();

    b = new Protocol();
    await b.load();

    [ socketA, socketB ] = Socket.pair();
  });

  afterEach(() => {
    a = null;
    b = null;
  });

  it('should create new identity with a channel', async () => {
    const test = await a.createIdentity('test');
    assert.strictEqual(test.name, 'test');

    await a.save();

    assert.strictEqual(a.identities.length, 1);
    assert.strictEqual(a.channels.length, 1);
  });

  it('should connect peers', async () => {
    const idA = await a.createIdentity('a');
    const idB = await b.createIdentity('b');

    const run = async () => {
      // Generate invite request
      const { requestId, request, decrypt } = idA.requestInvite(a.id);
      const invitePromise = a.waitForInvite(requestId).promise;

      // Issue invite
      const channel = b.getChannel('b');
      const { encryptedInvite, peerId } = idB.issueInvite(channel, request);

      // Send it back
      const peer = await b.waitForPeer(peerId).promise;
      await peer.sendInvite(encryptedInvite);

      const invite = decrypt(await invitePromise);

      const channelForA = await a.channelFromInvite(invite, idA);
    };

    await Promise.race([
      a.connect(socketA),
      b.connect(socketB),
      run(),
    ]);

    await a.close();
    await b.close();
  });
});
