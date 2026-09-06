import { z } from 'zod';

/**
 * Whether an item has been *thought about*, as opposed to merely filled in.
 *
 * `newItemBody` ships a body in which every section already has text: an italic prompt under
 * Problem and Plan, and one acceptance checkbox that is the title typed a second time. A check
 * for "the section is not empty" passes that body, so underdetermined work moves forward and
 * whoever picks it up invents the requirements. This module is the specific-absence test that
 * refuses it.
 *
 * Deliberately *not* a length rule. Length is not thought, and a gate satisfiable by padding
 * teaches padding. Nothing here counts words, sentences or characters. It looks only for the
 * absences it can name: a missing heading, a heading with nothing under it, the shipped
 * placeholder text, a stock filler word, and a criterion that only says the title back.
 *
 * Pure: no ports, no clock, no I/O, no throws. It is handed the parsed sections and the title
 * and returns what is missing.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The section `minCriteria` is measured against. Not configurable, and it does not need to be:
 * the criteria count is only taken when a requirement lists this heading in its own `sections`,
 * so a project that names other headings is asking for the written-ness test on those and gets
 * exactly that. A project whose acceptance heading is spelled differently lists it in
 * `sections` and is checked for placeholders like any other; only "how many bullets are under
 * it" is reserved for this one name.
 *
 * Spelled out rather than imported from `item.ts` — that module imports `flow.ts`, which
 * imports this one, and a cycle here would be a cycle in the domain's most-imported file. The
 * same literal lives there as `SECTION_ACCEPTANCE`.
 */
export const CRITERIA_SECTION = 'Acceptance criteria';

export const SpecRequirementSchema = z
  .object({
    /** `## Heading`s that must say something. Order is the order gaps are reported in. */
    sections: z.array(z.string().min(1)).default([]),
    /**
     * How many entries under {@link CRITERIA_SECTION} must survive the placeholder and
     * title-echo tests. Read only when `sections` lists {@link CRITERIA_SECTION} — otherwise
     * the requirement never asked about an acceptance list and is not refused for lacking one.
     * `0` turns the criteria check off even when the section is listed.
     */
    minCriteria: z.number().int().min(0).default(1),
  })
  .strict();

export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;

// ---------------------------------------------------------------------------
// What is missing
// ---------------------------------------------------------------------------

/**
 * One absence, with the numbers a sentence about it needs and no sentence in it. Rendered by
 * `describeUnmet` in `flow.ts` — and by hand-written copies of it in the web package, which
 * cannot import this module — so every field a sentence needs is on the member itself.
 *
 * - `missing` — the item body has no such `## Heading` at all.
 * - `empty` — the heading is there with nothing but whitespace under it.
 * - `placeholder` — the heading has text, and the text means nothing: the shipped italic
 *   prompt, or a stock filler like `TBD`.
 * - `criteria` — the acceptance section says something, but not enough of it survives.
 */
export type SpecGap =
  | { section: string; reason: 'missing' }
  | { section: string; reason: 'empty' }
  | { section: string; reason: 'placeholder' }
  | {
      section: string;
      reason: 'criteria';
      /** Entries found under the heading, before any were discarded. */
      found: number;
      /** Entries that survived both tests. Always `< needed`, or there would be no gap. */
      usable: number;
      /** `minCriteria`. */
      needed: number;
      /** Of the discarded, how many were the title said again. */
      echoesTitle: number;
      /** Of the discarded, how many were placeholders. Disjoint from `echoesTitle`. */
      placeholders: number;
    };

/** What a body must carry for the gaps to be judged. Everything is already on the item. */
export interface SpecInput {
  /** From `parseSections(item.body)`: heading -> the text under it, verbatim. */
  sections: Readonly<Record<string, string>>;
  /** `item.title`. Without it, a criterion that only restates the title cannot be spotted. */
  title: string;
}

// ---------------------------------------------------------------------------
// Placeholder detection — the only place in the codebase that knows this
// ---------------------------------------------------------------------------

/**
 * The stock non-answers, normalised. Written out rather than pattern-matched: each of these is
 * a thing people actually type instead of thinking, and a regex over "short and vague" would
 * start refusing short real answers, which is the failure mode this module must not have.
 *
 * `na` is here because `n/a` normalises to itself but `N.A.` and `NA` do not.
 */
const FILLER = new Set(['tbd', 'todo', 'to do', 'n/a', 'na', 'decide later', 'later', 'unknown']);

