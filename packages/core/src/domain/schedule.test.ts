import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.js';
import type { BacklogItem } from './item.js';
import {
  extractPlanPaths,
  pathsOverlap,
  planWaves,
  type ConflictEdge,
  type WavePlan,
} from './schedule.js';

/**
 * Pure-domain tests for wave planning. No harness and no I/O: `planWaves` takes an already
 * resolved `repoIsolatesRuns` map, so everything here is a fixture and a function call.
 */

/** A ready item with only the fields wave planning reads. Same cast pattern as `tests/backlog.test.ts`. */
function item(fields: Partial<BacklogItem> & { id: string }): BacklogItem {
  return {
    status: 'ready',
    order: 10,
    repos: [],
    touches: [],
    dependsOn: [],
    body: '',
    ...fields,
  } as BacklogItem;
}

function planOf(items: BacklogItem[], repoIsolatesRuns: Record<string, boolean> = {}): WavePlan {
  return planWaves({ items, repoIsolatesRuns });
}

function edgeBetween(plan: WavePlan, a: string, b: string): ConflictEdge | undefined {
  return plan.conflicts.find(
    (edge) => (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a),
  );
}

function waveOf(plan: WavePlan, id: string): number | undefined {
  return plan.waves.find((wave) => wave.itemIds.includes(id))?.index;
}

