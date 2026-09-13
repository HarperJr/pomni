import { describe, expect, it } from 'vitest';
import {
  CHAT_ACTIONS,
  CHAT_ACTION_GROUPS,
  CHAT_ACTION_GROUP_INFO,
  CHAT_PROMPT_RESERVE_BYTES,
  actionBriefing,
  describeAction,
  measureActionPrompt,
  type ChatActionGroup,
} from '@pomni/core';
// Not re-exported from the barrel yet — this module is not wired into anything else. Imported
// directly rather than waiting for `packages/core/src/index.ts` to grow an export nobody but
// this budget check needs.
import { PROMPT_LINT_THRESHOLD_BYTES } from '../packages/core/src/domain/prompt.js';

/**
 * The registry POMN-68 grows: every action declares a group, and the prompt that carries the
 * catalogue to the model has to survive that growth. These tests are written against the shape
 * the domain designer settled (see the `chat-actions-shape.md` handover) before the registry
 * itself exists, so a name or a field missing here is the registry not being there yet, not a
 * typo in the test.
 */

function findAction(name: string) {
  const found = CHAT_ACTIONS.find((action) => action.name === name);
  if (!found) throw new Error(`missing action '${name}'`);
  return found;
}

describe('registry invariants', () => {
  it('gives null as a group only to actions.expand, and only actions.expand', () => {
    const nullGroup = CHAT_ACTIONS.filter((action) => action.group === null);
    expect(nullGroup.map((action) => action.name)).toEqual(['actions.expand']);
  });

  it('names every grouped action after the group it is in', () => {
    for (const action of CHAT_ACTIONS) {
      if (action.group === null) continue;
      expect(
        action.name.startsWith(`${action.group}.`),
        `'${action.name}' is in group '${action.group}' but does not start with '${action.group}.'`,
      ).toBe(true);
    }
  });

  it('gives every declared group at least one action', () => {
    for (const group of CHAT_ACTION_GROUPS) {
      const inGroup = CHAT_ACTIONS.filter((action) => action.group === group);
      expect(inGroup.length, `group '${group}' has no actions in the registry`).toBeGreaterThan(0);
    }
  });

  // The names and writes flags come verbatim from the `chat-action-names.md` handover: the
  // existing 18 actions (12 read, 6 write) plus every action named for the new groups, plus
  // `actions.expand` itself. Every one of them is a claim from that handover, not a guess of
  // this agent's own.
  const EXPECTED: Array<{ name: string; writes: boolean }> = [
    { name: 'actions.expand', writes: false },

    // existing 18
    { name: 'project.list', writes: false },
    { name: 'project.show', writes: false },
    { name: 'repo.list', writes: false },
    { name: 'backlog.list', writes: false },
    { name: 'backlog.show', writes: false },
    { name: 'backlog.flow', writes: false },
    { name: 'workflow.list', writes: false },
    { name: 'workflow.show', writes: false },
    { name: 'tool.list', writes: false },
    { name: 'run.list', writes: false },
    { name: 'run.show', writes: false },
    { name: 'question.list', writes: false },
    { name: 'backlog.create', writes: true },
    { name: 'backlog.move', writes: true },
    { name: 'task.start', writes: true },
    { name: 'workflow.attach', writes: true },
    { name: 'tool.attach', writes: true },
    { name: 'question.answer', writes: true },

    // project
    { name: 'project.create', writes: true },
    { name: 'project.edit', writes: true },
    { name: 'project.remove', writes: true },

    // repo
    { name: 'repo.add', writes: true },
    { name: 'repo.sync', writes: true },
    { name: 'repo.doctor', writes: false },
    { name: 'repo.remove', writes: true },

    // backlog
    { name: 'backlog.edit', writes: true },
    { name: 'backlog.block', writes: true },
    { name: 'backlog.unblock', writes: true },
    { name: 'backlog.link', writes: true },
    { name: 'backlog.remove', writes: true },
    { name: 'backlog.next', writes: false },
    { name: 'backlog.waves', writes: false },
    { name: 'backlog.comment', writes: true },

    // task
    { name: 'task.list', writes: false },
    { name: 'task.show', writes: false },
    { name: 'task.cancel', writes: true },
    { name: 'task.resume', writes: true },
    { name: 'task.rerun', writes: true },
    { name: 'task.comment', writes: true },
    { name: 'task.spend', writes: false },

    // run
    { name: 'run.run', writes: true },
    { name: 'run.verify', writes: true },

    // workflow
    { name: 'workflow.create', writes: true },
    { name: 'workflow.remove', writes: true },
    { name: 'workflow.detach', writes: true },
    { name: 'workflow.agentAdd', writes: true },
    { name: 'workflow.agentEdit', writes: true },
    { name: 'workflow.agentRemove', writes: true },
    { name: 'workflow.signals', writes: false },
    { name: 'workflow.amend', writes: true },

    // tool
    { name: 'tool.add', writes: true },
    { name: 'tool.edit', writes: true },
    { name: 'tool.check', writes: false },
    { name: 'tool.detach', writes: true },
    { name: 'tool.remove', writes: true },

    // cred
    { name: 'cred.list', writes: false },
    { name: 'cred.add', writes: true },
    { name: 'cred.edit', writes: true },
    { name: 'cred.test', writes: false },
    { name: 'cred.remove', writes: true },

    // provider
    { name: 'provider.list', writes: false },
    { name: 'provider.add', writes: true },
    { name: 'provider.use', writes: true },
    { name: 'provider.remove', writes: true },

    // worktree
    { name: 'worktree.list', writes: false },
    { name: 'worktree.prune', writes: true },
    { name: 'worktree.remove', writes: true },

    // discover
    { name: 'discover.list', writes: false },
    { name: 'discover.show', writes: false },
  ];

  it.each(EXPECTED)('has $name with writes=$writes', ({ name, writes }) => {
    const found = CHAT_ACTIONS.find((action) => action.name === name);
    expect(found, `missing action '${name}'`).toBeDefined();
    expect(found?.writes).toBe(writes);
  });
});

