import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileUrl, resolveInside } from '@pomni/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

/**
 * Opening one of a run's files on the machine Pomni is running on.
 *
 * This is the one thing here that starts a program, so most of what follows is about what it
 * refuses. The request names an artifact and never a path; the path is resolved from the run's
 * own record of what it changed and has to land inside a directory this project owns.
 */

let harness: TestHarness;

async function seed(): Promise<void> {
  await harness.projects.create({ name: 'Acme' });
  await harness.workflows.create({ name: 'Discovery' });
  await harness.workflows.addAgent('discovery', {
    name: 'Lead',
    role: 'orchestrator',
    spec: 'Owns the question.',
    prompt: 'You lead.',
  });
  await harness.workflows.addAgent('discovery', {
    name: 'Analyst',
    spec: 'Answers questions.',
    prompt: 'You analyse.',
  });
  await harness.workflows.attach('acme', 'discovery');
}

async function attachRepo(name: string): Promise<{ id: string; dir: string }> {
  const dir = await makeNodeRepo(join(harness.dir, name));
  harness.git.trackRepo(dir);
  const { repo, completion } = await harness.repos.add('acme', {
    source: { kind: 'local', path: dir },
    role: 'lib',
  });
  await completion;
  return { id: repo.id, dir };
}

/** A finished run with one file recorded against it, sitting in the repo it delivered to. */
async function runTouching(path: string, contents = 'export const it = true;\n') {
  const repo = await attachRepo('web');
  await writeFile(join(repo.dir, 'README.md'), '# web\n');

  const { run, completion } = await harness.pipelines.start({
    projectId: 'acme',
    task: 'Add a column',
  });
  await completion;

  await harness.pipelineStore.putArtifacts([
    {
      id: 'the-file',
      runId: run.id,
      stepId: null,
      name: path,
      kind: 'file',
      path,
      change: 'modified',
      bytes: 0,
      createdAt: '2026-09-10T00:00:00.000Z',
    },
  ]);

  if (contents) await writeFile(join(repo.dir, 'on-disk.ts'), contents);
  return { runId: run.id, dir: repo.dir };
}

