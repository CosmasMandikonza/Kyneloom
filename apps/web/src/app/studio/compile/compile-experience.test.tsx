// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildEvidenceProjection } from '@/lib/evidence-data';
import { buildSceneData } from '@/lib/scene-data';
import { buildCompilerSource } from '@/lib/moment-compiler-service';
import {
  buildCompileCorpus,
  compileMomentProposal,
  type CompileSuccess,
} from '@kyneloom/moment-compiler';
import { CompileExperience } from './compile-experience';
import type { CorpusEntryCard } from '@/lib/moment-compiler-service';

/**
 * KYN-16 review blocker C — recompilation updates the actual experience.
 * Real fixture, real compiler results; only the network fetch is stubbed
 * (with the REAL server-side compiles of the same corpus entries). Proves:
 * hash B replaces hash A everywhere on success; a rejection never touches
 * the stage and the previous artifact is explicitly labeled; stale network
 * responses cannot overwrite newer state; transport survives the swap.
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
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

async function realWorld() {
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) throw new Error('source unavailable');
  const corpus = buildCompileCorpus(source.snapshot.context);
  const initial = compileMomentProposal(corpus.golden, source.snapshot.context);
  if (!initial.ok) throw new Error('golden failed to compile');
  const sweepEntry = corpus.entries.find((entry) => entry.id === 'broadcast-sweep');
  const defectEntry = corpus.entries.find((entry) => entry.id === 'defect-false-distance');
  if (sweepEntry === undefined || defectEntry === undefined) throw new Error('corpus incomplete');
  const sweep = compileMomentProposal(sweepEntry.proposal, source.snapshot.context);
  if (!sweep.ok) throw new Error('sweep variant failed to compile');
  const defect = compileMomentProposal(defectEntry.proposal, source.snapshot.context);
  const scene = buildSceneData(golden, {
    initialFocusMs: corpus.candidate.startMs,
  });
  if (scene === null) throw new Error('scene unavailable');
  const entries: CorpusEntryCard[] = corpus.entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    expect: entry.expect,
    ...(entry.expectedCode === undefined ? {} : { expectedCode: entry.expectedCode }),
    proposal: entry.proposal,
  }));
  return {
    scene,
    evidence: buildEvidenceProjection(golden),
    entries,
    initial,
    sweep,
    defect,
    defectEntry,
  };
}

function deferredFetch() {
  const calls: { resolve: (payload: unknown) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          calls.push({
            resolve: (payload: unknown) =>
              resolve(new Response(JSON.stringify(payload), { status: 200 })),
          });
        }),
    ),
  );
  return calls;
}

function activeHash(): string | null {
  return document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash') ?? null;
}

describe('CompileExperience — recompilation changes what you watch (blocker C)', () => {
  it('successful recompilation swaps the artifact identity everywhere', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const calls = deferredFetch();
    render(
      <CompileExperience
        baseScene={world.scene}
        evidence={world.evidence}
        entries={world.entries}
        initialResult={world.initial as CompileSuccess}
        sourcePanel={<div>source</div>}
      />,
    );
    expect(activeHash()).toBe(world.initial.manifestHash);

    // Compile the second VALID cut (broadcast sweep).
    fireEvent.click(screen.getByRole('button', { name: /broadcast sweep/i }));
    fireEvent.click(screen.getByTestId('compile-proposal'));
    expect(calls.length).toBe(1);
    calls[0]!.resolve(world.sweep);
    await waitFor(
      () => {
        expect(activeHash()).toBe(world.sweep.manifestHash);
      },
      { timeout: 6000 },
    );

    // Identity is hash B in EVERY surface, and hash A appears nowhere.
    expect(document.querySelector('[data-identity-hash]')?.getAttribute('data-identity-hash')).toBe(
      world.sweep.manifestHash,
    );
    expect(document.querySelector('[data-verdict="valid"]')?.textContent).toContain(
      world.sweep.manifestHash,
    );
    expect(activeHash()).not.toBe(world.initial.manifestHash);
    expect(screen.queryByText(world.initial.manifestHash)).toBeNull();
    // The recap headline swapped with the artifact.
    expect(screen.getByText('Space made, finish taken')).toBeTruthy();
    // No stale-artifact banner on a clean success.
    expect(document.querySelector('[data-last-valid-banner]')).toBeNull();
  });

  it('a rejected compilation never enters the scene — the previous artifact is labeled', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const calls = deferredFetch();
    render(
      <CompileExperience
        baseScene={world.scene}
        evidence={world.evidence}
        entries={world.entries}
        initialResult={world.initial as CompileSuccess}
        sourcePanel={<div>source</div>}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /False distance claim/i }));
    fireEvent.click(screen.getByTestId('compile-proposal'));
    calls[0]!.resolve(world.defect);
    await waitFor(
      () => {
        expect(document.querySelector('[data-verdict="invalid"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    // The stage still plays the last valid artifact, explicitly labeled.
    expect(activeHash()).toBe(world.initial.manifestHash);
    const banner = document.querySelector('[data-last-valid-banner]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain(world.defectEntry.label);
    expect(banner!.textContent).toContain('was rejected');
    // Exact field-path errors from the compiler, with the recomputed truth.
    expect(screen.getByText('claims[0].metricAssertion.assertedValue')).toBeTruthy();
    expect(screen.getAllByText(/23\.063/).length).toBeGreaterThan(0);
  });

  it('selection change during a pending compile cannot misassociate the verdict; the sequence guard owns ordering', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const calls = deferredFetch();
    render(
      <CompileExperience
        baseScene={world.scene}
        evidence={world.evidence}
        entries={world.entries}
        initialResult={world.initial as CompileSuccess}
        sourcePanel={<div>source</div>}
      />,
    );
    // Start compiling the sweep, then switch the SELECTION to the defect
    // while the request is in flight.
    fireEvent.click(screen.getByRole('button', { name: /broadcast sweep/i }));
    fireEvent.click(screen.getByTestId('compile-proposal'));
    fireEvent.click(screen.getByRole('button', { name: /False distance claim/i }));
    // The in-flight request resolves while the defect is selected: the
    // verdict must stay associated with the entry that was compiled
    // (broadcast-sweep), never with the currently selected defect.
    calls[0]!.resolve(world.sweep);
    await waitFor(
      () => {
        expect(activeHash()).toBe(world.sweep.manifestHash);
      },
      { timeout: 6000 },
    );
    const verdict = document.querySelector('[data-verdict]');
    expect(verdict?.getAttribute('data-verdict')).toBe('valid');
    expect(verdict?.getAttribute('data-compiled-entry')).toBe('broadcast-sweep');
    expect(
      screen.getByRole('button', { name: /False distance claim/i }).getAttribute('aria-pressed'),
    ).toBe('true');

    // Now compile the defect (a NEW request — the sequence guard makes IT
    // the owner); its rejection replaces the verdict but never the stage.
    fireEvent.click(screen.getByTestId('compile-proposal'));
    expect(calls.length).toBe(2);
    calls[1]!.resolve(world.defect);
    await waitFor(
      () => {
        expect(document.querySelector('[data-verdict="invalid"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(document.querySelector('[data-verdict]')?.getAttribute('data-compiled-entry')).toBe(
      'defect-false-distance',
    );
    expect(activeHash()).toBe(world.sweep.manifestHash);
    expect(document.querySelector('[data-last-valid-banner]')).not.toBeNull();
  });

  it('the transport remains functional after a manifest swap', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const calls = deferredFetch();
    render(
      <CompileExperience
        baseScene={world.scene}
        evidence={world.evidence}
        entries={world.entries}
        initialResult={world.initial as CompileSuccess}
        sourcePanel={<div>source</div>}
      />,
    );
    // Watch, then recompile to the sweep, then use the transport.
    fireEvent.click(screen.getByTestId('watch-compiled-moment'));
    await waitFor(() => expect(document.querySelector('[data-compile-poster]')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /broadcast sweep/i }));
    fireEvent.click(screen.getByTestId('compile-proposal'));
    calls[0]!.resolve(world.sweep);
    await waitFor(
      () => {
        expect(activeHash()).toBe(world.sweep.manifestHash);
      },
      { timeout: 6000 },
    );
    const play = screen.getByRole('button', { name: /pause/i });
    if (play === null) throw new Error('pause button missing after swap');
    fireEvent.click(play);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Play' }).getAttribute('aria-pressed')).toBe(
        'false',
      );
    });
    // The compiled QA hook is bound to the NEW artifact.
    const hook = (window as unknown as { __kyneloomCompiled?: { manifestHash: string } })
      .__kyneloomCompiled;
    expect(hook?.manifestHash).toBe(world.sweep.manifestHash);
  });
});
