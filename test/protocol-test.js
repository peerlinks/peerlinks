/* eslint-env node, mocha */
import * as assert from 'assert';

import Protocol, { Channel, Message } from '../';

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

    assert.strictEqual(a.identities.length, 1);
    assert.strictEqual(a.channels.length, 1);
  });

  it('should reload identities/channels from a storage', async () => {
    const id2 = await a.createIdentity('2');
    const id1 = await a.createIdentity('1');

    assert.strictEqual(id1.name, '1');
    assert.strictEqual(id2.name, '2');

    const clone = new Protocol({ storage: a.storage });
    await clone.load();

    assert.deepStrictEqual(clone.channels.map((channel) => channel.name),
      [ '1', '2' ]);
    assert.deepStrictEqual(clone.identities.map((id) => id.name),
      [ '1', '2' ]);
  });

  it('should connect peers', async () => {
    const idA = await a.createIdentity('a');
    const idB = await b.createIdentity('b');

    const run = async () => {
      // Generate invite request
      const { requestId, request, decrypt } = idA.requestInvite(a.id);
      const invitePromise = a.waitForInvite(requestId).promise;

      // Issue invite
      const channelB = b.getChannel('b');
      const { encryptedInvite, peerId } = idB.issueInvite(
        channelB, request, 'b');

      // Post a message
      await channelB.post(Message.json('ohai'), idB);

      // Send it back
      const peer = await b.waitForPeer(peerId).promise;
      await peer.sendInvite(encryptedInvite);

      // Decrypt and create channel
      const invite = decrypt(await invitePromise);
      const channelForA = await a.channelFromInvite(invite, idA);
      await a.addChannel(channelForA);

      assert.strictEqual(await channelForA.getMessageCount(), 1);

      // Wait for sync to complete
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(await channelForA.getMessageCount(), 2);
      const last = await channelForA.getMessageAtOffset(1);
      assert.strictEqual(last.content.body.json, '"ohai"');
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
