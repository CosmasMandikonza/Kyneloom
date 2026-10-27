// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MomentProposal } from '@kyneloom/contracts';
import {
  buildCompileCorpus,
  compileMomentProposal,
  type CompileSuccess,
  type CompilerSourceContext,
} from '@kyneloom/moment-compiler';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildCompilerSource } from '@/lib/moment-compiler-service';
import { buildSceneData } from '@/lib/scene-data';
import { buildEvidenceProjection } from '@/lib/evidence-data';
import { resetMemoryDraftBackendForTests } from '@/lib/studio/local-draft-store';
import { StudioExperience } from './studio-experience';

/**
 * KYN-17 — the Studio acceptance matrix against the REAL trusted world (the
 * committed fixture, the real compiler in-process; only the network fetch is
 * stubbed with the REAL compiler's answers, exactly like the KYN-16 surface
 * tests). These are the issue's red-team checks end to end through the UI.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage?.removeItem('kyneloom.lens');
  resetMemoryDraftBackendForTests();
  delete (window as unknown as Record<string, unknown>)['__kyneloomStudio'];
});

function stubBrowserApis(): void {
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: FrameRequestCallback): number =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number,
  );
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
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
        addListener: (): void => undefined,
        removeListener: (): void => undefined,
        dispatchEvent: (): boolean => false,
        onchange: null,
      }) as unknown as MediaQueryList,
  );
}

async function realWorld(): Promise<{
  scene: NonNullable<ReturnType<typeof buildSceneData>>;
  evidence: ReturnType<typeof buildEvidenceProjection>;
  proposal: MomentProposal;
  initial: CompileSuccess;
  context: CompilerSourceContext;
}> {
  const golden = await loadGoldenMatch();
  if (!golden.ok) throw new Error('fixture unavailable');
  const source = buildCompilerSource(golden);
  if (!source.ok) throw new Error('source unavailable');
  const corpus = buildCompileCorpus(source.snapshot.context);
  const initial = compileMomentProposal(corpus.golden, source.snapshot.context);
  if (!initial.ok) throw new Error('golden failed to compile');
  const scene = buildSceneData(golden, { initialFocusMs: corpus.golden.timeRangeMs[0] });
  if (scene === null) throw new Error('scene unavailable');
  return {
    scene,
    evidence: buildEvidenceProjection(golden),
    proposal: corpus.golden,
    initial,
    context: source.snapshot.context,
  };
}

function deferredFetch(): {
  readonly calls: { resolve: (payload: unknown) => void }[];
  readonly bodies: string[];
} {
  const calls: { resolve: (payload: unknown) => void }[] = [];
  const bodies: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: unknown, init?: { body?: string }) =>
        new Promise<Response>((resolve) => {
          bodies.push(init?.body ?? '');
          calls.push({
            resolve: (payload: unknown) =>
              resolve(new Response(JSON.stringify(payload), { status: 200 })),
          });
        }),
    ),
  );
  return { calls, bodies };
}

const button = (name: RegExp | string): HTMLButtonElement =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

/** Click a timeline clip's select button by clip kind (unambiguous DOM path). */
function clickClip(kind: 'camera' | 'overlay' | 'caption' | 'event'): void {
  const clip = document.querySelector(`[data-clip="${kind}"]`);
  if (clip === null) throw new Error(`no ${kind} clip mounted`);
  const select =
    kind === 'event'
      ? (clip as HTMLElement)
      : (clip.querySelector('.studio-tl__clip-select') as HTMLElement | null);
  if (select === null) throw new Error(`no select control on ${kind} clip`);
  fireEvent.click(select);
}

function commitInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function keyframeInput(row: number, column: number): HTMLInputElement {
  const rowEl = document.querySelector(`[data-keyframe="${String(row)}"]`);
  if (rowEl === null) throw new Error(`keyframe row ${String(row)} not found`);
  const inputs = rowEl.querySelectorAll<HTMLInputElement>('input[type="number"]');
  const input = inputs[column];
  if (input === undefined) throw new Error(`keyframe column ${String(column)} not found`);
  return input;
}

function mount(world: Awaited<ReturnType<typeof realWorld>>): void {
  render(
    <StudioExperience
      baseScene={world.scene}
      evidence={world.evidence}
      initialProposal={world.proposal}
      initialResult={world.initial}
      sourcePanel={<div>source</div>}
    />,
  );
}