describe('the assembled action prompt fits the budget', () => {
  it('equals policy.promptBudget\'s default of 8000 bytes (project.ts:75)', () => {
    // Lint has to warn about exactly the prompts the runtime budget would start trimming, so
    // the two numbers are not allowed to disagree about what "too big" means.
    expect(PROMPT_LINT_THRESHOLD_BYTES).toBe(8000);
  });

  it('fits with no group opened', () => {
    const { bytes } = measureActionPrompt([]);
    const total = bytes + CHAT_PROMPT_RESERVE_BYTES;
    expect(
      total,
      `closed catalogue ${bytes}B + reserve ${CHAT_PROMPT_RESERVE_BYTES}B = ${total}B`,
    ).toBeLessThanOrEqual(PROMPT_LINT_THRESHOLD_BYTES);
  });

  it.each(CHAT_ACTION_GROUPS.map((group) => [group] as const))('fits with only %s opened', (group) => {
    const { bytes } = measureActionPrompt([group]);
    const total = bytes + CHAT_PROMPT_RESERVE_BYTES;
    expect(
      total,
      `'${group}' opened: ${bytes}B + reserve ${CHAT_PROMPT_RESERVE_BYTES}B = ${total}B`,
    ).toBeLessThanOrEqual(PROMPT_LINT_THRESHOLD_BYTES);
  });

  const pairs: Array<readonly [ChatActionGroup, ChatActionGroup]> = [];
  for (let i = 0; i < CHAT_ACTION_GROUPS.length; i += 1) {
    for (let j = i + 1; j < CHAT_ACTION_GROUPS.length; j += 1) {
      pairs.push([CHAT_ACTION_GROUPS[i]!, CHAT_ACTION_GROUPS[j]!]);
    }
  }

  it.each(pairs)('fits with %s and %s opened together', (a, b) => {
    const { bytes } = measureActionPrompt([a, b]);
    const total = bytes + CHAT_PROMPT_RESERVE_BYTES;
    expect(
      total,
      `'${a}' + '${b}' opened: ${bytes}B + reserve ${CHAT_PROMPT_RESERVE_BYTES}B = ${total}B`,
    ).toBeLessThanOrEqual(PROMPT_LINT_THRESHOLD_BYTES);
  });
});

describe('actionBriefing', () => {
  it('lists every closed group as one line, and hides what is inside it', () => {
    const briefing = actionBriefing([]);

    expect(briefing).toContain('actions.expand');

    for (const group of CHAT_ACTION_GROUPS) {
      const count = CHAT_ACTIONS.filter((action) => action.group === group).length;
      const pattern = new RegExp(`\`${group}\`[^\\n]*\\(${count} action`);
      expect(briefing, `expected a closed-group line for '${group}' naming ${count} actions`).toMatch(
        pattern,
      );
    }

    expect(briefing).not.toContain('`repo.remove`');
    expect(briefing).not.toContain('repo.remove');
  });

  it('expands an opened group into the actions inside it', () => {
    const briefing = actionBriefing(['repo']);

    expect(briefing).toMatch(/###\s*repo\b/);
    expect(briefing).toContain('`repo.remove`');
    // The write tag sits on the line that names the action, not merely somewhere in the text.
    expect(briefing).toMatch(/`repo\.remove`[^\n]*\[confirm\]/);
  });
});

describe('CHAT_ACTION_GROUP_INFO', () => {
  it('describes every group the domain declares', () => {
    for (const group of CHAT_ACTION_GROUPS) {
      expect(CHAT_ACTION_GROUP_INFO[group], `no description for group '${group}'`).toBeTruthy();
    }
  });
});

describe('confirm sentences', () => {
  it('names the repo and the project when removing a repo', () => {
    expect(describeAction(findAction('repo.remove'), { project: 'acme', repo: 'api' })).toBe(
      "Remove repo 'api' from project 'acme'. Pomni's record of it is deleted; the files on disk are kept.",
    );
  });

  it('says the clone goes too when the removal is purged', () => {
    expect(
      describeAction(findAction('repo.remove'), { project: 'acme', repo: 'api', purge: true }),
    ).toBe(
      "Remove repo 'api' from project 'acme' and delete its cloned working copy. Pomni's record and the clone under the workspace are deleted; a linked local repository is never deleted.",
    );
  });

  it('says what stays on disk when removing a project', () => {
    expect(describeAction(findAction('project.remove'), { project: 'acme' })).toBe(
      "Remove project 'acme'. Its backlog, repo records and settings are deleted; cloned working copies and linked local repositories stay on disk.",
    );
  });

  it('says the clones go too when the project removal is purged', () => {
    expect(describeAction(findAction('project.remove'), { project: 'acme', purge: true })).toBe(
      "Remove project 'acme' and delete its cloned working copies. Its backlog, repo records and settings are deleted along with every clone under the workspace; linked local repositories are never deleted.",
    );
  });

  it('says what worktree.prune keeps', () => {
    expect(describeAction(findAction('worktree.prune'), { project: 'acme' })).toBe(
      "Prune orphaned worktrees in 'acme'. Worktrees with uncommitted work are kept.",
    );
  });
});
