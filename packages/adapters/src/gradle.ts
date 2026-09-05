import { join } from 'node:path';
import type { CapabilityMap, DetectionResult, FsProbe, StackDetector } from '@pomni/core';

/** Gradle builds are slow enough that the ten-minute default would fail honest work. */
const GRADLE_TIMEOUT_MS = 40 * 60 * 1000;

interface PluginMarker {
  /** Matched against the build scripts and the version catalogue together. */
  pattern: RegExp;
  label: string;
}

const MARKERS: PluginMarker[] = [
  { pattern: /kotlin[.-]?multiplatform|kotlinMultiplatform/i, label: 'kotlin-multiplatform' },
  { pattern: /androidApplication|com\.android\.application/i, label: 'android' },
  { pattern: /androidLibrary|com\.android\.library/i, label: 'android-library' },
  { pattern: /kotlin[.-]?cocoapods|cocoapods/i, label: 'ios' },
  { pattern: /jetbrainsCompose|compose[.-]?compiler|org\.jetbrains\.compose/i, label: 'compose' },
  { pattern: /kotlin[.-]?jvm|jetbrains\.kotlin\.jvm/i, label: 'kotlin-jvm' },
  { pattern: /\bspringframework\b|spring-boot/i, label: 'spring' },
  { pattern: /\bksp\b/i, label: 'ksp' },
  { pattern: /androidx[.-]?room|\broom\b/i, label: 'room' },
  { pattern: /\bhilt\b|dagger/i, label: 'hilt' },
  { pattern: /\bkoin\b/i, label: 'koin' },
];

/**
 * Gradle, including Kotlin Multiplatform and Android.
 *
 * Gradle projects declare their tooling rather than their commands, so detection reads the
 * build scripts and the version catalogue for plugins and maps those to tasks. The wrapper
 * is preferred over a system `gradle` — it is the whole point of committing it.
 */
export const gradleDetector: StackDetector = {
  name: 'gradle',

  async detect(dir: string, fs: FsProbe): Promise<DetectionResult | null> {
    const names = await fs.listNames(dir);

    const hasWrapper = names.includes('gradlew') || names.includes('gradlew.bat');
    const buildScript = ['build.gradle.kts', 'build.gradle'].find((name) => names.includes(name));
    const settings = ['settings.gradle.kts', 'settings.gradle'].find((name) => names.includes(name));
    if (!hasWrapper && !buildScript && !settings) return null;

    // Read everything that might name a plugin, and match against the lot at once — a plugin
    // alias lives in the build script, its coordinates in the version catalogue.
    const sources = await Promise.all(
      [buildScript, settings, 'gradle/libs.versions.toml', 'gradle.properties']
        .filter((name): name is string => Boolean(name))
        .map((name) => fs.readText(join(dir, name))),
    );
    const manifest = sources.filter(Boolean).join('\n');

    const detected: string[] = [gradleLabel(await wrapperVersion(dir, fs))];
    for (const marker of MARKERS) {
      if (marker.pattern.test(manifest)) detected.push(marker.label);
    }

    const hasKtlint = /ktlint/i.test(manifest);
    const hasDetekt = /detekt/i.test(manifest);
    const hasSpotless = /spotless/i.test(manifest);
    if (hasKtlint) detected.push('ktlint');
    if (hasDetekt) detected.push('detekt');
    if (hasSpotless) detected.push('spotless');

    const gw = wrapperCommand(hasWrapper);
    const run = (task: string) => `${gw} ${task} --console=plain`;

    const capabilities: CapabilityMap = {
      // `assemble` builds without running tests, so build and test stay separable — a gate
      // that runs both should not compile everything twice.
      build: cap(run('assemble'), { timeoutMs: GRADLE_TIMEOUT_MS }),
      test: cap(run('test'), { timeoutMs: GRADLE_TIMEOUT_MS }),
    };

    // Prefer the linters the project actually configured over Android's generic `lint`.
    const linters = [hasKtlint ? 'ktlintCheck' : null, hasDetekt ? 'detekt' : null].filter(
      (task): task is string => task !== null,
    );
    if (linters.length > 0) {
      capabilities.lint = cap(run(linters.join(' ')), { timeoutMs: GRADLE_TIMEOUT_MS });
    } else if (detected.includes('android') || detected.includes('android-library')) {
      capabilities.lint = cap(run('lint'), { timeoutMs: GRADLE_TIMEOUT_MS });
    }

    if (hasSpotless) {
      capabilities.format = cap(run('spotlessApply'), { timeoutMs: GRADLE_TIMEOUT_MS });
    }

    // No `typecheck`: Kotlin is type-checked by compiling, which `build` already does.
    // Declaring one would mean compiling twice for no extra signal.

    return { adapter: 'gradle', detected, capabilities };
  },
};

/**
 * `./gradlew` is not runnable by cmd.exe, and a bare `gradlew` is not on PATH under sh.
 * Detection runs on the machine that will run the command, and `pomni repo sync` re-derives
 * it, so choosing per-platform here is safe — a hand-edited command is never overwritten.
 */
function wrapperCommand(hasWrapper: boolean): string {
  if (!hasWrapper) return 'gradle';
  return process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
}

async function wrapperVersion(dir: string, fs: FsProbe): Promise<string | null> {
  const properties = await fs.readText(join(dir, 'gradle', 'wrapper', 'gradle-wrapper.properties'));
  if (!properties) return null;
  return /gradle-([\d.]+)-(?:bin|all)\.zip/.exec(properties)?.[1] ?? null;
}

function gradleLabel(version: string | null): string {
  if (!version) return 'gradle';
  const [major, minor] = version.split('.');
  return minor ? `gradle@${major}.${minor}` : `gradle@${major}`;
}

function cap(cmd: string, extra: Record<string, unknown> = {}) {
  return { cmd, origin: 'detected' as const, ...extra };
}
