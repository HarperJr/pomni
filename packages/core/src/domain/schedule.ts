import { ValidationError } from './errors.js';
import { SECTION_PLAN, parseSections } from './item.js';
import type { BacklogItem } from './item.js';

/**
 * Grouping `ready` backlog items into waves that may be launched at the same time.
 *
 * A wave is a set of items with no conflict between any two of them. Wave 2 starts when
 * wave 1 has finished. Two items conflict when any of:
 *
 *   (a) one `dependsOn` the other, directly or through a chain;
 *   (b) they share a repo and that repo cannot give each run its own worktree — and an item
 *       naming no repos is read as being in every repo of the project, for this rule as much
 *       as for the question of whether their paths are worth comparing;
 *   (c) their declared or inferred paths overlap — the same file, or one inside the other.
 *
 * Deterministic by construction: same backlog in, same waves out. Every ordering here is a
 * plain codepoint comparison rather than `localeCompare`, so the answer does not depend on
 * the host's ICU data. Nothing in this module asks a model anything.
 *
 * Worktree eligibility is an async git probe, so it is not resolved here — `planWaves`
 * receives an already-resolved `repoIsolatesRuns` map from the application layer. This file
 * imports nothing but the domain.
 *
 * ---------------------------------------------------------------------------
 * How paths are read out of a Plan section
 * ---------------------------------------------------------------------------
 *
 * An item's scope is its `touches` frontmatter when that is non-empty. Otherwise the `## Plan`
 * section is scanned, and if that yields nothing the item is read as touching its whole repo —
 * the safe reading, because an item whose prose names no files may rewrite anything.
 *
 * The scan, so a reader can predict it without running it:
 *
 *   1. Every line of the Plan section is scanned except lines inside a ``` or ~~~ fence.
 *   2. From each line, first the backtick-quoted spans are taken as candidates; then the
 *      backtick spans are blanked out and the remaining whitespace-delimited words are taken.
 *   3. Each candidate is trimmed of wrapping prose punctuation: leading `( [ < " ' * _` and
 *      trailing `) ] > " ' * _ , ; : .`.
 *   4. A candidate is rejected outright when it contains whitespace (this is what stops
 *      `npm run typecheck` being read as a path), carries a URL scheme, starts with `-` `@`
 *      `#` or `+`, or contains a shell or glob metacharacter
 *      (`" ' $ & | ; < > ( ) { } [ ] * ? ! =`). That last rule is also why WHOLE_REPO_PATH
 *      can never collide with an extracted path. A backslash is NOT a metacharacter here: on
 *      Windows a Plan is as likely to say `packages\core\x.ts` as `packages/core/x.ts`, and
 *      rejecting it made every such item silently whole-repo while `--explain` said it named
 *      no paths.
 *   4b. What survives must be repo-relative, because that is the only thing the paths it will
 *      be compared against are. A drive-letter prefix (`C:\...`), a UNC prefix or `//`
 *      anywhere, a leading `/`, and a `..` that is still there once the token is normalised
 *      (`../packages/core/x.ts`) are all rejected rather than trimmed: the domain does not
 *      know where any repo root is, so cutting an absolute path down to a relative one, or
 *      deciding what sits above the root, would be a guess. The first three are tested on the
 *      slash-folded token, so `\\host\share` cannot slip past the `//` test by spelling itself
 *      with backslashes. A token that carries backslashes must also look like a Windows path to
 *      keep them — no `/` mixed in, and every segment drawn only from ASCII letters, digits,
 *      `_`, `.`, `~` and `-` — so `\d+/\w+` and `\d+\w+` stay prose. That segment rule is
 *      narrower than what a filename may really hold: a segment carrying `@`, `+`, `%`, `#` or
 *      a non-ASCII letter is turned away with them, and the item falls back to whole-repo.
 *   4c. A trailing `:12` or `:12:5` is dropped before any of that, because prose cites a file
 *      by line and the line number is not part of the file's name: `src/auth.ts:42` and
 *      `src/auth.ts` have to reach the same path or the two items editing that file share a
 *      wave. A `:` anywhere else rejects the token outright rather than being cut at, since
 *      cutting would invent a shorter path that then falsely overlaps a real one.
 *   5. Survivors are normalised — backslashes to `/`, `.` and `..` segments resolved, a
 *      leading `./` or `/` dropped, a trailing `/` dropped, `//` collapsed.
 *   6. A normalised candidate is kept only when it still contains `/`, whether it was
 *      backticked or not. A single-segment token is not read as a path: `schedule.ts` could be
 *      any file in the tree with that name, and `item.status`, `repo.id` or `Promise.all` are
 *      not files at all. An item whose Plan names only bare tokens declares no paths and
 *      falls through to the whole-repo reading, which over-conflicts rather than under-conflicts.
 *   7. What is kept is deduplicated and sorted by codepoint.
 */

