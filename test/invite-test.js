/* eslint-env node, mocha */
import * as assert from 'assert';
import * as sodium from 'sodium-universal';
import { Buffer } from 'buffer';

import { Channel, Identity, Message } from '../';

describe('Invite', () => {
  let issuer = null;
  let invitee = null;
  let channel = null;

  beforeEach(async () => {
    issuer = new Identity('issuer', { sodium });
    invitee = new Identity('invitee', { sodium });

    channel = await Channel.fromIdentity(issuer, {
      name: 'test-channel',
      sodium,
    });
  });

  afterEach(() => {
    issuer = null;
    invitee = null;

    channel = null;
  });

  it('should be requested, issued by issuer', async () => {
    const { request, decrypt } = invitee.requestInvite(Buffer.from('peer-id'));

    const { encryptedInvite, peerId } = issuer.issueInvite(
      channel, request, 'invitee');
    assert.strictEqual(peerId.toString(), 'peer-id');

    const invite = decrypt(encryptedInvite);

    const copy = await Channel.fromInvite(invite, {
      identity: invitee,
      sodium,
    });

    // Try posting a message
    const posted = await copy.post(Message.json('hello world'), invitee);

    // And receiving it on original chnanel
    await channel.receive(posted);
  });
});
