import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { formatMatchClock, loadGoldenMatch } from './match-fixture';

/**
 * KYN-05 / PR #36 review — the server-side seam the cinematic surfaces read
 * match facts through.
 *
 * Valid-fixture behavior is pinned (committed golden fixture projects through
 * the reducer with derived checkpoint state), and every malformed-input mode
 * (events.json, tracking.jsonl, metadata.json, unreadable or external
 * directories) must degrade to a truthful {ok:false} status WITHOUT throwing
 * and WITHOUT leaking filesystem paths into the user-visible message.
 * Detailed diagnostics are asserted to reach the server log instead.
 */

const CANONICAL_SEED_DIR = 'synthetic-derby-01';
const COMMITTED_FIXTURE_DIR = path.resolve(
  process.cwd(),
  'tests/fixtures/generated',
  CANONICAL_SEED_DIR,
);

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function withFixtureDir(
  envValue: string | undefined,
  files: Record<string, string> | null,
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env['KYNELOOM_FIXTURES_DIR'];
  if (envValue === undefined) delete process.env['KYNELOOM_FIXTURES_DIR'];
  else process.env['KYNELOOM_FIXTURES_DIR'] = envValue;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env['KYNELOOM_FIXTURES_DIR'];
    else process.env['KYNELOOM_FIXTURES_DIR'] = previous;
  }
}

/** Create a fixture root OUTSIDE the repo; `null` files = directory absent. */
async function makeExternalFixtureRoot(files: Record<string, string> | null): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kyneloom-fixture-test-'));
  tempRoots.push(root);
  if (files !== null) {
    const dir = path.join(root, 'generated', CANONICAL_SEED_DIR);
    await mkdir(dir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, name), contents, 'utf-8');
    }
  }
  return root;
}

