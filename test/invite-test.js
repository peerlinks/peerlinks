/* eslint-env node, mocha */
import * as assert from 'assert';

import { Channel, Identity, Message } from '../';

describe('Link', () => {
  let issuer = null;
  let invitee = null;
  let channel = null;

  beforeEach(async () => {
    issuer = new Identity('issuer');
    invitee = new Identity('invitee');

    channel = await Channel.create(issuer, 'test-channel');
  });

  afterEach(() => {
    issuer = null;
    invitee = null;

    channel = null;
  });

  it('should be requested, issued by issuer', async () => {
    const { request, decrypt } = invitee.requestInvite('peer-id');

    const { encryptedInvite, peerId } = issuer.issueInvite(channel, request);
    assert.strictEqual(peerId, 'peer-id');

    const invite = decrypt(encryptedInvite);

    const copy = await Channel.fromInvite(invite, invitee);

    // Try posting a message
    const posted = await copy.post(Message.text('hello world'), invitee);

    // And receiving it on original chnanel
    await channel.receive(posted);
  });
});
