import { ValidationError } from './errors.js';

/** Slugs are used as directory names and URL segments, so keep them boring. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * There is deliberately no reserved-word list. Ids only ever appear as a nested path segment
 * (`projects/<id>/`, `/api/projects/:id`), so a name like `api` or `config` collides with
 * nothing — and `api` is the most natural repo name there is in a fullstack project. The
 * pattern above already excludes the cases that actually matter: empty, `.`, `..`, and
 * anything containing a path separator.
 */

export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug;
}

export function assertSlug(value: string, what: string): void {
  if (!SLUG_PATTERN.test(value)) {
    throw new ValidationError(
      `${what} '${value}' is not a valid id — use lowercase letters, digits and hyphens (1-40 chars)`,
    );
  }
}

/**
 * Derive an id from a name, falling back to a prefix when the name yields nothing
 * usable (e.g. a name that is entirely punctuation or non-Latin script).
 */
export function deriveId(name: string, fallbackPrefix: string): string {
  const slug = slugify(name);
  // One character is a legitimate name; the pattern already allows it.
  if (slug.length >= 1 && SLUG_PATTERN.test(slug)) return slug;
  return `${fallbackPrefix}-${Date.now().toString(36)}`;
}

/** Make `desired` unique against `taken` by appending -2, -3, ... */
export function uniqueId(desired: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(desired)) return desired;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${desired}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new ValidationError(`could not derive a unique id from '${desired}'`);
}

/** Item prefix for backlog ids: ACME-1, WEB-12. Derived from the project id. */
export function deriveItemPrefix(projectId: string): string {
  const letters = projectId.replace(/[^a-z0-9]/g, '').toUpperCase();
  return (letters.slice(0, 4) || 'POM').padEnd(2, 'X');
}

/** Repo id guessed from a git URL or a filesystem path. */
export function repoIdFromSource(value: string): string {
  const cleaned = value
    .replace(/\.git$/i, '')
    .replace(/[\\/]+$/, '');
  const last = cleaned.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return slugify(last);
}
