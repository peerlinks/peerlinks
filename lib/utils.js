/**
 * All timestamp has to be generated through use of this function. All stored
 * and networked timestamps are in seconds and not in milliseconds!
 *
 * @returns {number} Number of seconds since 01-01-1970 00:00:00 UTC
 */
export function now() {
  return Date.now() / 1000;
}
