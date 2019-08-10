import * as assert from 'assert';
import * as sodium from 'sodium-universal';

import { Channel, Identity } from '../';

describe('Link', () => {
  let issuer = null;

  beforeEach(() => {
    issuer = new Identity('test');
  });

  afterEach(() => {
    issuer = null;
  });

  it('should be issued by identity', () => {
    const channelId = Buffer.alloc(Channel.ID_SIZE);
    sodium.randombytes_buf(channelId);

    const trustee = new Identity('trustee');

    const link = issuer.issueLink({
      channelId,
      trusteePubKey: trustee.publicKey,
    });

    assert.ok(link.verify(channelId, issuer));
    assert.ok(!link.verify(channelId, trustee));
  });
});
