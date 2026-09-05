import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PomniError } from '@pomni/core';
import { createHarness, makeNodeRepo, type TestHarness } from './harness.js';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme SaaS' });
});

afterEach(async () => {
  await harness.cleanup();
});

describe('projects', () => {
  it('derives an id and item prefix from the name', async () => {
    const list = await harness.projects.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('acme-saas');
    expect(list[0]?.itemPrefix).toBe('ACME');
  });

  it('refuses a duplicate id', async () => {
    await expect(harness.projects.create({ name: 'Acme SaaS' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('lists projects by scanning, with no index file to drift', async () => {
    await harness.projects.create({ name: 'Second' });
    expect((await harness.projects.list()).map((project) => project.id)).toEqual([
      'acme-saas',
      'second',
    ]);
  });

  it('allocates sequential backlog ids', async () => {
    expect(await harness.projects.nextItemId('acme-saas')).toBe('ACME-1');
    expect(await harness.projects.nextItemId('acme-saas')).toBe('ACME-2');
  });
});

describe('adding a local repo', () => {
  it('links in place and detects the stack', async () => {
    const path = await makeNodeRepo(join(harness.dir, 'web'));
    const { completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'local', path },
      role: 'web',
    });
    const repo = await completion;

    expect(repo.status).toBe('linked');
    expect(repo.stack?.adapter).toBe('node');
    expect(repo.stack?.detected).toContain('next@15');
    expect(Object.keys(repo.capabilities).sort()).toEqual([
      'build',
      'dev',
      'install',
      'lint',
      'test',
      'typecheck',
    ]);

    // Linked, not copied: the working dir is the user's own folder.
    const resolved = await harness.repos.get('acme-saas', repo.id);
    expect(resolved.workingDir).toBe(path);
    expect(harness.git.clones).toHaveLength(0);
  });

  it('rejects a path that does not exist', async () => {
    await expect(
      harness.repos.add('acme-saas', {
        source: { kind: 'local', path: join(harness.dir, 'nope') },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('refuses to add the same folder twice', async () => {
    const path = await makeNodeRepo(join(harness.dir, 'web'));
    await (await harness.repos.add('acme-saas', { source: { kind: 'local', path } })).completion;

    await expect(
      harness.repos.add('acme-saas', { source: { kind: 'local', path } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('never deletes a linked folder on remove', async () => {
    const path = await makeNodeRepo(join(harness.dir, 'web'));
    const { repo, completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'local', path },
    });
    await completion;
    await harness.repos.remove('acme-saas', repo.id, { purge: true });

    expect(await harness.fs.exists(join(path, 'package.json'))).toBe(true);
    expect(await harness.repos.list('acme-saas')).toHaveLength(0);
  });

  it('treats a repo removed mid-clone as cancelled, not as a crash', async () => {
    const { repo, completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'git', url: 'https://github.com/o/r.git' },
    });

    // Delete the record while the background clone is still running.
    await harness.repos.remove('acme-saas', repo.id);

    await expect(completion).resolves.toMatchObject({ id: repo.id });
    expect(await harness.repos.list('acme-saas')).toHaveLength(0);
  });
});

describe('adding a git repo', () => {
  it('reports cloning immediately and becomes ready when the clone finishes', async () => {
    const { repo, completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'git', url: 'https://github.com/owner/Hello-World.git' },
    });

    expect(repo.status).toBe('cloning');
    expect(repo.id).toBe('hello-world');
    expect(repo.source).toMatchObject({ kind: 'git', provider: 'github' });

    const settled = await completion;
    expect(settled.status).toBe('ready');
    expect(settled.vcs?.currentBranch).toBe('main');
  });

  it('clones into the managed workspace, not next to the user code', async () => {
    const { repo, completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'git', url: 'https://github.com/owner/repo.git' },
    });
    await completion;

    const resolved = await harness.repos.get('acme-saas', repo.id);
    expect(resolved.workingDir).toBe(join(harness.root, 'workspace', 'acme-saas', 'repo'));
    expect(harness.git.clones[0]?.dir).toBe(resolved.workingDir);
  });

  it('records a failed clone on the repo instead of throwing at the caller', async () => {
    harness.git.failNextClone = 'authentication failed';
    const { completion } = await harness.repos.add('acme-saas', {
      source: { kind: 'git', url: 'https://github.com/owner/private.git' },
    });

    const settled = await completion;
    expect(settled.status).toBe('error');
    expect(settled.lastError).toMatch(/authentication failed/);
  });

  it('treats urls differing only by .git or trailing slash as the same remote', async () => {
    await (
      await harness.repos.add('acme-saas', {
        source: { kind: 'git', url: 'https://github.com/owner/repo.git' },
      })
    ).completion;

    await expect(
      harness.repos.add('acme-saas', {
        source: { kind: 'git', url: 'https://github.com/owner/repo' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('gives a second repo with the same name a distinct id', async () => {
    await (
      await harness.repos.add('acme-saas', {
        source: { kind: 'git', url: 'https://github.com/one/repo.git' },
      })
    ).completion;
    const second = await harness.repos.add('acme-saas', {
      source: { kind: 'git', url: 'https://github.com/two/repo.git' },
    });
    expect(second.repo.id).toBe('repo-2');
    await second.completion;
  });

  it('rejects an unknown credential before doing any work', async () => {
    await expect(
      harness.repos.add('acme-saas', {
        source: { kind: 'git', url: 'https://github.com/o/r.git', credential: 'missing' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(harness.git.clones).toHaveLength(0);
  });
});

describe('credentials', () => {
  it('resolves a token from an environment variable and never stores it', async () => {
    process.env.POMNI_TEST_TOKEN = 'secret-value';
    const created = await harness.credentials.create({
      name: 'GitHub',
      provider: 'github',
      secretRef: { kind: 'env', var: 'POMNI_TEST_TOKEN' },
    });

    expect(created.hasSecret).toBe(true);
    expect(await harness.credentials.auth(created.id)).toMatchObject({ secret: 'secret-value' });

    const onDisk = await harness.fs.readText(join(harness.root, 'credentials.yaml'));
    expect(onDisk).not.toContain('secret-value');
    delete process.env.POMNI_TEST_TOKEN;
  });

  it('keeps a stored token out of the tracked credentials file', async () => {
    await harness.credentials.create({
      name: 'Stored',
      provider: 'github',
      secretRef: { kind: 'file' },
      secret: 'ghp_example',
    });

    const tracked = await harness.fs.readText(join(harness.root, 'credentials.yaml'));
    const untracked = await harness.fs.readText(join(harness.root, 'credentials.secret.json'));
    expect(tracked).not.toContain('ghp_example');
    expect(untracked).toContain('ghp_example');
  });

  it('matches a credential to a repo url by host', async () => {
    process.env.POMNI_TEST_TOKEN = 'tok';
    await harness.credentials.create({
      name: 'GitHub',
      provider: 'github',
      secretRef: { kind: 'env', var: 'POMNI_TEST_TOKEN' },
    });

    await (
      await harness.repos.add('acme-saas', {
        source: { kind: 'git', url: 'https://github.com/o/r.git' },
      })
    ).completion;

    expect(harness.git.authSeen[0]).toMatchObject({ secret: 'tok' });
    delete process.env.POMNI_TEST_TOKEN;
  });

  it('reports a masked tail so two tokens can be told apart, and never more', async () => {
    const created = await harness.credentials.create({
      name: 'Long',
      provider: 'gitlab',
      host: 'a.example.com',
      secretRef: { kind: 'file' },
      secret: 'glpat-ABCDEFGHIJKLM4f2a',
    });
    expect(created.secretHint).toBe('••••' + '4f2a');

    // Short enough that four characters would give away a meaningful fraction.
    const short = await harness.credentials.create({
      name: 'Short',
      provider: 'gitlab',
      host: 'b.example.com',
      secretRef: { kind: 'file' },
      secret: 'abc123',
    });
    expect(short.secretHint).toBe('••••');

    // Whatever is listed must not contain either token in full.
    const listed = JSON.stringify(await harness.credentials.list());
    expect(listed).not.toContain('glpat-ABCDEFGHIJKLM4f2a');
    expect(listed).not.toContain('abc123');
  });

  it('forgets a stored token when the source stops being file storage', async () => {
    const created = await harness.credentials.create({
      name: 'Rotating',
      provider: 'gitlab',
      host: 'c.example.com',
      secretRef: { kind: 'file' },
      secret: 'glpat-STORED-TOKEN-VALUE',
    });
    expect(created.hasSecret).toBe(true);

    await harness.credentials.update(created.id, { secretRef: { kind: 'env', var: 'NOT_SET' } });

    const raw = await harness.fs.readText(join(harness.root, 'credentials.secret.json'));
    expect(raw).not.toContain('glpat-STORED-TOKEN-VALUE');
  });

  it('refuses to switch to stored storage without a token', async () => {
    const created = await harness.credentials.create({
      name: 'Env only',
      provider: 'gitlab',
      host: 'd.example.com',
      secretRef: { kind: 'env', var: 'NOT_SET' },
    });

    await expect(
      harness.credentials.update(created.id, { secretRef: { kind: 'file' } }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('carries provider defaults across when they were never overridden', async () => {
    const created = await harness.credentials.create({
      name: 'Moves',
      provider: 'github',
      secretRef: { kind: 'env', var: 'NOT_SET' },
    });
    expect(created.host).toBe('github.com');
    expect(created.username).toBe('pomni');

    const moved = await harness.credentials.update(created.id, { provider: 'gitlab' });
    expect(moved.host).toBe('gitlab.com');
    expect(moved.username).toBe('oauth2');
  });

  it('leaves an overridden host alone when the provider changes', async () => {
    const created = await harness.credentials.create({
      name: 'Self hosted',
      provider: 'github',
      host: 'git.internal:3380',
      secretRef: { kind: 'env', var: 'NOT_SET' },
    });

    const moved = await harness.credentials.update(created.id, { provider: 'gitlab' });
    expect(moved.host).toBe('git.internal:3380');
  });

  it('matches a credential to a url whose host carries a port', async () => {
    process.env.POMNI_TEST_TOKEN = 'tok';
    await harness.credentials.create({
      name: 'Self hosted',
      provider: 'gitlab',
      host: 'git.internal',
      secretRef: { kind: 'env', var: 'POMNI_TEST_TOKEN' },
    });

    const matched = await harness.credentials.findForUrl('http://git.internal:3380/g/p.git');
    expect(matched?.host).toBe('git.internal');
    delete process.env.POMNI_TEST_TOKEN;
  });

  it('refuses a token that was supplied for a non-file secret source', async () => {
    await expect(
      harness.credentials.create({
        name: 'Bad',
        provider: 'github',
        secretRef: { kind: 'gh-cli' },
        secret: 'ghp_oops',
      }),
    ).rejects.toBeInstanceOf(PomniError);
  });
});