/**
 * The path standing for "everything in this repo", used when an item declares no paths and its
 * Plan names none. Rule 4 above rejects `*` from ever being extracted, so this cannot collide
 * with a real path.
 */
export const WHOLE_REPO_PATH = '*';

/** What an item is read as touching, and whether that was declared or inferred. */
export type PathScope =
  | { kind: 'paths'; paths: string[]; source: 'touches' | 'plan' }
  | { kind: 'whole-repo' };

/** Why two items cannot run at the same time. One edge may carry several. */
export type ConflictReason =
  | { kind: 'depends_on'; from: string; to: string; via: string[] }
  | { kind: 'shared_repo'; repo: string }
  | { kind: 'path_overlap'; path: string; otherPath: string };

export interface ConflictEdge {
  a: string;
  b: string;
  reasons: ConflictReason[];
}

/** One wave. `index` is 1-based, and strictly increasing across `WavePlan.waves`. */
export interface Wave {
  index: number;
  itemIds: string[];
}

/** A ready item that cannot be scheduled because something it depends on is not done. */
export interface BlockedItem {
  itemId: string;
  /** The unsatisfied dependency ids, sorted. */
  waitingOn: string[];
}

export interface WavePlan {
  waves: Wave[];
  conflicts: ConflictEdge[];
  blocked: BlockedItem[];
  /** Every ready item's scope, keyed by item id — what `--explain` prints. */
  scopes: Record<string, PathScope>;
}

