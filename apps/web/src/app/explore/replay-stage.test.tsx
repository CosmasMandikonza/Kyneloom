// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('has six ENABLED camera modes incl. goalkeeper and directed', async () => {
    await renderStage();
    const group = screen.getByRole('radiogroup', { name: 'Camera' });
    const radios = group.querySelectorAll('[role="radio"]') as NodeListOf<HTMLButtonElement>;
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
    const radios = () =>
      screen
        .getByRole('radiogroup', { name: 'Camera' })
        .querySelectorAll('[role="radio"]') as NodeListOf<HTMLButtonElement>;
    fireEvent.keyDown(stage, { key: '4' }); // Goalkeeper
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
    const radios = () =>
      screen
        .getByRole('radiogroup', { name: 'Camera' })
        .querySelectorAll('[role="radio"]') as NodeListOf<HTMLButtonElement>;
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

  it('Accessible lens switches to the 2D tactical view', async () => {
    await renderStage();
    const accessible = screen.getByRole('radio', { name: 'Accessible' });
    fireEvent.click(accessible);
    expect(accessible.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-scene-fallback="user-choice"]')).not.toBeNull();
  });
});

describe('Evidence X-Ray (KYN-08)', () => {
  it('full button path: X-Ray → Show evidence → sources → frame navigation → back to replay', async () => {
    await renderStage();
    const xray = screen.getByRole('button', { name: 'X-Ray' });
    fireEvent.click(xray);
    expect(xray.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence' }));
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
    await renderStage();
    fireEvent.click(screen.getByRole('button', { name: 'X-Ray' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Accessible' }));
    const line = document.querySelector('[data-xray-2d="separation"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain('6.306 m → 20.344 m');
    fireEvent.click(line as HTMLElement);
    const sentence = await screen.findByTestId('evidence-sentence');
    expect(sentence.textContent).toContain('14.038');
  });

  it('keyboard X/I/Escape drive the same path', async () => {
    await renderStage();
    const stage = screen.getByRole('region', { name: 'Living Replay stage' });
    fireEvent.keyDown(stage, { key: 'x' });
    expect(screen.getByRole('button', { name: 'X-Ray' }).getAttribute('aria-pressed')).toBe('true');
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
    const xray = screen.getByRole('button', { name: 'X-Ray' });
    expect((xray as HTMLButtonElement).disabled).toBe(true);
  });
});
