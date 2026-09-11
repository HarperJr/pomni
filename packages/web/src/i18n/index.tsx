import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en } from './en';
import { ru } from './ru';

/**
 * Two languages, no library.
 *
 * A typed `t()` and a React context are enough for two dictionaries; an i18n library brings a
 * loader, a formatter, a plural engine and its release cadence for a problem that is one file
 * per language. `Intl` already ships the parts that are genuinely hard — plural categories,
 * dates, relative times — and it is in the browser whether we use it or not.
 *
 * What is **not** translated, ever: anything a person or an agent wrote. Item titles and
 * bodies, agent output, run logs, repo names, ids, commands, and statuses as the data spells
 * them. A Russian item in the backlog looks the same in both languages, because it is the
 * same text.
 */

export type Language = 'en' | 'ru';

export const LANGUAGES: Array<{ code: Language; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
];

const DICTIONARIES = { en, ru } as const;
const STORAGE_KEY = 'pomni.language';

export type Key = keyof typeof en;

interface Translator {
  language: Language;
  setLanguage(next: Language): void;
  /** One phrase, with `{name}` placeholders filled from `values`. */
  t(key: Key, values?: Record<string, string | number>): string;
  /**
   * A phrase that changes with a count. The dictionary holds the forms separated by `|`, in
   * the order `Intl.PluralRules` names them for that language — two for English, three for
   * Russian, which is the whole reason this exists rather than `n + ' задач'`.
   */
  plural(key: Key, count: number, values?: Record<string, string | number>): string;
  /** A date, formatted by `Intl` in the chosen language rather than by a hand-built string. */
  date(iso: string | null | undefined, options?: Intl.DateTimeFormatOptions): string;
  /**
   * A number with the grouping the chosen language uses. English groups with commas and
   * Russian with spaces, and both are what a reader of that language expects to see.
   */
  number(value: number): string;
  /**
   * How long something took: `850ms`, `12.3s`, `2m 5s`, and `850 мс`, `12,3 с`, `2 мин 5 с`.
   *
   * Through `Intl.NumberFormat`'s unit style rather than by appending `s` and `m`, which are
   * English abbreviations wherever they appear. Empty string for an unmeasured duration —
   * `null` means nobody counted, and `0ms` would be a measurement.
   */
  duration(ms: number | null | undefined): string;
}

const Context = createContext<Translator | null>(null);

/**
 * What language to start in.
 *
 * A remembered choice wins. Otherwise the browser's own preference decides, which is the
 * question `navigator.language` exists to answer — assuming either language would be wrong
 * for half the people who open this.
 *
 * Every storage access is wrapped: a private window, cleared site data or a browser told to
 * block storage each throw here, and none of them is a reason to fail to render.
 */
export function initialLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'ru') return stored;
  } catch {
    // Falls through to the browser's preference, which is the right answer anyway.
  }

  const preferred = typeof navigator === 'undefined' ? '' : navigator.language;
  return preferred.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setStored] = useState<Language>(initialLanguage);

  const setLanguage = useCallback((next: Language) => {
    setStored(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Remembering is a convenience. The choice still applies to this page.
    }
    // So `:lang()` rules and a screen reader both know what they are looking at.
    if (typeof document !== 'undefined') document.documentElement.lang = next;
  }, []);

  const value = useMemo<Translator>(() => {
    const dictionary = DICTIONARIES[language];
    const locale = language === 'ru' ? 'ru-RU' : 'en-GB';
    const plurals = new Intl.PluralRules(locale);

    // A missing key renders the English rather than the key itself or nothing: a screen that
    // is briefly bilingual is usable, and a screen showing `board.move` is not.
    const phrase = (key: Key): string => dictionary[key] ?? en[key];

    return {
      language,
      setLanguage,
      t: (key, values) => fill(phrase(key), values),
      plural: (key, count, values) => {
        const forms = phrase(key).split('|');
        const category = plurals.select(count);
        const order = language === 'ru' ? ['one', 'few', 'many'] : ['one', 'other'];
        const chosen = forms[order.indexOf(category)] ?? forms.at(-1) ?? '';
        return fill(chosen, { ...values, n: count });
      },
      number: (value) => new Intl.NumberFormat(locale).format(value),
      duration: (ms) => {
        if (ms === null || ms === undefined) return '';

        const unit = (value: number, name: 'millisecond' | 'second' | 'minute') =>
          new Intl.NumberFormat(locale, {
            style: 'unit',
            unit: name,
            // Narrow, so English keeps the dense `12.3s` it had rather than gaining `12.3 secs`.
            // Russian widens to `12,3 с` on its own, which is what Russian does with units.
            unitDisplay: 'narrow',
            maximumFractionDigits: name === 'second' ? 1 : 0,
          }).format(value);

        if (ms < 1000) return unit(ms, 'millisecond');
        if (ms < 60_000) return unit(ms / 1000, 'second');
        return `${unit(Math.floor(ms / 60_000), 'minute')} ${unit(
          Math.round((ms % 60_000) / 1000),
          'second',
        )}`;
      },
      date: (iso, options) => {
        if (!iso) return '';
        const at = new Date(iso);
        if (Number.isNaN(at.getTime())) return '';
        return new Intl.DateTimeFormat(
          locale,
          options ?? { dateStyle: 'medium', timeStyle: 'short' },
        ).format(at);
      },
    };
  }, [language, setLanguage]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLanguage(): Translator {
  const value = useContext(Context);
  if (!value) throw new Error('useLanguage was called outside LanguageProvider');
  return value;
}

function fill(text: string, values?: Record<string, string | number>): string {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** The language selector, for the top bar. */
export function LanguagePicker() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <select
      className="language-picker"
      value={language}
      aria-label={t('nav.language')}
      onChange={(event) => setLanguage(event.target.value as Language)}
    >
      {LANGUAGES.map((entry) => (
        <option key={entry.code} value={entry.code}>
          {entry.label}
        </option>
      ))}
    </select>
  );
}
