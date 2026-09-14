import { Writable } from 'node:stream';
import type { PomniContainer } from '@pomni/core';
import { main } from '../packages/cli/src/index.js';
import type { ContainerOptions } from '../packages/cli/src/container.js';
import type { TestHarness } from './harness.js';

/**
 * A `--json` command prints one document on stdout (or one per line, for a stream); nothing
 * else may land there. `lines` is every non-empty stdout line, parsed as JSON — a command that
 * broke that contract by writing prose fails here with a `SyntaxError`, not a wrong assertion
 * further down. `last` is the final line, which is what a stream command's summary/report is.
 */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  lines: unknown[];
  last: unknown;
}

class MemoryWritable extends Writable {
  private chunks: string[] = [];

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    callback();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

/**
 * A container `main` should open instead of the real one: either a harness to hand back as-is,
 * or a function taking the same shape as `openContainer` — for the one test that needs `open`
 * itself to fail (an uninitialized workspace) rather than any call made on a working container.
 */
export type HarnessLike =
  | TestHarness
  | ((options?: ContainerOptions) => Promise<PomniContainer>);

/**
 * Runs the real CLI (`packages/cli/src/index.ts`'s `main`) against an in-memory harness instead
 * of a real workspace on disk. `args` are what a person would type after `pomni` — `runCli(h,
 * ['--json', 'runs', 'list'])` is `pomni --json runs list`.
 *
 * stdout and stderr are captured in memory rather than inherited, so a test can assert on
 * exactly what a script parsing this command's output would see, and nothing this process
 * itself writes leaks into a test running beside it.
 */
export async function runCli(harness: HarnessLike, args: string[]): Promise<CliResult> {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();
  const openContainer = typeof harness === 'function' ? harness : async () => harness;

  const code = await main(['node', 'pomni', ...args], { stdout, stderr, openContainer });

  const lines = stdout.text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  return {
    code,
    stdout: stdout.text,
    stderr: stderr.text,
    lines,
    last: lines[lines.length - 1],
  };
}
