import { describe, expect, it } from 'vitest';
import { en } from './en';
import { ru } from './ru';

/**
 * What can be checked without a browser.
 *
 * Completeness is a compile error rather than a test — `ru` is typed as `Dictionary`, so a key
 * added to English and forgotten in Russian fails `tsc`. What a test can still catch is the
 * other direction, and the things a type cannot see: a key that is present but empty, a
 * placeholder that exists in one language and not the other, a plural with the wrong number of
 * forms for the language it is in.
 */

const keys = Object.keys(en) as Array<keyof typeof en>;

/**
 * The distinct `{name}` placeholders in a phrase, sorted.
 *
 * Distinct rather than every occurrence: a plural key holds two forms in English and three in
 * Russian, each mentioning `{n}`, and counting occurrences would call that a mismatch. What is
 * worth catching is a *name* that exists in one language and not the other.
 */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string))].sort();
}

describe('the dictionaries', () => {
  it('say something for every key, in both languages', () => {
    for (const key of keys) {
      expect(en[key].trim(), `en is empty for ${key}`).not.toBe('');
      expect(ru[key].trim(), `ru is empty for ${key}`).not.toBe('');
    }
  });

  it('has no Russian key that English does not have', () => {
    // The type catches the other direction. This one catches a key deleted from English and
    // left behind in Russian, which a type cannot see.
    expect(Object.keys(ru).sort()).toEqual(keys.slice().sort());
  });

  it('fills the same placeholders in both languages', () => {
    // A phrase that says `{editor}` in English and nothing in Russian silently drops the one
    // piece of information the sentence was for.
    for (const key of keys) {
      expect(placeholders(ru[key]), `placeholders differ for ${key}`).toEqual(
        placeholders(en[key]),
      );
    }
  });

  it('is not accidentally still English', () => {
    // Product vocabulary stays as it is on purpose — `merge request`, `worktree`, `Pomni` —
    // so this only asks that a Russian phrase is not character-for-character the English one
    // unless it is one of those, which is what an untranslated string looks like.
    const sameOnPurpose = new Set<string>(['run.artifacts.mr']);
    const identical = keys.filter(
      (key) => !sameOnPurpose.has(key) && ru[key] === en[key] && /[a-z]{4}/i.test(en[key]),
    );
    expect(identical).toEqual([]);
  });
});

describe('plural keys', () => {
  // A key whose English holds two forms must hold three in Russian, or `plural()` falls back
  // to the last form and quietly renders the wrong one for every number but 1.
  const pluralKeys = keys.filter((key) => en[key].includes('|'));

  it('exist, and carry one form per category in each language', () => {
    expect(pluralKeys.length).toBeGreaterThan(0);
    for (const key of pluralKeys) {
      expect(en[key].split('|'), `en forms for ${key}`).toHaveLength(2);
      expect(ru[key].split('|'), `ru forms for ${key}`).toHaveLength(3);
    }
  });

  it('has no Russian plural where English is a single phrase', () => {
    const mismatched = keys.filter((key) => !en[key].includes('|') && ru[key].includes('|'));
    expect(mismatched).toEqual([]);
  });
});

describe('Russian plurals', () => {
  // The reason a plural helper exists at all: `n + ' задач'` is wrong for most numbers, and
  // the three Russian forms do not line up with English's two.
  const forms = new Intl.PluralRules('ru-RU');

  it('picks one, few and many where Russian does', () => {
    expect(forms.select(1)).toBe('one');
    expect(forms.select(2)).toBe('few');
    expect(forms.select(4)).toBe('few');
    expect(forms.select(5)).toBe('many');
    expect(forms.select(0)).toBe('many');
    // The cases a hand-written rule gets wrong.
    expect(forms.select(11)).toBe('many');
    expect(forms.select(12)).toBe('many');
    expect(forms.select(21)).toBe('one');
    expect(forms.select(22)).toBe('few');
    expect(forms.select(111)).toBe('many');
  });

  it('English needs only two', () => {
    const english = new Intl.PluralRules('en-GB');
    expect(english.select(1)).toBe('one');
    expect([english.select(0), english.select(2), english.select(21)]).toEqual([
      'other',
      'other',
      'other',
    ]);
  });
});