/**
 * An *italic* span — the shape `newItemBody` writes its prompts in (`_Why does this matter?_`),
 * and the same shape `sectionIsWritten` in `flow.ts` has always stripped.
 *
 * Deliberately not bold. `**Runs orphaned by a dead process can never be cancelled.**` is a
 * real paragraph written emphatically, and refusing it would refuse a short, real spec — the
 * one thing this module must never do. The lookarounds are what keep `**` and `__` out: a
 * marker with another of its own kind on either side is not an italic delimiter. `**TBD**` is
 * still refused, by the filler rule below, which is where a stock non-answer belongs.
 */
const ITALIC_SPAN = /(?<![*_])([*_])(?!\1)([\s\S]+?)(?<![*_])\1(?![*_])/g;

/**
 * A letter or a digit, in *any* script. Text carrying none of these says nothing — `???`,
 * `...`, `—`, a lone emoji — and that is the whole of the "it is only punctuation" test.
 *
 * Phrased as "is there anything meaningful" rather than "strip everything that is not
 * `[a-z0-9]`", which is what it used to be and which judged every Cyrillic, CJK, Greek and
 * Arabic paragraph in the codebase a placeholder with no body such a project could write to
 * pass. A gate that only Latin script can satisfy is a broken gate.
 */
const HAS_MEANING = /[\p{L}\p{N}]/u;

/**
 * Markdown emphasis and code markers. Dropped before comparing, because wrapping the title in
 * `**` changes how it looks and not what it says — without this, `- [ ] **{the title}**` slips
 * past the echo test, and so do `_…_`, `` `…` `` and `~~…~~`.
 */