export interface WaveInput {
  /**
   * ALL of the project's items, not just the ready ones: a dependency is only satisfied when
   * the item it points at is `done`, which cannot be checked from the ready set alone.
   */
  items: BacklogItem[];
  /**
   * `repoId -> can this repo give each run its own worktree`. A missing repo counts as false.
   * Its keys also stand for the project's repos, which is what an item naming no repos is read
   * as covering; the caller resolves it over every repo in the project whenever any ready item
   * names none.
   */
  repoIsolatesRuns: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Plain codepoint comparison. Deliberately not `localeCompare`: wave grouping must not change
 * because the machine running it has different ICU data.
 */
function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The stable order every decision below is made in: `order` ascending, then id. */
function compareCandidates(a: BacklogItem, b: BacklogItem): number {
  if (a.order !== b.order) return a.order - b.order;
  return compareCodepoint(a.id, b.id);
}

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

const LEADING_PUNCTUATION = new Set(['(', '[', '<', '"', "'", '*', '_']);
const TRAILING_PUNCTUATION = new Set([')', ']', '>', '"', "'", '*', '_', ',', ';', ':', '.']);
const METACHARACTERS = new Set([
  '"',
  "'",
  '$',
  '&',
  '|',
  ';',
  '<',
  '>',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '*',
  '?',
  '!',
  '=',
  '`',
]);
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const FENCE = /^\s*(?:```|~~~)/;
const BACKTICK_SPAN = /`([^`]+)`/g;
/** `C:`, `d:` — a drive letter, in either the `C:\x` or the `C:/x` spelling. */
const DRIVE_PREFIX = /^[A-Za-z]:/;
/**
 * What a segment of a backslash-written path may contain: ASCII letters, digits, `_`, `.`, `~`
 * and `-`, and nothing else. Deliberately narrower than a real filename — it exists to tell
 * `packages\core\schedule.ts` apart from a regex quoted in prose, and it pays for that by also
 * turning away `@`, `+`, `%`, `#` and every non-ASCII letter. A backslash-written path holding
 * one of those is not read as a path at all, so its item falls through to the whole-repo
 * reading: over-conflicting, which costs a wave, not a collision.
 */
const BACKSLASH_PATH_SEGMENT = /^[A-Za-z0-9_.~-]+$/;
/** A trailing `:12` or `:12:5` — how prose cites a line, and not part of the file's name. */
const LINE_REFERENCE_SUFFIX = /:\d+(?::\d+)?$/;

/** Strip wrapping prose punctuation. Repeated, so `("packages/core")` still reduces. */
function trimPunctuation(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && LEADING_PUNCTUATION.has(raw[start] as string)) start += 1;
  while (end > start && TRAILING_PUNCTUATION.has(raw[end - 1] as string)) end -= 1;
  return raw.slice(start, end);
}

/** Rule 4: things that are never a path, whatever they look like. */
function isRejected(token: string): boolean {
  if (token.length === 0) return true;
  if (/\s/.test(token)) return true;
  if (URL_SCHEME.test(token)) return true;
  const first = token[0] as string;
  if (first === '-' || first === '@' || first === '#' || first === '+') return true;
  for (const character of token) {
    if (METACHARACTERS.has(character)) return true;
  }

  // A path read out of a Plan is repo-relative or it is nothing. A drive letter names a
  // location no repo-relative path can ever equal, and nothing in the domain knows where a
  // repo root sits, so there is no honest way to make it relative — deciding that the repo
  // starts at `packages` would be a guess, and a wrong guess invents a path that then falsely
  // overlaps a real one. Rejecting is the safe direction: an item left naming nothing reads
  // as touching its whole repo, which over-conflicts.
  if (DRIVE_PREFIX.test(token)) return true;

  // The `//` and absolute tests run on the slash-folded form, so a backslash spelling cannot
  // dodge them: `\\host\share\x.ts` is a UNC path, not the repo-relative `host/share/x.ts`
  // that normalisation would otherwise turn it into.
  const slashed = token.replace(/\\/g, '/');
  if (slashed.startsWith('/')) return true;
  if (slashed.includes('//')) return true;

  // A `file:line` citation names the file, so the citation comes off before the rest of the
  // token is judged — otherwise `src/auth.ts:42` and `src/auth.ts` are two unrelated paths and
  // the two items editing that one file land in the same wave. This runs after the drive-letter
  // test above, so it cannot reopen that hole: `C:\x\y.ts` has already been rejected, and
  // `C:42` never reaches here either. Any surviving `:` rejects the token rather than being cut
  // at — a truncated path would falsely overlap a real one, whereas a rejected token leaves the
  // item naming nothing, which reads as its whole repo and over-conflicts.
  const bare = token.replace(LINE_REFERENCE_SUFFIX, '');
  if (bare.includes(':')) return true;

  // A `..` still standing after normalisation points above the repo root, and where that root
  // sits is exactly what the domain does not know. `../packages/core/x.ts` and
  // `packages/core/x.ts` may well be one file; kept as written they overlap nothing, which is
  // the unsafe direction, so the token is refused and its item reads as whole-repo instead.
  // An interior `..` that resolves inside the repo (`a/b/../c` -> `a/c`) is unaffected.
  if (escapesRepoRoot(normalisePathToken(bare))) return true;

  // Backslashes are accepted because a Windows Plan writes `packages\core\x.ts`, not because
  // any escaped prose is a path claim. Two things mark a backslash that is not a separator: it
  // sits alongside `/` in one token (`\d+/\w+`), or it delimits something no file is named
  // (`\d+\w+`). Either way the token is a quoted regex, and reading it as a path serialises
  // two items into different waves for nothing.
  if (bare.includes('\\')) {
    if (bare.includes('/')) return true;
    const segments = bare.split('\\').filter((segment) => segment.length > 0);
    if (!segments.every((segment) => BACKSLASH_PATH_SEGMENT.test(segment))) return true;
  }

  return false;
}

/** A path that still climbs above the repo root, and so cannot be placed without knowing it. */
function escapesRepoRoot(path: string): boolean {
  return path === '..' || path.startsWith('../');
}

/**
 * The form a token is compared in: line citation dropped, then normalised. `undefined` when the
 * token names nothing comparable — empty, or escaping the repo root. Every path that reaches
 * `pathsOverlap` goes through here, so the two spellings of one file cannot arrive apart.
 */
function comparablePath(raw: string): string | undefined {
  const path = normalisePathToken(raw.replace(LINE_REFERENCE_SUFFIX, ''));
  if (path.length === 0 || escapesRepoRoot(path)) return undefined;
  return path;
}

/**
 * Canonical form of a path token: `/` separators, no `.`/`..` segments, no leading `./` or `/`,
 * no trailing `/`. A `..` with nothing above it to pop is kept, so the token stays honest
 * rather than silently becoming a different path — `comparablePath` is what then refuses it,
 * because a path above the repo root cannot be compared with one below it.
 */
export function normalisePathToken(raw: string): string {
  const slashed = raw.replace(/\\/g, '/');
  const segments: string[] = [];

  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = segments[segments.length - 1];
      if (last !== undefined && last !== '..') {
        segments.pop();
        continue;
      }
      segments.push('..');
      continue;
    }
    segments.push(segment);
  }

  return segments.join('/');
}

function sortedUnique(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))].sort(compareCodepoint);
}

