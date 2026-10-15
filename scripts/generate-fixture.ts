/**
 * KYN-03 fixture CLI: `pnpm fixture:generate --seed 24017`
 *
 * Generates the deterministic synthetic match fixture, validates it through
 * the canonical contracts, writes versioned files under
 * tests/fixtures/generated/<matchId>/ and registers the fixture in the
 * test-harness fixture index (tests/fixtures/index.json).
 *
 * Output files:
 *   events.json     — canonical MatchEvent envelopes (array)
 *   tracking.jsonl  — one canonical TrackingSample per line (streamable)
 *   metadata.json   — seed, sampling plan, score timeline, derived golden
 *                     metrics and sha256 integrity checksums (node crypto
 *                     lives here in the CLI, never in the shared packages)
 *   README.md       — human-readable golden timeline
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJsonStringify } from '@kyneloom/contracts';
import {
  assembleFixtureBundle,
  generateMatchFixture,
  SIMULATOR_VERSION,
  type FixtureMetadata,
} from '@kyneloom/match-core';

interface CliOptions {
  seed: number;
  out?: string;
}

/**
 * The canonical golden seed (docs/15): the only seed that may write into
 * tests/fixtures/generated/<matchId> and register the fixture index. Any
 * other seed is experiment output — isolated to a git-ignored scratch
 * directory and never registered — so experimenting can never overwrite or
 * re-register the committed golden fixture.
 */
export const CANONICAL_GOLDEN_SEED = 24017;

export interface GenerationPlan {
  readonly seed: number;
  readonly outDir: string;
  /** True only for the canonical seed at its default committed location. */
  readonly registerInIndex: boolean;
  readonly isCanonical: boolean;
}

export function resolveGenerationPlan(options: CliOptions): GenerationPlan {
  const isCanonical = options.seed === CANONICAL_GOLDEN_SEED;
  if (options.out) {
    return {
      seed: options.seed,
      outDir: path.resolve(options.out),
      registerInIndex: false,
      isCanonical,
    };
  }
  if (isCanonical) {
    return {
      seed: options.seed,
      outDir: path.resolve('tests', 'fixtures', 'generated', 'synthetic-derby-01'),
      registerInIndex: true,
      isCanonical,
    };
  }
  return {
    seed: options.seed,
    outDir: path.resolve('.fixture-scratch', `seed-${options.seed}`),
    registerInIndex: false,
    isCanonical,
  };
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { seed: 24017 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--seed') {
      const value = Number(argv[i + 1]);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`--seed must be a non-negative integer, got ${String(argv[i + 1])}`);
      }
      options.seed = value;
      i += 1;
    } else if (arg === '--out') {
      options.out = argv[i + 1];
      i += 1;
    } else {
      throw new Error(
        `unknown argument ${arg}; usage: pnpm fixture:generate --seed <int> [--out <dir>]`,
      );
    }
  }
  return options;
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`;
}

function fixtureReadme(metadata: FixtureMetadata, checksums: Record<string, string>): string {
  const g = metadata.golden;
  const goals = ['', ''];
  return `# ${metadata.matchId} — generated golden fixture

Seed **${metadata.seed}** · generator **${metadata.generatorVersion}** ·
pitch ${metadata.pitch.lengthM}×${metadata.pitch.widthM} m ·
sampling ${metadata.sampling.backgroundHz} Hz background / ${metadata.sampling.goldenHz} Hz golden ·
${metadata.sampling.frameCount} frames · ${metadata.sampling.sampleCount} samples · ${metadata.eventCount} events.

## Files

- \`events.json\` — canonical event envelopes (validated by \`parseMatchEvent\`).
- \`tracking.jsonl\` — one canonical sample per line (validated by \`parseTrackingSample\`).
- \`metadata.json\` — sampling plan, score timeline, derived golden metrics and integrity checksums.

## Golden timeline — "The Invisible Assist" (second half, home attacks +x)

| Time (ms) | Beat |
|---|---|
| ${g.decoyRun.fromMs} | Decoy run begins: ${g.decoyRun.winger} sprints short; ${g.decoyRun.drawnDefender} follows |
| ${metadata.goldenCheckpointMs} | **Checkpoint frame** (run in flight, defender following) |
| ${g.decoyRun.toMs} | Separation ${g.decoyRun.drawnDefender}↔${g.decoyRun.striker}: ${g.decoyRun.separationBeforeM} m → ${g.decoyRun.separationAfterM} m (**${g.decoyRun.separationDeltaM > 0 ? '+' : ''}${g.decoyRun.separationDeltaM} m**) |
| ${g.pass.attemptedMs} | pass_attempted — ${g.pass.from} releases |
| ${g.pass.completedMs} | pass_completed (evt-0042) — ${g.pass.to} controls (${g.pass.distanceM} m at ${g.pass.speedMps} m/s) |
| ${g.shot.atMs} | shot_attempted — ${g.shot.by} shoots |
| ${g.shot.goalMs} | **goal** — score 1–1 |
| ${metadata.sampling.emittedToMs} | Emission window ends |

Winger top speed during the decoy: ${g.decoyRun.wingerTopSpeedMps} m/s (measured from samples).

## Score timeline

${metadata.scoreTimeline.map((s) => `- ${s.atMs} ms: ${s.score}`).join('\n')}

## Integrity

\`\`\`json
${JSON.stringify(checksums, null, 2)}
\`\`\`

Every metric above is derived from the emitted tracking samples at
generation time — nothing is hard-coded for the UI. Regenerate with:
\`pnpm fixture:generate --seed ${metadata.seed}\`.
${goals.length ? '' : ''}
`;
}

