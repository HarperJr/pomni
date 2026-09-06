import { describe, expect, it } from 'vitest';
import { mergeCapabilities } from './capability.js';
import { ValidationError } from './errors.js';
import { assertSlug, deriveItemPrefix, repoIdFromSource, slugify, uniqueId } from './ids.js';
import {
  assertCredentialUsable,
  detectProvider,
  isSshUrl,
  normalizeGitUrl,
  describeSource,
} from './source.js';
import { isUlid, ulid } from './ulid.js';

describe('ids', () => {
  it('slugifies names into directory-safe ids', () => {
    expect(slugify('Acme SaaS')).toBe('acme-saas');
    expect(slugify('  Hello   World!! ')).toBe('hello-world');
    expect(slugify('Café Über')).toBe('cafe-uber');
  });

  it('rejects ids that are not slugs', () => {
    expect(() => assertSlug('Not A Slug', 'project id')).toThrow(ValidationError);
    expect(() => assertSlug('-leading', 'project id')).toThrow(ValidationError);
    expect(() => assertSlug('has/slash', 'project id')).toThrow(ValidationError);
    expect(() => assertSlug('..', 'project id')).toThrow(ValidationError);
    expect(() => assertSlug('acme-saas', 'project id')).not.toThrow();
  });

  it('allows ordinary repo names that a reserved-word list would have blocked', () => {
    // `api` is the most common repo name in a fullstack project; ids are always a nested
    // path segment, so there is nothing for it to collide with.
    for (const id of ['api', 'web', 'config', 'workspace', 'new']) {
      expect(() => assertSlug(id, 'repo id')).not.toThrow();
    }
  });

  it('makes ids unique without clobbering the original', () => {
    expect(uniqueId('web', [])).toBe('web');
    expect(uniqueId('web', ['web'])).toBe('web-2');
    expect(uniqueId('web', ['web', 'web-2'])).toBe('web-3');
  });

  it('derives a stable item prefix from the project id', () => {
    expect(deriveItemPrefix('acme-saas')).toBe('ACME');
    expect(deriveItemPrefix('web')).toBe('WEB');
    expect(deriveItemPrefix('a')).toBe('AX');
  });

  it('derives a repo id from either a path or a url', () => {
    expect(repoIdFromSource('C:\\dev\\my-app')).toBe('my-app');
    expect(repoIdFromSource('/home/me/projects/api/')).toBe('api');
    expect(repoIdFromSource('https://github.com/owner/Hello-World.git')).toBe('hello-world');
    expect(repoIdFromSource('git@github.com:owner/repo.git')).toBe('repo');
  });
});

describe('repo sources', () => {
  it('recognises ssh urls without confusing them for https', () => {
    expect(isSshUrl('git@github.com:owner/repo.git')).toBe(true);
    expect(isSshUrl('ssh://git@host/owner/repo')).toBe(true);
    expect(isSshUrl('https://github.com/owner/repo.git')).toBe(false);
  });

  it('detects the provider from the url host', () => {
    expect(detectProvider('https://github.com/o/r.git')).toBe('github');
    expect(detectProvider('https://gitlab.com/o/r.git')).toBe('gitlab');
    expect(detectProvider('https://bitbucket.org/o/r')).toBe('bitbucket');
    expect(detectProvider('https://git.example.com/o/r')).toBe('generic');
  });

  it('rejects things that are not git urls', () => {
    expect(() => normalizeGitUrl('not a url')).toThrow(ValidationError);
    expect(() => normalizeGitUrl('')).toThrow(ValidationError);
    expect(normalizeGitUrl('  https://github.com/o/r.git  ')).toBe('https://github.com/o/r.git');
  });

  it('refuses a token credential on an ssh url, where it cannot work', () => {
    expect(() =>
      assertCredentialUsable({
        kind: 'git',
        url: 'git@github.com:o/r.git',
        credential: 'gh',
        provider: 'github',
      }),
    ).toThrow(/ssh/);

    expect(() =>
      assertCredentialUsable({
        kind: 'git',
        url: 'https://github.com/o/r.git',
        credential: 'gh',
        provider: 'github',
      }),
    ).not.toThrow();
  });

  it('describes a source without leaking anything', () => {
    expect(describeSource({ kind: 'local', path: '/a/b' })).toBe('/a/b');
    expect(
      describeSource({ kind: 'git', url: 'https://h/o/r.git', ref: 'main', provider: 'generic' }),
    ).toBe('https://h/o/r.git @ main');
  });
});

describe('capabilities', () => {
  it('lets re-detection replace detected commands but never manual ones', () => {
    const existing = {
      test: { cmd: 'pnpm test --custom', origin: 'manual' as const },
      build: { cmd: 'old build', origin: 'detected' as const },
    };
    const detected = {
      test: { cmd: 'pnpm test', origin: 'detected' as const },
      build: { cmd: 'new build', origin: 'detected' as const },
      lint: { cmd: 'pnpm lint', origin: 'detected' as const },
    };

    const merged = mergeCapabilities(existing, detected);
    expect(merged.test?.cmd).toBe('pnpm test --custom');
    expect(merged.build?.cmd).toBe('new build');
    expect(merged.lint?.cmd).toBe('pnpm lint');
  });
});

describe('ulid', () => {
  it('sorts in creation order when every id shares one timestamp', () => {
    // What a FixedClock does to every id in a test, and what `pipeline-service` does to the
    // six ids it mints in a row.
    const ids = Array.from({ length: 500 }, () => ulid(1_700_000_000_000));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isUlid(id)).toBe(true);
  });

  it('carries across base32 characters rather than only stepping the last one', () => {
    const first = ulid(1_700_000_000_001);
    let last = first;
    for (let i = 0; i < 40; i += 1) {
      const next = ulid(1_700_000_000_001);
      expect(next > last).toBe(true);
      last = next;
    }
    expect(last.slice(0, 10)).toBe(first.slice(0, 10));
  });

  it('keeps increasing when the clock goes backwards instead of throwing', () => {
    const ahead = ulid(1_700_000_050_000);
    const behind = ulid(1_600_000_000_000);
    expect(behind > ahead).toBe(true);
    // The timestamp is held at the highest one seen, so the id stays sortable.
    expect(behind.slice(0, 10)).toBe(ahead.slice(0, 10));
  });

  it('draws fresh randomness once the timestamp actually advances', () => {
    const before = ulid(1_700_000_060_000);
    const after = ulid(1_700_000_060_001);
    expect(after > before).toBe(true);
    expect(after.slice(0, 10)).not.toBe(before.slice(0, 10));
  });
});
