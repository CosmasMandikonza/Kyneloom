import { describe, expect, it } from 'vitest';
import { loadGoldenMatch } from './match-fixture';
import { buildSceneData } from './scene-data';
import { buildEvidenceProjection } from './evidence-data';
import { sceneTimeline } from './scene-client';
import { createFrameCache } from '@/app/explore/scene/scene-context';
import { describeSpatialState, fanExplanation, transcriptEntries } from './lens-selectors';

/**
 * KYN-11 selector truth tests: every presentation is DERIVED from the same
 * authoritative inputs — the description must track the real sampled state,
 * the transcript must carry real source event ids with honest
 * classifications, and the fan narrative must reuse the verified metric.
 */

async function fixture() {
  const golden = await loadGoldenMatch();
  if (!golden.ok) throw new Error(`fixture unavailable: ${golden.message}`);
  const scene = buildSceneData(golden);
  if (scene === null) throw new Error('scene null');
  const timeline = sceneTimeline(scene);
  const getFrame = createFrameCache(timeline, scene.ballEntityId);
  const evidence = buildEvidenceProjection(golden);
  return { scene, getFrame, evidence };
}

describe('describeSpatialState (accessible descriptions)', () => {
  it('describes the REAL sampled state and changes with the playhead', async () => {
    const { scene, getFrame } = await fixture();
    const early = describeSpatialState({
      scene,
      frame: getFrame(4_717_000),
      playheadMs: 4_717_000,
      selectedEntityId: null,
    });
    expect(early.summary).toContain('78:37.0');
    expect(early.details.join(' ')).toContain('5.2'); // ball x at the window open
    // Ball truth at the checkpoint (golden 21.241, -2.172).
    const mid = describeSpatialState({
      scene,
      frame: getFrame(4_722_100),
      playheadMs: 4_722_100,
      selectedEntityId: 'home-11',
    });
    const text = mid.details.join(' ');
    expect(mid.summary).toContain('78:42.1');
    expect(text).toContain('21.2');
    expect(text).toContain('home-11');
    expect(text).toContain('number 11');
    // …and it is not hardcoded: the two instants describe different worlds.
    expect(early.details.join(' ')).not.toBe(mid.details.join(' '));
  });

  it('discloses exactness/interpolation and full tracking coverage honestly', async () => {
    const { scene, getFrame } = await fixture();
    const onGrid = describeSpatialState({
      scene,
      frame: getFrame(4_722_100),
      playheadMs: 4_722_100,
      selectedEntityId: 'away-03',
    }).details.join(' ');
    expect(onGrid).toContain('All 22 players and the ball are tracked');
    // Off-grid playhead: the frame is interpolated — the description says so.
    const offGrid = describeSpatialState({
      scene,
      frame: getFrame(4_722_150),
      playheadMs: 4_722_150,
      selectedEntityId: 'away-03',
    }).details.join(' ');
    expect(offGrid).toContain('interpolated');
  });

  it('speaks uncertainty, never invention, for unknown selections', async () => {
    const { scene, getFrame } = await fixture();
    const unknown = describeSpatialState({
      scene,
      frame: getFrame(4_722_100),
      playheadMs: 4_722_100,
      selectedEntityId: 'not-a-player',
    }).details.join(' ');
    expect(unknown).toContain('no tracked position');
  });
});

describe('transcriptEntries', () => {
  it('carries the real source event ids with honest classifications', async () => {
    const { scene, evidence } = await fixture();
    const entries = transcriptEntries(scene, evidence);
    const ids = entries.filter((entry) => entry.kind === 'event').map((entry) => entry.id);
    expect(ids).toEqual(['evt-0007', 'evt-0042', 'evt-0009', 'evt-0010']);
    const measurement = entries.find((entry) => entry.kind === 'measurement');
    expect(measurement?.description).toContain('14.038');
    expect(measurement?.description).toContain('separation-v1');
    const interpretation = entries.find((entry) => entry.kind === 'interpretation');
    expect(interpretation?.id).toBe('interpretation:separation');
    // Interpretation is NEVER classified as a measurement or event.
    expect(interpretation?.kind).toBe('interpretation');
  });

  it('omits the measurement entries entirely when evidence is unverified', async () => {
    const { scene } = await fixture();
    const entries = transcriptEntries(scene, {
      status: 'unverified',
      reason: 'verification failed',
      defenderId: 'away-03',
      strikerId: 'home-09',
      fromMs: 4_720_500,
      toMs: 4_724_000,
    });
    expect(entries.every((entry) => entry.kind === 'event')).toBe(true);
    expect(entries).toHaveLength(4);
  });
});

