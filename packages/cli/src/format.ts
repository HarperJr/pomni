import type { RepoStatus, ResolvedRepo } from '@pomni/core';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (text: string) =>
  useColor ? `[${code}m${text}[0m` : text;

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
};

export function statusLabel(status: RepoStatus): string {
  switch (status) {
    case 'ready':
      return style.green('ready');
    case 'linked':
      return style.green('linked');
    case 'cloning':
      return style.yellow('cloning');
    case 'error':
      return style.red('error');
    case 'missing':
      return style.red('missing');
  }
}

/** Left-aligned columns sized to content. Header is optional. */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return '';

  const columns = Math.max(...all.map((row) => row.length));
  const widths: number[] = [];
  for (let i = 0; i < columns; i += 1) {
    widths[i] = Math.max(...all.map((row) => visibleLength(row[i] ?? '')));
  }

  const render = (row: string[]) =>
    row
      .map((cell, i) => pad(cell ?? '', widths[i] ?? 0))
      .join('  ')
      .trimEnd();

  const lines: string[] = [];
  if (header) lines.push(style.dim(render(header)));
  for (const row of rows) lines.push(render(row));
  return lines.join('\n');
}

export function repoRow(repo: ResolvedRepo): string[] {
  const stack = repo.stack?.detected.slice(0, 3).join(', ') ?? style.dim('—');
  const source =
    repo.source.kind === 'local'
      ? repo.source.path
      : repo.source.ref
        ? `${repo.source.url} @ ${repo.source.ref}`
        : repo.source.url;

  return [
    style.bold(repo.id),
    repo.role,
    statusLabel(repo.status),
    stack,
    repo.source.kind === 'local' ? style.dim('local') : style.dim('git'),
    source,
  ];
}

export function describeCapabilities(capabilities: Record<string, { cmd: string }>): string {
  const names = Object.keys(capabilities).sort();
  if (names.length === 0) return style.dim('none detected');
  return names.map((name) => `${name}: ${style.dim(capabilities[name]?.cmd ?? '')}`).join('\n');
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}