const EMPHASIS_MARKS = /[*_`~]/g;

/** Quotation marks around the whole entry — the other way a restated title gets dressed up. */
const QUOTE_MARKS = /^["'“”‘’«»„]+|["'“”‘’«»„]+$/g;

/**
 * Trailing punctuation and symbols in any script, so that a sentence ending `。`, `»`, `!` or
 * `.` compares equal to the same sentence without it. Unicode classes rather than an ASCII
 * list, for the same reason {@link HAS_MEANING} is.
 */
const TRAILING_PUNCTUATION = /[\p{P}\p{S}\s]+$/u;

/** A list entry's marker: the bullet, and the checkbox that may follow it. */
const ENTRY_MARKER = /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/;

/**
 * A line that opens a list entry, with its indentation captured. Indentation is what tells a
 * criterion from a note *about* one: see {@link criteriaEntries}.
 */
const ENTRY_LINE = /^([ \t]*)[-*+][ \t]+/;

/**
 * Lowercase, collapse whitespace, drop the list marker, the emphasis and quoting, and any
 * trailing punctuation, so that `- [ ] **Refuse to advance a placeholder.**` and
 * `Refuse to advance a placeholder` compare equal. This is the comparison the title-echo test
 * uses; both sides go through it, so every transformation here is symmetric and none of them
 * can make two different sentences equal — only two spellings of one sentence.
 */
export function normalizeEntry(text: string): string {
  return text
    .replace(ENTRY_MARKER, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(EMPHASIS_MARKS, '')
    .trim()
    .replace(QUOTE_MARKS, '')
    .replace(TRAILING_PUNCTUATION, '')
    .trim();
}

/**
 * Whether a piece of body text says nothing.
 *
 * Three ways to say nothing, in order: it is blank; it is *only italic*, which is how the
 * template's prompts are written (`_Why does this matter?_`) — so a real paragraph that merely
 * *contains* an italic phrase, or that is bold for emphasis, survives; or, once the markup is
 * dropped, nothing with a letter or a digit in it is left (`???`, `...`) or what is left is
 * filler (`TBD`, `n/a`).
 */
export function isPlaceholderText(text: string | undefined): boolean {
  const raw = (text ?? '').trim();
  if (raw === '') return true;

  // Only italic, and nothing outside it.
  if (raw.replace(ITALIC_SPAN, '').trim() === '') return true;

  const normalized = normalizeEntry(raw);
  if (!HAS_MEANING.test(normalized)) return true;
  return FILLER.has(normalized);
}

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

/** How wide a line's indentation is, counting a tab as the four spaces it usually stands in for. */
function indentWidth(prefix: string): number {
  return prefix.replace(/\t/g, '    ').length;
}

/**
 * The entries under an acceptance heading.
 *
 * A bulleted list is the usual shape, and when there is one its items are the entries — prose
 * wrapped around a list is a preamble, not a criterion. Acceptance criteria written as plain
 * prose with no checkbox at all is legal in this codebase and always has been, so a section
 * with no list is read as one entry per paragraph rather than as zero criteria. That is the
 * whole reason this does not go through `countAcceptance`, which only ever counts checkboxes.
 *
 * A *nested* bullet is not a criterion. The shallowest bullet in the list is the criterion
 * level, and anything indented past it is a note about the entry above and is folded into it —
 * as is any non-bullet continuation line. Counting sub-bullets as peers would make "add a
 * sub-bullet" the way to answer "Acceptance criteria has one entry and it repeats the title",
 * and a gate that can be answered with padding teaches padding.
 *
 * The shallowest bullet, not the first, because a whole list may be written indented; the
 * lines are read unmodified for the same reason, since trimming the section would flatten the
 * first bullet's indentation and make every later peer look nested under it.
 */
export function criteriaEntries(section: string | undefined): string[] {
  const raw = section ?? '';
  if (raw.trim() === '') return [];

  const lines = raw.split(/\r?\n/);
  const openers = lines.map((line) => ENTRY_LINE.exec(line));
  const indents = openers.flatMap((opener) =>
    opener === null ? [] : [indentWidth(opener[1] ?? '')],
  );

  if (indents.length > 0) {
    const baseIndent = indents.reduce((lowest, indent) => Math.min(lowest, indent));
    const entries: string[] = [];

    // Prose before the list is a preamble, so there is nothing to fold it into and it is
    // dropped — the same thing the plain-continuation branch has always done.
    const foldIntoLast = (fragment: string): void => {
      const last = entries.length - 1;
      if (last < 0) return;
      entries[last] = `${entries[last] as string} ${fragment}`;
    };

    lines.forEach((line, index) => {
      const opener = openers[index] ?? null;
      if (opener !== null) {
        const content = line.replace(ENTRY_MARKER, '').trim();
        if (indentWidth(opener[1] ?? '') <= baseIndent) entries.push(content);
        else foldIntoLast(content);
      } else if (line.trim() !== '') foldIntoLast(line.trim());
    });
    return entries;
  }

  return raw
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

interface CriteriaVerdict {
  found: number;
  usable: number;
  echoesTitle: number;
  placeholders: number;
}

function judgeCriteria(entries: string[], title: string): CriteriaVerdict {
  // An empty title would make every empty entry "an echo of the title"; those are placeholders
  // and are already discarded as such, but the count they land in should still be honest.
  const wanted = normalizeEntry(title);
  let usable = 0;
  let echoesTitle = 0;
  let placeholders = 0;

  for (const entry of entries) {
    if (isPlaceholderText(entry)) placeholders += 1;
    else if (wanted !== '' && normalizeEntry(entry) === wanted) echoesTitle += 1;
    else usable += 1;
  }

  return { found: entries.length, usable, echoesTitle, placeholders };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Every way this body falls short of this spec requirement, in the order the requirement lists
 * its sections, with the criteria gap last. Empty means the item has been thought about.
 *
 * The acceptance section is judged once. When it is missing, blank or a placeholder it is
 * reported that way and the criteria count is not also reported — two lines about the same
 * absent paragraph read as two problems, and only one of them is real.
 *
 * The criteria count is taken only when the requirement itself lists {@link CRITERIA_SECTION}.
 * A project that writes `spec: { sections: [Problem] }` asked about one paragraph, and being
 * refused with "Acceptance criteria lists no criteria" — naming a heading its config never
 * mentioned — is the gate answering a question nobody asked. The built-in `ready` guard lists
 * the section, so what ships is unchanged.
 */
export function specGaps(input: SpecInput, requirement: SpecRequirement): SpecGap[] {
  const gaps: SpecGap[] = [];
  let criteriaSectionFaulted = false;

  for (const section of requirement.sections) {
    const text = input.sections[section];
    if (text === undefined) gaps.push({ section, reason: 'missing' });
    else if (text.trim() === '') gaps.push({ section, reason: 'empty' });
    else if (isPlaceholderText(text)) gaps.push({ section, reason: 'placeholder' });
    else continue;

    if (section === CRITERIA_SECTION) criteriaSectionFaulted = true;
  }

  const asksForCriteria =
    requirement.minCriteria > 0 && requirement.sections.includes(CRITERIA_SECTION);

  if (asksForCriteria && !criteriaSectionFaulted) {
    const verdict = judgeCriteria(criteriaEntries(input.sections[CRITERIA_SECTION]), input.title);
    if (verdict.usable < requirement.minCriteria) {
      gaps.push({
        section: CRITERIA_SECTION,
        reason: 'criteria',
        needed: requirement.minCriteria,
        ...verdict,
      });
    }
  }

  return gaps;
}