beforeEach(async () => {
  harness = await createHarness();
  await seed();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('opening a file a run changed', () => {
  it('reveals it in a folder, at the path the project resolved', async () => {
    const { runId, dir } = await runTouching('on-disk.ts');

    await harness.pipelines.openArtifact(runId, 'the-file', 'reveal');

    expect(harness.desktop.revealed).toHaveLength(1);
    expect(harness.desktop.revealed[0]).toContain('on-disk.ts');
    expect(harness.desktop.revealed[0]).toContain(dir.split(/[\\/]/).pop() as string);
  });

  it('opens it with the first editor on PATH when none is configured', async () => {
    const { runId } = await runTouching('on-disk.ts');
    // `cursor` comes after `code` in the known list, so with only this one installed it is
    // the one that must be chosen — the order is a preference, not a fallback chain to the end.
    harness.desktop.installed.add('cursor');

    await harness.pipelines.openArtifact(runId, 'the-file', 'editor');

    expect(harness.desktop.opened).toHaveLength(1);
    expect(harness.desktop.opened[0]?.command).toBe('cursor');
    expect(harness.desktop.opened[0]?.path).toContain('on-disk.ts');
  });

  it('prefers the configured editor over anything found on PATH', async () => {
    const { runId } = await runTouching('on-disk.ts');
    harness.desktop.installed.add('code');
    harness.desktop.installed.add('mine');
    await harness.workspace.setConfig({ editor: { command: 'mine' } });

    await harness.pipelines.openArtifact(runId, 'the-file', 'editor');

    expect(harness.desktop.opened[0]?.command).toBe('mine');
  });

  it('says there is no editor rather than failing when one is pressed', async () => {
    const { runId } = await runTouching('on-disk.ts');
    // Nothing installed: the machine most people first run this on.
    await expect(harness.pipelines.openArtifact(runId, 'the-file', 'editor')).rejects.toThrow(
      /no editor is configured and none of code, cursor, subl, idea is on PATH/,
    );
    expect(harness.desktop.opened).toEqual([]);
  });

  it('treats a configured editor that is not installed as no editor at all', async () => {
    const { runId } = await runTouching('on-disk.ts');
    await harness.workspace.setConfig({ editor: { command: 'uninstalled' } });

    await expect(harness.pipelines.openArtifact(runId, 'the-file', 'editor')).rejects.toThrow(
      /no editor is configured/,
    );
  });
});

describe('what opening a file refuses', () => {
  it('refuses a path that climbs out of the repo', async () => {
    // The artifact is the run's own record, so this is not a request someone can send — it is
    // what a confused run, or a rewritten record, could put there. The check is here because
    // the consequence is a program opening a file outside anything this project owns.
    const { runId } = await runTouching('../../../etc/passwd', '');

    await expect(harness.pipelines.openArtifact(runId, 'the-file', 'reveal')).rejects.toThrow(
      /does not resolve to somewhere inside a directory this project owns/,
    );
    expect(harness.desktop.revealed).toEqual([]);
  });

  it('refuses an absolute path', async () => {
    const { runId } = await runTouching('C:/Windows/System32/calc.exe', '');

    await expect(harness.pipelines.openArtifact(runId, 'the-file', 'reveal')).rejects.toThrow(
      /does not resolve to somewhere inside a directory this project owns/,
    );
  });

  it('refuses an artifact that is not a file, and one that is not on the run', async () => {
    const { runId } = await runTouching('on-disk.ts');
    const detail = await harness.pipelines.get(runId);
    const answer = detail.artifacts.find((artifact) => artifact.kind === 'answer');

    await expect(
      harness.pipelines.openArtifact(runId, answer?.id as string, 'reveal'),
    ).rejects.toThrow(/is not a file/);
    await expect(harness.pipelines.openArtifact(runId, 'not-here', 'reveal')).rejects.toThrow(
      /not found/,
    );
  });

  it('says so when the file is not on disk, instead of opening nothing', async () => {
    // What a run that created a file on a branch nobody has checked out leaves behind.
    const { runId } = await runTouching('never-written.ts', '');

    await expect(harness.pipelines.openArtifact(runId, 'the-file', 'reveal')).rejects.toThrow(
      /a branch that is not checked out/,
    );
  });
});

describe('containment, as string arithmetic', () => {
  it('joins a relative path and refuses one that leaves', () => {
    expect(resolveInside('C:/repos/web', 'src/api.ts')).toBe('C:/repos/web/src/api.ts');
    expect(resolveInside('C:/repos/web/', 'src/api.ts')).toBe('C:/repos/web/src/api.ts');
    // A leading separator or a drive letter means the caller is not describing a repo-relative
    // path at all, and joining it produces something that looks contained and is not the file
    // that was named.
    expect(resolveInside('C:/repos/web', '/etc/passwd')).toBeNull();
    expect(resolveInside('C:/repos/web', 'C:/Windows/System32/calc.exe')).toBeNull();
    expect(resolveInside('C:/repos/web', String.raw`\\server\share\x`)).toBeNull();
    // Resolved before it is checked, never after it is used.
    expect(resolveInside('C:/repos/web', '../secrets.env')).toBeNull();
    expect(resolveInside('C:/repos/web', 'src/../../secrets.env')).toBeNull();
    // A sibling whose name starts the same way is not inside it.
    expect(resolveInside('C:/repos/web', '../web-secrets/x')).toBeNull();
    expect(resolveInside('', 'src/api.ts')).toBeNull();
    expect(resolveInside('C:/repos/web', '')).toBeNull();
  });

  it('folds case, because Windows does', () => {
    expect(resolveInside('C:/Repos/Web', 'src/api.ts')).toBe('C:/Repos/Web/src/api.ts');
    // The path handed back keeps the case the filesystem has; only the comparison folds.
    expect(resolveInside('C:/Repos/Web', 'SRC/Api.ts')).toBe('C:/Repos/Web/SRC/Api.ts');
  });
});

describe('where a file can be read on the forge', () => {
  it('knows the shape of the three hosts, and admits when it does not', () => {
    expect(fileUrl('https://github.com/acme/web.git', 'feature/POMN-1/main', 'src/api.ts')).toBe(
      'https://github.com/acme/web/blob/feature/POMN-1/main/src/api.ts',
    );
    expect(fileUrl('https://gitlab.com/acme/web', 'fix/POMN-2/main', 'src/api.ts')).toBe(
      'https://gitlab.com/acme/web/-/blob/fix/POMN-2/main/src/api.ts',
    );
    expect(fileUrl('https://bitbucket.org/acme/web', 'main', 'a.ts')).toBe(
      'https://bitbucket.org/acme/web/blob/main/a.ts',
    );

    // A self-hosted GitLab is the default shape rather than an unknown one — that is what a
    // private instance is, and it is the case this repository itself runs on.
    expect(fileUrl('http://git.internal:3380/utils/pomni', 'main', 'a.ts')).toBe(
      'http://git.internal:3380/utils/pomni/-/blob/main/a.ts',
    );

    // A wrong link is worse than none, because a link is followed.
    expect(fileUrl('git@github.com:acme/web.git', 'main', 'a.ts')).toBeNull();
    expect(fileUrl(null, 'main', 'a.ts')).toBeNull();
    expect(fileUrl('https://github.com/acme/web', null, 'a.ts')).toBeNull();
  });

  it('escapes each segment without escaping the separators', () => {
    expect(fileUrl('https://github.com/acme/web', 'feature/a b', 'src/a b.ts')).toBe(
      'https://github.com/acme/web/blob/feature/a%20b/src/a%20b.ts',
    );
  });
});
