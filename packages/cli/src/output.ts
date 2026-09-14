import { relative } from 'node:path';
import { ZodError } from 'zod';
import { NotFoundError, NotInitializedError, PomniError, RequirementsNotMetError, ValidationError } from '@pomni/core';
import { style } from './format.js';

/**
 * Every command's one route to stdout/stderr. In JSON mode `report` writes exactly one
 * document to stdout and nothing else touches it; otherwise it defers to the existing
 * human-formatted printing. `fail` records that the command's answer is "no" without
 * throwing — a red gate or a refused move is not an exceptional condition.
 */
export interface Output {
  readonly json: boolean;
  readonly exitCode: number;
  report<T>(value: T, human: () => void): void;
  warn(message: string): void;
  /**
   * A line about work in flight — "cloning …", "run started". stdout for a person, stderr
   * under --json, where stdout is reserved for the one document a script will parse.
   */
  progress(message: string): void;
  fail(code?: number): void;
}

export interface OutputOptions {
  json: () => boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export function createOutput({ json, stdout, stderr }: OutputOptions): Output {
  let exitCode = 0;
  return {
    get json() {
      return json();
    },
    get exitCode() {
      return exitCode;
    },
    report(value, human) {
      if (json()) stdout.write(`${JSON.stringify(value)}\n`);
      else human();
    },
    warn(message) {
      stderr.write(`${message}\n`);
    },
    progress(message) {
      (json() ? stderr : stdout).write(`${message}\n`);
    },
    fail(code = 1) {
      if (code > exitCode) exitCode = code;
    },
  };
}

/** The exit code documented in docs/COMMANDS.md for a thrown error. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof RequirementsNotMetError) return 1;
  if (error instanceof NotFoundError || error instanceof NotInitializedError) return 3;
  if (error instanceof ValidationError) return 2;
  // By code as well as by class: a service may raise a plain PomniError with a richer message
  // than the class constructors format, and the code is what the table is keyed on.
  if (error instanceof PomniError) {
    if (error.code === 'not_found' || error.code === 'not_initialized') return 3;
    if (error.code === 'validation') return 2;
    return 1;
  }
  // A schema rejection is bad input, the same as any other validation failure.
  if (error instanceof ZodError) return 2;
  return 1;
}

/** The JSON-mode error envelope: `{ error: { code, message } }` on stdout. */
export function errorEnvelope(
  error: unknown,
): { error: { code: string; message: string; details?: unknown; unmet?: unknown } } {
  if (error instanceof RequirementsNotMetError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
        unmet: error.unmet,
      },
    };
  }
  if (error instanceof PomniError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    };
  }
  if (error instanceof ZodError) {
    return { error: { code: 'validation', message: error.message, details: error.issues } };
  }
  return { error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } };
}

/**
 * Reports an error and records the exit code on `out` — never `process.exitCode` directly,
 * so a caller composing several commands in one process is not surprised by global state.
 */
export function reportError(error: unknown, out: Output): void {
  out.report(errorEnvelope(error), () => {
    if (error instanceof RequirementsNotMetError) {
      out.warn(style.red(error.message));
      const advice = error.unmet.some((unmet) => unmet.kind === 'gate')
        ? "run 'pomni verify' first, or pass --force to record that you moved it anyway"
        : 'pass --force to record that you moved it anyway';
      out.warn(style.dim(advice));
    } else if (error instanceof PomniError) {
      out.warn(style.red(error.message));
      if (error.code === 'not_initialized') {
        out.warn(style.dim(`run 'pomni init' in ${relative(process.cwd(), '.') || '.'}`));
      }
    } else {
      out.warn(style.red(error instanceof Error ? error.message : String(error)));
    }
  });
  out.fail(exitCodeFor(error));
}