/** Executes a generation plan. Exported for the isolation tests. */
export function runGeneration(plan: GenerationPlan): void {
  const bundle = generateMatchFixture({ seed: plan.seed });

  // Validate everything through the canonical contracts before writing.
  const assembled = assembleFixtureBundle({
    events: bundle.events,
    tracking: bundle.tracking,
    metadata: bundle.metadata,
  });
  if (!assembled.ok) {
    for (const error of assembled.errors) {
      console.error(`[${error.kind} #${error.index}] ${error.message}`);
    }
    throw new Error(
      `generated fixture failed contract validation (${assembled.errors.length} errors)`,
    );
  }

  const matchId = bundle.metadata.matchId;
  const outDir = plan.outDir;
  mkdirSync(outDir, { recursive: true });

  const checksums = {
    events: sha256Canonical(bundle.events),
    tracking: sha256Canonical(bundle.tracking),
    generatorVersion: SIMULATOR_VERSION,
  };
  const metadataOut = { ...bundle.metadata, integrity: checksums };

  writeFileSync(path.join(outDir, 'events.json'), `${JSON.stringify(bundle.events, null, 2)}\n`);
  writeFileSync(
    path.join(outDir, 'tracking.jsonl'),
    bundle.tracking.map((sample) => JSON.stringify(sample)).join('\n') + '\n',
  );
  writeFileSync(path.join(outDir, 'metadata.json'), `${JSON.stringify(metadataOut, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'README.md'), fixtureReadme(bundle.metadata, checksums));

  // Register in the test-harness fixture index (server-side seam) — only the
  // canonical golden seed at its default committed location may do this, so
  // alternate-seed experiments can never overwrite or re-register it.
  if (plan.registerInIndex) {
    const indexPath = path.resolve('tests', 'fixtures', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
      schemaVersion: string;
      fixtures: { id: string; label: string; generator: string; seed: number; file: string }[];
    };
    const entry = {
      id: matchId,
      label: `Synthetic derby — the invisible assist (seed ${plan.seed})`,
      generator: SIMULATOR_VERSION,
      seed: plan.seed,
      file: `generated/${matchId}/metadata.json`,
    };
    const withoutDuplicate = index.fixtures.filter((f) => f.id !== matchId);
    index.fixtures = [...withoutDuplicate, entry].sort((a, b) => a.id.localeCompare(b.id));
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  const m = bundle.metadata;
  const g = m.golden;
  console.log(`fixture ${matchId} written to ${path.relative(process.cwd(), outDir)}`);
  if (!plan.registerInIndex) {
    console.log(
      `  note: seed ${plan.seed} is not the canonical golden seed (${CANONICAL_GOLDEN_SEED}); output is NOT registered in the fixture index${plan.isCanonical ? ' (custom --out location)' : ''}`,
    );
  }
  console.log(
    `  seed=${plan.seed} frames=${m.sampling.frameCount} samples=${m.sampling.sampleCount} events=${m.eventCount}`,
  );
  console.log(
    `  golden: separation ${g.decoyRun.separationBeforeM}m -> ${g.decoyRun.separationAfterM}m (d=${g.decoyRun.separationDeltaM}m), pass ${g.pass.distanceM}m @ ${g.pass.speedMps}m/s, shot ${g.shot.distanceM}m @ ${g.shot.speedMps}m/s`,
  );
  console.log(
    `  checksums: events ${checksums.events.slice(7, 19)}… tracking ${checksums.tracking.slice(7, 19)}…`,
  );
}

function main(): void {
  runGeneration(resolveGenerationPlan(parseArgs(process.argv.slice(2))));
}

// Run only when executed directly (tsx / node), not when imported by tests.
const invokedScript = process.argv[1]?.replaceAll('\\', '/');
if (invokedScript != null && invokedScript.endsWith('scripts/generate-fixture.ts')) {
  main();
}