/** Every path an item's Plan section names, normalised, deduplicated and sorted. */
export function extractPlanPaths(plan: string): string[] {
  const kept: string[] = [];
  let inFence = false;

  for (const line of plan.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const candidates: string[] = [];
    BACKTICK_SPAN.lastIndex = 0;
    let match = BACKTICK_SPAN.exec(line);
    while (match !== null) {
      candidates.push(match[1] as string);
      match = BACKTICK_SPAN.exec(line);
    }

    // The backtick spans are blanked out before the words are taken, so the insides of
    // `npm run typecheck` are never re-read as three separate words.
    for (const word of line.replace(BACKTICK_SPAN, ' ').split(/\s+/)) candidates.push(word);

    for (const candidate of candidates) {
      const token = trimPunctuation(candidate);
      if (isRejected(token)) continue;
      // Rule 6: a separator is what makes a token a path claim, and backticks do not change
      // that. A bare `schedule.ts` names no directory and `item.status` names no file at all;
      // both are left out, so the item falls through to the whole-repo reading rather than
      // being credited with a narrow scope it never claimed.
      const path = comparablePath(token);
      if (path !== undefined && path.includes('/')) kept.push(path);
    }
  }

  return sortedUnique(kept);
}

/**
 * What an item is read as touching. Declared `touches` wins outright; otherwise the Plan is
 * parsed; otherwise the whole repo.
 */
export function itemScope(item: BacklogItem): PathScope {
  // Declared paths go through the same reading as inferred ones: a `touches` entry written as
  // `src/auth.ts:42` or `../src/auth.ts` has to reach the same path the item next door reached
  // by writing it plainly, or the two share a wave and one file. An entry that reaches nothing
  // is dropped; an item left with none falls through to the Plan and then to whole-repo.
  const declared = sortedUnique(
    item.touches.map(comparablePath).filter((path): path is string => path !== undefined),
  );
  if (declared.length > 0) return { kind: 'paths', paths: declared, source: 'touches' };

  const plan = parseSections(item.body)[SECTION_PLAN] ?? '';
  const inferred = extractPlanPaths(plan);
  if (inferred.length > 0) return { kind: 'paths', paths: inferred, source: 'plan' };

  return { kind: 'whole-repo' };
}

/**
 * Equal, or one a directory prefix of the other on a segment boundary. `packages/core` overlaps
 * `packages/core/src/x.ts` and does not overlap `packages/corex/y.ts`. Compared case-folded,
 * because a case-insensitive filesystem would treat the two as one file.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === WHOLE_REPO_PATH || b === WHOLE_REPO_PATH) return true;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return true;
  return right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Every id reachable from `roots` by following `dependsOn`, the roots included. Membership only —
 * the result is a set that is the same whatever order the walk took, so nothing downstream reads
 * an ordering out of it.
 *
 * `traverse` decides whether to walk *through* an id; an id it refuses is still in the result,
 * as a leaf. Cycle-safe either way, because `seen` is checked before the frontier grows.
 */
