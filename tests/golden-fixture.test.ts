import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify, parseFixtureIndex } from '@kyneloom/contracts';
import { assembleFixtureBundle, GOLDEN_ACTORS } from '@kyneloom/match-core';

/**
 * KYN-03 acceptance: the COMMITTED golden fixture loads through the public
 * interfaces exactly as the future renderer's server will — files from disk,
 * JSONL samples, contract validation, checksums verified — and regenerating
 * with the golden seed reproduces it byte-identically.
 */

const fixtureDir = path.resolve(import.meta.dirname, 'fixtures', 'generated', 'synthetic-derby-01');

function loadCommitted() {
  const events = JSON.parse(
    readFileSync(path.join(fixtureDir, 'events.json'), 'utf-8'),
  ) as unknown[];
  const tracking = readFileSync(path.join(fixtureDir, 'tracking.jsonl'), 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  const metadata = JSON.parse(readFileSync(path.join(fixtureDir, 'metadata.json'), 'utf-8')) as {
    integrity?: Record<string, string>;
  } & Record<string, unknown>;
  return { events, tracking, metadata };
}

describe('committed golden fixture', () => {
  const committed = loadCommitted();

  it('loads and validates through the public fixture interface', () => {
    const result = assembleFixtureBundle({
      events: committed.events,
      tracking: committed.tracking,
      metadata: committed.metadata,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.events).toHaveLength(11);
    expect(result.bundle.tracking).toHaveLength(5129);
  });

  it('passes its own sha256 integrity checksums', () => {
    const integrity = committed.metadata['integrity'] as Record<string, string> | undefined;
    expect(integrity).toBeDefined();
    const sha = (value: unknown) =>
      `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`;
    expect(sha(committed.events)).toBe(integrity!['events']);
    expect(sha(committed.tracking)).toBe(integrity!['tracking']);
  });

  it('registers in the fixture index consumed by the web seam', () => {
    const index = parseFixtureIndex(
      JSON.parse(
        readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'index.json'), 'utf-8'),
      ),
    );
    expect(index.ok).toBe(true);
    if (!index.ok) return;
    const entry = index.index.fixtures.find((f) => f.id === 'synthetic-derby-01');
    expect(entry).toBeDefined();
    expect(entry!.file).toBe('generated/synthetic-derby-01/metadata.json');
    expect(entry!.seed).toBe(24017);
  });

  it(
    'is byte-identical to regeneration with the golden seed (deterministic output comparison)',
    { timeout: 20_000 },
    async () => {
      const { generateMatchFixture } = await import('@kyneloom/match-core');
      const regenerated = generateMatchFixture({ seed: 24017 });
      expect(canonicalJsonStringify(regenerated.events)).toBe(
        canonicalJsonStringify(committed.events),
      );
      expect(canonicalJsonStringify(regenerated.tracking)).toBe(
        canonicalJsonStringify(committed.tracking),
      );
    },
  );

  it('animates the golden sequence: 22 players plus ball with monotone time', () => {
    const result = assembleFixtureBundle({
      events: committed.events,
      tracking: committed.tracking,
      metadata: committed.metadata,
    });
    if (!result.ok) throw new Error('must assemble');
    const { bundle } = result;
    const times = bundle.frameTimesMs;
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
    const checkpoint = bundle.frameAt(bundle.metadata.goldenCheckpointMs);
    expect(checkpoint.size).toBe(23);
    // The striker's track exists across the whole golden window.
    const striker = bundle.entityTrack(GOLDEN_ACTORS.scorer);
    expect(striker.length).toBeGreaterThan(130);
  });
});
