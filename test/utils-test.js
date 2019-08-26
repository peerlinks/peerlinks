/* eslint-env node, mocha */
import * as assert from 'assert';
import { Buffer } from 'buffer';

import * as utils from '../lib/utils';

describe('utils', () => {
  describe('compareDistance()', () => {
    it('should compare values within threshold', () => {
      const a = Buffer.from('0'.repeat(62) + '00', 'hex');
      const b = Buffer.from('0'.repeat(62) + 'ff', 'hex');

      assert.strictEqual(utils.compareDistance(a, b), -1);
      assert.strictEqual(utils.compareDistance(b, a), 1);
      assert.strictEqual(utils.compareDistance(a, a), 0);
      assert.strictEqual(utils.compareDistance(b, b), 0);
    });

    it('should compare values outside threshold', () => {
      const a = Buffer.from('0'.repeat(62) + '00', 'hex');
      const b = Buffer.from('ff' + '0'.repeat(62), 'hex');

      assert.strictEqual(utils.compareDistance(a, b), 1);
      assert.strictEqual(utils.compareDistance(b, a), -1);
      assert.strictEqual(utils.compareDistance(a, a), 0);
      assert.strictEqual(utils.compareDistance(b, b), 0);
    });
  });
});
