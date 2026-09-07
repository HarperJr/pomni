import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { layout, type PomniEvent } from '@pomni/core';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme SaaS' });
});

afterEach(async () => {
  await harness.cleanup();
});

/** Every `repo.updated` event emitted while `fn` runs. */
async function eventsDuring(harness: TestHarness, fn: () => Promise<void>): Promise<PomniEvent[]> {
  const seen: PomniEvent[] = [];
  const unsubscribe = harness.events.subscribe((event) => {
    if (event.type === 'repo.updated') seen.push(event);
  });
  try {
    await fn();
  } finally {
    unsubscribe();
  }
  return seen;
}

describe('syncing a repo whose working copy did not change', () => {
  it('writes nothing on a repeat sync of a local repo', async () => {
    const path = await makeNodeRepo(join(harness.dir, 'web'));
    const { completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'local', path },
      role: 'web',
    });
    const first = await completion;
    expect(first.lastSyncedAt).toBeTruthy();

    harness.clock.advance(60_000);

    const events = await eventsDuring(harness, async () => {
      await harness.repos.sync('acme-saas', first.id);
    });

    expect(events).toHaveLength(0);

    const onDisk = await harness.repos.list('acme-saas');
    const record = onDisk.find((repo) => repo.id === first.id);
    // The clock moved a full minute between the two syncs; if the second sync had written
    // anything, these would carry the advanced time instead of the first sync's.
    expect(record?.lastSyncedAt).toBe(first.lastSyncedAt);
    expect(record?.updatedAt).toBe(first.updatedAt);
  });

  it('writes nothing on a repeat sync of a git repo whose head has not moved', async () => {
    const { repo, completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'git', url: 'https://github.com/owner/repo.git' },
    });
    const first = await completion;
    expect(first.status).toBe('ready');

    harness.clock.advance(60_000);

    const events = await eventsDuring(harness, async () => {
      await harness.repos.sync('acme-saas', repo.id);
    });

    expect(events).toHaveLength(0);

    const record = (await harness.repos.list('acme-saas')).find((entry) => entry.id === repo.id);
    expect(record?.lastSyncedAt).toBe(first.lastSyncedAt);
    expect(record?.updatedAt).toBe(first.updatedAt);
    expect(record?.vcs?.head).toBe(first.vcs?.head);
  });

  it('is a no-op even when the working copy reports different dirt and a different branch', async () => {
    const { repo, completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'git', url: 'https://github.com/owner/repo.git' },
    });
    const first = await completion;
    const workingDir = (await harness.repos.get('acme-saas', repo.id)).workingDir;

    const docPath = join(harness.root, layout.repo('acme-saas', repo.id));
    const before = await readFile(docPath, 'utf8');

    harness.clock.advance(60_000);

    // The working copy now looks dirty and checked out on a different branch, but the head it
    // reports and everything detection found are unchanged — this is exactly the case a
    // reviewer found still dirtied Pomni's own tracked repo record and got the next
    // `git checkout` refused, so it is asserted at the persisted document, not the return value.
    const originalInfo = harness.git.info.bind(harness.git);
    harness.git.info = async (dir: string) => {
      const info = await originalInfo(dir);
      if (!info || dir !== workingDir) return info;
      return { ...info, dirty: true, currentBranch: 'feature/unrelated' };
    };

    const events = await eventsDuring(harness, async () => {
      await harness.repos.sync('acme-saas', repo.id);
    });

    expect(events).toHaveLength(0);

    const after = await readFile(docPath, 'utf8');
    expect(after).toBe(before);
  });

  it('writes once to fill in a lastSyncedAt that predates the field, even though nothing else differs', async () => {
    const path = await makeNodeRepo(join(harness.dir, 'web'));
    const { completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'local', path },
      role: 'web',
    });
    const first = await completion;
    expect(first.lastSyncedAt).toBeTruthy();

    // A record written before `lastSyncedAt` existed: otherwise current, but the field is null,
    // the way a yaml on disk from before the field was added would look.
    const docPath = join(harness.root, layout.repo('acme-saas', first.id));
    const onDisk = parseYaml(await readFile(docPath, 'utf8')) as Record<string, unknown>;
    onDisk.lastSyncedAt = null;
    await writeFile(docPath, stringifyYaml(onDisk, { lineWidth: 100 }), 'utf8');

    harness.clock.advance(60_000);

    const events = await eventsDuring(harness, async () => {
      await harness.repos.sync('acme-saas', first.id);
    });

    expect(events).toHaveLength(1);

    const record = (await harness.repos.list('acme-saas')).find((repo) => repo.id === first.id);
    expect(record?.lastSyncedAt).toBeTruthy();
  });
});

describe('syncing a repo whose working copy changed', () => {
  it('records a moved head, and writes exactly once', async () => {
    const { repo, completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'git', url: 'https://github.com/owner/repo.git' },
    });
    const first = await completion;
    const workingDir = (await harness.repos.get('acme-saas', repo.id)).workingDir;

    harness.clock.advance(60_000);

    // The remote moved: fetch+fast-forward brings the clone's head to a new commit.
    harness.git.trackRepo(workingDir, { branch: 'main', head: 'commit-2' });
    harness.git.fastForwardResult = {
      status: 'advanced',
      branch: 'main',
      upstream: 'origin/main',
      from: first.vcs?.head ?? null,
      to: 'commit-2',
      detail: "'main' advanced to origin/main",
    };

    const events = await eventsDuring(harness, async () => {
      const synced = await harness.repos.sync('acme-saas', repo.id);
      expect(synced.advanced).toMatchObject({ status: 'advanced', to: 'commit-2' });
      expect(synced.vcs?.head).toBe('commit-2');
    });

    expect(events).toHaveLength(1);

    const record = (await harness.repos.list('acme-saas')).find((entry) => entry.id === repo.id);
    expect(record?.vcs?.head).toBe('commit-2');
    expect(record?.lastSyncedAt).not.toBe(first.lastSyncedAt);
    expect(record?.updatedAt).not.toBe(first.updatedAt);
  });

  it('still writes when a non-timestamp field other than head changes', async () => {
    const path = await makeNodeRepo(join(harness.dir, 'web'), {
      scripts: { build: 'next build', test: 'vitest run', dev: 'next dev' },
    });
    const { completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'local', path },
      role: 'web',
    });
    const first = await completion;
    expect(first.capabilities.lint).toBeUndefined();

    harness.clock.advance(60_000);

    // Detection now finds a capability it did not find before — a real change to the record,
    // not merely the clock moving.
    await makeNodeRepo(path, {
      scripts: { build: 'next build', test: 'vitest run', lint: 'eslint .', dev: 'next dev' },
    });

    const events = await eventsDuring(harness, async () => {
      await harness.repos.sync('acme-saas', first.id);
    });

    expect(events).toHaveLength(1);

    const record = (await harness.repos.list('acme-saas')).find((entry) => entry.id === first.id);
    expect(record?.capabilities.lint).toBeTruthy();
    expect(record?.lastSyncedAt).not.toBe(first.lastSyncedAt);
    expect(record?.updatedAt).not.toBe(first.updatedAt);
  });
});
