import * as assert from 'assert';

import { Channel, Identity, Link } from '../';

describe('Link', () => {
  let issuer = null;

  beforeEach(() => {
    issuer = new Identity('test');
  });

  afterEach(() => {
    issuer = null;
  });

  it('should be issued by identity', () => {
    const channel = new Channel('test-channel', issuer.publicKey);

    const trustee = new Identity('trustee');

    const link = issuer.issueLink(channel, {
      trusteePubKey: trustee.publicKey,
    });

    assert.ok(link.verify(channel, issuer.publicKey));
    assert.ok(!link.verify(channel, trustee.publicKey));

    // Invalid because of timestamp
    const ONE_YEAR = 365 * 24 * 3600 * 1000;
    assert.ok(!link.verify(channel, issuer.publicKey,
      Date.now() + ONE_YEAR));
  });

  it('should be serialized/deserialized', () => {
    const channel = new Channel('test-channel', issuer.publicKey);

    const trustee = new Identity('trustee');

    const link = issuer.issueLink(channel, {
      trusteePubKey: trustee.publicKey,
    });

    const proto = link.serializeData();
    const deserialized = Link.deserializeData(proto);

    assert.ok(deserialized.verify(channel, issuer.publicKey));
  });
});
