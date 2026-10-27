// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildEvidenceProjection } from '@/lib/evidence-data';
import { buildSceneData } from '@/lib/scene-data';
import { ReplayStage } from './replay-stage';

/**
 * KYN-06 — interaction contract of the Living Replay stage.
 *
 * The transport controls are REAL now: play/pause, frame stepping, speed,
 * scrubbing in explicit milliseconds, enabled cameras, and a lens that
 * switches to the accessible 2D view. WebGL cannot exist under jsdom, so
 * the canvas gate falls back to the 2D tactical view — which conveniently
 * exercises the fallback contract here.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Lens preference persistence is REAL (sessionStorage) — isolate tests.
  window.sessionStorage?.removeItem('kyneloom.lens');
});

async function renderStage(): Promise<HTMLElement> {
  const golden = await loadGoldenMatch();
  const scene = buildSceneData(golden);
  const evidence = buildEvidenceProjection(golden);
  expect(scene).not.toBeNull();
  // requestAnimationFrame does not exist in this jsdom setup the way the
  // transport loop expects; polyfill deterministically.
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
  render(<ReplayStage scene={scene!} evidence={evidence!} />);
  return screen.getByRole('region', { name: 'Living Replay stage' });
}

function slider(): HTMLInputElement {
  return screen.getByRole('slider', { name: 'Moment playhead' }) as HTMLInputElement;
}

function cameraRadios(): NodeListOf<HTMLButtonElement> {
  return screen
    .getByRole('radiogroup', { name: 'Camera (analyst)' })
    .querySelectorAll('[role="radio"]') as NodeListOf<HTMLButtonElement>;
}

describe('ReplayStage stage shell', () => {
  it('renders the canvas mount region and the 2D fallback under jsdom', async () => {
    await renderStage();
    const mount = document.querySelector('[data-scene-mount]');
    expect(mount).not.toBeNull();
    // jsdom has no WebGL → the accessible 2D view must be showing.
    const fallback = document.querySelector('[data-scene-fallback]');
    expect(fallback).not.toBeNull();
    // 22 player dots + ball dot.
    const dots = fallback?.querySelectorAll('circle');
    expect(dots?.length).toBeGreaterThanOrEqual(23);
  });

  it('shows the live scene status with the canonical seed', async () => {
    await renderStage();
    expect(screen.getByText(/SCENE LIVE · seed 24017/i)).toBeTruthy();
  });
});

describe('ReplayStage truthfully enabled controls', () => {
  /** KYN-11: camera controls live in the Analyst rail — switch there first. */
  async function enterAnalyst(): Promise<void> {
    fireEvent.click(screen.getByRole('radio', { name: 'Analyst' }));
  }

  function cameraRadios(): NodeListOf<HTMLButtonElement> {
    return screen
      .getByRole('radiogroup', { name: 'Camera (analyst)' })
      .querySelectorAll('[role="radio"]') as NodeListOf<HTMLButtonElement>;
  }

  it('has six ENABLED camera modes incl. goalkeeper and directed', async () => {
    await renderStage();
    await enterAnalyst();
    const radios = cameraRadios();
    const labels = [...radios].map((radio) => radio.textContent?.trim());
    expect(labels).toEqual([
      'Broadcast',
      'Overhead',
      'Follow',
      'Goalkeeper',
      'Free orbit',
      'Directed',
    ]);
    for (const radio of radios) {
      expect(radio.disabled).toBe(false); // the authored manifest track is valid
    }
    fireEvent.click(radios[2]!); // Follow
    expect(radios[2]!.getAttribute('aria-checked')).toBe('true');
  });

  it('selects cameras with the 1–6 keyboard shortcuts and Esc exits directed', async () => {
    const stage = await renderStage();
    await enterAnalyst();
    const radios = () => cameraRadios();
    fireEvent.keyDown(stage, { key: '4' }); // Keeper
    expect(radios()[3]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(stage, { key: '6' }); // Directed — the guided sequence
    expect(radios()[5]!.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Exit Directed Mode' })).toBeDefined();
    fireEvent.keyDown(stage, { key: 'Escape' });
    expect(radios()[0]!.getAttribute('aria-checked')).toBe('true'); // broadcast
    expect(screen.queryByRole('button', { name: 'Exit Directed Mode' })).toBeNull();
  });

  it('keeps the player selection across camera changes', async () => {
    const stage = await renderStage();
    await enterAnalyst();
    const radios = () => cameraRadios();
    fireEvent.keyDown(stage, { key: '3' }); // Follow — selection chip appears
    fireEvent.keyDown(stage, { key: '2' }); // Overhead
    fireEvent.keyDown(stage, { key: '5' }); // Free orbit
    // No mode change may clear or duplicate the selection identity.
    expect(radios()[4]!.getAttribute('aria-checked')).toBe('true');
  });

  it('plays and pauses with a real toggle button', async () => {
    await renderStage();
    const play = screen.getByRole('button', { name: 'Play' });
    expect(play.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(play);
    expect(screen.getByRole('button', { name: 'Pause' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Play' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('offers exactly the four required speeds', async () => {
    await renderStage();
    const group = screen.getByRole('radiogroup', { name: 'Playback speed' });
    const labels = [...group.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent);
    expect(labels).toEqual(['0.25×', '0.5×', '1×', '2×']);
  });

  it('scrubs in explicit milliseconds', async () => {
    await renderStage();
    const rail = slider();
    expect(rail.min).toBe('4717000');
    expect(rail.max).toBe('4731000');
    expect(rail.step).toBe('10');
    expect(rail.value).toBe('4722100');
    fireEvent.input(rail, { target: { value: '4728000' } });
    expect(rail.value).toBe('4728000');
  });

  it('steps frames and resets to the checkpoint deterministically', async () => {
    await renderStage();
    const back = screen.getByRole('button', { name: 'Step back one frame' });
    fireEvent.click(back);
    fireEvent.click(back);
    // The slider DOM syncs on the transport loop's next tick.
    await waitFor(() => expect(slider().value).toBe('4721900'));
    const reset = screen.getByRole('button', { name: /Reset to checkpoint/ });
    fireEvent.click(reset);
    await waitFor(() => expect(slider().value).toBe('4722100'));
  });

  it('Accessible lens adds the panel WITHOUT changing the view; 2D is an explicit opt-in', async () => {
    await renderStage();
    const accessible = screen.getByRole('radio', { name: 'Accessible' });
    fireEvent.click(accessible);
    expect(accessible.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('accessible-panel')).toBeDefined();
    // KYN-11 invariant: the lens switch did NOT change the view. Under
    // jsdom the 3D canvas degrades to the WebGL-unavailable fallback from
    // the start — the switch must leave that reason untouched (a forced 2D
    // switch would show 'user-choice').
    expect(
      document.querySelector('[data-scene-fallback]')?.getAttribute('data-scene-fallback'),
    ).toBe('webgl-unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to the 2D tactical view' }));
    expect(document.querySelector('[data-scene-fallback="user-choice"]')).not.toBeNull();
  });
});

describe('Evidence X-Ray (KYN-08)', () => {
  it('full button path: X-Ray → Show evidence → sources → frame navigation → back to replay', async () => {
    await renderStage();
    // KYN-11: the X-Ray affordances live in the Analyst rail.
    fireEvent.click(screen.getByRole('radio', { name: 'Analyst' }));
    const xray = screen.getByRole('button', { name: 'Show X-Ray' });
    fireEvent.click(xray);
    expect(xray.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Source evidence' }));
    const sentence = await screen.findByTestId('evidence-sentence');
    expect(sentence.textContent).toContain('6.306');
    expect(sentence.textContent).toContain('20.344');
    expect(sentence.textContent).toContain('14.038');
    expect(screen.getByTestId('evidence-delta').textContent).toContain('14.038');
    expect(screen.getByTestId('evidence-interpretation').textContent).toContain('INTERPRETATION');
    fireEvent.click(screen.getByRole('button', { name: 'Show source frames' }));
    const frames = await screen.findByTestId('evidence-frames');
    expect(frames.textContent).toContain('frame-47205');
    expect(frames.textContent).toContain('frame-47240');
    fireEvent.click(screen.getByRole('button', { name: 'Go to before frame' }));
    await waitFor(() => expect(slider().value).toBe('4720500'));
    fireEvent.click(screen.getByRole('button', { name: 'Back to replay' }));
    await waitFor(() => expect(slider().value).toBe('4722100'));
  });

  it('scene evidence is clickable: the 2D measurement line opens the inspector', async () => {
    const stage = await renderStage();
    fireEvent.keyDown(stage, { key: 'x' });
    fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to the 2D tactical view' }));
    const line = document.querySelector('[data-xray-2d="separation"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain('6.306 m → 20.344 m');
    fireEvent.click(line as HTMLElement);
    const sentence = await screen.findByTestId('evidence-sentence');
    expect(sentence.textContent).toContain('14.038');
  });

  it('keyboard X/I/Escape drive the same path', async () => {
    const stage = await renderStage();
    fireEvent.keyDown(stage, { key: 'x' });
    // KYN-11: the phase chips (and the overlay probe) prove X-Ray is live.
    expect(document.querySelector('.stage__xray-phases')).not.toBeNull();
    fireEvent.keyDown(stage, { key: 'i' });
    expect(await screen.findByTestId('evidence-sentence')).toBeTruthy();
    fireEvent.keyDown(stage, { key: 'Escape' });
    expect(screen.queryByTestId('evidence-sentence')).toBeNull();
  });

  it('withholds X-Ray entirely when verification fails (button disabled, no geometry)', async () => {
    const golden = await loadGoldenMatch();
    const scene = buildSceneData(golden);
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
    render(
      <ReplayStage
        scene={scene!}
        evidence={{
          status: 'unverified',
          reason: 'verification failed — dependency fingerprint changed',
          defenderId: 'away-03',
          strikerId: 'home-09',
          fromMs: 4_720_500,
          toMs: 4_724_000,
        }}
      />,
    );
    // KYN-11: in the Analyst rail the measurement section renders the
    // honest unavailable state instead of a button that could lie.
    fireEvent.click(screen.getByRole('radio', { name: 'Analyst' }));
    const unavailable = screen.getByTestId('rail-measure-unavailable');
    expect(unavailable.textContent).toContain('Not available from this source');
    expect(unavailable.textContent).toContain('verification failed');
    expect(screen.queryByRole('button', { name: 'Show X-Ray' })).toBeNull();
  });
});

describe('KYN-11 — lens perspectives over one football truth', () => {
  it('defaults to Fan: dock present, Explain discoverable, no analyst chrome', async () => {
    await renderStage();
    expect(screen.getByRole('radio', { name: 'Fan' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('fan-explain')).toBeDefined();
    expect(screen.queryByTestId('analyst-rail')).toBeNull();
    expect(screen.queryByTestId('accessible-panel')).toBeNull();
  });

  it('Fan → Analyst → Accessible → Fan preserves playhead, selection and camera exactly', async () => {
    const stage = await renderStage();
    // Establish a distinctive state: seek, select a lens of the action.
    fireEvent.input(slider(), { target: { value: '4723400' } });
    await waitFor(() => expect(slider().value).toBe('4723400'));
    fireEvent.click(screen.getByRole('radio', { name: 'Analyst' }));
    fireEvent.keyDown(stage, { key: '3' }); // Follow camera (analyst rail active)
    const before = {
      playhead: slider().value,
      camera: cameraRadios()[2]!.getAttribute('aria-checked'),
    };
    for (const next of ['accessible', 'fan', 'analyst', 'accessible', 'fan'] as const) {
      fireEvent.click(
        screen.getByRole('radio', {
          name: next === 'fan' ? 'Fan' : next === 'analyst' ? 'Analyst' : 'Accessible',
        }),
      );
      await waitFor(() => expect(slider().value).toBe(before.playhead));
    }
    // Back to analyst to read the camera state: unchanged through every switch.
    fireEvent.click(screen.getByRole('radio', { name: 'Analyst' }));
    expect(cameraRadios()[2]!.getAttribute('aria-checked')).toBe(before.camera);
    expect(slider().value).toBe(before.playhead);
  });

  it('the Accessible panel renders real transcript entries and a live description', async () => {
    await renderStage();
    fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
    const transcript = screen.getByTestId('transcript');
    for (const id of ['evt-0007', 'evt-0042', 'evt-0009', 'evt-0010']) {
      expect(transcript.textContent).toContain(id);
    }
    // The description is generated from the sampled state at the current
    // playhead (default checkpoint 4722100 → ball 21.2).
    const description = await screen.findByTestId('spatial-description');
    await waitFor(() => expect(description.textContent).toContain('78:42.1'));
    expect(description.textContent).toContain('21.2');
    // Seek from the transcript: clicking the goal entry moves the playhead.
    fireEvent.click(screen.getByRole('button', { name: /GOAL · 78:48.3|Goal · 78:48.3/ }));
    await waitFor(() => expect(slider().value).toBe('4728300'));
  });

  it('Explain switches to the Analyst presentation at the same instant', async () => {
    await renderStage();
    fireEvent.input(slider(), { target: { value: '4722100' } });
    fireEvent.click(screen.getByTestId('fan-explain'));
    expect(screen.getByTestId('analyst-rail')).toBeDefined();
    expect(slider().value).toBe('4722100');
    const measure = screen.getByTestId('rail-measure');
    expect(measure.textContent).toContain('6.306');
    expect(measure.textContent).toContain('20.344');
    expect(measure.textContent).toContain('14.038');
  });

  it('keyboard L cycles lenses without touching the transport', async () => {
    const stage = await renderStage();
    fireEvent.input(slider(), { target: { value: '4726000' } });
    for (const expected of ['analyst', 'accessible', 'fan']) {
      fireEvent.keyDown(stage, { key: 'l' });
      expect(
        screen
          .getByRole('radio', {
            name: expected === 'fan' ? 'Fan' : expected === 'analyst' ? 'Analyst' : 'Accessible',
          })
          .getAttribute('aria-checked'),
      ).toBe('true');
      expect(slider().value).toBe('4726000');
    }
  });

  it('remembers the lens only as a session presentation preference (malformed reverts to Fan)', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
    await renderStage();
    fireEvent.click(screen.getByRole('radio', { name: 'Analyst' }));
    expect(store.get('kyneloom.lens')).toBe('analyst');
    // A corrupted preference can only ever mean Fan.
    store.set('kyneloom.lens', '{"role":"producer"}');
    cleanup();
    await renderStage();
    expect(screen.getByRole('radio', { name: 'Fan' }).getAttribute('aria-checked')).toBe('true');
    vi.unstubAllGlobals();
  });

  it('repeated lens switching spawns no duplicate transport or panels', async () => {
    await renderStage();
    for (let round = 0; round < 4; round += 1) {
      fireEvent.click(screen.getByRole('radio', { name: 'Analyst' }));
      fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
      fireEvent.click(screen.getByRole('radio', { name: 'Fan' }));
    }
    expect(screen.getAllByTestId('lens-dock')).toHaveLength(1);
    expect(document.querySelectorAll('.stage__transport')).toHaveLength(1);
    expect(screen.queryByTestId('analyst-rail')).toBeNull();
    expect(screen.queryByTestId('accessible-panel')).toBeNull();
  });
});

describe('KYN-11 review round — analyst facts DOM integrity', () => {
  it('keeps the semantic facts list intact while the live detail value updates', async () => {
    await renderStage();
    fireEvent.click(screen.getByRole('radio', { name: 'Analyst' }));
    const factsList = () => document.querySelector('.rail__facts') as HTMLDListElement | null;
    const detail = () => document.querySelector('[data-testid="rail-selected-detail"]');
    expect(factsList()).not.toBeNull();
    expect(detail()?.textContent).toBe('select a player in the scene');

    // Select a player through the projected-selection bridge.
    fireEvent(window, new CustomEvent('kyneloom:scene-select', { detail: 'home-11' }));
    // The 250 ms rail sync writes the live value into the LEAF ONLY.
    await waitFor(() => expect(detail()?.textContent).toContain('home-11'), { timeout: 2000 });
    // The React-owned semantic structure survives every update.
    const labels = [...(factsList()?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent);
    expect(labels).toEqual(['Selection', 'Selected detail']);
    expect(factsList()?.querySelectorAll('dd').length).toBe(2);
    expect(factsList()?.querySelector('dd')?.textContent).toContain('northbridge-athletic #11'); // React-owned selection value intact

    // Advance time — the detail value changes; labels persist.
    const valueBeforeSeek = detail()?.textContent ?? '';
    fireEvent.input(slider(), { target: { value: '4726200' } });
    await waitFor(() => expect(detail()?.textContent).not.toBe(valueBeforeSeek), { timeout: 2000 });
    expect(detail()?.textContent).toMatch(
      /home-11: -?\d+\.\d, -?\d+\.\d m · \d+\.\d m\/s · synthetic_ground_truth/,
    );
    expect([...(factsList()?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent)).toEqual([
      'Selection',
      'Selected detail',
    ]);

    // Switch selection to another player, then leave and return to Analyst.
    fireEvent(window, new CustomEvent('kyneloom:scene-select', { detail: 'away-03' }));
    await waitFor(() => expect(detail()?.textContent).toContain('away-03'), { timeout: 2000 });
    fireEvent.click(screen.getByRole('radio', { name: 'Fan' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Analyst' }));
    await waitFor(() => expect(detail()?.textContent).toContain('away-03'), { timeout: 2000 });
    expect(
      [...(document.querySelectorAll('.rail__facts dt') ?? [])].map((dt) => dt.textContent),
    ).toEqual(['Selection', 'Selected detail']);
  });
});

describe('KYN-11 review round — accessible announcement channel', () => {
  it('the spatial description is readable, not a live region; announcements are separate and concise', async () => {
    await renderStage();
    fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
    const description = await screen.findByTestId('spatial-description');
    expect(description.getAttribute('aria-live')).toBeNull();
    expect(description.getAttribute('role')).toBe('region');
    const live = screen.getByTestId('live-announcement');
    expect(live.getAttribute('role')).toBe('status');
  });

  it('coordinate/time updates refresh the description WITHOUT announcing', async () => {
    await renderStage();
    fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
    const description = await screen.findByTestId('spatial-description');
    const live = screen.getByTestId('live-announcement');
    await waitFor(() => expect(description.textContent).toContain('78:42.1'));
    const countBefore = Number(live.dataset.count ?? '0');
    // Move within the same open-play stretch: description changes, live
    // channel must not re-announce the whole paragraph.
    fireEvent.input(slider(), { target: { value: '4721900' } });
    await waitFor(() => expect(description.dataset.playhead).toBe('4721900'));
    await waitFor(() => expect(description.textContent).not.toContain('78:42.1'));
    expect(Number(live.dataset.count ?? '0')).toBe(countBefore);
  });

  it('deliberate transcript seeking announces concisely, once per action, deduplicated', async () => {
    await renderStage();
    fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
    const live = screen.getByTestId('live-announcement');
    const countBefore = Number(live.dataset.count ?? '0');
    fireEvent.click(screen.getByRole('button', { name: /GOAL · 78:48.3/ }));
    await waitFor(() => expect(slider().value).toBe('4728300'));
    await waitFor(() => expect(live.textContent).toContain('Jumped to 78:48.3'));
    // Concise: the event context rides along, never the spatial paragraph.
    expect(live.textContent).toContain('GOAL');
    expect(live.textContent).not.toContain('The ball is at');
    expect(Number(live.dataset.count ?? '0')).toBe(countBefore + 1);
    // A DIFFERENT deliberate seek announces its own destination; the sync
    // loop does not overwrite it (the seek claims the event key).
    fireEvent.click(screen.getByRole('button', { name: /Pass received · 78:46.2/ }));
    await waitFor(() => expect(slider().value).toBe('4726200'));
    await waitFor(() => expect(live.textContent).toContain('Jumped to 78:46.2'));
    expect(Number(live.dataset.count ?? '0')).toBe(countBefore + 2);
    // Repeating the SAME seek is deduplicated — no re-announcement.
    fireEvent.click(screen.getByRole('button', { name: /Pass received · 78:46.2/ }));
    await waitFor(() => expect(slider().value).toBe('4726200'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Number(live.dataset.count ?? '0')).toBe(countBefore + 2);
  });

  it('source-event transitions during playback announce once each; drift never announces', async () => {
    await renderStage();
    fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
    const live = screen.getByTestId('live-announcement');
    const description = screen.getByTestId('spatial-description');
    // Start OUTSIDE the event tolerance so the first (silent) sync adopts
    // the upcoming key; playback then crosses INTO the active window.
    fireEvent.input(slider(), { target: { value: '4723600' } });
    await waitFor(() => expect(description.dataset.playhead).toBe('4723600'));
    const countBeforePlay = Number(live.dataset.count ?? '0');
    const panelPlay = within(screen.getByTestId('accessible-panel')).getByRole('button', {
      name: 'Play',
    });
    fireEvent.click(panelPlay);
    // Entering the pass-release window (4723650) announces it — concisely.
    await waitFor(() => expect(live.textContent).toContain('Pass released'), { timeout: 6000 });
    expect(live.textContent).toContain('home-08');
    expect(live.textContent).not.toContain('The ball is at'); // never the paragraph
    const countAtEvent = Number(live.dataset.count ?? '0');
    expect(countAtEvent).toBe(countBeforePlay + 1);
    // Keep playing: the description keeps refreshing (real drift), while the
    // announcement channel stays bounded — only source-event transitions
    // add entries (at most one more, when the active window is left).
    const playheadBefore = description.dataset.playhead;
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(description.dataset.playhead).not.toBe(playheadBefore); // description IS live
    expect(Number(live.dataset.count ?? '0')).toBeLessThanOrEqual(countAtEvent + 1);
    fireEvent.click(
      within(screen.getByTestId('accessible-panel')).getByRole('button', { name: 'Pause' }),
    );
  });
});

describe('KYN-20 — audio-first playback & synchronized transcript', () => {
  /** Deterministic device-speech stub: counts controller-driven engine calls. */
  function stubSpeech(): {
    spoken: { text: string; rate: number }[];
    cancelled: () => number;
    paused: () => number;
    resumed: () => number;
  } {
    const state = {
      spoken: [] as { text: string; rate: number }[],
      cancel: 0,
      pause: 0,
      resume: 0,
    };
    class Utterance {
      readonly text: string;
      rate: number;
      constructor(text: string) {
        this.text = text;
        this.rate = 1;
      }
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    const engine = {
      speaking: true,
      paused: false,
      speak: (u: { text: string; rate: number }): void => {
        state.spoken.push({ text: u.text, rate: u.rate });
      },
      cancel: (): void => {
        state.cancel += 1;
      },
      pause: (): void => {
        state.pause += 1;
        engine.paused = true; // a stateful engine, like the real one
      },
      resume: (): void => {
        state.resume += 1;
        engine.paused = false;
      },
    };
    vi.stubGlobal('speechSynthesis', engine);
    return {
      spoken: state.spoken,
      cancelled: (): number => state.cancel,
      paused: (): number => state.pause,
      resumed: (): number => state.resume,
    };
  }

  async function enterAccessible(): Promise<void> {
    fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
    await screen.findByTestId('accessible-panel');
  }

  it('A — speech is strictly opt-in: mounting, playing and drifting NEVER speak', async () => {
    const speech = stubSpeech();
    await renderStage();
    await enterAccessible();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(speech.spoken).toHaveLength(0);
    // Playback with transitions still never speaks without the opt-in.
    const panel = screen.getByTestId('accessible-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Play' }));
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(speech.spoken).toHaveLength(0);
    const playback = within(panel).getByRole('region', { name: 'Playback' });
    fireEvent.click(within(playback).getByRole('button', { name: /^Pause$/ }));
  });

  it('B — follow, pause, resume, rate and stop drive the controller correctly', async () => {
    const speech = stubSpeech();
    await renderStage();
    await enterAccessible();
    const panel = screen.getByTestId('accessible-panel');
    const follow = within(panel).getByRole('button', { name: /Follow narration/ });
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(follow); // explicit user start
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(speech.spoken.length).toBeGreaterThanOrEqual(1));
    expect(speech.spoken[0]!.text).toContain('Following narration.');
    // Pause / Resume reach the engine through the controller (scoped to the
    // narration controls — the transport has its own Play/Pause).
    const audio = within(panel).getByTestId('audio-controls');
    fireEvent.click(within(audio).getByRole('button', { name: /^Pause$/ }));
    expect(speech.paused()).toBe(1);
    fireEvent.click(within(audio).getByRole('button', { name: /^Resume$/ }));
    expect(speech.resumed()).toBe(1);
    // Rate changes apply to the NEXT utterance.
    const rateSlider = audio.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.input(rateSlider, { target: { value: '1.25' } });
    fireEvent.click(within(audio).getByRole('button', { name: 'Speak current state' }));
    await waitFor(() => expect(speech.spoken.length).toBeGreaterThanOrEqual(2));
    expect(speech.spoken.at(-1)!.rate).toBe(1.25);
    // Stop cancels AND disarms follow mode (review round): the toggle
    // resets to off by itself — later transitions stay silent.
    fireEvent.click(within(audio).getByRole('button', { name: /^Stop$/ }));
    expect(speech.cancelled()).toBeGreaterThanOrEqual(1);
    expect(
      within(panel)
        .getByRole('button', { name: /Follow narration/ })
        .getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('C — a deliberate transcript seek cancels stale narration and keeps the canonical playhead', async () => {
    const speech = stubSpeech();
    await renderStage();
    await enterAccessible();
    const panel = screen.getByTestId('accessible-panel');
    fireEvent.click(within(panel).getByRole('button', { name: /Follow narration/ }));
    await waitFor(() => expect(speech.spoken.length).toBeGreaterThanOrEqual(1));
    const cancelsBefore = speech.cancelled();
    fireEvent.click(within(panel).getByRole('button', { name: /GOAL · 78:48.3/ }));
    // Stale narration cancelled, destination narrated, THE shared slider
    // (the canonical transport) carries the seek.
    expect(speech.cancelled()).toBeGreaterThan(cancelsBefore);
    await waitFor(() => expect(slider().value).toBe('4728300'));
    await waitFor(() => expect(speech.spoken.at(-1)!.text).toContain('Jumped to 78:48.3'));
  });

  it('D — the transcript active entry follows playback and deliberate seeks', async () => {
    await renderStage();
    await enterAccessible();
    const panel = screen.getByTestId('accessible-panel');
    fireEvent.click(within(panel).getByRole('button', { name: /Pass received · 78:46.2/ }));
    const received = within(panel).getByRole('button', { name: /Pass received · 78:46.2/ });
    // The bounded sync loop marks the entry at/before the playhead.
    await waitFor(() => expect(received.getAttribute('aria-current')).toBe('true'), {
      timeout: 4000,
    });
    expect(received.closest('li')?.getAttribute('data-active')).toBe('true');
    // Seeking later moves the marker — exactly one current entry at a time.
    fireEvent.click(within(panel).getByRole('button', { name: /GOAL · 78:48.3/ }));
    const goal = within(panel).getByRole('button', { name: /GOAL · 78:48.3/ });
    await waitFor(() => expect(goal.getAttribute('aria-current')).toBe('true'), {
      timeout: 4000,
    });
    expect(received.getAttribute('aria-current')).toBeNull();
  });

  it('E — provenance ids render for every entry kind; measurement cites its fingerprint', async () => {
    await renderStage();
    await enterAccessible();
    const panel = screen.getByTestId('accessible-panel');
    const measurement = within(panel).getByRole('button', { name: /Measured separation/ });
    expect(measurement.querySelector('.a11y__entry-id')?.textContent).toMatch(/^measurement:/);
    const interpretation = within(panel).getByRole('button', { name: /Tactical reading/ });
    expect(interpretation.querySelector('.a11y__entry-id')?.textContent).toBe(
      'interpretation:separation',
    );
  });

  it('G/H — keyboard-activatable journey: play/pause, slider seek, 2D switch, lens change keeps time', async () => {
    await renderStage();
    await enterAccessible();
    const panel = screen.getByTestId('accessible-panel');
    // Play/pause via the panel's real buttons (keyboard-activatable).
    fireEvent.click(within(panel).getByRole('button', { name: 'Play' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Pause' }));
    // Seek through the canonical slider (arrow-key operable range input).
    fireEvent.input(slider(), { target: { value: '4726200' } });
    await waitFor(() => expect(slider().value).toBe('4726200'));
    // The 2D tactical switch is a real button and flips the view honestly.
    fireEvent.click(within(panel).getByRole('button', { name: 'Switch to the 2D tactical view' }));
    expect(document.querySelector('[data-scene-fallback="user-choice"]')).not.toBeNull();
    // Lens switch preserves the shared playhead (no second clock).
    fireEvent.input(slider(), { target: { value: '4728300' } });
    await waitFor(() => expect(slider().value).toBe('4728300'));
    fireEvent.click(screen.getByRole('radio', { name: 'Fan' }));
    await waitFor(() => expect(() => screen.getByTestId('accessible-panel')).toThrow());
    await waitFor(() => expect(slider().value).toBe('4728300'));
  });

  it('I — repeated lens switching never duplicates speech or leaks the sync loop', async () => {
    const speech = stubSpeech();
    await renderStage();
    for (let round = 0; round < 3; round += 1) {
      await enterAccessible();
      await new Promise((resolve) => setTimeout(resolve, 350));
      fireEvent.click(screen.getByRole('radio', { name: 'Fan' }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // No user speech action was taken: nothing ever spoke, nothing queued.
    expect(speech.spoken).toHaveLength(0);
    // The announcement channel is bounded across remounts (fresh counters).
    await enterAccessible();
    const live = screen.getByTestId('live-announcement');
    expect(Number(live.dataset.count ?? '0')).toBeLessThanOrEqual(2);
  });
});

describe('KYN-20 review round — narration-control synchronization', () => {
  function stubSpeechStateful(): {
    spoken: { text: string; rate: number }[];
    cancelled: () => number;
    paused: () => number;
    resumed: () => number;
  } {
    const state = {
      spoken: [] as { text: string; rate: number }[],
      cancel: 0,
      pause: 0,
      resume: 0,
    };
    class Utterance {
      readonly text: string;
      rate: number;
      constructor(text: string) {
        this.text = text;
        this.rate = 1;
      }
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    const engine = {
      speaking: true,
      paused: false,
      speak: (u: { text: string; rate: number }): void => {
        state.spoken.push({ text: u.text, rate: u.rate });
      },
      cancel: (): void => {
        state.cancel += 1;
      },
      pause: (): void => {
        state.pause += 1;
        engine.paused = true;
      },
      resume: (): void => {
        state.resume += 1;
        engine.paused = false;
      },
    };
    vi.stubGlobal('speechSynthesis', engine);
    return {
      spoken: state.spoken,
      cancelled: (): number => state.cancel,
      paused: (): number => state.pause,
      resumed: (): number => state.resume,
    };
  }

  async function enterAccessiblePanel(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
    return screen.findByTestId('accessible-panel');
  }

  async function startFollowing(panel: HTMLElement): Promise<void> {
    fireEvent.click(within(panel).getByRole('button', { name: /Follow narration/ }));
    await waitFor(() =>
      expect(within(panel).getByTestId('follow-narration').getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
  }

  it('R1 — Pause is authoritative: a real transition during playback does NOT speak until Resume', async () => {
    const speech = stubSpeechStateful();
    await renderStage();
    const panel = await enterAccessiblePanel();
    await startFollowing(panel);
    await waitFor(() => expect(speech.spoken.length).toBeGreaterThanOrEqual(1));
    // Pause the narration controls (not the transport).
    fireEvent.click(
      within(within(panel).getByTestId('audio-controls')).getByRole('button', { name: /^Pause$/ }),
    );
    // Position BEFORE the pass-release window, then play across it — a
    // genuine source-event transition fires (the VISUAL announcement
    // channel still reports it), but narration must stay silent.
    fireEvent.input(slider(), { target: { value: '4723600' } });
    await waitFor(() => expect(slider().value).toBe('4723600'));
    fireEvent.click(
      within(within(panel).getByRole('region', { name: 'Playback' })).getByRole('button', {
        name: 'Play',
      }),
    );
    const live = screen.getByTestId('live-announcement');
    await waitFor(() => expect(live.textContent).toContain('Pass released'), { timeout: 8000 });
    const spokenAtTransition = speech.spoken.length;
    expect(spokenAtTransition).toBe(1); // only the explicit start line
    // Keep playing past more drift: still no new utterances.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(speech.spoken.length).toBe(spokenAtTransition);
    fireEvent.click(
      within(within(panel).getByRole('region', { name: 'Playback' })).getByRole('button', {
        name: /^Pause$/,
      }),
    );
    // Resume re-opens the gate: a deliberate transcript seek narrates again.
    fireEvent.click(
      within(within(panel).getByTestId('audio-controls')).getByRole('button', { name: /^Resume$/ }),
    );
    fireEvent.click(within(panel).getByRole('button', { name: /GOAL · 78:48.3/ }));
    await waitFor(() => expect(speech.spoken.at(-1)!.text).toContain('Jumped to 78:48.3'));
  });

  it('R2 — Stop cancels AND disarms follow: later transitions stay silent, button resets to off', async () => {
    const speech = stubSpeechStateful();
    await renderStage();
    const panel = await enterAccessiblePanel();
    await startFollowing(panel);
    await waitFor(() => expect(speech.spoken.length).toBeGreaterThanOrEqual(1));
    fireEvent.click(
      within(within(panel).getByTestId('audio-controls')).getByRole('button', { name: /^Stop$/ }),
    );
    const follow = within(panel).getByTestId('follow-narration');
    expect(follow.getAttribute('aria-pressed')).toBe('false'); // disarmed
    // A later genuine transition during playback must not revive it.
    fireEvent.input(slider(), { target: { value: '4723600' } });
    fireEvent.click(
      within(within(panel).getByRole('region', { name: 'Playback' })).getByRole('button', {
        name: 'Play',
      }),
    );
    const live = screen.getByTestId('live-announcement');
    await waitFor(() => expect(live.textContent).toContain('Pass released'), { timeout: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(speech.spoken.length).toBe(1); // nothing beyond the start line
    fireEvent.click(
      within(within(panel).getByRole('region', { name: 'Playback' })).getByRole('button', {
        name: /^Pause$/,
      }),
    );
  });

  it('R3 — frame stepping and the canonical slider cancel stale narration without unsolicited speech', async () => {
    const speech = stubSpeechStateful();
    await renderStage();
    const panel = await enterAccessiblePanel();
    await startFollowing(panel);
    await waitFor(() => expect(speech.spoken.length).toBeGreaterThanOrEqual(1));
    // Frame step (panel transport): deliberate navigation cancels in-flight.
    const cancelsBefore = speech.cancelled();
    fireEvent.click(
      within(within(panel).getByRole('region', { name: 'Playback' })).getByRole('button', {
        name: /Frame ▶/,
      }),
    );
    expect(speech.cancelled()).toBeGreaterThan(cancelsBefore);
    // Main transport slider (canonical clock, outside the panel): a jump
    // impossible at playback speed cancels the stale utterance — and while
    // NOT playing, never starts new speech.
    fireEvent.input(slider(), { target: { value: '4728300' } });
    await waitFor(() => expect(slider().value).toBe('4728300'));
    await new Promise((resolve) => setTimeout(resolve, 900)); // one sync cycle
    const cancelsAfterSlider = speech.cancelled();
    expect(cancelsAfterSlider).toBeGreaterThan(cancelsBefore);
    expect(speech.spoken.length).toBe(1); // cancel-only, no unsolicited speak
    // The canonical playhead carries the seek (no second clock).
    expect(slider().value).toBe('4728300');
  });

  it('R3c — while narration-paused, a transcript seek cancels but does NOT speak the destination', async () => {
    const speech = stubSpeechStateful();
    await renderStage();
    const panel = await enterAccessiblePanel();
    await startFollowing(panel);
    await waitFor(() => expect(speech.spoken.length).toBeGreaterThanOrEqual(1));
    fireEvent.click(
      within(within(panel).getByTestId('audio-controls')).getByRole('button', { name: /^Pause$/ }),
    );
    const spokenBefore = speech.spoken.length;
    fireEvent.click(within(panel).getByRole('button', { name: /GOAL · 78:48.3/ }));
    await waitFor(() => expect(slider().value).toBe('4728300'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(speech.spoken.length).toBe(spokenBefore); // no destination narration
    expect(speech.cancelled()).toBeGreaterThanOrEqual(1); // stale cancelled
  });

  it('R4 — leaving the lens destroys the controller: cancel observed, nothing speaks afterwards', async () => {
    const speech = stubSpeechStateful();
    await renderStage();
    const panel = await enterAccessiblePanel();
    await startFollowing(panel);
    await waitFor(() => expect(speech.spoken.length).toBeGreaterThanOrEqual(1));
    const cancelsBefore = speech.cancelled();
    const spokenBefore = speech.spoken.length;
    fireEvent.click(screen.getByRole('radio', { name: 'Fan' }));
    await waitFor(() => expect(() => screen.getByTestId('accessible-panel')).toThrow());
    // destroy() cancels; time passes with the lens off — no further speech.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(speech.cancelled()).toBeGreaterThan(cancelsBefore);
    expect(speech.spoken.length).toBe(spokenBefore);
  });
});
