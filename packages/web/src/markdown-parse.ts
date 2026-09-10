/**
 * Markdown, parsed into a shape a renderer can walk.
 *
 * Pure and separate from the component on purpose: this is the part with the edge cases, and
 * it can be tested a hundred ways without a DOM. The component that consumes it has no
 * decisions left to make.
 *
 * The subset is what agents actually write — headings, emphasis, code, lists, quotes, links,
 * rules and tables — and no more. A markdown library would bring a parser, a sanitiser and
 * their release cadence to render output we generate ourselves; `packages/web` has four
 * runtime dependencies and is worth keeping that way.
 *
 * The rule that does not bend: nothing here produces HTML. Blocks become React elements, and a
 * `<script>` in the source is a paragraph that says `<script>`.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] };

export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(\s*)(```+|~~~+)\s*(\S*)\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
/** A delimiter row: `| --- | :---: |`. What tells a table from a paragraph full of pipes. */
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let at = 0;

  while (at < lines.length) {
    const line = lines[at] as string;

    if (!line.trim()) {
      at += 1;
      continue;
    }

    // Fences first, and by their own indent: everything inside one is text, including lines
    // that would otherwise be a heading or a list. That is the whole point of a fence.
    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent = '', marker = '```', language = ''] = fence;
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !closes(lines[at] as string, marker)) {
        body.push(unindent(lines[at] as string, indent.length));
        at += 1;
      }
      // An unclosed fence runs to the end rather than swallowing the document into nothing.
      if (at < lines.length) at += 1;
      blocks.push({ kind: 'code', language: language || null, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        children: parseInline(heading[2] as string),
      });
      at += 1;
      continue;
    }

    // Before the rule check, because `---` under a bullet list is a rule and `- - -` is not a
    // list. Order here is the difference between a horizontal line and three empty items.
    if (RULE.test(line) && !BULLET.test(line)) {
      blocks.push({ kind: 'rule' });
      at += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (at < lines.length && (QUOTE.test(lines[at] as string) || (lines[at] as string).trim())) {
        const inner = QUOTE.exec(lines[at] as string);
        if (!inner) break;
        quoted.push(inner[1] as string);
        at += 1;
      }
      blocks.push({ kind: 'quote', children: parseBlocks(quoted) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, at);
      blocks.push(list);
      at = next;
      continue;
    }

    const table = parseTable(lines, at);
    if (table) {
      blocks.push(table.block);
      at = table.next;
      continue;
    }

    // Everything else is a paragraph, running until a blank line or something that starts a
    // block of its own. A line that only *looks* like a construct — a malformed table row, a
    // stray `|` — lands here and is shown as what it is.
    const paragraph: string[] = [];
    while (at < lines.length && (lines[at] as string).trim() && !starts(lines, at)) {
      paragraph.push((lines[at] as string).trim());
      at += 1;
    }
    if (paragraph.length === 0) {
      // `starts` said this line opens a block and the handlers above disagreed. Take it as
      // text rather than looping forever on it.
      paragraph.push(line.trim());
      at += 1;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

/** Whether this line begins a block, so a paragraph before it must stop. */
function starts(lines: string[], at: number): boolean {
  const line = lines[at] as string;
  if (at === 0) return false;
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    (RULE.test(line) && !BULLET.test(line))
  );
}

function closes(line: string, marker: string): boolean {
  return new RegExp(`^\\s*${marker[0] === '`' ? '`{3,}' : '~{3,}'}\\s*$`).test(line);
}

function unindent(line: string, by: number): string {
  let cut = 0;
  while (cut < by && (line[cut] === ' ' || line[cut] === '\t')) cut += 1;
  return line.slice(cut);
}

/**
 * One list, and where it ends.
 *
 * Nesting is by indent: a deeper marker belongs to the item above it, and is parsed by the
 * same function one level down. A continuation line that is neither is joined to the item's
 * text, which is how a wrapped bullet stays one bullet.
 */
function parseList(lines: string[], from: number): [Block, number] {
  const first = (BULLET.exec(lines[from] as string) ?? ORDERED.exec(lines[from] as string)) as
    | RegExpExecArray
    | null;
  if (!first) return [{ kind: 'paragraph', children: parseInline(lines[from] as string) }, from + 1];

  const ordered = ORDERED.test(lines[from] as string);
  const indent = (first[1] as string).length;
  const start = ordered ? Number(first[2]) : 1;

  const items: Block[][] = [];
  let current: string[] | null = null;
  let at = from;

  while (at < lines.length) {
    const line = lines[at] as string;
    if (!line.trim()) {
      // A blank line inside a list is kept: it separates paragraphs within an item. A blank
      // line followed by anything that is not part of this list ends it.
      const following = lines[at + 1];
      if (following === undefined || !continues(following, indent)) break;
      current?.push('');
      at += 1;
      continue;
    }

    const marker = BULLET.exec(line) ?? ORDERED.exec(line);
    const isSame = marker !== null && (marker[1] as string).length === indent;
    const isDeeper = marker !== null && (marker[1] as string).length > indent;
    const isShallower = marker !== null && (marker[1] as string).length < indent;

    if (isShallower) break;

    if (isSame && ORDERED.test(line) !== ordered) break;

    if (isSame) {
      if (current) items.push(parseBlocks(current));
      current = [marker[3] as string];
      at += 1;
      continue;
    }

    if (isDeeper || line.startsWith(' '.repeat(indent + 1))) {
      current?.push(unindent(line, indent + 2));
      at += 1;
      continue;
    }

    if (current === null) break;

    // A wrapped line: no marker, no indent, but the item is still open.
    current.push(line.trim());
    at += 1;
  }

  if (current) items.push(parseBlocks(current));
  return [{ kind: 'list', ordered, start, items }, at];
}

function continues(line: string, indent: number): boolean {
  const marker = BULLET.exec(line) ?? ORDERED.exec(line);
  if (marker) return (marker[1] as string).length >= indent;
  return line.startsWith(' '.repeat(indent + 1));
}

/**
 * A table, if the two lines here are a header and a delimiter.
 *
 * The delimiter row is what makes it a table. Without it a line full of pipes is a line full
 * of pipes — which is what a malformed table is, and it renders as the text it is rather than
 * vanishing.
 */
function parseTable(lines: string[], from: number): { block: Block; next: number } | null {
  const header = lines[from] as string;
  const delimiter = lines[from + 1];
  if (!header.includes('|') || delimiter === undefined || !TABLE_RULE.test(delimiter)) return null;

  const cells = (line: string): string[] =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const head = cells(header);
  if (head.length < 2) return null;

  const rows: Inline[][][] = [];
  let at = from + 2;
  while (at < lines.length && (lines[at] as string).includes('|') && (lines[at] as string).trim()) {
    rows.push(cells(lines[at] as string).map(parseInline));
    at += 1;
  }

  return { block: { kind: 'table', header: head.map(parseInline), rows }, next: at };
}

/**
 * Where a link may point.
 *
 * The same rule as "nothing becomes HTML", applied to an attribute: a `javascript:` href is a
 * script the page would run, and React does not stop it. Anything not plainly a web address,
 * a mail address or a path within the app renders as text, keeping its brackets so the reader
 * can see what it said.
 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[./#]/.test(trimmed) && !/^\/\//.test(trimmed)) return trimmed;
  return null;
}

const CODE_SPAN = /`([^`]+)`/;
const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/;
const EM = /(\*|_)(?=\S)([\s\S]*?\S)\1/;
const LINK = /\[([^\]]*)\]\(([^)\s]*)\)/;

/**
 * Inline markup, innermost-first by precedence.
 *
 * Code spans go first and are never looked inside: `**` between backticks is two asterisks,
 * which is exactly what someone writing about markdown means by it.
 */
export function parseInline(source: string): Inline[] {
  if (!source) return [];

  const takers: Array<[RegExp, (m: RegExpExecArray) => Inline]> = [
    [CODE_SPAN, (m) => ({ kind: 'code', text: m[1] as string })],
    [LINK, (m) => link(m[1] as string, m[2] as string)],
    [STRONG, (m) => ({ kind: 'strong', children: parseInline(m[2] as string) })],
    [EM, (m) => ({ kind: 'em', children: parseInline(m[2] as string) })],
  ];

  let earliest: { at: number; length: number; node: Inline } | null = null;
  for (const [pattern, make] of takers) {
    const found = pattern.exec(source);
    if (!found) continue;
    if (earliest && found.index >= earliest.at) continue;
    earliest = { at: found.index, length: found[0].length, node: make(found) };
  }

  if (!earliest) return [{ kind: 'text', text: source }];

  const before = source.slice(0, earliest.at);
  const after = source.slice(earliest.at + earliest.length);

  return [
    ...(before ? [{ kind: 'text' as const, text: before }] : []),
    earliest.node,
    ...parseInline(after),
  ];
}

function link(text: string, href: string): Inline {
  const safe = safeHref(href);
  // Kept as what it said, brackets and all. A link that silently loses its destination is
  // worse than one that shows it.
  if (!safe) return { kind: 'text', text: `[${text}](${href})` };
  return { kind: 'link', href: safe, children: parseInline(text) };
}
