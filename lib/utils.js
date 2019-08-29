/**
 * All timestamp has to be generated through use of this function. All stored
 * and networked timestamps are in seconds and not in milliseconds!
 *
 * @returns {number} Number of seconds since 01-01-1970 00:00:00 UTC
 */
export function now() {
  return Date.now() / 1000;
}

const METRIC_THRESHOLD = 2n ** 255n;

export function compareDistance(a, b) {
  if (a.length !== 32 || b.length !== 32) {
    throw new BanError('Invalid parameter length for `compareDistance`');
  }

  a = BigInt(`0x${a.toString('hex')}`);
  b = BigInt(`0x${b.toString('hex')}`);

  const delta = b - a;
  if (delta === 0n) {
    return 0;
  }

  const absDelta = delta < 0 ? -delta : delta;

  if (delta > 0n) {
    if (absDelta < METRIC_THRESHOLD) {
      return -1;
    } else {
      return 1;
    }
  } else {
    if (absDelta < METRIC_THRESHOLD) {
      return 1;
    } else {
      return -1;
    }
  }
}

export class BanError extends Error {
  constructor(...args) {
    super(...args);

    this.name = 'BanError';
    this.ban = true;
  }
}
