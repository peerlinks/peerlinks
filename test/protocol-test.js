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
  });
});
