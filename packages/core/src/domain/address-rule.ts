/**
 * Addressing in a chat message: `#project`, `@agent`, `/skill`.
 *
 * This file finds *candidates* and nothing else. It has no idea which projects exist, which
 * agents a workflow contains, or which skills are installed — and it must not, or the rule for
 * what counts as an address would change every time someone added a project. Parsing is
 * therefore deterministic and total: it never throws, and every message parses.
 *
 * The consequence is the design's central split. `#include <stdio.h>` produces a candidate
 * addressing a project called `include`, because no rule short of knowing the project list can
 * tell it from `#pomni`. Resolution decides: a candidate that names nothing is not an error and
 * must not be stripped from the prose — the caller strips only what it resolved, via
 * `stripAddresses`. That is why offsets are carried on every candidate.
 *
 * Nothing here imports zod, and nothing here may start to. The composer in `packages/web` needs
 * the identical rule and cannot depend on `@pomni/core`, so this file is the half it aliases;
 * a runtime dependency would put a bundler between the two copies of the rule and let them
 * drift, which is the failure the split exists to prevent. The schemas live in `address.ts`.
 */

/** The rule, whole, for printing in the composer. Keep it one sentence — that is the point. */
export const ADDRESS_RULE =
  'Type #project, @agent or /skill at the start of a word — after a space or a new line. ' +
  '@ may take a workflow/agent form; # and / may not contain a slash; anything inside backticks is left alone.';

export type AddressKind = 'project' | 'agent' | 'skill';

export const ADDRESS_SIGILS: Record<AddressKind, string> = {
  project: '#',
  agent: '@',
  skill: '/',
};

/**
 * One candidate found in a draft.
 *
 * `start`/`end` index the raw string in UTF-16 code units — the same units as
 * `textarea.selectionStart`, so a composer can slice, highlight or replace the span without
 * converting. `end` is exclusive.
 *
 * The first three fields are exactly `MessageAddress` in `address.ts`, which is what gets
 * stored: the offsets describe one draft in one composer and are meaningless afterwards.
 */
export interface ParsedAddress {
  kind: AddressKind;
  /** The name after the sigil, lowercased. For an agent, the agent id alone. */
  name: string;
  /** `@workflow/agent` only. Null for the bare `@agent` form, and for every other kind. */
  workflowId: string | null;
  /** Exactly as typed, sigil included. What a chip labels itself with. */
  raw: string;
  start: number;
  end: number;
}

/**
 * A second `#project` in the same message, ignored.
 *
 * Surfaced rather than swallowed: the reader's eye takes the leftmost chip as the subject, so
 * the parser keeps the first and says out loud that it dropped the others. Silently taking the
 * last would put the message under a project whose chip is not the one you read first.
 */
export interface AddressConflict {
  kind: AddressKind;
  /** The candidate that won. */
  kept: ParsedAddress;
  /** The ones that did not. */
  dropped: ParsedAddress[];
}

export interface ParsedMessage {
  /** Every candidate, in the order it appears. Repeats and losing duplicates included. */
  addresses: ParsedAddress[];
  /** The one `#project` in force for this message, or null. */
  project: ParsedAddress | null;
  /** `@agent` candidates, which apply to this message only. */
  agents: ParsedAddress[];
  /** `/skill` candidates, which apply to this message only. */
  skills: ParsedAddress[];
  conflicts: AddressConflict[];
  /** The message with every candidate removed. Use `stripAddresses` to remove only some. */
  prose: string;
}

/**
 * The candidate shape: a sigil, a slug, and any number of further `/slug` segments.
 *
 * The segments are matched here and rejected per-kind below rather than left unmatched, so that
 * `/usr/bin` is seen whole and refused, instead of being read as the skill `usr` with `/bin`
 * left dangling in the prose.
 */
