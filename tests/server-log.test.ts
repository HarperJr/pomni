import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_LOG_CEILING_BYTES,
  filterLog,
  parseLog,
  scrubSecrets,
  trimLog,
  type LogEntry,
} from '@pomni/core';
import { createApp } from '@pomni/server';
import { createHarness, type TestHarness } from './harness.js';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    at: '2026-09-13T10:00:00.000Z',
    level: 'info',
    message: 'something happened',
    detail: '',
    ...overrides,
  };
}

/**
 * POMN-69: Pomni's own log, which until now went to whichever terminal started `serve` — and
 * for a detached process, to nobody.
 */
describe('scrubbing', () => {
  /**
   * Eager on purpose. A false positive costs a reader some context; a false negative publishes
   * a token to anyone who can open the page.
   */
  it('takes the secret out of a url that carries one', () => {
    expect(scrubSecrets('cloning https://nikita:glpat-abcdefghijklmnop@forge.test/a/b.git')).toBe(
      'cloning https://nikita:***@forge.test/a/b.git',
    );
  });

  it('takes out bearer tokens and the bare key forms', () => {
    expect(scrubSecrets('Authorization: Bearer sk-abcdefghijklmnopqrst')).toContain('***');
    expect(scrubSecrets('Authorization: Bearer sk-abcdefghijklmnopqrst')).not.toContain(
      'abcdefghijklmnopqrst',
    );
    expect(scrubSecrets('api_key=abcdefghijklmnop')).toBe('api_key=***');
  });

  it('recognises a provider token on its own, with nothing around it', () => {
    expect(scrubSecrets('token is ghp_abcdefghijklmnopqrstuvwxyz01')).not.toContain('ghp_abcd');
  });

  it('leaves an ordinary sentence alone', () => {
    const plain = "sync refused: the clone at .pomni/workspace/acme/api has uncommitted changes";
    expect(scrubSecrets(plain)).toBe(plain);
  });
});

describe('the ceiling', () => {
  it('drops whole entries from the front rather than cutting a line in half', () => {
    const lines = Array.from({ length: 200 }, (_, index) =>
      JSON.stringify(entry({ message: `line ${index}` })),
    ).join('\n');
    const raw = `${lines}\n`;

    const trimmed = trimLog(raw, 2000);
    expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(2000);

    // Every surviving line still parses — nothing was cut mid-entry.
    const parsed = parseLog(trimmed);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length * JSON.stringify(entry({ message: 'line 0' })).length).toBeLessThan(2400);
    // The newest are what is kept.
    expect(parsed.at(-1)?.message).toBe('line 199');
  });

  it('leaves a log under the ceiling exactly as it was', () => {
    const raw = `${JSON.stringify(entry())}\n`;
    expect(trimLog(raw, SERVER_LOG_CEILING_BYTES)).toBe(raw);
  });

  it('keeps reading a file whose last line was half written', () => {
    const raw = `${JSON.stringify(entry({ message: 'whole' }))}\n{"at":"2026-`;
    expect(parseLog(raw).map((line) => line.message)).toEqual(['whole']);
  });
});

describe('filtering', () => {
  const entries = [
    entry({ level: 'debug', message: 'probing the stack' }),
    entry({ level: 'info', message: 'synced acme/api' }),
    entry({ level: 'warn', message: 'sync refused, the clone is dirty' }),
    entry({ level: 'error', message: 'credential github-personal would not resolve' }),
  ];

  /** What a person came for is `warn` and worse; `debug` is what they need once already lost. */
  it('hides debug unless it is asked for', () => {
    expect(filterLog(entries).map((line) => line.level)).toEqual(['info', 'warn', 'error']);
    expect(filterLog(entries, { level: 'debug' })).toHaveLength(4);
  });

  it('takes a level as a floor, not as an exact match', () => {
    expect(filterLog(entries, { level: 'warn' }).map((line) => line.level)).toEqual([
      'warn',
      'error',
    ]);
  });

  it('searches the message and the detail, case-insensitively', () => {
    expect(filterLog(entries, { q: 'CLONE' }).map((line) => line.level)).toEqual(['warn']);
    expect(
      filterLog([entry({ detail: 'repoId=api' })], { q: 'repoid', level: 'debug' }),
    ).toHaveLength(1);
  });
});

describe('a line a service wrote comes back over the API', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('reaches the store and the route, scrubbed', async () => {
    harness.logger.warn('could not reach https://bot:ghp_abcdefghijklmnopqrstuvwx@forge.test/x');

    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const response = await app.inject({ method: 'GET', url: '/api/logs?level=warn' });
    expect(response.statusCode).toBe(200);

    const entries = response.json().entries as LogEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.message).toContain('bot:***@forge.test');
    expect(entries[0]?.message).not.toContain('ghp_abcdefghijklmnopqrstuvwx');

    await app.close();
  });

  it('hides debug from the default read and returns it when asked', async () => {
    harness.logger.debug('probing');
    harness.logger.info('synced');

    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });

    const quiet = await app.inject({ method: 'GET', url: '/api/logs' });
    expect((quiet.json().entries as LogEntry[]).map((line) => line.message)).toEqual(['synced']);

    const loud = await app.inject({ method: 'GET', url: '/api/logs?level=debug' });
    expect(loud.json().entries).toHaveLength(2);

    await app.close();
  });

  it('searches from the query string', async () => {
    harness.logger.warn('sync refused, the clone is dirty');
    harness.logger.warn('worktree kept, it holds uncommitted work');

    const app = await createApp(harness, { webRoot: join(harness.dir, 'no-web') });
    const response = await app.inject({ method: 'GET', url: '/api/logs?level=warn&q=worktree' });
    expect(response.json().entries).toHaveLength(1);

    await app.close();
  });
});
