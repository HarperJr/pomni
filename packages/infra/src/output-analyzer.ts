import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutputAnalyzer, TestResult } from '@pomni/core';

/**
 * Turns raw command output into the one line a human wants on a list screen.
 *
 * Deliberately pattern-based rather than reporter-based: asking every repo to emit junit
 * before Pomni can say "12 passed" would make the feature useless on day one. Structured
 * per-test rows are the opt-in path, via `parser: junit` plus `reportPath`.
 */
export class DefaultOutputAnalyzer implements OutputAnalyzer {
  summarize(
    capability: string,
    cmd: string,
    output: string,
    exitCode: number | null,
  ): string | null {
    const text = stripAnsi(output);

    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(text);
      if (match) return pattern.format(match);
    }

    // Nothing recognised: fall back to the last non-empty line, which is usually the error.
    if (exitCode !== 0) {
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const last = lines[lines.length - 1];
      if (last) return truncate(last, 160);
    }

    return exitCode === 0 ? null : `exited with code ${exitCode}`;
  }

  async testResults(
    _capability: string,
    cwd: string,
    reportPath: string | undefined,
  ): Promise<TestResult[]> {
    if (!reportPath) return [];
    try {
      const xml = await readFile(join(cwd, reportPath), 'utf8');
      return parseJunit(xml);
    } catch {
      return [];
    }
  }
}

interface Pattern {
  regex: RegExp;
  format: (match: RegExpExecArray) => string;
}

/** Ordered: the most specific and most trustworthy first. */
const PATTERNS: Pattern[] = [
  // vitest: "Tests  1 failed | 11 passed (12)"
  {
    regex: /^\s*Tests\s+(?:(\d+) failed \|\s*)?(\d+) passed(?:\s*\|\s*(\d+) skipped)?\s*\((\d+)\)/m,
    format: (m) => countLine(Number(m[2]), Number(m[1] ?? 0), Number(m[3] ?? 0)),
  },
  // vitest, all failing: "Tests  3 failed (3)"
  {
    regex: /^\s*Tests\s+(\d+) failed\s*\((\d+)\)/m,
    format: (m) => countLine(Number(m[2]) - Number(m[1]), Number(m[1]), 0),
  },
  // jest: "Tests:       1 failed, 11 passed, 12 total"
  {
    regex: /^Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed,\s*(\d+) total/m,
    format: (m) => countLine(Number(m[3]), Number(m[1] ?? 0), Number(m[2] ?? 0)),
  },
  // pytest: "===== 1 failed, 5 passed, 2 skipped in 0.42s ====="
  {
    regex: /=+\s*(?:(\d+) failed,?\s*)?(?:(\d+) passed,?\s*)?(?:(\d+) skipped,?\s*)?.*in [\d.]+s/m,
    format: (m) => countLine(Number(m[2] ?? 0), Number(m[1] ?? 0), Number(m[3] ?? 0)),
  },
  // cargo: "test result: FAILED. 10 passed; 2 failed; 1 ignored"
  {
    regex: /test result:\s*\w+\.\s*(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/m,
    format: (m) => countLine(Number(m[1]), Number(m[2]), Number(m[3])),
  },
  // tsc: "Found 3 errors in 2 files."
  {
    regex: /Found (\d+) errors? in (\d+) files?/m,
    format: (m) => `${m[1]} type error${m[1] === '1' ? '' : 's'} in ${m[2]} file(s)`,
  },
  { regex: /^\s*Found 0 errors\./m, format: () => 'no type errors' },
  // eslint: "✖ 7 problems (3 errors, 4 warnings)"
  {
    regex: /[✖x]\s*(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/m,
    format: (m) => `${m[2]} error(s), ${m[3]} warning(s)`,
  },
  // go test
  { regex: /^FAIL\s+\S+/m, format: () => 'go test failed' },
  { regex: /^ok\s+\S+\s+[\d.]+s/m, format: () => 'go test ok' },
  // gradle: the task that failed is what you want to see, not the summary line
  {
    regex: /^>\s*Task\s+(\S+)\s+FAILED/m,
    format: (m) => `task ${m[1]} failed`,
  },
  {
    regex: /^(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/m,
    format: (m) => `${m[2]} error(s), ${m[3]} warning(s)`,
  },
  {
    regex: /detekt finished with (\d+) weighted issues/m,
    format: (m) => `detekt: ${m[1]} weighted issues`,
  },
  { regex: /^BUILD SUCCESSFUL in (.+)$/m, format: (m) => `build successful in ${m[1]?.trim()}` },
  { regex: /^BUILD FAILED in (.+)$/m, format: (m) => `build failed after ${m[1]?.trim()}` },
  // next / vite build
  { regex: /✓ Compiled successfully/m, format: () => 'build succeeded' },
  {
    regex: /built in ([\d.]+m?s)/m,
    format: (m) => `built in ${m[1]}`,
  },
];

function countLine(passed: number, failed: number, skipped: number): string {
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  parts.push(`${passed} passed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(', ');
}

/**
 * Minimal JUnit XML reader. Regex rather than a parser dependency: the schema in question is
 * a flat list of `testcase` elements, and every runner emits it the same shallow way.
 */
export function parseJunit(xml: string): TestResult[] {
  const results: TestResult[] = [];
  const caseRegex = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;

  let match: RegExpExecArray | null;
  while ((match = caseRegex.exec(xml)) !== null) {
    const attributes = match[1] ?? '';
    const body = match[3] ?? '';

    const name = attribute(attributes, 'name') ?? 'unknown';
    const suite = attribute(attributes, 'classname') ?? attribute(attributes, 'file') ?? '';
    const time = attribute(attributes, 'time');

    let status: TestResult['status'] = 'passed';
    let message: string | null = null;

    const failure = /<(failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (failure) {
      status = 'failed';
      const detail = decode(failure[3] ?? '').trim().slice(0, 500);
      message = attribute(failure[2] ?? '', 'message') ?? (detail.length > 0 ? detail : null);
    } else if (/<skipped\b/.test(body)) {
      status = 'skipped';
    }

    results.push({
      suite,
      name,
      status,
      durationMs: time ? Math.round(Number(time) * 1000) : null,
      message,
    });
  }

  return results;
}

function attribute(attributes: string, name: string): string | null {
  // The boundary matters: without it, `name=` also matches inside `classname=`.
  const match = new RegExp('\\b' + name + '="([^"]*)"').exec(attributes);
  return match ? decode(match[1] ?? '') : null;
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