function fixtureFailureLogger(): MockInstance {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function expectLoggedDirectory(spy: MockInstance, expectedDir: string): void {
  const logged = spy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  expect(logged).toContain(expectedDir);
}

function expectNoPathLeakage(message: string, ...forbidden: string[]): void {
  expect(message).not.toMatch(/[\\/]/);
  expect(message).not.toMatch(/[A-Za-z]:\\/);
  for (const fragment of forbidden) {
    expect(message).not.toContain(fragment);
  }
}

let committedFiles: Record<string, string> | null = null;

async function committedFixtureFiles(): Promise<Record<string, string>> {
  committedFiles ??= {
    'events.json': await readFile(path.join(COMMITTED_FIXTURE_DIR, 'events.json'), 'utf-8'),
    'tracking.jsonl': await readFile(path.join(COMMITTED_FIXTURE_DIR, 'tracking.jsonl'), 'utf-8'),
    'metadata.json': await readFile(path.join(COMMITTED_FIXTURE_DIR, 'metadata.json'), 'utf-8'),
  };
  return committedFiles;
}

describe('formatMatchClock', () => {
  it('formats absolute match ms as a zero-padded MM:SS broadcast clock', () => {
    expect(formatMatchClock(0)).toBe('00:00');
    expect(formatMatchClock(59_999)).toBe('00:59');
    expect(formatMatchClock(4_722_100)).toBe('78:42');
    expect(formatMatchClock(3_600_000)).toBe('60:00');
  });
});

describe('loadGoldenMatch (valid committed fixture)', () => {
  it('projects the committed golden fixture through the authoritative reducer', async () => {
    const golden = await loadGoldenMatch();
    expect(golden.ok).toBe(true);
    if (!golden.ok) return;

    expect(golden.data.matchId).toBe('synthetic-derby-01');
    expect(golden.data.seed).toBe(24017);
    expect(golden.data.generatorVersion).toBe('fixture-engine-v1');
    expect(golden.data.eventCount).toBe(11);
    expect(golden.data.sampleCount).toBe(5129);
    expect(golden.data.goldenWindowMs).toEqual([4_717_000, 4_731_000]);
    expect(golden.data.checkpointMs).toBe(4_722_100);

    // Checkpoint state is reducer-derived at request time, not stored JSON.
    // Possession is source-verified-only: at the checkpoint no possession
    // event identifies a carrier (proximity never grants possession); the
    // measured possession starts later in the window.
    const state = golden.data.stateAtCheckpoint;
    expect(state.period).toBe('second_half');
    expect(state.players).toHaveLength(22);
    expect(state.ball.possessorEntityId).toBeNull();
    expect(golden.data.projected.matchStateAt(4_726_300).ball.possessorEntityId).toBe('home-09');

    // Final score comes only from accepted goal events (0-1 away, then 1-1).
    expect(golden.data.finalScore).toEqual({ home: 1, away: 1 });
    expect(golden.data.projected.acceptedEvents.length).toBeGreaterThan(0);
  });

  it('honors an external fixtures directory override that holds valid data', async () => {
    await withFixtureDir(path.resolve(process.cwd(), 'tests/fixtures'), null, async () => {
      const golden = await loadGoldenMatch();
      expect(golden.ok).toBe(true);
      if (!golden.ok) return;
      expect(golden.data.matchId).toBe('synthetic-derby-01');
      expect(golden.data.seed).toBe(24017);
      expect(golden.data.finalScore).toEqual({ home: 1, away: 1 });
    });
  });
});

describe('loadGoldenMatch (malformed fixtures never throw, never leak paths)', () => {
  it('returns invalid — not a crash — for malformed events.json', async () => {
    const base = await committedFixtureFiles();
    const root = await makeExternalFixtureRoot({ ...base, 'events.json': '{"nope": ' });
    await withFixtureDir(root, null, async () => {
      const spy = fixtureFailureLogger();
      const golden = await loadGoldenMatch();
      expect(golden.ok).toBe(false);
      if (golden.ok) return;
      expect(golden.reason).toBe('invalid');
      expect(golden.message).toContain('events.json');
      expectNoPathLeakage(golden.message, root, tmpdir());
      expectLoggedDirectory(spy, path.join(root, 'generated', CANONICAL_SEED_DIR));
    });
  });

  it('returns invalid for a malformed tracking.jsonl line, naming the line in the log only', async () => {
    const base = await committedFixtureFiles();
    const lines = (base['tracking.jsonl'] ?? '').split('\n');
    const corrupted = [...lines];
    corrupted.splice(3, 1, '{ this line is not json');
    const root = await makeExternalFixtureRoot({
      ...base,
      'tracking.jsonl': corrupted.join('\n'),
    });
    await withFixtureDir(root, null, async () => {
      const spy = fixtureFailureLogger();
      const golden = await loadGoldenMatch();
      expect(golden.ok).toBe(false);
      if (golden.ok) return;
      expect(golden.reason).toBe('invalid');
      expect(golden.message).toContain('tracking.jsonl');
      expectNoPathLeakage(golden.message, root, tmpdir());
      const logged = spy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
      expect(logged).toContain('line 4');
      expectLoggedDirectory(spy, path.join(root, 'generated', CANONICAL_SEED_DIR));
    });
  });

  it('returns invalid for metadata.json that is not JSON at all', async () => {
    const base = await committedFixtureFiles();
    const root = await makeExternalFixtureRoot({ ...base, 'metadata.json': 'not json' });
    await withFixtureDir(root, null, async () => {
      fixtureFailureLogger();
      const golden = await loadGoldenMatch();
      expect(golden.ok).toBe(false);
      if (golden.ok) return;
      expect(golden.reason).toBe('invalid');
      expect(golden.message).toContain('metadata.json');
      expectNoPathLeakage(golden.message, root, tmpdir());
    });
  });

  it('returns invalid for structurally invalid metadata (missing sampling) instead of dereferencing it', async () => {
    const base = await committedFixtureFiles();
    const root = await makeExternalFixtureRoot({
      ...base,
      'metadata.json': JSON.stringify({
        matchId: 'synthetic-derby-01',
        seed: 24017,
        narrative: 'The Invisible Assist',
        generatorVersion: 'fixture-engine-v1',
        goldenCheckpointMs: 4_722_100,
        scoreTimeline: [],
      }),
    });
    await withFixtureDir(root, null, async () => {
      const spy = fixtureFailureLogger();
      const golden = await loadGoldenMatch();
      expect(golden.ok).toBe(false);
      if (golden.ok) return;
      expect(golden.reason).toBe('invalid');
      expect(golden.message).toContain('metadata.json');
      expectNoPathLeakage(golden.message, root, tmpdir());
      const logged = spy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
      expect(logged).toContain('sampling');
    });
  });

  it('returns invalid when the reducer accepts zero events (valid JSON, empty array)', async () => {
    const base = await committedFixtureFiles();
    const root = await makeExternalFixtureRoot({ ...base, 'events.json': '[]' });
    await withFixtureDir(root, null, async () => {
      fixtureFailureLogger();
      const golden = await loadGoldenMatch();
      expect(golden.ok).toBe(false);
      if (golden.ok) return;
      expect(golden.reason).toBe('invalid');
      expect(golden.message).toContain('zero events');
      expectNoPathLeakage(golden.message, root, tmpdir());
    });
  });
});

describe('loadGoldenMatch (unavailable fixtures)', () => {
  it('degrades truthfully when the fixtures directory is missing entirely', async () => {
    const root = await makeExternalFixtureRoot(null);
    await withFixtureDir(root, null, async () => {
      const spy = fixtureFailureLogger();
      const golden = await loadGoldenMatch();
      expect(golden.ok).toBe(false);
      if (golden.ok) return;
      expect(golden.reason).toBe('unavailable');
      expect(golden.message).toMatch(/unavailable/i);
      expectNoPathLeakage(golden.message, root, tmpdir());
      expectLoggedDirectory(spy, path.join(root, 'generated', CANONICAL_SEED_DIR));
    });
  });

  it('degrades truthfully when a fixture file is missing while others exist', async () => {
    const base = await committedFixtureFiles();
    const partial = { ...base } as Record<string, string>;
    delete partial['metadata.json'];
    const root = await makeExternalFixtureRoot(partial);
    await withFixtureDir(root, null, async () => {
      fixtureFailureLogger();
      const golden = await loadGoldenMatch();
      expect(golden.ok).toBe(false);
      if (golden.ok) return;
      expect(golden.reason).toBe('unavailable');
      expectNoPathLeakage(golden.message, root, tmpdir());
    });
  });

  it('degrades truthfully when the env override points outside the workspace', async () => {
    const spy = fixtureFailureLogger();
    await withFixtureDir('Q:/kyneloom-missing-fixtures', null, async () => {
      const golden = await loadGoldenMatch();
      expect(golden.ok).toBe(false);
      if (golden.ok) return;
      expect(golden.reason).toBe('unavailable');
      expectNoPathLeakage(golden.message, 'Q:', 'kyneloom-missing-fixtures');
      expectLoggedDirectory(
        spy,
        path.join('Q:\\kyneloom-missing-fixtures', 'generated', CANONICAL_SEED_DIR),
      );
    });
  });
});