describe('fanExplanation', () => {
  it('uses the verified metric and keeps cause as interpretation', async () => {
    const { evidence } = await fixture();
    const story = fanExplanation(evidence);
    if (story === null) throw new Error('story unexpectedly null');
    expect(story.body).toContain('14.038');
    expect(story.body).toContain('6.306');
    expect(story.body).toContain('20.344');
    expect(story.body).toContain('interpretation');
    expect(story.body).not.toContain('14.037');
  });

  it('returns null when nothing is verified (no invented story)', async () => {
    expect(
      fanExplanation({
        status: 'unverified',
        reason: 'verification failed',
        defenderId: 'away-03',
        strikerId: 'home-09',
        fromMs: 4_720_500,
        toMs: 4_724_000,
      }),
    ).toBeNull();
  });
});

describe('neutral coordinate-relative pitch zones (review round 3)', () => {
  it('describes X zones neutrally — right/left/middle thirds of the pitch itself', async () => {
    const { scene, getFrame } = await fixture();
    const frame = getFrame(4_722_100);
    // Find real players at both ends of the pitch from the sampled frame.
    const right = scene.players.find((p) => (frame.positions.get(p.entityId)?.xM ?? 0) > 34.5);
    const left = scene.players.find((p) => (frame.positions.get(p.entityId)?.xM ?? 0) < -34.5);
    const middle = scene.players.find((p) => {
      const x = frame.positions.get(p.entityId)?.xM ?? 0;
      return x >= -34.5 && x <= 34.5;
    });
    expect(right).toBeDefined();
    expect(left).toBeDefined();
    expect(middle).toBeDefined();
    const describe = (id: string): string =>
      describeSpatialState({
        scene,
        frame,
        playheadMs: 4_722_100,
        selectedEntityId: id,
      }).details.join(' ');
    // Both teams' players at the SAME end get the SAME coordinate-relative
    // wording — no team-relative attack direction is invented from X.
    expect(describe(right!.entityId)).toContain('right third of the pitch');
    expect(describe(left!.entityId)).toContain('left third of the pitch');
    expect(describe(middle!.entityId)).toContain('middle third of the pitch');
  });

  it('never uses team-relative attacking/defending zone language anywhere', async () => {
    const { scene, getFrame } = await fixture();
    for (const t of [4_717_000, 4_722_100, 4_726_200, 4_728_300, 4_731_000]) {
      const frame = getFrame(t);
      for (const player of scene.players.slice(0, 6)) {
        const text = describeSpatialState({
          scene,
          frame,
          playheadMs: t,
          selectedEntityId: player.entityId,
        }).details.join(' ');
        expect(text, `${player.entityId}@${String(t)}`).not.toContain('attacking third');
        expect(text, `${player.entityId}@${String(t)}`).not.toContain('defending third');
        expect(text, `${player.entityId}@${String(t)}`).not.toContain('attacking');
        expect(text, `${player.entityId}@${String(t)}`).not.toContain('defending');
      }
    }
  });

  it('the ball description carries no possession, team or attack-direction attribution', async () => {
    const { scene, getFrame } = await fixture();
    for (const t of [4_717_000, 4_725_100, 4_731_000]) {
      const text = describeSpatialState({
        scene,
        frame: getFrame(t),
        playheadMs: t,
        selectedEntityId: null,
      }).details.join(' ');
      const ballLine = text.split('.').find((part) => part.includes('The ball is at'));
      expect(ballLine).toBeDefined();
      expect(ballLine).not.toMatch(/home|away|attacking|defending|possession|carried by/i);
    }
  });
});