const planSection = (...paths: string[]) => `## Plan\n\n${paths.map((p) => `1. Edit \`${p}\``).join('\n')}\n`;

describe('waves', () => {
  it('makes a chain of dependencies run one wave at a time, prerequisite first', () => {
    // Deliberately fed in the order A, B, C — the reverse of the order they must run in — so a
    // planner that placed items in the order it saw them would fail here.
    const items = [
      item({ id: 'POMN-1', order: 10, repos: ['api'], dependsOn: ['POMN-2'], touches: ['a.ts'] }),
      item({ id: 'POMN-2', order: 20, repos: ['web'], dependsOn: ['POMN-3'], touches: ['b.ts'] }),
      item({ id: 'POMN-3', order: 30, repos: ['docs'], touches: ['c.ts'] }),
    ];

    const plan = planOf(items, { api: true, web: true, docs: true });

    expect(plan.waves).toEqual([
      { index: 1, itemIds: ['POMN-3'] },
      { index: 2, itemIds: ['POMN-2'] },
      { index: 3, itemIds: ['POMN-1'] },
    ]);
    expect(plan.blocked).toEqual([]);
  });

  it('keeps two items that edit the same file apart even when the repo isolates runs', () => {
    const path = 'packages/core/src/app/pipeline-service.ts';
    const items = [
      item({ id: 'POMN-4', order: 10, repos: ['core'], body: planSection(path) }),
      item({ id: 'POMN-5', order: 20, repos: ['core'], body: planSection(path) }),
    ];

    // Isolation is on, so a worktree is available to each run and the only thing that can
    // separate these two is the file they both rewrite.
    const plan = planOf(items, { core: true });

    expect(waveOf(plan, 'POMN-4')).not.toBe(waveOf(plan, 'POMN-5'));
    expect(plan.waves).toHaveLength(2);

    const edge = edgeBetween(plan, 'POMN-4', 'POMN-5');
    expect(edge?.reasons).toContainEqual({ kind: 'path_overlap', path, otherPath: path });
    expect(edge?.reasons.some((reason) => reason.kind === 'shared_repo')).toBe(false);
  });

  it('reads a directory as covering the files under it, and not a directory it merely prefixes', () => {
    expect(pathsOverlap('packages/core', 'packages/core/src/app/x.ts')).toBe(true);
    expect(pathsOverlap('packages/core/src/app/x.ts', 'packages/core')).toBe(true);
    expect(pathsOverlap('packages/core', 'packages/corex/y.ts')).toBe(false);
  });

  it('treats an item that names no paths as touching its whole repo', () => {
    const items = [
      item({ id: 'POMN-6', order: 10, repos: ['core'], body: '## Problem\n\nSomething is wrong.\n' }),
      item({
        id: 'POMN-7',
        order: 20,
        repos: ['core'],
        body: planSection('packages/core/src/domain/item.ts'),
      }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.scopes['POMN-6']).toEqual({ kind: 'whole-repo' });
    expect(plan.scopes['POMN-7']).toEqual({
      kind: 'paths',
      paths: ['packages/core/src/domain/item.ts'],
      source: 'plan',
    });
    // Even with worktrees available, an item that may rewrite anything cannot share a wave with
    // an item in the same repo.
    expect(waveOf(plan, 'POMN-6')).not.toBe(waveOf(plan, 'POMN-7'));
    expect(edgeBetween(plan, 'POMN-6', 'POMN-7')?.reasons).toContainEqual({
      kind: 'path_overlap',
      path: '*',
      otherPath: 'packages/core/src/domain/item.ts',
    });
  });

  it('launches items that cannot collide together in one wave', () => {
    const items = [
      item({ id: 'POMN-8', order: 10, repos: ['api'], body: planSection('src/auth.ts') }),
      item({ id: 'POMN-9', order: 20, repos: ['web'], body: planSection('src/auth.ts') }),
      item({ id: 'POMN-10', order: 30, repos: ['api'], body: planSection('src/billing.ts') }),
    ];

    const plan = planOf(items, { api: true, web: true });

    // Codepoint order, not numeric: 'POMN-10' sorts before 'POMN-8'.
    expect(plan.waves).toEqual([{ index: 1, itemIds: ['POMN-8', 'POMN-9', 'POMN-10'] }]);
    expect(plan.conflicts).toEqual([]);
  });

  it('lets declared touches override what the Plan section says', () => {
    const items = [item({ id: 'POMN-11', repos: ['core'], touches: ['c/d.ts'], body: planSection('a/b.ts') })];

    const plan = planOf(items, { core: true });

    expect(plan.scopes['POMN-11']).toEqual({ kind: 'paths', paths: ['c/d.ts'], source: 'touches' });
  });

  it('holds a ready item back when something it depends on was cancelled', () => {
    const items = [
      item({ id: 'POMN-12', order: 10, repos: ['api'], dependsOn: ['POMN-13'], touches: ['a.ts'] }),
      item({ id: 'POMN-13', order: 20, status: 'cancelled', repos: ['api'] }),
      item({ id: 'POMN-14', order: 30, repos: ['web'], touches: ['b.ts'] }),
    ];

    const plan = planOf(items, { api: true, web: true });

    expect(plan.blocked).toEqual([{ itemId: 'POMN-12', waitingOn: ['POMN-13'] }]);
    expect(waveOf(plan, 'POMN-12')).toBeUndefined();
    expect(plan.waves).toEqual([{ index: 1, itemIds: ['POMN-14'] }]);
  });

  it('refuses to plan a dependency cycle, and names the items in it', () => {
    const items = [
      item({ id: 'POMN-15', order: 10, dependsOn: ['POMN-16'] }),
      item({ id: 'POMN-16', order: 20, dependsOn: ['POMN-15'] }),
    ];

    expect(() => planOf(items)).toThrow(ValidationError);
    expect(() => planOf(items)).toThrow(/POMN-15[\s\S]*POMN-16/);
  });

  it('gives the same waves whatever order the backlog is read in', () => {
    const items = [
      item({ id: 'POMN-17', order: 10, repos: ['api'], dependsOn: ['POMN-19'], touches: ['a.ts'] }),
      item({ id: 'POMN-18', order: 20, repos: ['web'], touches: ['b.ts'] }),
      item({ id: 'POMN-19', order: 30, repos: ['api'], touches: ['c.ts'] }),
      item({ id: 'POMN-20', order: 40, repos: ['api'], touches: ['a.ts'] }),
    ];
    const isolation = { api: true, web: true };

    expect(planOf([...items].reverse(), isolation).waves).toEqual(planOf(items, isolation).waves);
  });
});

describe('reading paths out of a Plan section', () => {
  it('believes a backticked path and disbelieves a command, a URL and a code block', () => {
    const plan = [
      'Run `npm run typecheck` when done, see https://example.com/docs/plan.md.',
      '',
      '1. Rewrite `packages/core/src/domain/schedule.ts`.',
      '',
      '```',
      'packages/core/src/not-a-plan.ts',
      '```',
      '',
    ].join('\n');

    expect(extractPlanPaths(plan)).toEqual(['packages/core/src/domain/schedule.ts']);
  });
});
