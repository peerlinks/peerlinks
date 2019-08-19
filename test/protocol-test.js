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
    const [ test, _ ] = await a.createIdentityPair('test');
    assert.strictEqual(test.name, 'test');

    assert.strictEqual(a.identities.length, 1);
    assert.strictEqual(a.channels.length, 1);
  });

  it('should reload identities/channels from a storage', async () => {
    const id2 = (await a.createIdentityPair('2'))[0];
    const id1 = (await a.createIdentityPair('1'))[0];

    assert.strictEqual(id1.name, '1');
    assert.strictEqual(id2.name, '2');

    const clone = new Protocol({ storage: a.storage });
    await clone.load();

    assert.ok(clone.getIdentity('1').canInvite(clone.getChannel('1')));
    assert.ok(clone.getIdentity('1').canPost(clone.getChannel('1')));

    assert.deepStrictEqual(clone.channels.map((channel) => channel.name),
      [ '1', '2' ]);
    assert.deepStrictEqual(clone.identities.map((id) => id.name),
      [ '1', '2' ]);
  });

  it('should connect peers', async () => {
    const [ idA, _ ] = await a.createIdentityPair('a');
    const [ idB, channelB ] = await b.createIdentityPair('b');
    const [ idC, duplicate ] = await b.createIdentityPair('a');

    const run = async () => {
      // Generate invite request
      const { requestId, request, decrypt } = idA.requestInvite(a.id);
      const invitePromise = a.waitForInvite(requestId).promise;

      // Issue invite
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

      // Same channels should not be added, but can be ignored
      await a.addChannel(
        await Channel.deserializeData(channelForA.serializeData()));

      // Duplicate adds should throw
      await assert.rejects(a.addChannel(duplicate), {
        name: 'Error',
        message: 'Channel with a duplicate name: "a"',
      });

      assert.strictEqual(await channelForA.getMessageCount(), 1);

      // Wait for sync to complete
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(await channelForA.getMessageCount(), 2);
      const last = await channelForA.getMessagesAtOffset(1);
      assert.strictEqual(last[0].json, 'ohai');
    };

    await Promise.race([
      a.connect(socketA),
      b.connect(socketB),
      run(),
    ]);

    await a.close();
    await b.close();
  });

  it('should self-resolve invite', async () => {
    const [ idA, _ ] = await a.createIdentityPair('a');
    const [ idB, channelB ] = await a.createIdentityPair('b');

    // Generate invite request
    const { requestId, request, decrypt } = idA.requestInvite(a.id);
    const invitePromise = a.waitForInvite(requestId).promise;

    // Issue invite
    const { encryptedInvite, peerId } = idB.issueInvite(
      channelB, request, 'b');
    assert.ok(peerId.equals(a.id));

    // Send it back
    a.resolveInvite(requestId, encryptedInvite);

    // Decrypt and create channel
    const invite = decrypt(await invitePromise);
    await a.channelFromInvite(invite, idA, { name: 'b-copy' });
  });

  it('should encrypt/decrypt blobs', async function() {
    // Derivation of encryption key is a slow process
    this.timeout(20000);

    const protocol = new Protocol({ passphrase: 'secret' });
    const encrypted = protocol.encryptData(Buffer.from('hello'));
    const decrypted = protocol.decryptData(encrypted);
    assert.strictEqual(decrypted.toString(), 'hello');

    // Should create encrypted identity
    await a.createIdentityPair('test');
  });

  it('should work when peers have no common channels', async () => {
    const idA = (await a.createIdentityPair('a'))[0];
    const idB = (await b.createIdentityPair('b'))[0];

    await Promise.race([
      a.connect(socketA),
      b.connect(socketB),

      // Lame, but okay
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);

    await a.close();
    await b.close();
  });
});
