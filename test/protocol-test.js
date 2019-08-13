/* eslint-env node, mocha */
import * as assert from 'assert';

import Protocol from '../';

describe('Protocol', () => {
  let a = null;
  let b = null;

  beforeEach(async () => {
    a = new Protocol();
    await a.load();

    b = new Protocol();
    await b.load();
  });

  afterEach(() => {
    a = null;
    b = null;
  });

  it('should create new identity with a channel', async () => {
    const test = await a.createIdentity('test');
    assert.strictEqual(test.name, 'test');

    await a.save();

    const copy = await a.getIdentity('test');
    assert.strictEqual(copy.publicKey.toString('hex'),
      test.publicKey.toString('hex'));

    const missing = await a.getIdentity('unknown');
    assert.ok(!missing);
  });
});
