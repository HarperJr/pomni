import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref, type Block, type Inline } from './markdown-parse';

/**
 * The parser, on its own.
 *
 * Everything with an edge case lives here rather than in the component, which is why this can
 * be tested a hundred ways without a DOM. The cases that matter most are the ones where the
 * source is *not* what it looks like: a malformed table, an unclosed fence, a link that would
 * run a script.
 */

const text = (value: string): Inline => ({ kind: 'text', text: value });

/** What a block says, flattened, for assertions that are about structure and not wording. */
function flatten(children: Inline[]): string {
  return children
    .map((child) => {
      switch (child.kind) {
        case 'text':
        case 'code':
          return child.text;
        default:
          return flatten(child.children);
      }
    })
    .join('');
}

describe('blocks', () => {
  it('reads headings by their depth', () => {
    const blocks = parseMarkdown('# One\n\n### Three');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 3 });
    expect(flatten((blocks[1] as Extract<Block, { kind: 'heading' }>).children)).toBe('Three');
  });

  it('joins the lines of a paragraph and ends it at a blank line', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree');
    expect(blocks).toHaveLength(2);
    expect(flatten((blocks[0] as Extract<Block, { kind: 'paragraph' }>).children)).toBe('one\ntwo');
  });

  it('keeps a fenced block exactly, including the lines that look like markdown', () => {
    const source = ['```ts', 'const a = 1;', '', '# not a heading', '  indented', '```'].join('\n');
    const [block] = parseMarkdown(source);

    expect(block).toMatchObject({ kind: 'code', language: 'ts' });
    expect((block as Extract<Block, { kind: 'code' }>).text).toBe(
      'const a = 1;\n\n# not a heading\n  indented',
    );
  });

  it('runs an unclosed fence to the end rather than losing the document', () => {
    const [block, ...rest] = parseMarkdown('```\nstill code\nand this too');
    expect(block).toMatchObject({ kind: 'code', text: 'still code\nand this too' });
    expect(rest).toEqual([]);
  });

  it('tells a rule from a list, and from a paragraph', () => {
    expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }]);
    expect(parseMarkdown('***')).toEqual([{ kind: 'rule' }]);
    expect(parseMarkdown('- one')[0]).toMatchObject({ kind: 'list' });
  });

  it('reads a quote, and the blocks inside it', () => {
    const [block] = parseMarkdown('> a note\n> and **more**');
    expect(block).toMatchObject({ kind: 'quote' });

    const inner = (block as Extract<Block, { kind: 'quote' }>).children;
    expect(inner).toHaveLength(1);
    expect(flatten((inner[0] as Extract<Block, { kind: 'paragraph' }>).children)).toBe(
      'a note\nand more',
    );
  });
});

describe('lists', () => {
  it('reads bullets, and keeps a wrapped line in the item it belongs to', () => {
    const [block] = parseMarkdown('- one\n  continued\n- two');
    const list = block as Extract<Block, { kind: 'list' }>;

    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(flatten((list.items[0]?.[0] as Extract<Block, { kind: 'paragraph' }>).children)).toBe(
      'one\ncontinued',
    );
  });

  it('reads an ordered list and remembers where it started', () => {
    const [block] = parseMarkdown('3. three\n4. four');
    expect(block).toMatchObject({ kind: 'list', ordered: true, start: 3 });
    expect((block as Extract<Block, { kind: 'list' }>).items).toHaveLength(2);
  });

  it('nests a deeper list inside the item above it', () => {
    const [block] = parseMarkdown('- outer\n  - inner\n  - also inner\n- second');
    const list = block as Extract<Block, { kind: 'list' }>;

    expect(list.items).toHaveLength(2);
    const nested = list.items[0]?.[1] as Extract<Block, { kind: 'list' }>;
    expect(nested).toMatchObject({ kind: 'list' });
    expect(nested.items).toHaveLength(2);
  });

  it('starts a new list when the marker changes kind', () => {
    const blocks = parseMarkdown('- bullet\n1. numbered');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: true });
  });
});

