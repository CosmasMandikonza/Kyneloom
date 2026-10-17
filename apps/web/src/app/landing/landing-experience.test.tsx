// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGoldenMatch } from '@/lib/match-fixture';

vi.mock('next/navigation', () => ({
  useRouter: (): { push: ReturnType<typeof vi.fn>; prefetch: ReturnType<typeof vi.fn> } => ({
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
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
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubEnvironment(): void {
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

  it('builds the deterministic field from the real checkpoint players', async () => {
    const input = await fieldInput();
    expect(input.checkpointPlayers.length).toBe(22);
    const field = buildLandingField({ ...input, fragmentCount: 64 });
    expect(field.fragments).toHaveLength(64);
    expect(field.checkpointMarkers.length).toBe(23); // 22 players + ball
  });
});
