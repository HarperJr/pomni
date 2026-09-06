import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.js';
import type { BacklogItem } from './item.js';
import {
  assertWavesDisjoint,
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

  it('separates an item working in a directory from one working on a file inside it', () => {
    // The containment rule reaching all the way through planning, not only through
    // `pathsOverlap`: one item claims a directory, the next a file underneath it.
    const items = [
      item({ id: 'POMN-21', order: 10, repos: ['core'], touches: ['packages/core/src/app'] }),
      item({
        id: 'POMN-22',
        order: 20,
        repos: ['core'],
        body: planSection('packages/core/src/app/pipeline-service.ts'),
      }),
      // The near miss: a sibling directory that merely shares a prefix is free to run alongside.
      item({ id: 'POMN-23', order: 30, repos: ['core'], touches: ['packages/core/src/appx'] }),
    ];

    const plan = planOf(items, { core: true });

    expect(waveOf(plan, 'POMN-21')).not.toBe(waveOf(plan, 'POMN-22'));
    expect(waveOf(plan, 'POMN-21')).toBe(waveOf(plan, 'POMN-23'));
    expect(edgeBetween(plan, 'POMN-21', 'POMN-22')?.reasons).toContainEqual({
      kind: 'path_overlap',
      path: 'packages/core/src/app',
      otherPath: 'packages/core/src/app/pipeline-service.ts',
    });
    expect(edgeBetween(plan, 'POMN-21', 'POMN-23')).toBeUndefined();
  });

  it('serialises two items in a repo that cannot give each run its own worktree', () => {
    // Same two items, planned twice against opposite isolation. Nothing but the worktree answer
    // differs, so this is exactly the boundary the repo's isolation probe moves.
    const items = () => [
      item({ id: 'POMN-24', order: 10, repos: ['core'], touches: ['src/auth.ts'] }),
      item({ id: 'POMN-25', order: 20, repos: ['core'], touches: ['src/billing.ts'] }),
    ];

    const serialised = planOf(items(), { core: false });
    expect(serialised.waves).toEqual([
      { index: 1, itemIds: ['POMN-24'] },
      { index: 2, itemIds: ['POMN-25'] },
    ]);
    expect(edgeBetween(serialised, 'POMN-24', 'POMN-25')?.reasons).toEqual([
      { kind: 'shared_repo', repo: 'core' },
    ]);

    // A repo missing from the map is not an unknown to guess at — it counts as not isolating.
    expect(planOf(items(), {}).waves).toEqual(serialised.waves);

    const together = planOf(items(), { core: true });
    expect(together.waves).toEqual([{ index: 1, itemIds: ['POMN-24', 'POMN-25'] }]);
    expect(together.conflicts).toEqual([]);
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

  it('still plans the ready work when two finished items point at each other', () => {
    // The cycle is real, but it sits between two items nobody ready can reach. It is history,
    // not a scheduling problem, and it must not cost the rest of the project its plan.
    const items = [
      item({ id: 'POMN-40', order: 10, status: 'done', dependsOn: ['POMN-41'] }),
      item({ id: 'POMN-41', order: 20, status: 'cancelled', dependsOn: ['POMN-40'] }),
      item({ id: 'POMN-42', order: 30, repos: ['core'], touches: ['src/auth.ts'] }),
      item({ id: 'POMN-43', order: 40, repos: ['core'], touches: ['src/billing.ts'] }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.waves).toEqual([{ index: 1, itemIds: ['POMN-42', 'POMN-43'] }]);
    expect(plan.blocked).toEqual([]);
  });

  it('still refuses when a ready item depends into a cycle', () => {
    // Same shape as above except that a ready item reaches the cycle: an item whose prerequisite
    // can never finish must never be scheduled, so this one is meant to throw.
    const items = [
      item({ id: 'POMN-44', order: 10, repos: ['core'], dependsOn: ['POMN-45'] }),
      item({ id: 'POMN-45', order: 20, status: 'in_progress', dependsOn: ['POMN-46'] }),
      item({ id: 'POMN-46', order: 30, status: 'in_progress', dependsOn: ['POMN-45'] }),
    ];

    expect(() => planOf(items, { core: true })).toThrow(ValidationError);
    expect(() => planOf(items, { core: true })).toThrow(/POMN-45[\s\S]*POMN-46/);
  });

  it('reads an item that names no repos as being in every repo, for the worktree rule too', () => {
    // Distinct files on purpose: the only thing that can separate these two is the repo they
    // share, and POMN-50 only shares it by naming no repos at all.
    const items = () => [
      item({ id: 'POMN-50', order: 10, repos: [], touches: ['src/auth.ts'] }),
      item({ id: 'POMN-51', order: 20, repos: ['core'], touches: ['src/billing.ts'] }),
    ];

    const serialised = planOf(items(), { core: false });
    expect(serialised.waves).toEqual([
      { index: 1, itemIds: ['POMN-50'] },
      { index: 2, itemIds: ['POMN-51'] },
    ]);
    expect(edgeBetween(serialised, 'POMN-50', 'POMN-51')?.reasons).toEqual([
      { kind: 'shared_repo', repo: 'core' },
    ]);

    // The same pair against a repo that can hand each run its own checkout: nothing left to
    // separate them.
    const together = planOf(items(), { core: true });
    expect(together.waves).toEqual([{ index: 1, itemIds: ['POMN-50', 'POMN-51'] }]);
    expect(together.conflicts).toEqual([]);
  });

  it('treats an item whose Plan names only a bare filename as touching its whole repo', () => {
    const items = [
      // `schedule.ts` could be any file in the tree with that name, so it is not a path claim.
      item({ id: 'POMN-52', order: 10, repos: ['core'], body: planSection('schedule.ts') }),
      item({
        id: 'POMN-53',
        order: 20,
        repos: ['core'],
        body: planSection('packages/core/src/domain/item.ts'),
      }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.scopes['POMN-52']).toEqual({ kind: 'whole-repo' });
    expect(waveOf(plan, 'POMN-52')).not.toBe(waveOf(plan, 'POMN-53'));
    expect(edgeBetween(plan, 'POMN-52', 'POMN-53')?.reasons).toContainEqual({
      kind: 'path_overlap',
      path: '*',
      otherPath: 'packages/core/src/domain/item.ts',
    });
  });

  it('reads a Windows path as the same file its forward-slash twin names', () => {
    const items = [
      item({
        id: 'POMN-54',
        order: 10,
        repos: ['core'],
        body: planSection('packages\\core\\src\\domain\\schedule.ts'),
      }),
      item({
        id: 'POMN-55',
        order: 20,
        repos: ['core'],
        body: planSection('packages/core/src/domain/schedule.ts'),
      }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.scopes['POMN-54']).toEqual({
      kind: 'paths',
      paths: ['packages/core/src/domain/schedule.ts'],
      source: 'plan',
    });
    expect(waveOf(plan, 'POMN-54')).not.toBe(waveOf(plan, 'POMN-55'));
    expect(edgeBetween(plan, 'POMN-54', 'POMN-55')?.reasons).toContainEqual({
      kind: 'path_overlap',
      path: 'packages/core/src/domain/schedule.ts',
      otherPath: 'packages/core/src/domain/schedule.ts',
    });
  });

  it('reads an absolute Windows path as no path at all, unlike its repo-relative twin', () => {
    // The pair is the whole point: the same file, spelled once from the drive root and once from
    // the repo root. Only the second is something a repo-relative path could ever be compared
    // against, so only the second may narrow the item's scope. Cutting `C:\Users\me\repo\` off
    // the first would be the domain guessing where a repo starts.
    const items = [
      item({
        id: 'POMN-56',
        order: 10,
        repos: ['core'],
        body: planSection('C:\\Users\\me\\repo\\packages\\core\\x.ts'),
      }),
      item({ id: 'POMN-57', order: 20, repos: ['core'], body: planSection('packages\\core\\x.ts') }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.scopes['POMN-56']).toEqual({ kind: 'whole-repo' });
    expect(plan.scopes['POMN-57']).toEqual({
      kind: 'paths',
      paths: ['packages/core/x.ts'],
      source: 'plan',
    });
  });

  it('reads a file cited with a line number as the same file cited without one', () => {
    // Prose cites a file by line. If `src/auth.ts:42` stayed its own path it would overlap
    // nothing, and the two items rewriting that one file would launch into the same wave.
    const items = [
      item({ id: 'POMN-60', order: 10, repos: ['core'], body: planSection('src/auth.ts:42') }),
      item({ id: 'POMN-61', order: 20, repos: ['core'], body: planSection('src/auth.ts') }),
      // The column form of the same citation, in a repo of its own so only the path can speak.
      item({ id: 'POMN-62', order: 30, repos: ['api'], body: planSection('src/auth.ts:42:7') }),
    ];

    const plan = planOf(items, { core: true, api: true });

    for (const id of ['POMN-60', 'POMN-61', 'POMN-62']) {
      expect(plan.scopes[id]).toEqual({ kind: 'paths', paths: ['src/auth.ts'], source: 'plan' });
    }
    expect(waveOf(plan, 'POMN-60')).not.toBe(waveOf(plan, 'POMN-61'));
    expect(edgeBetween(plan, 'POMN-60', 'POMN-61')?.reasons).toContainEqual({
      kind: 'path_overlap',
      path: 'src/auth.ts',
      otherPath: 'src/auth.ts',
    });
  });

  it('matches a touches entry cited by line against one written plainly', () => {
    const items = [
      item({ id: 'POMN-63', order: 10, repos: ['core'], touches: ['src/auth.ts:42'] }),
      item({ id: 'POMN-64', order: 20, repos: ['core'], touches: ['src/auth.ts'] }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.scopes['POMN-63']).toEqual({
      kind: 'paths',
      paths: ['src/auth.ts'],
      source: 'touches',
    });
    expect(waveOf(plan, 'POMN-63')).not.toBe(waveOf(plan, 'POMN-64'));
  });

  it('reads an item whose only declared path climbs above the repo as touching everything', () => {
    // `../x.ts` cannot be placed without knowing where the repo root is, so it names nothing —
    // and an item left naming nothing is read as its whole repo, which over-conflicts rather
    // than letting it quietly share a wave with work it may well collide with.
    const items = [
      item({ id: 'POMN-65', order: 10, repos: ['core'], touches: ['../x.ts'] }),
      item({ id: 'POMN-66', order: 20, repos: ['core'], touches: ['src/billing.ts'] }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.scopes['POMN-65']).toEqual({ kind: 'whole-repo' });
    expect(waveOf(plan, 'POMN-65')).not.toBe(waveOf(plan, 'POMN-66'));
  });

  it('still plans the ready work when a cancelled prerequisite sits in a cycle of its own', () => {
    // POMN-67 waits on a cancelled item, and behind that cancelled item is a cycle between two
    // more cancelled ones. Cancelled work is settled, so that cycle is history: it must not cost
    // the project its plan. The candidate is still held back — a cancelled prerequisite needs a
    // human, not a launch — but it is reported as blocked rather than thrown over.
    const items = [
      item({ id: 'POMN-67', order: 10, repos: ['core'], dependsOn: ['POMN-68'], touches: ['src/auth.ts'] }),
      item({ id: 'POMN-68', order: 20, status: 'cancelled', dependsOn: ['POMN-69'] }),
      item({ id: 'POMN-69', order: 30, status: 'cancelled', dependsOn: ['POMN-68'] }),
      item({ id: 'POMN-70', order: 40, repos: ['core'], touches: ['src/billing.ts'] }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.blocked).toEqual([{ itemId: 'POMN-67', waitingOn: ['POMN-68'] }]);
    expect(waveOf(plan, 'POMN-67')).toBeUndefined();
    expect(plan.waves).toEqual([{ index: 1, itemIds: ['POMN-70'] }]);
  });

  it('still plans a ready item whose finished dependencies point at each other', () => {
    // POMN-1 is ready and waits on POMN-2, which is done; POMN-2 and POMN-3 are both done and
    // name each other. The cycle is only reachable *through* finished work, and finished work is
    // settled — so it is history, not something this plan has to be able to order.
    const items = [
      item({ id: 'POMN-1', order: 10, repos: ['core'], dependsOn: ['POMN-2'], touches: ['src/auth.ts'] }),
      item({ id: 'POMN-2', order: 20, status: 'done', dependsOn: ['POMN-3'] }),
      item({ id: 'POMN-3', order: 30, status: 'done', dependsOn: ['POMN-2'] }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.waves).toEqual([{ index: 1, itemIds: ['POMN-1'] }]);
    // And POMN-3 is not inherited as something POMN-1 waits on: a done dependency's own
    // dependencies are already settled, so there is nothing left there to wait for.
    expect(plan.blocked).toEqual([]);
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

describe('the check made before anything is launched', () => {
  // Plans built by hand rather than by `planWaves`, because `planWaves` cannot produce these —
  // the point of the check is to catch a plan that reached the launcher some other way.

  it('refuses a wave holding two items that conflict', () => {
    const bad: WavePlan = {
      waves: [{ index: 1, itemIds: ['POMN-26', 'POMN-27'] }],
      conflicts: [
        {
          a: 'POMN-26',
          b: 'POMN-27',
          reasons: [{ kind: 'path_overlap', path: 'src/auth.ts', otherPath: 'src/auth.ts' }],
        },
      ],
      blocked: [],
      scopes: {},
    };

    expect(() => assertWavesDisjoint(bad)).toThrow(ValidationError);
    expect(() => assertWavesDisjoint(bad)).toThrow(/POMN-26.*POMN-27.*both touch src\/auth\.ts/);
  });

  it('refuses a plan that runs a dependent before what it depends on', () => {
    const bad: WavePlan = {
      waves: [
        { index: 1, itemIds: ['POMN-28'] },
        { index: 2, itemIds: ['POMN-29'] },
      ],
      // POMN-28 depends on POMN-29 but sits in the earlier wave.
      conflicts: [
        { a: 'POMN-28', b: 'POMN-29', reasons: [{ kind: 'depends_on', from: 'POMN-28', to: 'POMN-29', via: [] }] },
      ],
      blocked: [],
      scopes: {},
    };

    expect(() => assertWavesDisjoint(bad)).toThrow(/POMN-28 depends on POMN-29 but runs in wave 1/);
  });

  it('refuses a plan that both blocks an item and schedules it', () => {
    const bad: WavePlan = {
      waves: [{ index: 1, itemIds: ['POMN-30'] }],
      conflicts: [],
      blocked: [{ itemId: 'POMN-30', waitingOn: ['POMN-31'] }],
      scopes: {},
    };

    expect(() => assertWavesDisjoint(bad)).toThrow(/POMN-30 is blocked on POMN-31/);
  });

  it('accepts a plan that planWaves actually produced', () => {
    const plan = planOf(
      [
        item({ id: 'POMN-32', order: 10, repos: ['api'], dependsOn: ['POMN-33'], touches: ['a.ts'] }),
        item({ id: 'POMN-33', order: 20, repos: ['api'], touches: ['b.ts'] }),
      ],
      { api: true },
    );

    expect(() => assertWavesDisjoint(plan)).not.toThrow();
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

  it('takes a separator, not backticks, as what makes a token a path', () => {
    // Every one of these is backticked, and none of them names a directory. A bare filename
    // could be any file in the tree; the dotted ones are not files at all.
    const plan = [
      '1. Rewrite `schedule.ts` and check `item.status` against `repo.id`.',
      '2. Await `Promise.all`, then `./x.ts` and `/y.ts`.',
      '',
    ].join('\n');

    expect(extractPlanPaths(plan)).toEqual([]);
  });

  it('reads a backslash path, so a Windows Plan is not silently scopeless', () => {
    const plan = '1. Edit `packages\\core\\src\\domain\\schedule.ts`, then `src\\auth.ts`.\n';

    expect(extractPlanPaths(plan)).toEqual([
      'packages/core/src/domain/schedule.ts',
      'src/auth.ts',
    ]);
  });

  it('keeps a path that is relative to the repo and drops every one that is not', () => {
    // Each of these normalises to something that *looks* repo-relative — `x/y.ts`,
    // `host/share/x.ts`, `etc/passwd` — which is exactly why they have to be refused before
    // normalisation rather than after it. The domain does not know where any repo root is.
    const plan = [
      '1. Edit `C:\\Users\\me\\repo\\packages\\core\\x.ts` and `C:/Users/me/repo/x.ts`.',
      '2. Copy from `\\\\host\\share\\x.ts` into `/etc/passwd`.',
      '',
    ].join('\n');

    expect(extractPlanPaths(plan)).toEqual([]);
  });

  it('drops a line citation from a path but refuses a colon anywhere else', () => {
    // `:42` and `:42:7` are how prose points at a line, and the line is not part of the file's
    // name. A colon that is not a citation is not cut at — truncating `src/a:b.ts` to `src/a`
    // would invent a path that then falsely overlaps a real one.
    const plan = [
      '1. Fix `src/auth.ts:42`, and the same bug at `src/auth.ts:42:7`.',
      '2. Leave `src/a:b.ts` and `src/x.ts:notaline` alone.',
      '',
    ].join('\n');

    expect(extractPlanPaths(plan)).toEqual(['src/auth.ts']);
  });

  it('still refuses a drive-lettered path once the line citation is taken off it', () => {
    // The citation strip runs after the drive-letter test, and this is what holds it there: a
    // `C:\...` token must not reach the path set by any route, cited or not.
    const plan = '1. Edit `C:\\x\\y.ts` and `C:\\x\\y.ts:42` and `C:/x/y.ts:42`.\n';

    expect(extractPlanPaths(plan)).toEqual([]);
  });

  it('refuses a path that still climbs above the repo, and keeps one that only dips', () => {
    // `../packages/core/x.ts` points somewhere the domain cannot place — it does not know where
    // any repo root sits. `a/b/../c` resolves to `a/c`, which is inside, and stays.
    const plan = '1. Edit `../packages/core/x.ts`, then `a/b/../c`.\n';

    expect(extractPlanPaths(plan)).toEqual(['a/c']);
  });

  it('leaves a quoted regex as prose rather than reading it as a path', () => {
    // `\d+/\w+` normalises to `d+/w+` and `\d+\w+` to `d+w+` — the first would look like a real
    // two-segment path and put two unrelated items in different waves for nothing.
    const plan = '1. Match `\\d+/\\w+`, then `\\d+\\w+`, in `src/auth.ts`.\n';

    expect(extractPlanPaths(plan)).toEqual(['src/auth.ts']);
  });

  it('does not invent a conflict between two items that quote the same regex', () => {
    // The regression this guards: both Plans quote `\d+/\w+`, both would gain the path `d+/w+`,
    // and two items touching entirely different files would then be serialised over a regex.
    const items = [
      item({
        id: 'POMN-58',
        order: 10,
        repos: ['core'],
        body: planSection('src/auth.ts', '\\d+/\\w+'),
      }),
      item({
        id: 'POMN-59',
        order: 20,
        repos: ['core'],
        body: planSection('src/billing.ts', '\\d+/\\w+'),
      }),
    ];

    const plan = planOf(items, { core: true });

    expect(plan.scopes['POMN-58']).toEqual({ kind: 'paths', paths: ['src/auth.ts'], source: 'plan' });
    expect(plan.waves).toEqual([{ index: 1, itemIds: ['POMN-58', 'POMN-59'] }]);
    expect(plan.conflicts).toEqual([]);
  });
});
