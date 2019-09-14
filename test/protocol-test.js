/* eslint-env node, mocha */
import * as assert from 'assert';
import * as sodium from 'sodium-universal';

import Protocol, { Channel, Message } from '../';

import Socket from './fixtures/socket';

describe('Protocol', () => {
  let a = null;
  let b = null;
  let socketA = null;
  let socketB = null;

  beforeEach(async () => {
    a = new Protocol({ sodium });
    await a.load();

    b = new Protocol({ sodium });
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

  it('should remove the identity and the channel', async () => {
    const [ id, channel ] = await a.createIdentityPair('test');

    await a.removeChannel(channel);
    assert.ok(!id.getChain(channel));

    await a.removeIdentity(id);
    assert.strictEqual(a.channels.length, 0);
    assert.strictEqual(a.identities.length, 0);
  });

  it('should reload identities/channels from a storage', async () => {
    const id2 = (await a.createIdentityPair('2'))[0];
    const id1 = (await a.createIdentityPair('1'))[0];

    assert.strictEqual(id1.name, '1');
    assert.strictEqual(id2.name, '2');

    const clone = new Protocol({ storage: a.storage, sodium });
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

    assert.strictEqual(a.peerCount, 0);
    assert.strictEqual(b.peerCount, 0);

    const run = async () => {
      // Generate invite request
      const { requestId, request, decrypt } = idA.requestInvite(a.id);
      const invitePromise = a.waitForInvite(requestId);

      // Issue invite
      const { encryptedInvite, peerId } = idB.issueInvite(
        channelB, request, 'a');

      // Post a message
      await channelB.post(Message.json('ohai'), idB);

      // Send it back
      const peer = await b.waitForPeer(peerId);
      await peer.sendInvite(encryptedInvite);

      // Decrypt and create channel
      const invite = decrypt(await invitePromise);
      const channelForA = await a.channelFromInvite(invite, idA);

      // Same channels should not be added, but can be ignored
      const ignored = await Channel.deserializeData(
        channelForA.serializeData(),
        { sodium });
      await a.addChannel(ignored);

      // Duplicate adds should throw
      await assert.rejects(a.addChannel(duplicate), {
        name: 'Error',
        message: 'Channel with a duplicate name: "a"',
      });

      assert.strictEqual(await channelForA.getMessageCount(), 0);
      await assert.rejects(channelForA.post(Message.json('no-sync', idA)), {
        name: 'Error',
        message: 'Initial synchronization not complete',
      });

      // Wait for sync to complete
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(await channelForA.getMessageCount(), 2);
      const last = await channelForA.getReverseMessagesAtOffset(0);
      assert.strictEqual(last[0].json, 'ohai');
    };

    const checkAChains = async () => {
      await a.waitForChainMapUpdate();
      const map = a.computeChainMap();

      assert.strictEqual(map.size, 1);

      // `a` is connected to `b`, which is root
      const chains = Array.from(map.values())[0];
      assert.strictEqual(chains.length, 1);
      assert.strictEqual(chains[0].length, 0);
    };

    const checkBChains = async () => {
      await b.waitForChainMapUpdate();
      const map = b.computeChainMap();

      assert.strictEqual(map.size, 1);

      // `a` is non-root
      const chains = Array.from(map.values())[0];
      assert.strictEqual(chains.length, 1);
      assert.strictEqual(chains[0].length, 1);
      assert.deepStrictEqual(chains[0].getDisplayPath(), [ 'a' ]);
    };

    const [ socketC, socketD ] = Socket.pair();

    await Promise.race([
      Promise.all([
        a.connect(socketA),
        b.connect(socketB),

        // Test duplicate connections too
        a.connect(socketC),
        b.connect(socketD),
      ]),
      Promise.all([
        checkAChains(),
        checkBChains(),
        run(),
      ]),
    ]);

    await a.close();
    await b.close();
  });

  it('should sync read-only channels', async () => {
    const [ idA, channelA ] = await a.createIdentityPair('a', {
      isFeed: true,
    });
    assert.ok(channelA.isFeed);
    const [ idB, _ ] = await b.createIdentityPair('b');

    const run = async () => {
      // Post a message
      await channelA.post(Message.json('ohai'), idA);

      const readonly = await b.feedFromPublicKey(channelA.publicKey, {
        name: 'readonly',
      });
      assert.ok(readonly.isFeed);
      assert.ok(!idB.canInvite(readonly));
      assert.ok(!idB.canPost(readonly));

      assert.strictEqual(await readonly.getMessageCount(), 0);
      while ((await readonly.getMessageCount()) !== 2) {
        await readonly.waitForIncomingMessage();
      }

      const last = await readonly.getReverseMessagesAtOffset(0);
      assert.strictEqual(last[0].json, 'ohai');
    };

    await Promise.race([
      Promise.all([
        a.connect(socketA),
        b.connect(socketB),
      ]),
      run(),
    ]);

    await a.close();
    await b.close();
  });

  it('should not sync normal channels as read-only', async () => {
    const [ idA, channelA ] = await a.createIdentityPair('a', {
      isFeed: false,
    });
    assert.ok(!channelA.isFeed);
    const [ idB, _ ] = await b.createIdentityPair('b');

    const run = async () => {
      // Post a message
      await channelA.post(Message.json('ohai'), idA);

      const readonly = await b.feedFromPublicKey(channelA.publicKey, {
        name: 'readonly',
      });
      assert.ok(readonly.isFeed);
      assert.ok(!idB.canInvite(readonly));
      assert.ok(!idB.canPost(readonly));

      assert.strictEqual(await readonly.getMessageCount(), 0);

      await readonly.waitForIncomingMessage();
    };

    await assert.rejects(Promise.race([
      Promise.all([
        a.connect(socketA),
        b.connect(socketB),
      ]),
      run(),
    ]), {
      name: 'BanError',
      message: /Expected (chain|publicKey) in SyncRequest/,
    });

    await Promise.all([
      a.close(),
      b.close(),
    ]);
  });

  it('should self-resolve invite', async () => {
    const [ idA, _ ] = await a.createIdentityPair('a');
    const [ idB, channelB ] = await a.createIdentityPair('b');

    // Generate invite request
    const { requestId, request, decrypt } = idA.requestInvite(a.id);
    const invitePromise = a.waitForInvite(requestId);

    // Issue invite
    const { encryptedInvite, peerId } = idB.issueInvite(
      channelB, request, 'b');
    assert.ok(peerId.equals(a.id));

    // Send it back
    assert.ok(a.resolveInvite(encryptedInvite));

    // Can\'t resolve twice
    assert.ok(!a.resolveInvite(encryptedInvite));

    // Decrypt and create channel
    const invite = decrypt(await invitePromise);
    await a.channelFromInvite(invite, idA, { name: 'b-copy' });
  });

  it('should encrypt/decrypt blobs', async function() {
    // Derivation of encryption key is a slow process
    this.timeout(20000);

    const protocol = new Protocol({ passphrase: 'secret', sodium });
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

  it('should re-distribute messages', async () => {
    const c = new Protocol({ sodium });
    await c.load();

    const [ idA, channelA ] = await a.createIdentityPair('a:source', {
      isFeed: true,
    });
    const idB = (await b.createIdentityPair('b'))[0];
    const idC = (await b.createIdentityPair('c'))[0];

    const [ socketBC, socketCB ] = Socket.pair();

    const run = async () => {
      assert.strictEqual(a.peerCount, 0);
      assert.strictEqual(b.peerCount, 0);
      assert.strictEqual(c.peerCount, 0);

      // A <-> B, B <-> C
      await Promise.all([ a.waitForPeer(), c.waitForPeer() ]);
      assert.strictEqual(a.peerCount, 1);
      assert.strictEqual(c.peerCount, 1);
      assert.strictEqual(b.peerCount, 2);

      const readonlyB = await b.feedFromPublicKey(channelA.publicKey, {
        name: 'b:feed',
      });
      const readonlyC = await c.feedFromPublicKey(channelA.publicKey, {
        name: 'c:feed',
      });

      await channelA.post(Message.json('ohai'), idA);

      while ((await readonlyB.getMessageCount()) !== 2) {
        await readonlyB.waitForIncomingMessage();
      }
      while ((await readonlyC.getMessageCount()) !== 2) {
        await readonlyC.waitForIncomingMessage();
      }

      assert.strictEqual(a.computeChainMap().size, 0);

      // Let it linger for some time to make sure that it doesn't loop
      // (seen only in debug logs)
      await new Promise((resolve) => setTimeout(resolve, 100));
    };

    await Promise.race([
      a.connect(socketA),
      b.connect(socketB),
      b.connect(socketBC),
      c.connect(socketCB),

      // Lame, but okay
      run(),
    ]);

    await a.close();
    await b.close();
    await c.close();
  });
});
