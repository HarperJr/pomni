import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Git token auth without ever writing the token down.
 *
 * The obvious approaches are both wrong: putting the token in the clone URL persists it in
 * `.git/config` in plaintext, and `-c http.extraHeader=...` puts it in the process command
 * line where any other process can read it. `GIT_ASKPASS` keeps the secret in the child's
 * environment and out of both.
 *
 * Git executes `$GIT_ASKPASS <prompt>`, so it needs a real executable — hence the shim,
 * which is written once per temp dir and contains no secret of its own.
 */

const SCRIPT_BODY = `#!/usr/bin/env node
// Written by Pomni. Answers git credential prompts from the environment.
// Contains no secret: the values arrive via POMNI_ASKPASS_USER / POMNI_ASKPASS_SECRET.
const prompt = String(process.argv[2] || '').toLowerCase();
const answer = prompt.includes('username')
  ? process.env.POMNI_ASKPASS_USER || ''
  : process.env.POMNI_ASKPASS_SECRET || '';
process.stdout.write(answer + '\\n');
`;

let cached: string | null = null;

/** Path to the askpass shim, creating it on first use. */
export async function ensureAskpass(): Promise<string> {
  if (cached) return cached;

  const dir = join(tmpdir(), 'pomni-askpass');
  await mkdir(dir, { recursive: true });

  const scriptPath = join(dir, 'askpass.mjs');
  await writeFile(scriptPath, SCRIPT_BODY, 'utf8');

  const shimPath = join(dir, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
  const shim =
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`;

  await writeFile(shimPath, shim, 'utf8');
  if (process.platform !== 'win32') await chmod(shimPath, 0o755);

  cached = shimPath;
  return shimPath;
}

/** Reset the cache. Tests only. */
export function resetAskpassCache(): void {
  cached = null;
}
