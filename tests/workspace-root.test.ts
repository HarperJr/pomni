import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findWorkspaceRoot } from '@pomni/infra';

/**
 * Which `.pomni` a command belongs to.
 *
 * The Pomni repository is the one case where a run's checkout lives *inside* a workspace —
 * `<root>/.pomni/worktrees/<project>/<repo>/<run>` — and also carries a `.pomni` of its own,
 * because the tracked half of the workspace is committed. Getting the boundary wrong there
 * hands an agent the live backlog, the live database and the live credentials.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pomni-root-'));
  await mkdir(join(root, '.pomni', 'worktrees', 'pomni', 'pomni-2', 'RUN', '.pomni'), {
    recursive: true,
  });
  await mkdir(join(root, 'packages', 'core'), { recursive: true });
  await mkdir(join(root, '.pomni', 'worktrees', 'pomni', 'pomni-2', 'RUN', 'packages'), {
    recursive: true,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('finding the workspace a command belongs to', () => {
  it('answers with the live workspace from anywhere in the repo', async () => {
    expect(await findWorkspaceRoot(root)).toBe(join(root, '.pomni'));
    expect(await findWorkspaceRoot(join(root, 'packages', 'core'))).toBe(join(root, '.pomni'));
  });

  it("gives a run its own workspace, not the one running it", async () => {
    const run = join(root, '.pomni', 'worktrees', 'pomni', 'pomni-2', 'RUN');
    expect(await findWorkspaceRoot(run)).toBe(join(run, '.pomni'));
    expect(await findWorkspaceRoot(join(run, 'packages'))).toBe(join(run, '.pomni'));
  });

  it('refuses the live workspace to a path sitting inside its worktrees', async () => {
    // One `cd ..` out of the run's checkout, and the walk used to sail up to the live
    // workspace. A workspace that contains you among its worktrees is the harness running
    // you, not the workspace you are working in.
    const between = join(root, '.pomni', 'worktrees', 'pomni', 'pomni-2');
    expect(await findWorkspaceRoot(between)).toBeNull();
    expect(await findWorkspaceRoot(join(root, '.pomni', 'worktrees'))).toBeNull();
  });

  it('still answers for a workspace that has no worktrees directory at all', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'pomni-plain-'));
    try {
      await mkdir(join(plain, '.pomni'), { recursive: true });
      expect(await findWorkspaceRoot(plain)).toBe(join(plain, '.pomni'));
    } finally {
      await rm(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
