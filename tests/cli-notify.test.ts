import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './harness.js';
import { runCli } from './cli.js';

/**
 * POMN-75: `pomni notify test` — sends a sample notification to every configured channel so
 * setup can be checked without waiting for a real red gate.
 *
 * Nothing under test exists yet. `packages/cli/src/index.ts` has no `notify` command, and the
 * whole harness fails to load before this file's tests even run, because `tests/harness.ts`
 * imports `NotificationService` and `WebhookPort` from files POMN-75 has not written
 * (`packages/core/src/app/notification-service.ts`, `packages/core/src/ports/notify.ts`) —
 * see `tests/notify.test.ts` for the detail. The shape asserted below — `container.notifications
 * .sendTest()`, `out().fail(1)` with nothing configured, mirroring `cred test <id>`'s own
 * `out().fail(1)` / `out().report` pair in `packages/cli/src/index.ts` — is inferred from that
 * existing command and from the acceptance criterion's own wording, and is a proposal for the
 * CLI author to confirm, not settled fact.
 */

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
  await harness.projects.create({ name: 'Acme', id: 'acme' });
});

afterEach(async () => {
  await harness.cleanup();
});

describe('pomni notify test', () => {
  it('sends a sample to every configured channel and exits 0', async () => {
    await harness.workspace.setConfig({
      notify: {
        desktop: true,
        webhook: { url: 'http://hook.test/x', credential: null },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await runCli(harness, ['--json', 'notify', 'test']);

    expect(result.code).toBe(0);
    const body = result.last as { results: Array<{ ok: boolean }> };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((entry) => entry.ok)).toBe(true);
    expect(harness.webhook.posted).toHaveLength(1);
    expect(harness.desktop.notified).toHaveLength(1);
  });

  it('exits 1 with nothing configured', async () => {
    const result = await runCli(harness, ['--json', 'notify', 'test']);

    expect(result.code).toBe(1);
    const body = result.last as { results: Array<{ ok: boolean }> };
    expect(body.results).toEqual([]);
    expect(harness.webhook.posted).toHaveLength(0);
    expect(harness.desktop.notified).toHaveLength(0);
  });
});
