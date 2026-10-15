import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CANONICAL_GOLDEN_SEED,
  resolveGenerationPlan,
  runGeneration,
} from '../scripts/generate-fixture';

/**
 * Review rounds 2+3: alternate-seed generation must never overwrite or
 * re-register the canonical seed-24017 golden fixture — including via a
 * custom --out — and test cleanup must only remove directories this test
 * file owns, never other developers' scratch fixtures.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const goldenDir = path.join(repoRoot, 'tests', 'fixtures', 'generated', 'synthetic-derby-01');
const indexPath = path.join(repoRoot, 'tests', 'fixtures', 'index.json');
const scratchRoot = path.join(repoRoot, '.fixture-scratch');
/** Owned exclusively by this test file; nothing else is ever deleted. */
const testScratchDir = path.join(scratchRoot, 'seed-4242');
/** Stands in for a developer's unrelated experiment; must survive the run. */
const bystanderDir = path.join(scratchRoot, 'seed-98765-bystander');

function readGolden(): Record<string, string> {
  const names = ['events.json', 'tracking.jsonl', 'metadata.json', 'README.md'];
  return Object.fromEntries(names.map((n) => [n, readFileSync(path.join(goldenDir, n), 'utf-8')]));
}

afterAll(() => {
  // Scoped cleanup: ONLY the directory this test file created.
  rmSync(testScratchDir, { recursive: true, force: true });
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

  it('rejects alternate-seed --out aimed at the canonical golden directory (final review: --out bypass)', () => {
    const dangerous = [
      'tests/fixtures/generated/synthetic-derby-01',
      'tests/fixtures/generated/synthetic-derby-01/',
      './tests/fixtures/generated/synthetic-derby-01',
      'tests/fixtures/generated/synthetic-derby-01/.',
      'tests\\fixtures\\generated\\synthetic-derby-01',
    ];
    for (const out of dangerous) {
      expect(() => resolveGenerationPlan({ seed: 4242, out }), out).toThrow(
        /committed fixtures tree/,
      );
    }
  });

  it('rejects alternate-seed --out anywhere inside the committed fixtures tree', () => {
    expect(() => resolveGenerationPlan({ seed: 4242, out: 'tests/fixtures/contracts' })).toThrow(
      /committed fixtures tree/,
    );
    expect(() => resolveGenerationPlan({ seed: 4242, out: 'tests/fixtures/index.json' })).toThrow(
      /committed fixtures tree/,
    );
  });

  it('still allows alternate-seed --out outside tests/fixtures, and canonical --out anywhere', () => {
    expect(() => resolveGenerationPlan({ seed: 4242, out: 'tmp/experiment' })).not.toThrow();
    expect(() =>
      resolveGenerationPlan({ seed: CANONICAL_GOLDEN_SEED, out: 'tmp/golden-copy' }),
    ).not.toThrow();
  });
});

describe('dangerous path end to end (CLI subprocess)', () => {
  it(
    'the CLI refuses and leaves golden files and index byte-identical',
    { timeout: 90_000 },
    () => {
      const goldenBefore = readGolden();
      const indexBefore = readFileSync(indexPath, 'utf-8');

      let failed = false;
      let output = '';
      try {
        execFileSync(
          'pnpm',
          [
            'exec',
            'tsx',
            'scripts/generate-fixture.ts',
            '--seed',
            '4242',
            '--out',
            'tests/fixtures/generated/synthetic-derby-01',
          ],
          { cwd: repoRoot, stdio: 'pipe', timeout: 60_000, shell: process.platform === 'win32' },
        );
      } catch (error) {
        failed = true;
        const err = error as { stderr?: Buffer; message?: string };
        output = `${String(err.stderr ?? '')}\n${String(err.message ?? '')}`;
      }
      expect(failed, 'the CLI must exit non-zero on the dangerous path').toBe(true);
      expect(output).toContain('committed fixtures tree');

      for (const [name, content] of Object.entries(goldenBefore)) {
        expect(readFileSync(path.join(goldenDir, name), 'utf-8'), `${name} must be untouched`).toBe(
          content,
        );
      }
      expect(readFileSync(indexPath, 'utf-8')).toBe(indexBefore);
    },
  );
});

describe('alternate-seed generation cannot touch the golden fixture', () => {
  it(
    'end to end: seed 4242 leaves golden files and the index byte-identical',
    { timeout: 30_000 },
    () => {
      const goldenBefore = readGolden();
      const indexBefore = readFileSync(indexPath, 'utf-8');

      runGeneration(resolveGenerationPlan({ seed: 4242 }));

      const goldenAfter = readGolden();
      for (const [name, content] of Object.entries(goldenBefore)) {
        expect(goldenAfter[name], `${name} must be untouched`).toBe(content);
      }
      expect(readFileSync(indexPath, 'utf-8')).toBe(indexBefore);
    },
  );

  it('cleanup removes only this file-owned scratch directory, preserving bystanders (final review fix 3)', () => {
    // A developer's unrelated experiment that must survive the whole run.
    mkdirSync(bystanderDir, { recursive: true });
    writeFileSync(path.join(bystanderDir, 'marker.txt'), 'do not delete');

    expect(existsSync(testScratchDir)).toBe(true); // our own scratch exists
    // Scoped removal — the exact operation afterAll performs.
    rmSync(testScratchDir, { recursive: true, force: true });

    expect(existsSync(testScratchDir)).toBe(false);
    expect(existsSync(path.join(bystanderDir, 'marker.txt'))).toBe(true);
    expect(readFileSync(path.join(bystanderDir, 'marker.txt'), 'utf-8')).toBe('do not delete');
  });
});