const CANDIDATE = /([#@/])([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)((?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)/gi;

/** Same bound as `SLUG_PATTERN` in `ids.ts`. A longer run of letters is prose, not an id. */
const MAX_SEGMENT = 40;

/**
 * Find every address in a draft.
 *
 * Total and pure: no throw, no I/O, no knowledge of what exists.
 */
export function parseAddresses(raw: string): ParsedMessage {
  const masked = codeRanges(raw);
  const addresses: ParsedAddress[] = [];

  CANDIDATE.lastIndex = 0;
  for (let match = CANDIDATE.exec(raw); match !== null; match = CANDIDATE.exec(raw)) {
    const start = match.index;
    const text = match[0] as string;
    const sigil = match[1] ?? '';
    const head = match[2] ?? '';
    const tail = match[3] ?? '';
    const end = start + text.length;

    // At the start of a word, and not inside code.
    if (start > 0 && !/\s/.test(raw.charAt(start - 1))) continue;
    if (masked.some((range) => start >= range.start && start < range.end)) continue;

    // `_` is the only word character the charset above does not already consume; treating
    // `#pomni_backup` as the project `pomni` would address the wrong thing.
    if (/[A-Za-z0-9_]/.test(raw.charAt(end))) continue;

    const kind = KIND_BY_SIGIL[sigil];
    if (!kind) continue;

    const segments = [head, ...(tail ? tail.slice(1).split('/') : [])].map((part) =>
      part.toLowerCase(),
    );
    if (segments.some((part) => part.length > MAX_SEGMENT)) continue;

    // A project id and a skill name are single slugs, so a slash means this was a path or a URL
    // fragment. An agent takes at most `workflow/agent`.
    const limit = kind === 'agent' ? 2 : 1;
    if (segments.length > limit) continue;
    // `/skill.md` and `/usr/` are paths. `#pomni.` is a sentence ending, and is fine.
    if (kind === 'skill' && raw.charAt(end) === '.') continue;

    const [first = '', second] = segments;
    addresses.push({
      kind,
      name: second ?? first,
      workflowId: second ? first : null,
      raw: text,
      start,
      end,
    });
  }

  const { project, conflicts } = pickProject(addresses);

  return {
    addresses,
    project,
    agents: addresses.filter((entry) => entry.kind === 'agent'),
    skills: addresses.filter((entry) => entry.kind === 'skill'),
    conflicts,
    prose: stripAddresses(raw, addresses),
  };
}

const KIND_BY_SIGIL: Record<string, AddressKind | undefined> = {
  '#': 'project',
  '@': 'agent',
  '/': 'skill',
};

/**
 * First `#project` wins; repeats of the same one are not a conflict.
 *
 * Justified in `AddressConflict`. The rule has to be deterministic — a message cannot be about
 * two projects, and asking would put a dialog back in front of a person who came here to type.
 */
function pickProject(addresses: ParsedAddress[]): {
  project: ParsedAddress | null;
  conflicts: AddressConflict[];
} {
  const projects = addresses.filter((entry) => entry.kind === 'project');
  const kept = projects[0] ?? null;
  if (!kept) return { project: null, conflicts: [] };

  const dropped = projects.slice(1).filter((entry) => entry.name !== kept.name);
  return {
    project: kept,
    conflicts: dropped.length > 0 ? [{ kind: 'project', kept, dropped }] : [],
  };
}

/**
 * Remove a chosen set of addresses from the text they came from.
 *
 * Takes the subset so a caller can drop the addresses it resolved and leave the ones it did not
 * — deleting `#include` out of a question about C would change what was asked.
 *
 * Tidying is confined to the gap each removal leaves, and never runs over the message as a
 * whole. A four-space indent in a code block is something the person typed; a double space
 * where a chip used to be is not, and only the second is ours to remove. The gap is joined with
 * one space, or with the newlines it already spanned, so `\r\n` survives everywhere except
 * inside a collapsed gap — which is the one place its exact bytes cannot be preserved anyway.
 */
export function stripAddresses(raw: string, remove: ParsedAddress[]): string {
  if (remove.length === 0) return raw.trim();

  const ordered = [...remove].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const entry of ordered) {
    if (entry.start < cursor) continue; // Overlapping spans cannot both be removed.
    out += raw.slice(cursor, entry.start);
    cursor = entry.end;

    // The whitespace the address sat between, on both sides, becomes one separator: removing a
    // chip mid-sentence would otherwise leave a double space, and removing one from its own
    // line a stray blank one.
    const before = /\s*$/.exec(out)?.[0] ?? '';
    const after = /^\s*/.exec(raw.slice(cursor))?.[0] ?? '';
    out = out.slice(0, out.length - before.length);
    cursor += after.length;

    const gap = before + after;
    const lines = (gap.match(/\n/g) ?? []).length;
    out += lines > 1 ? '\n\n' : lines === 1 ? '\n' : gap.length > 0 ? ' ' : '';
  }
  out += raw.slice(cursor);

  return out.trim();
}

/** Half-open, in the same UTF-16 units as `ParsedAddress`. */
export interface CodeRange {
  start: number;
  end: number;
}

/**
 * Spans that are code, and so hold no addresses.
 *
 * Fences first, by line, because a fence swallows whole lines including backticks that would
 * otherwise look like the start of an inline span. Inline spans are then matched only outside
 * them. An unterminated fence runs to the end of the message, which is what an editor shows.
 */
export function codeRanges(raw: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  let offset = 0;
  let open: { marker: string; start: number } | null = null;

  for (const line of raw.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!open && fence) {
      open = { marker: (fence[1] as string).charAt(0), start: offset };
    } else if (open && fence && (fence[1] as string).charAt(0) === open.marker) {
      ranges.push({ start: open.start, end: offset + line.length });
      open = null;
    }
    offset += line.length + 1;
  }
  if (open) ranges.push({ start: open.start, end: raw.length });

  const inline = /(`+)[\s\S]*?\1/g;
  for (let match = inline.exec(raw); match !== null; match = inline.exec(raw)) {
    const span = { start: match.index, end: match.index + match[0].length };
    const inFence = ranges.some((range) => span.start >= range.start && span.start < range.end);
    if (!inFence) ranges.push(span);
  }

  return ranges;
}
