// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildEvidenceProjection } from '@/lib/evidence-data';
import { buildSceneData } from '@/lib/scene-data';
import { buildCompilerSource } from '@/lib/moment-compiler-service';
import { buildCompileCorpus, compileMomentProposal } from '@kyneloom/moment-compiler';
import { ReplayStage, type CompiledMomentOverlay } from './replay-stage';

/**
 * KYN-16 — compiled-moment additions to the Living Replay stage (jsdom; the
 * canvas gate falls back to the 2D view, which is exactly where the overlay
 * and identity chip must still work). Regression law: with `compiled` null
 * the stage renders exactly as before.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage?.removeItem('kyneloom.lens');
});

function stubBrowserApis(): void {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  });
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    return {
      matches: false,
      media: query,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
      addListener: (): void => undefined,
      removeListener: (): void => undefined,
      dispatchEvent: (): boolean => false,
      onchange: null,
    } as unknown as MediaQueryList;
  });
}

async function fixture(): Promise<{
  scene: NonNullable<ReturnType<typeof buildSceneData>>;
  evidence: ReturnType<typeof buildEvidenceProjection>;
  compiled: CompiledMomentOverlay;
  hash: string;
}> {
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) throw new Error(`source unavailable: ${source.message}`);
  const corpus = buildCompileCorpus(source.snapshot.context);
  const result = compileMomentProposal(corpus.golden, source.snapshot.context);
  if (!result.ok) throw new Error('golden proposal failed to compile');
  const momentStart = result.manifest.timeRangeMs[0];
  const scene = buildSceneData(golden, { initialFocusMs: momentStart });
  if (scene === null) throw new Error('scene unavailable');
  return {
    scene,
    evidence: buildEvidenceProjection(golden),
    compiled: {
      manifestId: result.manifest.manifestId,
      manifestHash: result.manifestHash,
      momentWindowMs: [result.manifest.timeRangeMs[0], result.manifest.timeRangeMs[1]],
      cues: result.presentation.broadcast,
    },
    hash: result.manifestHash,
  };
}

describe('ReplayStage with a compiled moment', () => {
  it('without `compiled`, the stage renders unchanged (no hash chip, no moment region)', async () => {
    stubBrowserApis();
    const { scene, evidence } = await fixture();
    render(<ReplayStage scene={scene} evidence={evidence} />);
    expect(document.querySelector('[data-compiled-hash]')).toBeNull();
    expect(document.querySelector('[data-moment-region]')).toBeNull();
    expect(document.querySelector('[data-broadcast-overlay]')).toBeNull();
  });

  it('shows the immutable identity chip and the moment window marker', async () => {
    stubBrowserApis();
    const { scene, evidence, compiled, hash } = await fixture();
    render(<ReplayStage scene={scene} evidence={evidence} compiled={compiled} />);
    const chip = document.querySelector('[data-compiled-hash]');
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('data-compiled-hash')).toBe(hash);
    expect(chip!.textContent).toContain(hash.slice(7, 23));
    const region = document.querySelector('[data-moment-region]');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('data-moment-region')).toBe(compiled.manifestId);
  });

  it('renders time-coded broadcast cues driven by the shared playhead', async () => {
    stubBrowserApis();
    const { scene, evidence, compiled } = await fixture();
    render(<ReplayStage scene={scene} evidence={evidence} compiled={compiled} />);
    const overlay = document.querySelector('[data-broadcast-overlay]');
    expect(overlay).not.toBeNull();
    // Seek into the metric cue's window via the transport slider (absolute
    // match ms — one clock for scene, overlay and manifest).
    const metricCue = compiled.cues.find((cue) => cue.text.includes('SEPARATION'));
    expect(metricCue).toBeDefined();
    const slider = screen.getByRole('slider', { name: 'Moment playhead' }) as HTMLInputElement;
    fireEvent.input(slider, {
      target: { value: String((metricCue!.startMs + metricCue!.endMs) / 2) },
    });
    await waitFor(
      () => {
        expect(overlay!.hasAttribute('hidden')).toBe(false);
      },
      { timeout: 6000 },
    );
    await waitFor(
      () => {
        expect(overlay!.textContent).toContain('SEPARATION');
      },
      { timeout: 6000 },
    );
    // QA hook proves the shared clock: the active cue matches the playhead.
    const hook = (
      window as unknown as {
        __kyneloomCompiled?: { activeCue(): string | null; playheadMs(): number };
      }
    ).__kyneloomCompiled;
    expect(hook).toBeDefined();
    expect(hook!.activeCue()).toContain('SEPARATION');
    expect(hook!.playheadMs()).toBeGreaterThanOrEqual(metricCue!.startMs);
  });

  it('hides the overlay while the playhead is outside every cue window', async () => {
    stubBrowserApis();
    const { scene, evidence, compiled } = await fixture();
    render(<ReplayStage scene={scene} evidence={evidence} compiled={compiled} />);
    const overlay = document.querySelector('[data-broadcast-overlay]');
    expect(overlay).not.toBeNull();
    // The first ~900 ms of the scene window precede the earliest cue.
    const slider = screen.getByRole('slider', { name: 'Moment playhead' }) as HTMLInputElement;
    fireEvent.input(slider, { target: { value: String(scene.windowMs[0] + 200) } });
    await waitFor(
      () => {
        expect(overlay!.hasAttribute('hidden')).toBe(true);
      },
      { timeout: 6000 },
    );
  });
});
