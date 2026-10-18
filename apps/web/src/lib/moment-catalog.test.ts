import { describe, expect, it } from 'vitest';
import { loadGoldenMatch } from './match-fixture';
import { SEPARATION_INPUT } from './evidence-data';
import {
  buildMomentCatalog,
  exploreHrefFor,
  MEASURED_INTERVAL_MS,
  resolveMomentSelection,
} from './moment-catalog';

/**
 * KYN-10 catalog truth tests. Every assertion protects the same invariant:
 * the gallery may only offer beats the accepted fixture actually contains.
 */

async function catalog() {
  const golden = await loadGoldenMatch();
  if (!golden.ok) throw new Error(`golden fixture unavailable: ${golden.message}`);
  return buildMomentCatalog(golden);
}

describe('moment catalog (KYN-10)', () => {
  it('builds a deterministic catalog with a featured entry and 12 distinct chapters', async () => {
    const built = await catalog();
    if (built === null) throw new Error('catalog unexpectedly null');
    expect(built.matchId).toBe('synthetic-derby-01');
    expect(built.chapters).toHaveLength(12);
    expect(built.featured.chapter).toBeNull();
    expect(built.chapters.map((chapter) => chapter.chapter)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    const ids = [built.featured, ...built.chapters].map((entry) => entry.catalogId);
    expect(new Set(ids).size).toBe(13);
    const focusTimes = built.chapters.map((chapter) => chapter.focusMs);
    expect(new Set(focusTimes).size).toBe(12);
    // Chapters run forward through the window.
    const sorted = [...focusTimes].sort((a, b) => a - b);
    expect(focusTimes).toEqual(sorted);
  });

  it('is byte-stable across builds (same input → same catalog)', async () => {
    const a = await catalog();
    const b = await catalog();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps every focus inside the golden window on the 100 ms grid', async () => {
    const built = await catalog();
    if (built === null) throw new Error('catalog unexpectedly null');
    const [start, end] = built.windowMs;
    for (const entry of [built.featured, ...built.chapters]) {
      expect(entry.focusMs).toBeGreaterThanOrEqual(start);
      expect(entry.focusMs).toBeLessThanOrEqual(end);
      expect(entry.focusMs % 100).toBe(0);
      expect(entry.matchId).toBe('synthetic-derby-01');
      expect(entry.sourceStatus).toBe('synthetic');
    }
  });

  it('cites only real accepted events for the four event chapters', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) throw new Error('fixture unavailable');
    const built = buildMomentCatalog(golden);
    if (built === null) throw new Error('catalog unexpectedly null');
    const acceptedIds = new Set(golden.data.projected.acceptedEvents.map((event) => event.eventId));
    const withEvents = built.chapters.filter((chapter) => chapter.eventId !== null);
    expect(withEvents).toHaveLength(4);
    for (const chapter of withEvents) {
      expect(acceptedIds.has(chapter.eventId as string)).toBe(true);
    }
    // The event chapters are the pass attempt/completion, shot and goal.
    expect(withEvents.map((chapter) => chapter.eventKind)).toEqual([
      'pass_attempted',
      'pass_completed',
      'shot_attempted',
      'goal',
    ]);
    // Each cited event happens exactly at the chapter focus.
    for (const chapter of withEvents) {
      const event = golden.data.projected.acceptedEvents.find(
        (candidate) => candidate.eventId === chapter.eventId,
      );
      expect(event?.occurredAtMs).toBe(chapter.focusMs);
    }
  });

  it('computes the measured separation facts exactly (cross-checked with metadata)', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) throw new Error('fixture unavailable');
    const built = buildMomentCatalog(golden);
    if (built === null) throw new Error('catalog unexpectedly null');
    const byId = new Map(built.chapters.map((chapter) => [chapter.catalogId, chapter]));
    // The metadata golden block is the authority: 6.306 → 20.344.
    expect(byId.get('ia-02-run-develops')?.facts.separationM?.toFixed(3)).toBe('5.281');
    expect(byId.get('ia-05-lane-opens')?.facts.separationM?.toFixed(3)).toBe('20.344');
    expect(built.featured.facts.separationM?.toFixed(3)).toBe('6.306');
    // Top speed chapter reproduces the metadata's 7.183 m/s.
    expect(byId.get('ia-04-top-speed')?.facts.runnerSpeedMps?.toFixed(3)).toBe('7.183');
    // Ball at the canonical checkpoint (golden truth 21.241, -2.172).
    const checkpoint = byId.get('ia-03-measured-checkpoint');
    expect(checkpoint?.facts.ballAt?.xM.toFixed(3)).toBe('21.241');
    expect(checkpoint?.facts.ballAt?.yM.toFixed(3)).toBe('-2.172');
    // Score flips to 1-1 only from the goal chapter onward.
    expect(byId.get('ia-05-lane-opens')?.facts.scoreLine).toBe('0-1');
    expect(byId.get('ia-10-the-equalizer')?.facts.scoreLine).toBe('1-1');
    expect(byId.get('ia-11-aftermath')?.facts.scoreLine).toBe('1-1');
  });

  it('mirrors the X-Ray measurement interval so contexts cannot drift', async () => {
    expect([...MEASURED_INTERVAL_MS]).toEqual([SEPARATION_INPUT.fromMs, SEPARATION_INPUT.toMs]);
    const built = await catalog();
    if (built === null) throw new Error('catalog unexpectedly null');
    const inWindow = built.chapters.filter(
      (chapter) => chapter.evidenceContext === 'measured-window',
    );
    for (const chapter of inWindow) {
      expect(chapter.focusMs).toBeGreaterThanOrEqual(MEASURED_INTERVAL_MS[0]);
      expect(chapter.focusMs).toBeLessThanOrEqual(MEASURED_INTERVAL_MS[1]);
    }
    // The featured presentation starts exactly at the measured interval.
    expect(built.featured.focusMs).toBe(MEASURED_INTERVAL_MS[0]);
    expect(built.featured.evidenceContext).toBe('measured-window');
  });
});

describe('resolveMomentSelection (the catalog→viewer seam)', () => {
  it('accepts valid featured and chapter ids', async () => {
    const built = await catalog();
    if (built === null) throw new Error('catalog unexpectedly null');
    const featured = resolveMomentSelection(built, 'ia-00-invisible-assist');
    expect(featured.status).toBe('selected');
    const chapter = resolveMomentSelection(built, 'ia-10-the-equalizer');
    expect(chapter.status).toBe('selected');
    if (chapter.status === 'selected') {
      expect(chapter.entry.focusMs).toBe(4_728_300);
      expect(exploreHrefFor(chapter.entry)).toBe('/explore?moment=ia-10-the-equalizer');
    }
  });

  it('rejects unknown, malformed and hostile ids without throwing', async () => {
    const built = await catalog();
    for (const raw of [
      'does-not-exist',
      'IA-10',
      '../../etc/passwd',
      '<script>alert(1)</script>',
      'ia-10-the-equalizer extra',
      '',
    ]) {
      const resolved = resolveMomentSelection(built, raw);
      if (raw === '') expect(resolved.status).toBe('none');
      else expect(resolved.status).toBe('unknown');
    }
    // Arrays (repeated query params) resolve on the first value only.
    expect(
      resolveMomentSelection(built, ['ia-10-the-equalizer', 'ia-01-possession-settles']).status,
    ).toBe('selected');
    expect(resolveMomentSelection(built, undefined).status).toBe('none');
    expect(resolveMomentSelection(null, 'ia-10-the-equalizer').status).toBe('unknown');
  });
});