function reachableFrom(
  roots: Iterable<string>,
  direct: Map<string, string[]>,
  traverse: (id: string) => boolean = () => true,
): Set<string> {
  const seen = new Set<string>();
  const frontier = [...roots];

  while (frontier.length > 0) {
    const id = frontier.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!traverse(id)) continue;
    for (const dependency of direct.get(id) ?? []) frontier.push(dependency);
  }

  return seen;
}

/**
 * Every id each item transitively depends on, sorted. Ids naming items that do not exist are
 * kept as leaves — an unknown dependency is unsatisfied, not absent.
 *
 * Throws rather than looping or silently dropping items when the graph has a cycle.
 */
export function dependencyClosure(items: BacklogItem[]): Map<string, string[]> {
  const direct = new Map<string, string[]>();
  for (const item of items) direct.set(item.id, [...item.dependsOn]);

  const closure = new Map<string, string[]>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const walk = (id: string): string[] => {
    const done = closure.get(id);
    if (done !== undefined) return done;

    if (visiting.has(id)) {
      const from = stack.indexOf(id);
      const cycle = [...stack.slice(from === -1 ? 0 : from), id];
      throw new ValidationError(
        `dependency cycle: ${cycle.join(' -> ')} — each waits on the next, so none can ever ` +
          `start; drop one of those dependsOn links to break it`,
        { cycle },
      );
    }

    visiting.add(id);
    stack.push(id);

    const reached = new Set<string>();
    for (const dependency of direct.get(id) ?? []) {
      reached.add(dependency);
      for (const further of walk(dependency)) reached.add(further);
    }

    stack.pop();
    visiting.delete(id);

    const sorted = [...reached].sort(compareCodepoint);
    closure.set(id, sorted);
    return sorted;
  };

  for (const item of items) walk(item.id);
  return closure;
}

/** The intermediate ids on a shortest `from -> ... -> to` chain, endpoints excluded. */
function dependencyChain(direct: Map<string, string[]>, from: string, to: string): string[] {
  const previous = new Map<string, string>();
  const seen = new Set<string>([from]);
  let frontier = [from];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependency of direct.get(id) ?? []) {
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        previous.set(dependency, id);
        if (dependency === to) {
          const chain: string[] = [];
          let cursor = previous.get(to);
          while (cursor !== undefined && cursor !== from) {
            chain.unshift(cursor);
            cursor = previous.get(cursor);
          }
          return chain;
        }
        next.push(dependency);
      }
    }
    frontier = next;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * The repos an item is read as working in. Empty `repos` means the whole project — one reading,
 * used by both rules below. Reading it as "everything" for collision but as "nothing" for the
 * shared-repo rule is what let an item naming no repos share a wave with an item in a repo that
 * cannot isolate runs, and both then wrote into one checkout.
 *
 * `projectRepos` is sorted, so the intersection below is sorted without re-sorting.
 */
function effectiveRepos(item: BacklogItem, projectRepos: string[]): string[] {
  if (item.repos.length === 0) return projectRepos;
  return sortedUnique(item.repos);
}

/**
 * Every repo the plan knows about: the ones the isolation map was resolved for — which is the
 * whole project whenever any ready item names none — plus any a candidate names. Sorted by
 * codepoint, so nothing downstream depends on the map's key order.
 */
function projectReposOf(repoIsolatesRuns: Record<string, boolean>, candidates: BacklogItem[]): string[] {
  return sortedUnique([...Object.keys(repoIsolatesRuns), ...candidates.flatMap((item) => item.repos)]);
}

/**
 * Whether the two could touch one checkout at all. Empty on either side means the plan has no
 * repo information to go on — no isolation map and no repos named — and the conservative answer
 * is yes, exactly as before this took a project repo list.
 */
function reposCouldCollide(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const mine = new Set(a);
  return b.some((repo) => mine.has(repo));
}

/** The repos both work in, sorted. Both sides are already the effective sets. */
function sharedRepos(a: string[], b: string[]): string[] {
  const mine = new Set(a);
  return b.filter((repo) => mine.has(repo));
}

