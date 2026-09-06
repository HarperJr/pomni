import { describe, expect, it } from 'vitest';
import { parseAddresses, stripAddresses } from './address.js';

/**
 * The verdicts. Each case here is one the rule was designed against, so a change that makes one
 * of them flip is a change to the rule and should be argued, not absorbed.
 */

const names = (text: string) => parseAddresses(text).addresses.map((entry) => entry.raw);

describe('what is not an address', () => {
  it.each([
    ['an email address', 'ask a@b.com about it'],
    ['a URL fragment', 'see https://x.dev/guide#section'],
    ['a path', 'it lives in /usr/bin'],
    ['a dotted path', 'open /etc/hosts.d'],
    ['a markdown heading', '# Title\n\nbody'],
    ['a mid-word @', 'the foo@bar convention'],
    ['a mid-word #', 'issue no1#2 is open'],
    ['a comment marker', '// see above'],
    ['an underscored name', '#pomni_backup is the folder'],
    ['a skill-shaped file', 'read /notes.md'],
  ])('%s', (_label, text) => {
    expect(names(text)).toEqual([]);
  });

  it('leaves code spans alone', () => {
    expect(names('run `#pomni` and `@scout` please')).toEqual([]);
    expect(names('```\n#pomni\n@scout\n/skill\n```')).toEqual([]);
  });
});

describe('what is an address', () => {
  it('takes a project, an agent and a skill', () => {
    const parsed = parseAddresses('#pomni what changed /review');
    expect(parsed.project?.name).toBe('pomni');
    expect(parsed.skills.map((entry) => entry.name)).toEqual(['review']);
    expect(parsed.prose).toBe('what changed');
  });

  it('binds a slash to @ when there is no space', () => {
    const parsed = parseAddresses('@pomni/codebase-scout look at this');
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]).toMatchObject({ workflowId: 'pomni', name: 'codebase-scout' });
    expect(parsed.skills).toEqual([]);
  });

  it('reads a space as separating an agent from a skill', () => {
    const parsed = parseAddresses('@scout /summarize the diff');
    expect(parsed.agents[0]).toMatchObject({ workflowId: null, name: 'scout' });
    expect(parsed.skills[0]).toMatchObject({ name: 'summarize' });
  });

  it('carries offsets that slice the raw text back out', () => {
    const raw = 'hey #pomni ship it';
    const [address] = parseAddresses(raw).addresses;
    expect(raw.slice(address?.start, address?.end)).toBe('#pomni');
  });

  it('is case-insensitive, because ids are lowercase by definition', () => {
    expect(parseAddresses('#Pomni').project?.name).toBe('pomni');
  });
});

describe('#include and friends parse as candidates', () => {
  it('produces a candidate that resolution will reject', () => {
    const parsed = parseAddresses('#include <stdio.h> is missing');
    expect(parsed.project?.name).toBe('include');
  });

  it('leaves an unresolved candidate in the prose when nothing is stripped', () => {
    const raw = '#include <stdio.h> is missing';
    expect(stripAddresses(raw, [])).toBe(raw);
  });
});

describe('repeats and conflicts', () => {
  it('treats the same project twice as one address in force', () => {
    const parsed = parseAddresses('#pomni and again #pomni');
    expect(parsed.addresses).toHaveLength(2);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.project?.name).toBe('pomni');
  });

  it('keeps the first of two different projects and reports the drop', () => {
    const parsed = parseAddresses('#pomni versus #other');
    expect(parsed.project?.name).toBe('pomni');
    expect(parsed.conflicts[0]?.dropped.map((entry) => entry.name)).toEqual(['other']);
  });
});

describe('prose', () => {
  it('collapses the gap an address leaves behind', () => {
    expect(parseAddresses('#pomni  create a task for X').prose).toBe('create a task for X');
    expect(parseAddresses('please #pomni do it').prose).toBe('please do it');
  });

  it('removes only what it is given', () => {
    const raw = '#pomni ask @scout';
    const parsed = parseAddresses(raw);
    expect(stripAddresses(raw, parsed.agents)).toBe('#pomni ask');
  });

  it('survives a message that is nothing but an address', () => {
    expect(parseAddresses('#pomni').prose).toBe('');
  });
});
