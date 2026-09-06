import { randomBytes } from 'node:crypto';

/**
 * ULID: lexicographically sortable by time, safe as a directory name, no dependency.
 * 10 chars of timestamp (ms since epoch, Crockford base32) + 16 chars of randomness.
 *
 * Monotonic within a process. Callers order runs, messages and pipeline steps by comparing
 * ids (`MAX(id)` means "the latest"), and a millisecond holds many ids: `pipeline-service`
 * mints six kinds in a row, and a fixed clock in a test mints every id at one timestamp.
 * So when the requested timestamp is not greater than the last one, the previous random
 * component is incremented by one rather than redrawn — the ULID spec's monotonic factory.
 * Two ids from the same process are therefore strictly increasing in the order they were
 * minted. Across processes only the timestamp orders them, as before.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom = '';

export function ulid(now: number = Date.now()): string {
  const requested = Math.floor(now);
  if (requested > lastTime) {
    lastTime = requested;
    lastRandom = encodeRandom();
    return encodeTime(lastTime) + lastRandom;
  }
  // Same millisecond, or a clock that went backwards (an NTP adjustment, or a fixed clock
  // set behind a previous one). Both are handled the same way: hold the timestamp we last
  // emitted and step the random component. Never emit a smaller id than the last one, and
  // never throw — a run must not die because the clock moved.
  const stepped = increment(lastRandom);
  if (stepped === null) {
    // All 16 random characters were `Z`: 32^16 ids inside one millisecond. Carrying into
    // the timestamp keeps ids increasing and unique; wrapping the random component would
    // not.
    lastTime += 1;
    lastRandom = encodeRandom();
  } else {
    lastRandom = stepped;
  }
  return encodeTime(lastTime) + lastRandom;
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

/** Adds one to a base32 big-endian string, or null if every character carried. */
function increment(random: string): string | null {
  const chars = random.split('');
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const digit = ALPHABET.indexOf(chars[i] as string);
    if (digit < 31) {
      chars[i] = ALPHABET[digit + 1] as string;
      return chars.join('');
    }
    chars[i] = ALPHABET[0] as string;
  }
  return null;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}
