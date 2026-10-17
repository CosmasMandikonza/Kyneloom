// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGoldenMatch } from '@/lib/match-fixture';

const pushed: string[] = [];
vi.mock('next/navigation', () => ({
  useRouter: (): { push: (url: string) => void; prefetch: () => void } => ({
    push: (url: string): void => {
      pushed.push(url);
    },
    prefetch: (): void => undefined,
  }),
}));

// WebGL "exists" so the encounter stays canvas-driven; the canvas itself is
// stubbed out (jsdom has no WebGL) — these tests exercise the DRIVER. The
// fallback test flips `caps.webgl` to false.
const caps = vi.hoisted(() => ({ webgl: true }));
vi.mock('@kyneloom/scene-renderer', () => ({
  detectSceneCapabilities: (): { webgl: boolean } => caps,
}));
vi.mock('./orb-field', () => ({
  OrbField: (): null => null,
}));
import { buildLandingField, type LandingFieldInput } from '@/lib/landing-geometry';
import { LandingExperience } from './landing-experience';

/**
 * KYN-09 — the landing encounter under jsdom (no WebGL): the editorial
 * contract holds (headline, one primary CTA, real fixture facts), the
 * truthful fallback path engages, and the deterministic field builds with
 * the device budget.
 */

afterEach(() => {
  caps.webgl = true;
  pushed.length = 0;
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubEnvironment(reducedMotion = false): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    return {
      matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
      media: query,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
      addListener: (): void => undefined,
      removeListener: (): void => undefined,
      dispatchEvent: (): boolean => false,
      onchange: null,
    } as unknown as MediaQueryList;
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  });
}

async function fieldInput(): Promise<LandingFieldInput> {
  const golden = await loadGoldenMatch();
  if (!golden.ok) throw new Error('golden fixture unavailable');
  const players: { entityId: string; xM: number; yM: number }[] = [];
  const seen = new Set<string>();
  for (const sample of golden.data.projected.acceptedTracking) {
    if (sample.sampleTimeMs !== golden.data.checkpointMs) continue;
    if (sample.entityId === 'ball' || seen.has(sample.entityId)) continue;
    seen.add(sample.entityId);
    players.push({ entityId: sample.entityId, xM: sample.xM, yM: sample.yM });
  }
  return {
    checkpointPlayers: players,
    checkpointBall: { xM: 21.241, yM: -2.172 },
    trajectories: [],
    fragmentCount: 0,
    seed: golden.data.seed,
  };
}

describe('LandingExperience (jsdom — no WebGL)', () => {
  it('shows the headline, one primary CTA and the real fixture facts', async () => {
    stubEnvironment();
    const input = await fieldInput();
    render(
      <LandingExperience
        fixtureFacts={{
          matchClock: '78:25',
          finalScore: '2–1',
          sampleCount: 47241,
          seed: 24017,
          fixtureNote: 'fixtures loaded',
          generatorVersion: 'fixture-engine-v1',
        }}
        fieldInput={input}
      />,
    );
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.textContent).toContain('Every moment');
    expect(title.textContent).toContain('world');
    const cta = screen.getByTestId('enter-the-moment');
    expect(cta.textContent).toContain('Enter the moment');
    expect(screen.getByText('78:25')).toBeTruthy();
    expect(screen.getByText('2–1')).toBeTruthy();
    expect(screen.getByText('47,241')).toBeTruthy();
  });

  it('without WebGL the CTA becomes a direct link (truthful fallback)', async () => {
    stubEnvironment();
    caps.webgl = false;
    const input = await fieldInput();
    render(
      <LandingExperience
        fixtureFacts={{
          matchClock: null,
          finalScore: null,
          sampleCount: null,
          seed: null,
          fixtureNote: 'fixtures loaded',
          generatorVersion: null,
        }}
        fieldInput={input}
      />,
    );
    await waitFor(
      () => {
        expect(screen.getByRole('heading', { level: 1 }).closest('section')!.dataset.phase).toBe(
          'fallback',
        );
      },
      { timeout: 2000 },
    );
    const cta = screen.getByTestId('enter-the-moment');
    expect(cta.getAttribute('href')).toBe('/explore');
    expect(screen.getByRole('status').textContent).toContain('WebGL');
  });

  it('review gate 2 — during the transition the CTA stays an inert button, never a /explore link', async () => {
    stubEnvironment();
    const input = await fieldInput();
    render(
      <LandingExperience
        fixtureFacts={{
          matchClock: null,
          finalScore: null,
          sampleCount: null,
          seed: null,
          fixtureNote: 'fixtures loaded',
          generatorVersion: null,
        }}
        fieldInput={input}
      />,
    );
    const stage = screen.getByRole('heading', { level: 1 }).closest('section')!;
    const cta = screen.getByTestId('enter-the-moment');
    // Idle: a real button, no href.
    expect(cta.tagName).toBe('BUTTON');
    expect(cta.getAttribute('href')).toBeNull();
    fireEvent.click(cta);
    expect(stage.dataset.phase).toBe('intro');
    // During the transition: STILL a button (busy), no navigation href a
    // second click could follow, and activation is inert.
    expect(cta.tagName).toBe('BUTTON');
    expect(cta.getAttribute('href')).toBeNull();
    expect(cta.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(cta);
    fireEvent.click(cta);
    expect(stage.dataset.phase).toBe('intro'); // never re-entered
    expect(pushed).toEqual([]); // no direct /explore navigation bypass
  });

  it('review gate 1 — a live reduced-motion preference transitions idle straight to ready (no choreography)', async () => {
    stubEnvironment(true);
    const input = await fieldInput();
    render(
      <LandingExperience
        fixtureFacts={{
          matchClock: null,
          finalScore: null,
          sampleCount: null,
          seed: null,
          fixtureNote: 'fixtures loaded',
          generatorVersion: null,
        }}
        fieldInput={input}
      />,
    );
    const stage = screen.getByRole('heading', { level: 1 }).closest('section')!;
    await waitFor(() => {
      expect(stage.dataset.reducedMotion).toBe('true');
    });
    fireEvent.click(screen.getByTestId('enter-the-moment'));
    // PHASE assertion (not navigation): ready immediately, never intro.
    expect(stage.dataset.phase).toBe('ready');
    await waitFor(() => {
      expect(pushed).toEqual(['/explore?enter=orb']);
    });
  });

  it('builds the deterministic field from the real checkpoint players', async () => {
    const input = await fieldInput();
    expect(input.checkpointPlayers.length).toBe(22);
    const field = buildLandingField({ ...input, fragmentCount: 64 });
    expect(field.fragments).toHaveLength(64);
    expect(field.checkpointMarkers.length).toBe(23); // 22 players + ball
  });
});
