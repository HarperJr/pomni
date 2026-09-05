#!/usr/bin/env node
/**
 * SessionStart hook.
 *
 * Puts the live state of the workspace in front of the session — projects, where their code
 * actually is, what is open, what is failing, and which agent workflows are attached — so it
 * starts knowing what exists rather than discovering it one command at a time.
 *
 * CLAUDE.md carries the durable rules; this carries only what changes. Best effort by design:
 * an uninitialised workspace, or a Pomni that is not built yet, must never block a session.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(repoRoot, 'packages', 'cli', 'bin', 'pomni.mjs');

if (!existsSync(join(repoRoot, '.pomni', 'config.yaml')) || !existsSync(cli)) process.exit(0);

const run = (args) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return result.status === 0 ? result.stdout.trim() : '';
};

const projects = run(['project', 'list']);
if (!projects) process.exit(0);

const sections = ['## Pomni workspace', '', projects];

// Where the code actually is. The single most common thing a session needs and the one it
// is most likely to guess wrong, because a repo may be a managed clone or a linked folder.
const repos = run(['repo', 'list']);
if (repos && !repos.startsWith('no repos')) {
  sections.push('', '### Repos', '', repos);
}

const backlog = run(['backlog', 'list', '-s', 'active']);
if (backlog && !backlog.startsWith('nothing here')) {
  sections.push('', '### Open backlog', '', backlog);
}

const failed = run(['runs', 'list', '--failed', '-n', '5']);
if (failed && !failed.startsWith('no runs')) {
  sections.push('', '### Recent failures', '', failed);
}

const workflows = run(['workflow', 'list']);
if (workflows && !workflows.startsWith('none yet')) {
  sections.push('', '### Agent workflows', '', workflows);
}

sections.push(
  '',
  '### How to work here',
  '',
  'Change state through the CLI (`node packages/cli/bin/pomni.mjs …`), not by editing',
  '`.pomni/**.yaml` — the CLI runs the transition guards, appends to the item log, and emits',
  'the events the browser is watching. A backlog item\'s prose body is the exception: edit it',
  'with normal file tools.',
  '',
  'Move an item with `backlog move <ID> <status>`; a move to `in_review` requires the gate to',
  'have passed, so run `verify` first. See CLAUDE.md for the full rules.',
);

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: sections.join('\n'),
    },
  }),
);
