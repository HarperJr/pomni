import { join } from 'node:path';
import type { CapabilityMap, DetectionResult, FsProbe, StackDetector } from '@pomni/core';

export const goDetector: StackDetector = {
  name: 'go',

  async detect(dir: string, fs: FsProbe): Promise<DetectionResult | null> {
    const mod = await fs.readText(join(dir, 'go.mod'));
    if (mod === null) return null;

    const version = /^go\s+([\d.]+)/m.exec(mod)?.[1];
    return {
      adapter: 'go',
      detected: version ? [`go@${version}`] : ['go'],
      capabilities: {
        build: cap('go build ./...'),
        test: cap('go test ./...'),
        lint: cap('go vet ./...'),
      },
    };
  },
};

export const rustDetector: StackDetector = {
  name: 'rust',

  async detect(dir: string, fs: FsProbe): Promise<DetectionResult | null> {
    const manifest = await fs.readText(join(dir, 'Cargo.toml'));
    if (manifest === null) return null;

    const detected = ['cargo'];
    if (/\[workspace\]/.test(manifest)) detected.push('workspace');

    return {
      adapter: 'rust',
      detected,
      capabilities: {
        build: cap('cargo build', { timeoutMs: 900_000 }),
        test: cap('cargo test'),
        lint: cap('cargo clippy -- -D warnings'),
        typecheck: cap('cargo check'),
      },
    };
  },
};

/**
 * Last resort: a Makefile tells us what the author considered the entry points. Only
 * targets whose names Pomni already understands are mapped.
 */
export const makeDetector: StackDetector = {
  name: 'make',

  async detect(dir: string, fs: FsProbe): Promise<DetectionResult | null> {
    const makefile = await fs.readText(join(dir, 'Makefile'));
    if (makefile === null) return null;

    const targets = new Set(
      [...makefile.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)].map((match) => match[1] as string),
    );

    const capabilities: CapabilityMap = {};
    for (const name of ['install', 'build', 'test', 'lint', 'typecheck', 'e2e'] as const) {
      if (targets.has(name)) capabilities[name] = cap(`make ${name}`);
    }
    if (Object.keys(capabilities).length === 0) return null;

    return { adapter: 'make', detected: ['make'], capabilities };
  },
};

function cap(cmd: string, extra: Record<string, unknown> = {}) {
  return { cmd, origin: 'detected' as const, ...extra };
}