describe('StudioExperience — the end-to-end editing journey (red-team matrix)', () => {
  it('#1 loads the real compiled golden moment into the editor', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    expect(document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash')).toBe(
      world.initial.manifestHash,
    );
    expect(document.querySelector('[data-compiled-baseline-chip]')).not.toBeNull();
    expect(document.querySelectorAll('[data-clip="camera"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-clip="overlay"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-clip="caption"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-clip="event"]').length).toBeGreaterThan(0);
    expect(document.querySelector('.studio-tl__unavailable')?.textContent).toContain(
      'AUDIO · UNAVAILABLE',
    );
    // Approval/publish stay truthfully unavailable.
    expect((button(/^Approve$/) as HTMLButtonElement).disabled).toBe(true);
    expect((button(/^Publish$/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('#2/#3 selects the camera shot; a keyframe edit turns the draft dirty (the actual camera binding is the scene seam)', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    clickClip('camera');
    expect(document.querySelector('[data-inspector="shot"]')).not.toBeNull();
    expect(document.querySelector('[data-selected-shot-chip]')).not.toBeNull();

    // Edit keyframe 0's fov (column 7) — one validated command.
    commitInput(keyframeInput(0, 7), '60');
    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(document.querySelector('[data-unsaved-dot="true"]')).not.toBeNull();

    // Undo returns exactly to the compiled baseline.
    fireEvent.click(button(/^Undo$/));
    await waitFor(
      () => {
        expect(document.querySelector('[data-compiled-baseline-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/^Redo$/));
    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
  });

  it('#4 editing an overlay interval re-times the broadcast cue on the same clock', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    clickClip('overlay');
    expect(document.querySelector('[data-inspector="overlay"]')).not.toBeNull();
    const inputs = document.querySelectorAll<HTMLInputElement>(
      '[data-inspector="overlay"] input[type="number"]',
    );
    expect(inputs.length).toBe(2);
    commitInput(inputs[0]!, '100');
    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    // The overlay clip in the timeline now starts at 100 ms (position derives
    // from the real timecode).
    const clip = document.querySelector<HTMLElement>('[data-clip="overlay"]');
    expect(clip?.style.left).toBe('9px'); // 100 ms × 0.09 px/ms
  });

  it('#5 recompile through the REAL compiler: a hypothesis edit changes the hash', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const { calls, bodies } = deferredFetch();
    mount(world);

    clickClip('caption');
    const textareas = document.querySelectorAll<HTMLTextAreaElement>(
      '[data-inspector="caption"] textarea',
    );
    expect(textareas.length).toBe(2);
    commitInput(textareas[0]!, 'The decoy run bent the back line and the finish followed');

    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/Validate \/ Recompile/i));
    expect(calls.length).toBe(1);
    const sentProposal = JSON.parse(bodies[0]!) as MomentProposal;
    expect(sentProposal.claims[2]!.text).toContain('bent the back line');
    const recompiled = compileMomentProposal(sentProposal, world.context);
    expect(recompiled.ok).toBe(true);
    if (!recompiled.ok) return;
    expect(recompiled.manifestHash).not.toBe(world.initial.manifestHash);
    calls[0]!.resolve(recompiled);
    await waitFor(
      () => {
        expect(
          document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash'),
        ).toBe(recompiled.manifestHash);
      },
      { timeout: 6000 },
    );
    // The recap panel mirrors the compiled claim text of the NEW artifact.
    expect(document.querySelector('[data-claims-panel]')?.textContent).toContain(
      'bent the back line',
    );
  });

  it('#5b after a focused caption commit, undo resyncs the field to the restored value', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);

    clickClip('caption');
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-inspector="caption"] textarea',
    );
    expect(textarea).not.toBeNull();
    const original = textarea!.value;
    // A REAL user interaction sequence: focus → typed text → blur commits.
    commitInput(textarea!, 'The decoy run bent the back line and the finish followed');
    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    // Undo changes the value PROP while the field is unfocused — the field
    // must show the restored (original) text, not the abandoned draft.
    fireEvent.click(button(/^Undo$/));
    await waitFor(
      () => {
        expect(document.querySelector('[data-compiled-baseline-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    const after = document.querySelector<HTMLTextAreaElement>(
      '[data-inspector="caption"] textarea',
    );
    expect(after?.value).toBe(original);
  });

  it('#6 an invalid numeric editorial caption is rejected with token and path, nothing applied', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    clickClip('caption');
    const textArea = document.querySelector<HTMLTextAreaElement>(
      '[data-inspector="caption"] textarea',
    );
    if (textArea === null) throw new Error('caption textarea missing');
    commitInput(textArea, 'The gap grew by 14 metres');
    await waitFor(
      () => {
        expect(document.querySelector('[data-edit-errors]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    const errors = document.querySelector('[data-edit-errors]');
    expect(errors?.textContent).toContain('claims[2].text');
    expect(errors?.textContent).toContain('14');
    expect(errors?.textContent).toContain('NOTHING WAS APPLIED');
    expect(document.querySelector('[data-compiled-baseline-chip]')).not.toBeNull();
  });

  it('#7/#8 undo/redo across preset applications restores exactly', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    clickClip('camera');
    fireEvent.click(button(/Overhead tactical/i));
    await waitFor(
      () => {
        expect(
          document.querySelector('[data-selected-shot-chip="cam-overhead-tactical"]'),
        ).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/Broadcast sweep/i));
    await waitFor(
      () => {
        expect(
          document.querySelector('[data-selected-shot-chip="cam-broadcast-sweep"]'),
        ).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/^Undo$/));
    await waitFor(
      () => {
        expect(
          document.querySelector('[data-selected-shot-chip="cam-overhead-tactical"]'),
        ).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/^Undo$/));
    await waitFor(
      () => {
        expect(document.querySelector('[data-compiled-baseline-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/^Redo$/));
    await waitFor(
      () => {
        expect(
          document.querySelector('[data-selected-shot-chip="cam-overhead-tactical"]'),
        ).not.toBeNull();
      },
      { timeout: 6000 },
    );
    // Keyboard undo (Ctrl+Z outside inputs) returns to the baseline again.
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(
      () => {
        expect(document.querySelector('[data-compiled-baseline-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
  });

  it('#9 save and reload persist the draft through the repository', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    clickClip('camera');
    fireEvent.click(button(/Winger follow/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/Save draft/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-unsaved-dot="false"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(document.querySelector('[data-draft-revision]')?.textContent).toContain('rev 1');

    // A fresh mount over the same (session) storage is OFFERED the draft.
    cleanup();
    mount(world);
    await waitFor(
      () => {
        expect(document.querySelector('[data-restore-banner]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/Restore saved draft/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-revision]')?.textContent).toContain('rev 1');
      },
      { timeout: 6000 },
    );
    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(document.querySelector('[data-unsaved-dot="false"]')).not.toBeNull();
    // The restored document carries the winger-follow shot (baked from the
    // run's real samples) — restore clears the selection on purpose.
    expect(document.querySelector('[data-layer-id="cam-winger-follow"]')).not.toBeNull();
  });

  it('#9b Start from baseline discards the saved draft atomically; the next save starts a fresh lineage', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    clickClip('camera');
    fireEvent.click(button(/Winger follow/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/Save draft/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-unsaved-dot="false"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(document.querySelector('[data-draft-revision]')?.textContent).toContain('rev 1');
    cleanup();

    // Reload: the saved draft is offered. Starting from the baseline is an
    // EXPLICIT destructive confirmation, not a silent dismiss.
    mount(world);
    await waitFor(
      () => {
        expect(document.querySelector('[data-restore-banner]')?.textContent).toContain(
          'revision 1',
        );
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/Start from baseline/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-discard-confirm]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/Discard and start fresh/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-restore-banner]')).toBeNull();
        expect(document.querySelector('[data-discard-confirm]')).toBeNull();
      },
      { timeout: 6000 },
    );

    // The old blocker: this save used to conflict forever. Now it succeeds
    // — a fresh revision lineage from the compiled baseline.
    clickClip('camera');
    fireEvent.click(button(/Overhead tactical/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(button(/Save draft/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-unsaved-dot="false"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(document.querySelector('[data-draft-revision]')?.textContent).toContain('rev 1');
    expect(document.querySelector('[data-conflict-banner]')).toBeNull();
  });

  it('#10 two tabs editing one draft produce a conflict; Reload saved draft recovers to revision 2', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const worldProps = {
      baseScene: world.scene,
      evidence: world.evidence,
      initialProposal: world.proposal,
      initialResult: world.initial,
      sourcePanel: <div>source</div>,
    };
    // Two LIVE tabs over the shared session storage (jsdom has no IndexedDB,
    // so both sit on the memory-fallback singleton — same shape as two tabs
    // over one database). Both loaded while nothing was stored.
    const tabA = render(<StudioExperience {...worldProps} />);
    const tabB = render(<StudioExperience {...worldProps} />);
    await waitFor(
      () => {
        expect(tabA.container.querySelector('[data-timeline]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    await waitFor(
      () => {
        expect(tabB.container.querySelector('[data-timeline]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    const saveButton = (container: HTMLElement): HTMLElement => {
      const el = container.querySelector('[data-save-draft]');
      if (el === null) throw new Error('save button missing');
      return el as HTMLElement;
    };
    const namedButton = (container: HTMLElement, name: string): HTMLButtonElement => {
      const found = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === name,
      );
      if (found === undefined) throw new Error(`button "${name}" missing`);
      return found;
    };
    const clipSelect = (container: HTMLElement, kind: string): HTMLElement => {
      const el = container.querySelector(`[data-clip="${kind}"] .studio-tl__clip-select`);
      if (el === null) throw new Error(`${kind} clip missing`);
      return el as HTMLElement;
    };

    // Tab A edits (winger preset) and saves → revision 1.
    fireEvent.click(clipSelect(tabA.container, 'camera'));
    fireEvent.click(namedButton(tabA.container, 'Winger follow'));
    await waitFor(
      () => {
        expect(tabA.container.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(saveButton(tabA.container));
    await waitFor(
      () => {
        expect(tabA.container.querySelector('[data-unsaved-dot="false"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );

    // Tab B — still believing revision 0 — saves and must CONFLICT; the
    // banner offers a real recovery action (nothing was overwritten).
    fireEvent.click(saveButton(tabB.container));
    await waitFor(
      () => {
        expect(tabB.container.querySelector('[data-conflict-banner]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(tabB.container.querySelector('[data-conflict-banner]')?.textContent).toContain(
      'revision 1',
    );

    // Recovery: B adopts the latest stored draft — A's winger shot appears
    // in B, the conflict clears, and B's lineage continues at revision 1.
    fireEvent.click(tabB.container.querySelector('[data-reload-saved-draft]') as HTMLElement);
    await waitFor(
      () => {
        expect(tabB.container.querySelector('[data-layer-id="cam-winger-follow"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    await waitFor(
      () => {
        expect(tabB.container.querySelector('[data-conflict-banner]')).toBeNull();
      },
      { timeout: 6000 },
    );
    expect(tabB.container.querySelector('[data-draft-revision]')?.textContent).toContain('rev 1');

    // B edits on the adopted lineage and saves → revision 2 (no lost update).
    fireEvent.click(clipSelect(tabB.container, 'caption'));
    await waitFor(
      () => {
        expect(tabB.container.querySelector('[data-inspector="caption"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    commitInput(
      tabB.container.querySelector('[data-inspector="caption"] textarea') as HTMLTextAreaElement,
      'The decoy run bent the back line and the finish followed',
    );
    await waitFor(
      () => {
        expect(tabB.container.querySelector('[data-draft-preview-chip]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    fireEvent.click(saveButton(tabB.container));
    await waitFor(
      () => {
        expect(tabB.container.querySelector('[data-unsaved-dot="false"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(tabB.container.querySelector('[data-draft-revision]')?.textContent).toContain('rev 2');
  });

  it('#11 a stale draft surfaces the stale state; the compiled preview never swaps', async () => {
    stubBrowserApis();
    const world = await realWorld();
    const { calls } = deferredFetch();
    mount(world);
    fireEvent.click(button(/Validate \/ Recompile/i));
    expect(calls.length).toBe(1);
    const stale: MomentProposal = {
      ...world.proposal,
      basedOn: {
        reducerRevision: world.proposal.basedOn.reducerRevision + 5,
        sourceHash: world.proposal.basedOn.sourceHash,
      },
    };
    const rejected = compileMomentProposal(stale, world.context);
    expect(rejected.ok).toBe(false);
    calls[0]!.resolve(rejected);
    await waitFor(
      () => {
        expect(document.querySelector('[data-stale-banner]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash')).toBe(
      world.initial.manifestHash,
    );
  });

  it('#12 an invalid camera pose is rejected in the inspector with the exact field path', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    clickClip('camera');
    // Altitude (column 3) below the 0.5 m contract floor.
    commitInput(keyframeInput(0, 3), '0.1');
    await waitFor(
      () => {
        expect(document.querySelector('[data-edit-errors]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(document.querySelector('[data-edit-errors]')?.textContent).toContain(
      'cameraTracks[0].keyframes[0].position[2]',
    );
    expect(document.querySelector('[data-compiled-baseline-chip]')).not.toBeNull();
  });

  it('#13 changing the audience lens selection changes no scene geometry (content only)', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    // The compiler's own proof: identical camera/evidence/cues, new hash.
    const withLenses: MomentProposal = { ...world.proposal, lenses: ['analyst', 'accessible'] };
    const a = compileMomentProposal(world.proposal, world.context);
    const b = compileMomentProposal(withLenses, world.context);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.manifest.scene.cameraTracks).toEqual(a.manifest.scene.cameraTracks);
    expect(b.manifest.evidence).toEqual(a.manifest.evidence);
    expect(b.manifest.presentation?.broadcast).toEqual(a.manifest.presentation?.broadcast);
    expect(b.manifestHash).not.toBe(a.manifestHash);
  });

  it('#14 preview mode folds the editor chrome away and back', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    fireEvent.click(button(/^Preview$/));
    expect(document.querySelector('.studio-app')?.getAttribute('data-preview-mode')).toBe('true');
    fireEvent.click(button(/Exit preview/i));
    expect(document.querySelector('.studio-app')?.getAttribute('data-preview-mode')).toBeNull();
  });

  it('#15 a compile endpoint failure is the honest unavailable state, the stage untouched', async () => {
    stubBrowserApis();
    const world = await realWorld();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 503 }))),
    );
    mount(world);
    fireEvent.click(button(/Validate \/ Recompile/i));
    await waitFor(
      () => {
        const bad = document.querySelector('.studio-workflow li[data-state="bad"]');
        expect(bad?.textContent).toContain('compiler unavailable');
      },
      { timeout: 6000 },
    );
    expect(document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash')).toBe(
      world.initial.manifestHash,
    );
  });

  it('#16 storage failures surface as an honest banner — never unhandled rejections (review nonblocking)', async () => {
    stubBrowserApis();
    const world = await realWorld();
    // A BROKEN IndexedDB: the local backend picks it up and every repository
    // operation rejects. The editor must stay fully usable on the compiled
    // baseline and surface the failure visibly.
    vi.stubGlobal('indexedDB', {
      open: (): IDBDatabase => {
        throw new Error('quota exceeded');
      },
    });
    mount(world);
    await waitFor(
      () => {
        expect(document.querySelector('[data-timeline]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    await waitFor(
      () => {
        expect(document.querySelector('[data-storage-error]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    // Saving through the broken store surfaces the SAME banner, updated —
    // not an unhandled promise rejection (vitest fails those loudly).
    fireEvent.click(button(/Save draft/i));
    await waitFor(
      () => {
        expect(document.querySelector('[data-storage-error]')?.textContent).toContain(
          'quota exceeded',
        );
      },
      { timeout: 6000 },
    );
    // The compiled baseline identity and the editing surface stay usable.
    expect(document.querySelector('[data-compiled-hash]')).not.toBeNull();
    expect(document.querySelector('[data-conflict-banner]')).toBeNull();
  });

  it('the QA hook exposes the shared clock — timeline seek moves the stage playhead', async () => {
    stubBrowserApis();
    const world = await realWorld();
    mount(world);
    await waitFor(
      () => {
        expect(
          (window as unknown as { __kyneloomStudio?: { playheadMs(): number | null } })
            .__kyneloomStudio,
        ).toBeDefined();
      },
      { timeout: 6000 },
    );
    const hook = (
      window as unknown as {
        __kyneloomStudio: {
          playheadMs(): number | null;
          seek(ms: number): void;
          draftDirty(): boolean;
          shotIds(): readonly string[];
        };
      }
    ).__kyneloomStudio;
    expect(hook.shotIds()).toContain('cam-compiled-sequence');
    const momentStart = world.proposal.timeRangeMs[0];
    hook.seek(momentStart + 1500);
    await waitFor(
      () => {
        expect(hook.playheadMs()).toBe(momentStart + 1500);
      },
      { timeout: 6000 },
    );
    expect(hook.draftDirty()).toBe(false);
  });
});
