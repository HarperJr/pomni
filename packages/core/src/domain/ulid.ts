import { randomBytes } from 'node:crypto';

/**
 * ULID: lexicographically sortable by time, safe as a directory name, no dependency.
 * 10 chars of timestamp (ms since epoch, Crockford base32) + 16 chars of randomness.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

function encodeTime(now: number): string {
  let time = now;
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out += ALPHABET[(bytes[i] as number) % 32];
  }
  return out;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}
