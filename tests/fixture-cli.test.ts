import { readFileSync } from 'node:fs';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CANONICAL_GOLDEN_SEED,
  resolveGenerationPlan,
  runGeneration,
} from '../scripts/generate-fixture';

/**
 * Review fix 3: alternate-seed generation must never overwrite or re-register
 * the canonical seed-24017 golden fixture. Verified end to end — the golden
 * files and the fixture index are snapshotted, an alternate seed is actually
 * generated, and byte-identity is asserted afterwards.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const goldenDir = path.join(repoRoot, 'tests', 'fixtures', 'generated', 'synthetic-derby-01');
const indexPath = path.join(repoRoot, 'tests', 'fixtures', 'index.json');

function readGolden(): Record<string, string> {
  const names = ['events.json', 'tracking.jsonl', 'metadata.json', 'README.md'];
  return Object.fromEntries(names.map((n) => [n, readFileSync(path.join(goldenDir, n), 'utf-8')]));
}

afterAll(() => {
  rmSync(path.join(repoRoot, '.fixture-scratch'), { recursive: true, force: true });
});

describe('resolveGenerationPlan', () => {
  it('registers only the canonical seed at its default committed location', () => {
    const plan = resolveGenerationPlan({ seed: CANONICAL_GOLDEN_SEED });
    expect(plan.isCanonical).toBe(true);
    expect(plan.registerInIndex).toBe(true);
    expect(plan.outDir).toBe(
      path.join(repoRoot, 'tests', 'fixtures', 'generated', 'synthetic-derby-01'),
    );
  });

  it('isolates alternate seeds into git-ignored scratch without registration', () => {
    const plan = resolveGenerationPlan({ seed: 4242 });
    expect(plan.isCanonical).toBe(false);
    expect(plan.registerInIndex).toBe(false);
    expect(plan.outDir).toBe(path.join(repoRoot, '.fixture-scratch', 'seed-4242'));
  });

  it('honors --out for both, with registration still canonical-only', () => {
    const custom = resolveGenerationPlan({ seed: CANONICAL_GOLDEN_SEED, out: 'somewhere/else' });
    expect(custom.outDir).toBe(path.resolve(repoRoot, 'somewhere/else'));
    expect(custom.registerInIndex).toBe(false); // index entry would point nowhere
    const altCustom = resolveGenerationPlan({ seed: 99, out: 'tmp/x' });
    expect(altCustom.registerInIndex).toBe(false);
  });
});

describe('alternate-seed generation cannot touch the golden fixture (review fix 3)', () => {
  it(
    'end to end: seed 4242 leaves golden files and the index byte-identical',
    { timeout: 30_000 },
    () => {
      const goldenBefore = readGolden();
      const indexBefore = readFileSync(indexPath, 'utf-8');

      runGeneration(resolveGenerationPlan({ seed: 4242 }));

      const goldenAfter = readGolden();
      const indexAfter = readFileSync(indexPath, 'utf-8');
      for (const [name, content] of Object.entries(goldenBefore)) {
        expect(goldenAfter[name], `${name} must be untouched`).toBe(content);
      }
      expect(indexAfter).toBe(indexBefore);
    },
  );
});
