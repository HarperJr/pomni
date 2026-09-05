/**
 * Domain errors. Every surface (CLI, HTTP, MCP) maps these to its own vocabulary;
 * nothing below this layer knows about exit codes or status codes.
 */
export type PomniErrorCode =
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'stale_revision'
  | 'git_failed'
  | 'credential_failed'
  | 'not_initialized'
  | 'unsupported';

export class PomniError extends Error {
  readonly code: PomniErrorCode;
  readonly details?: unknown;

  constructor(code: PomniErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  /** HTTP status a surface should use. Kept here so every surface agrees. */
  get status(): number {
    switch (this.code) {
      case 'not_found':
        return 404;
      case 'conflict':
        return 409;
      case 'stale_revision':
        return 409;
      case 'validation':
        return 422;
      case 'not_initialized':
        return 412;
      case 'unsupported':
        return 400;
      default:
        return 500;
    }
  }
}

export class NotFoundError extends PomniError {
  constructor(what: string, id: string) {
    super('not_found', `${what} '${id}' not found`);
  }
}

export class ConflictError extends PomniError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, details);
  }
}

export class ValidationError extends PomniError {
  constructor(message: string, details?: unknown) {
    super('validation', message, details);
  }
}

/**
 * Thrown when a write is based on a revision that is no longer current — i.e. someone
 * else (a Claude session, the CLI, another browser tab) changed the file first.
 * Carries the current content so the caller can merge instead of clobbering.
 */
export class StaleRevisionError extends PomniError {
  readonly expected: string;
  readonly actual: string;
  readonly current: unknown;

  constructor(path: string, expected: string, actual: string, current: unknown) {
    super('stale_revision', `'${path}' was modified by someone else`, { path, expected, actual });
    this.expected = expected;
    this.actual = actual;
    this.current = current;
  }
}

export class GitError extends PomniError {
  constructor(message: string, details?: unknown) {
    super('git_failed', message, details);
  }
}

export class CredentialError extends PomniError {
  constructor(message: string, details?: unknown) {
    super('credential_failed', message, details);
  }
}

export class NotInitializedError extends PomniError {
  constructor(root: string) {
    super('not_initialized', `no Pomni workspace at '${root}' — run 'pomni init' first`);
  }
}