function pathOverlapReasons(a: PathScope, b: PathScope): ConflictReason[] {
  if (a.kind === 'whole-repo' && b.kind === 'whole-repo') {
    return [{ kind: 'path_overlap', path: WHOLE_REPO_PATH, otherPath: WHOLE_REPO_PATH }];
  }
  // One edge, not one per path: the whole repo covers every path the other side names, so the
  // path recorded here is only the first of them. `describeConflict` words it as an example
  // rather than as the file they collide on.
  if (a.kind === 'whole-repo') {
    const other = b.kind === 'paths' ? (b.paths[0] ?? WHOLE_REPO_PATH) : WHOLE_REPO_PATH;
    return [{ kind: 'path_overlap', path: WHOLE_REPO_PATH, otherPath: other }];
  }
  if (b.kind === 'whole-repo') {
    const mine = a.paths[0] ?? WHOLE_REPO_PATH;
    return [{ kind: 'path_overlap', path: mine, otherPath: WHOLE_REPO_PATH }];
  }

  const reasons: ConflictReason[] = [];
  for (const path of a.paths) {
    for (const otherPath of b.paths) {
      if (pathsOverlap(path, otherPath)) reasons.push({ kind: 'path_overlap', path, otherPath });
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Group the `ready` items into waves. `items` is the whole backlog; only `ready` items are
 * candidates, and only a `done` dependency counts as satisfied — `cancelled` blocks forever,
 * because an item whose prerequisite was cancelled needs a human, not a launch. What a cancelled
 * item itself depended on is not walked: it is as settled as a `done` one.
 *
 * The result is checked with `assertWavesDisjoint` before it is returned.
 */
export function planWaves(input: WaveInput): WavePlan {
  const { items, repoIsolatesRuns } = input;

  const byId = new Map(items.map((item) => [item.id, item]));
  const direct = new Map(items.map((item) => [item.id, [...item.dependsOn]]));

  const candidates = items.filter((item) => item.status === 'ready').sort(compareCandidates);
  const candidateIds = new Set(candidates.map((item) => item.id));

  // The closure covers the candidates and what they still wait on, and nothing else. `items` is
  // the whole backlog, so building it over all of them meant one cycle between two long-finished
  // items threw and took the whole project's plan with it.
  //
  // The walk stops at a settled item — `done` or `cancelled` — and the closure treats it as a
  // leaf: a settled item's own dependencies are no longer anyone's business, so they are neither
  // a reason to hold a candidate back nor a graph this command has to be able to order. Without
  // that, `ready -> done -> done -> back again` reached a cycle no item being scheduled was in,
  // and threw over history.
  //
  // `cancelled` is a leaf for the same reason `done` is, and for the opposite conclusion. A
  // cancelled prerequisite is dead, not pending: whatever it was itself waiting on will never
  // be worked, so a cycle sitting behind it is history too and must not take the project's plan
  // down. Being a leaf does NOT make it satisfied — the test below is `status !== 'done'`, so a
  // candidate that depends on a cancelled item is still `blocked`, with that cancelled id in its
  // `waitingOn`. That dependency can never be satisfied, and saying so is the honest answer;
  // throwing over a cycle behind it prints nothing for the whole project instead.
  //
  // A cycle a candidate reaches through UNFINISHED work still throws — an item whose
  // prerequisite can never finish must never be scheduled.
  const isSettled = (id: string): boolean => {
    const status = byId.get(id)?.status;
    return status === 'done' || status === 'cancelled';
  };
  const relevant = reachableFrom(candidateIds, direct, (id) => !isSettled(id));
  const closure = dependencyClosure(
    items
      .filter((item) => relevant.has(item.id))
      .map((item) => (isSettled(item.id) ? { ...item, dependsOn: [] } : item)),
  );

  const projectRepos = projectReposOf(repoIsolatesRuns, candidates);

  const scopes: Record<string, PathScope> = {};
  for (const item of candidates) scopes[item.id] = itemScope(item);

  // A dependency is satisfied when it is done, and pending-but-schedulable when it is another
  // ready candidate. Anything else — backlog, in_progress, cancelled, or an id naming nothing —
  // blocks. Because the closure is transitive, an item that depends on a blocked ready item
  // inherits that item's unsatisfied ids and is blocked too, with no extra pass.
  const blocked: BlockedItem[] = [];
  const runnable: BacklogItem[] = [];

  for (const item of candidates) {
    const waitingOn = (closure.get(item.id) ?? []).filter((dependencyId) => {
      if (candidateIds.has(dependencyId)) return false;
      return byId.get(dependencyId)?.status !== 'done';
    });

    if (waitingOn.length > 0) blocked.push({ itemId: item.id, waitingOn });
    else runnable.push(item);
  }

  const runnableIds = new Set(runnable.map((item) => item.id));

  const conflicts: ConflictEdge[] = [];
  const adjacency = new Map<string, Set<string>>();
  for (const item of runnable) adjacency.set(item.id, new Set());

  for (let i = 0; i < runnable.length; i += 1) {
    const a = runnable[i] as BacklogItem;
    for (let j = i + 1; j < runnable.length; j += 1) {
      const b = runnable[j] as BacklogItem;
      const reasons: ConflictReason[] = [];

      if ((closure.get(a.id) ?? []).includes(b.id)) {
        reasons.push({ kind: 'depends_on', from: a.id, to: b.id, via: dependencyChain(direct, a.id, b.id) });
      }
      if ((closure.get(b.id) ?? []).includes(a.id)) {
        reasons.push({ kind: 'depends_on', from: b.id, to: a.id, via: dependencyChain(direct, b.id, a.id) });
      }

      // A repo that cannot hand each run its own worktree serialises everything in it. Under
      // `noUncheckedIndexedAccess` the lookup is `boolean | undefined`, so `!== true` is the
      // only safe test — a repo missing from the map counts as not isolating.
      const reposA = effectiveRepos(a, projectRepos);
      const reposB = effectiveRepos(b, projectRepos);
      for (const repo of sharedRepos(reposA, reposB)) {
        if (repoIsolatesRuns[repo] !== true) reasons.push({ kind: 'shared_repo', repo });
      }

      // Identical-looking paths in two different codebases are not the same file, so paths are
      // only compared when the items could collide at all.
      if (reposCouldCollide(reposA, reposB)) {
        const scopeA = scopes[a.id] as PathScope;
        const scopeB = scopes[b.id] as PathScope;
        reasons.push(...pathOverlapReasons(scopeA, scopeB));
      }

      if (reasons.length === 0) continue;
      conflicts.push({ a: a.id, b: b.id, reasons });
      adjacency.get(a.id)?.add(b.id);
      adjacency.get(b.id)?.add(a.id);
    }
  }

  // Greedy over the stable order. An item's dependency may sit later in that order, so an item
  // whose dependencies are not all placed yet is skipped and retried on a later pass rather
  // than forced into a wave that would violate the ordering.
  const buckets: string[][] = [];
  const waveOf = new Map<string, number>();
  let pending = runnable;

  while (pending.length > 0) {
    const deferred: BacklogItem[] = [];
    let placed = false;

    for (const item of pending) {
      const dependencies = (closure.get(item.id) ?? []).filter((id) => runnableIds.has(id));
      let floor = 0;
      let ready = true;

      for (const dependencyId of dependencies) {
        const at = waveOf.get(dependencyId);
        if (at === undefined) {
          ready = false;
          break;
        }
        floor = Math.max(floor, at + 1);
      }

      if (!ready) {
        deferred.push(item);
        continue;
      }

      const neighbours = adjacency.get(item.id) ?? new Set<string>();
      let index = floor;
      while (
        (buckets[index] ?? []).some((placedId) => neighbours.has(placedId))
      ) {
        index += 1;
      }

      const bucket = buckets[index] ?? [];
      bucket.push(item.id);
      buckets[index] = bucket;
      waveOf.set(item.id, index);
      placed = true;
    }

    if (!placed) {
      // Unreachable unless the dependency graph has a cycle, which `dependencyClosure` throws
      // on first. Kept so a future change that loosens that check fails loudly.
      throw new ValidationError(
        `cannot order waves: ${deferred.map((item) => item.id).sort(compareCodepoint).join(', ')}`,
        { stuck: deferred.map((item) => item.id) },
      );
    }

    pending = deferred;
  }

  // Drop the empty buckets and renumber from 1. Renumbering is monotone, so every strict
  // ordering established above survives it.
  // Indexed rather than `for...of`: a wave floor can skip ahead, which leaves holes in
  // `buckets`, and a hole reads back as `undefined` at runtime.
  const waves: Wave[] = [];
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (bucket === undefined || bucket.length === 0) continue;
    waves.push({ index: waves.length + 1, itemIds: bucket });
  }

  const plan: WavePlan = { waves, conflicts, blocked, scopes };
  assertWavesDisjoint(plan);
  return plan;
}

/** One human sentence for one reason. Never the bare word "conflict" — that says nothing. */
export function describeConflict(reason: ConflictReason): string {
  switch (reason.kind) {
    case 'depends_on':
      return reason.via.length === 0
        ? `${reason.from} depends on ${reason.to}`
        : `${reason.from} depends on ${reason.to} through ${reason.via.join(' -> ')}`;
    case 'shared_repo':
      return `both work in '${reason.repo}', which cannot give each run its own worktree`;
    case 'path_overlap': {
      const { path, otherPath } = reason;
      if (path === WHOLE_REPO_PATH && otherPath === WHOLE_REPO_PATH) {
        return 'neither names any paths, so both are read as touching their whole repo';
      }
      // Deliberately not "which covers <path>": the other side may name a dozen paths and the
      // whole repo covers all of them, so naming one as if it were the collision would be a lie.
      if (path === WHOLE_REPO_PATH) {
        return `one names no paths and is read as touching its whole repo, which covers everything the other names, ${otherPath} among them`;
      }
      if (otherPath === WHOLE_REPO_PATH) {
        return `one names no paths and is read as touching its whole repo, which covers everything the other names, ${path} among them`;
      }
      if (path === otherPath) return `both touch ${path}`;
      return path.length < otherPath.length
        ? `${path} contains ${otherPath}`
        : `${otherPath} contains ${path}`;
    }
  }
}

/**
 * The invariant, re-checked against the conflict list rather than trusted: no wave holds a
 * conflicting pair, no blocked item sits in a wave, no item is in two waves, and a dependent
 * is strictly later than what it depends on.
 *
 * `planWaves` calls this on its own result. The CLI calls it again before `--run` launches
 * anything, because by then the cost of being wrong is real work on the wrong branch.
 */
export function assertWavesDisjoint(plan: WavePlan): void {
  const waveOf = new Map<string, number>();

  for (const wave of plan.waves) {
    for (const itemId of wave.itemIds) {
      const seen = waveOf.get(itemId);
      if (seen !== undefined) {
        throw new ValidationError(
          `${itemId} is in wave ${seen} and wave ${wave.index}`,
          { itemId, waves: [seen, wave.index] },
        );
      }
      waveOf.set(itemId, wave.index);
    }
  }

  for (const blocked of plan.blocked) {
    const at = waveOf.get(blocked.itemId);
    if (at !== undefined) {
      throw new ValidationError(
        `${blocked.itemId} is blocked on ${blocked.waitingOn.join(', ')} but sits in wave ${at}`,
        { itemId: blocked.itemId, wave: at, waitingOn: blocked.waitingOn },
      );
    }
  }

  for (const edge of plan.conflicts) {
    const a = waveOf.get(edge.a);
    const b = waveOf.get(edge.b);

    if (a !== undefined && b !== undefined && a === b) {
      throw new ValidationError(
        `wave ${a} holds ${edge.a} and ${edge.b} together: ${edge.reasons
          .map(describeConflict)
          .join('; ')}`,
        { wave: a, a: edge.a, b: edge.b, reasons: edge.reasons },
      );
    }

    for (const reason of edge.reasons) {
      if (reason.kind !== 'depends_on') continue;
      const from = waveOf.get(reason.from);
      const to = waveOf.get(reason.to);
      if (from === undefined || to === undefined) continue;
      if (from <= to) {
        throw new ValidationError(
          `${reason.from} depends on ${reason.to} but runs in wave ${from}, not after wave ${to}`,
          { from: reason.from, to: reason.to, fromWave: from, toWave: to },
        );
      }
    }
  }
}
