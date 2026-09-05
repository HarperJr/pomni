import { join } from 'node:path';
import type { CapabilityMap, DetectionResult, FsProbe, StackDetector } from '@pomni/core';

type PythonManager = 'uv' | 'poetry' | 'pipenv' | 'pip';

const FRAMEWORKS: Array<[RegExp, string]> = [
  [/\bfastapi\b/i, 'fastapi'],
  [/\bdjango\b/i, 'django'],
  [/\bflask\b/i, 'flask'],
  [/\blitestar\b/i, 'litestar'],
  [/\bstarlette\b/i, 'starlette'],
];

export const pythonDetector: StackDetector = {
  name: 'python',

  async detect(dir: string, fs: FsProbe): Promise<DetectionResult | null> {
    const names = await fs.listNames(dir);
    const hasPyproject = names.includes('pyproject.toml');
    const hasRequirements = names.includes('requirements.txt');
    const hasSetup = names.includes('setup.py') || names.includes('setup.cfg');
    if (!hasPyproject && !hasRequirements && !hasSetup) return null;

    const manifest = [
      hasPyproject ? await fs.readText(join(dir, 'pyproject.toml')) : null,
      hasRequirements ? await fs.readText(join(dir, 'requirements.txt')) : null,
    ]
      .filter(Boolean)
      .join('\n');

    const pm = detectManager(names);
    const detected: string[] = [pm];

    for (const [pattern, label] of FRAMEWORKS) {
      if (pattern.test(manifest)) {
        detected.push(label);
        break;
      }
    }

    const hasPytest = /\bpytest\b/i.test(manifest) || names.includes('pytest.ini');
    const hasRuff = /\bruff\b/i.test(manifest) || names.includes('ruff.toml');
    const hasMypy = /\bmypy\b/i.test(manifest);
    if (hasPytest) detected.push('pytest');
    if (hasRuff) detected.push('ruff');
    if (hasMypy) detected.push('mypy');

    const prefix = pm === 'uv' ? 'uv run ' : pm === 'poetry' ? 'poetry run ' : pm === 'pipenv' ? 'pipenv run ' : '';

    const capabilities: CapabilityMap = {
      install: cap(installCommand(pm, hasRequirements)),
    };
    if (hasPytest) capabilities.test = cap(`${prefix}pytest`);
    if (hasRuff) capabilities.lint = cap(`${prefix}ruff check .`);
    if (hasMypy) capabilities.typecheck = cap(`${prefix}mypy .`);
    if (/\buvicorn\b/i.test(manifest)) {
      capabilities.dev = cap(`${prefix}uvicorn app.main:app --reload`, {
        background: true,
        readyLog: 'Application startup complete',
        port: 8000,
      });
    }

    return { adapter: 'python', detected, capabilities };
  },
};

function detectManager(names: string[]): PythonManager {
  if (names.includes('uv.lock')) return 'uv';
  if (names.includes('poetry.lock')) return 'poetry';
  if (names.includes('Pipfile')) return 'pipenv';
  return 'pip';
}

function installCommand(pm: PythonManager, hasRequirements: boolean): string {
  switch (pm) {
    case 'uv':
      return 'uv sync';
    case 'poetry':
      return 'poetry install';
    case 'pipenv':
      return 'pipenv install --dev';
    default:
      return hasRequirements ? 'pip install -r requirements.txt' : 'pip install -e .';
  }
}

function cap(cmd: string, extra: Record<string, unknown> = {}) {
  return { cmd, origin: 'detected' as const, ...extra };
}
