import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGoldenMatch } from './match-fixture';
import { buildCompilerSource, buildWorkbenchPayload } from './moment-compiler-service';

/**
 * KYN-16 — the web service seam: the committed fixture must yield a
 * compilable workbench (trusted source + corpus + initial compiled result),
 * and the initial result must carry the pinned manifest identity the
 * /studio/compile surface renders.
 */

const ARTIFACT_PATH = path.resolve(
  import.meta.dirname,
  '../../../../tests/fixtures/compiled/invisible-assist-directed-v1.json',
);

describe('moment-compiler service seam', () => {
  it('builds a compilable workbench from the committed fixture', async () => {
    const golden = await loadGoldenMatch();
    const source = buildCompilerSource(golden);
    expect(source.ok).toBe(true);
    const workbench = buildWorkbenchPayload(golden, source);
    expect(workbench.ok).toBe(true);
    if (!workbench.ok) return;
    const { payload } = workbench;
    expect(payload.entries.length).toBeGreaterThanOrEqual(16);
    expect(
      payload.entries.filter((entry) => entry.expect === 'invalid').length,
    ).toBeGreaterThanOrEqual(9);
    expect(payload.initialResult.ok).toBe(true);
  });

  it('the initial compiled result equals the pinned artifact identity', async () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8')) as { manifestHash: string };
    const golden = await loadGoldenMatch();
    const source = buildCompilerSource(golden);
    const workbench = buildWorkbenchPayload(golden, source);
    expect(workbench.ok).toBe(true);
    if (!workbench.ok || !workbench.payload.initialResult.ok) return;
    expect(workbench.payload.initialResult.manifestHash).toBe(artifact.manifestHash);
  });

  it('reports candidate metadata the UI can ground its source panel in', async () => {
    const golden = await loadGoldenMatch();
    const source = buildCompilerSource(golden);
    const workbench = buildWorkbenchPayload(golden, source);
    expect(workbench.ok).toBe(true);
    if (!workbench.ok) return;
    const candidate = workbench.payload.source.candidate;
    expect(candidate.candidateId).toMatch(/^cand-[0-9a-f]+$/);
    expect(candidate.windowMs[0]).toBeLessThan(candidate.windowMs[1]);
    expect(candidate.reasonCodes.length).toBeGreaterThan(0);
    expect(workbench.payload.source.coverageMs[0]).toBeLessThanOrEqual(candidate.windowMs[0]);
  });
});