describe('tables', () => {
  it('reads a table when a delimiter row says it is one', () => {
    const source = ['| a | b |', '| --- | :---: |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
    const [block] = parseMarkdown(source);
    const table = block as Extract<Block, { kind: 'table' }>;

    expect(table.kind).toBe('table');
    expect(table.header.map(flatten)).toEqual(['a', 'b']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]?.map(flatten)).toEqual(['3', '4']);
  });

  it('leaves a line full of pipes alone when nothing says it is a table', () => {
    const blocks = parseMarkdown('a | b | c\nand more prose');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'paragraph' });
    expect(flatten((blocks[0] as Extract<Block, { kind: 'paragraph' }>).children)).toContain('|');
  });

  it('renders a malformed table as the lines it is, rather than nothing', () => {
    // A delimiter row and one column: not a table, and it must not disappear.
    const blocks = parseMarkdown('| a\n| ---');
    expect(blocks.every((block) => block.kind === 'paragraph' || block.kind === 'rule')).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
  });
});

describe('inline', () => {
  it('reads emphasis, strong and code', () => {
    expect(parseInline('a **b** c')).toEqual([
      text('a '),
      { kind: 'strong', children: [text('b')] },
      text(' c'),
    ]);
    expect(parseInline('_it_')).toEqual([{ kind: 'em', children: [text('it')] }]);
    expect(parseInline('`x`')).toEqual([{ kind: 'code', text: 'x' }]);
  });

  it('never looks inside a code span', () => {
    // Somebody writing about markdown means two asterisks, and gets two asterisks.
    expect(parseInline('`**not bold**`')).toEqual([{ kind: 'code', text: '**not bold**' }]);
  });

  it('takes the earliest construct when two could match', () => {
    const parsed = parseInline('**first** and `second`');
    expect(parsed[0]).toMatchObject({ kind: 'strong' });
    expect(parsed.at(-1)).toMatchObject({ kind: 'code', text: 'second' });
  });

  it('leaves an unmatched marker as text', () => {
    expect(parseInline('a * b')).toEqual([text('a * b')]);
    expect(parseInline('**unclosed')).toEqual([text('**unclosed')]);
  });

  it('reads a link, and keeps its text', () => {
    expect(parseInline('[here](https://example.com)')).toEqual([
      { kind: 'link', href: 'https://example.com', children: [text('here')] },
    ]);
  });
});

describe('what a link is allowed to be', () => {
  it('accepts the web, mail, and a path inside the app', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('http://localhost:7777/x')).toBe('http://localhost:7777/x');
    expect(safeHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');
    expect(safeHref('/p/pomni/items/POMN-1')).toBe('/p/pomni/items/POMN-1');
    expect(safeHref('./relative')).toBe('./relative');
    expect(safeHref('#anchor')).toBe('#anchor');
  });

  it('refuses anything that would run', () => {
    // The same rule as "nothing becomes HTML", applied to an attribute. React will not stop
    // a `javascript:` href on its own.
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('  JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('vbscript:msgbox')).toBeNull();
    // Protocol-relative: it leaves the app for a host the source chose, without saying so.
    expect(safeHref('//evil.example')).toBeNull();
  });

  it('shows a refused link as what it said, brackets and all', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([
      text('[click](javascript:alert(1)'),
      text(')'),
    ]);
  });
});

describe('raw HTML', () => {
  it('is text, not markup', () => {
    const [block] = parseMarkdown('<script>alert(1)</script>');
    expect(block).toMatchObject({ kind: 'paragraph' });
    expect(flatten((block as Extract<Block, { kind: 'paragraph' }>).children)).toBe(
      '<script>alert(1)</script>',
    );
  });

  it('stays text inside a heading or a list item', () => {
    const [heading] = parseMarkdown('# <img src=x onerror=alert(1)>');
    expect(flatten((heading as Extract<Block, { kind: 'heading' }>).children)).toContain('<img');
  });
});

describe('the whole of an agent’s answer', () => {
  it('survives a document using every construct at once', () => {
    const source = [
      '# Findings',
      '',
      'Two things, and one **matters**:',
      '',
      '1. the gate never ran',
      '2. the branch is stranded',
      '   - on no remote',
      '',
      '> which is why the run says passed',
      '',
      '| where | what |',
      '| --- | --- |',
      '| `git.ts` | no push |',
      '',
      '```sh',
      'git push origin HEAD',
      '```',
      '',
      '---',
      '',
      'See [the run](https://example.com/runs/1).',
    ].join('\n');

    const kinds = parseMarkdown(source).map((block) => block.kind);
    expect(kinds).toEqual([
      'heading',
      'paragraph',
      'list',
      'quote',
      'table',
      'code',
      'rule',
      'paragraph',
    ]);
  });

  it('returns nothing for nothing, and does not throw on odd input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n\n')).toEqual([]);
    expect(() => parseMarkdown('```\n> - # | ** `` [](')).not.toThrow();
    expect(() => parseMarkdown('- \n- \n')).not.toThrow();
  });
});
