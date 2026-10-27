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
import { resolveAskMoment } from '@/lib/ask-intent';
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

describe('KYN Ask Kyneloom — intent input drives the actual experience', () => {
  /** Fetch stub that captures the URL so ask + compile calls resolve independently. */
  function askFetch(): {
    calls: { readonly url: string; resolve: (payload: unknown) => void }[];
  } {
    const calls: { readonly url: string; resolve: (payload: unknown) => void }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown) =>
          new Promise<Response>((resolve) => {
            calls.push({
              url: String(_url),
              resolve: (payload: unknown) =>
                resolve(new Response(JSON.stringify(payload), { status: 200 })),
            });
          }),
      ) as unknown as typeof fetch,
    );
    return { calls };
  }

  it('a supported prompt rebinds the stage to the resolved manifest (hash + answer visible)', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const wide = await resolveAskMoment('Give me a wide broadcast view');
    if (!wide.ok || !wide.result.ok) throw new Error('wide intent failed to resolve');
    const wideHash = wide.result.manifestHash;
    const { calls } = askFetch();
    render(
      <CompileExperience
        baseScene={world.scene}
        evidence={world.evidence}
        entries={world.entries}
        initialResult={world.initial}
        sourcePanel={<div>source</div>}
      />,
    );
    const hashBefore =
      document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash') ?? null;
    const input = screen.getByTestId('ask-input');
    fireEvent.change(input, { target: { value: 'Give me a wide broadcast view' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toContain('/api/moment/intent');
    calls[0]!.resolve(wide);
    await waitFor(() =>
      expect(screen.getByTestId('ask-answer').textContent).toContain('broadcast-wide'),
    );
    // The ACTIVE artifact swapped to the sweep manifest: the identity chip
    // changed — the resolved manifest reached the experience.
    await waitFor(() => {
      const hashAfter = document
        .querySelector('[data-compiled-hash]')
        ?.getAttribute('data-compiled-hash');
      expect(hashAfter).toBe(wideHash);
      expect(hashAfter).not.toBe(hashBefore);
    });
    expect(screen.getByTestId('ask-answer').textContent).toContain(
      wide.result.manifestHash.slice(7, 19),
    );
  });

  it('an unsupported prompt explains honestly and NEVER touches the active stage', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const refused = await resolveAskMoment('What is the referee\u2019s name?');
    const { calls } = askFetch();
    render(
      <CompileExperience
        baseScene={world.scene}
        evidence={world.evidence}
        entries={world.entries}
        initialResult={world.initial}
        sourcePanel={<div>source</div>}
      />,
    );
    const hashBefore = document
      .querySelector('[data-compiled-hash]')
      ?.getAttribute('data-compiled-hash');
    fireEvent.change(screen.getByTestId('ask-input'), {
      target: { value: 'What is the referee\u2019s name?' },
    });
    fireEvent.submit(screen.getByTestId('ask-input').closest('form') as HTMLFormElement);
    await waitFor(() => expect(calls.length).toBe(1));
    calls[0]!.resolve(refused);
    await waitFor(() =>
      expect(screen.getByTestId('ask-status').textContent).toContain('nothing was substituted'),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash')).toBe(
      hashBefore,
    );
  });

  it('rapid submissions: a stale resolution can never overwrite the latest question', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const wide = await resolveAskMoment('Give me a wide broadcast view');
    const goal = await resolveAskMoment('Show the build-up to the goal');
    if (!wide.ok || !wide.result.ok || !goal.ok || !goal.result.ok) {
      throw new Error('intents failed to resolve');
    }
    const goalHash = goal.result.manifestHash;
    const { calls } = askFetch();
    render(
      <CompileExperience
        baseScene={world.scene}
        evidence={world.evidence}
        entries={world.entries}
        initialResult={world.initial}
        sourcePanel={<div>source</div>}
      />,
    );
    // First question, then a SECOND question before the first answers.
    fireEvent.click(screen.getByTestId('ask-example-broadcast-wide'));
    await waitFor(() => expect(calls.length).toBe(1));
    fireEvent.change(screen.getByTestId('ask-input'), {
      target: { value: 'Show the build-up to the goal' },
    });
    fireEvent.submit(screen.getByTestId('ask-input').closest('form') as HTMLFormElement);
    await waitFor(() => expect(calls.length).toBe(2));
    // The LATEST response commits first; the stale one arrives later and
    // must be dropped entirely.
    calls[1]!.resolve(goal);
    await waitFor(() =>
      expect(
        document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash'),
      ).toBe(goalHash),
    );
    calls[0]!.resolve(wide);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash')).toBe(
      goal.result.manifestHash,
    );
  });

  it('Enter submits and the example chips run the same production handler', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const offBall = await resolveAskMoment('Show me how the off-ball run opened space');
    if (!offBall.ok || !offBall.result.ok) throw new Error('off-ball intent failed');
    const { calls } = askFetch();
    render(
      <CompileExperience
        baseScene={world.scene}
        evidence={world.evidence}
        entries={world.entries}
        initialResult={world.initial}
        sourcePanel={<div>source</div>}
      />,
    );
    // Enter in the input submits the form.
    const input = screen.getByTestId('ask-input');
    fireEvent.change(input, { target: { value: 'Show me how the off-ball run opened space' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Enter in a text input does not natively submit in jsdom; the form's
    // submit handler is what the button uses — invoke it directly.
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toContain('/api/moment/intent');
    calls[0]!.resolve(offBall);
    await waitFor(() =>
      expect(screen.getByTestId('ask-answer').textContent).toContain('off-ball-run'),
    );
    // The example chip populates the SAME input and calls the SAME handler.
    fireEvent.click(screen.getByTestId('ask-example-goal-buildup'));
    await waitFor(() => expect(calls.length).toBe(2));
    expect((screen.getByTestId('ask-input') as HTMLInputElement).value).toBe(
      'Show the build-up to the goal',
    );
  });
});

describe('KYN Ask review round — build-up focus, cross-flow sync', () => {
  function askFetch(): { calls: { readonly url: string; resolve: (payload: unknown) => void }[] } {
    const calls: { readonly url: string; resolve: (payload: unknown) => void }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown) =>
          new Promise<Response>((resolve) => {
            calls.push({
              url: String(_url),
              resolve: (payload: unknown) =>
                resolve(new Response(JSON.stringify(payload), { status: 200 })),
            });
          }),
      ) as unknown as typeof fetch,
    );
    return { calls };
  }

  function mount(world: Awaited<ReturnType<typeof realWorld>>): void {
    render(
      <CompileExperience
        baseScene={world.scene}
        evidence={world.evidence}
        entries={world.entries}
        initialResult={world.initial as CompileSuccess}
        sourcePanel={<div>source</div>}
      />,
    );
  }

  it('a goal build-up answer seeks the stage to the WINDOW START (the real autoRun.fromMs), not the goal instant', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const goal = await resolveAskMoment('Show the build-up to the goal');
    if (!goal.ok || !goal.result.ok) throw new Error('goal intent failed');
    const { calls } = askFetch();
    mount(world);
    fireEvent.click(screen.getByTestId('ask-example-goal-buildup'));
    await waitFor(() => expect(calls.length).toBe(1));
    calls[0]!.resolve(goal);
    await waitFor(() =>
      expect(screen.getByTestId('ask-answer').textContent).toContain('goal-buildup'),
    );
    // The actual playback focus: the stage transport slider (the canonical
    // clock) rests at the candidate window START — the build-up plays.
    const sliderEl = document.querySelector('input.stage__slider') as HTMLInputElement;
    expect(sliderEl).not.toBeNull();
    await waitFor(
      () => {
        expect(Number(sliderEl.value)).toBe(goal.focusPlayheadMs);
      },
      { timeout: 6000 },
    );
    // And provably NOT the goal instant (the old defect).
    const source = buildCompilerSource(await loadGoldenMatch());
    const goalAt = source.ok
      ? source.snapshot.context.events.find((event) => event.kind === 'goal')?.occurredAtMs
      : undefined;
    expect(goalAt).toBeDefined();
    expect(Number(sliderEl.value)).not.toBe(goalAt);
  });

  it('a successful MANUAL compile retires the Ask answer and its focus (one artifact, one story)', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const wide = await resolveAskMoment('Give me a wide broadcast view');
    if (!wide.ok || !wide.result.ok) throw new Error('wide intent failed');
    const { calls } = askFetch();
    mount(world);
    // Ask first: the answer is visible and the sweep manifest is active.
    fireEvent.click(screen.getByTestId('ask-example-broadcast-wide'));
    await waitFor(() => expect(calls.length).toBe(1));
    calls[0]!.resolve(wide);
    await waitFor(() =>
      expect(screen.getByTestId('ask-answer').textContent).toContain('broadcast-wide'),
    );
    // Then a manual corpus compile WINS (select + compile the golden entry).
    fireEvent.click(screen.getByRole('button', { name: /well-formed proposal/i }));
    fireEvent.click(screen.getByTestId('compile-proposal'));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]!.url).toContain('/api/moment/compile');
    calls[1]!.resolve(world.initial);
    await waitFor(() =>
      expect(
        document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash'),
      ).toBe(world.initial.manifestHash),
    );
    // The stale Ask answer is GONE (no answer describes a different artifact
    // than the stage is playing) and the status returns to the idle guide.
    await waitFor(() => expect(screen.queryByTestId('ask-answer')).toBeNull());
    expect(screen.getByTestId('ask-status').textContent).toContain('Ask about');
  });

  it('a stale cross-flow response cannot replace the newest user action', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const wide = await resolveAskMoment('Give me a wide broadcast view');
    if (!wide.ok || !wide.result.ok) throw new Error('wide intent failed');
    const { calls } = askFetch();
    mount(world);
    // An ask is issued, and BEFORE it answers a manual compile is issued.
    fireEvent.click(screen.getByTestId('ask-example-broadcast-wide'));
    await waitFor(() => expect(calls.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: /well-formed proposal/i }));
    fireEvent.click(screen.getByTestId('compile-proposal'));
    await waitFor(() => expect(calls.length).toBe(2));
    // The MANUAL response (the newest action) commits first.
    calls[1]!.resolve(world.sweep);
    await waitFor(() =>
      expect(
        document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash'),
      ).toBe(world.sweep.manifestHash),
    );
    // The stale ASK response arrives late — it must be dropped entirely.
    calls[0]!.resolve(wide);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash')).toBe(
      world.sweep.manifestHash,
    );
    expect(screen.queryByTestId('ask-answer')).toBeNull();
  });
});
