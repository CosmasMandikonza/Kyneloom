import { describe, expect, it } from 'vitest';
import { cameraTrack } from '@kyneloom/contracts';
import { compileMomentProposal } from '@kyneloom/moment-compiler';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildCompilerSource } from '@/lib/moment-compiler-service';
import { buildCompileCorpus } from '@kyneloom/moment-compiler';
import { buildSceneData } from '@/lib/scene-data';
import { compiledViewFrom } from '@/lib/compiled-moment';
import {
  addKeyframe,
  applyShotPreset,
  createDraft,
  removeKeyframe,
  setHypothesisDisclosure,
  setHypothesisText,
  setKeyframePose,
  setKeyframeTime,
  setLenses,
  setOverlayInterval,
  setRecapHeadline,
  setShotInterval,
  type StudioDraft,
} from './draft';
import { applyCommand, createHistory, redo, undo } from './history';
import { buildShotPreset, wingerFollow } from './presets';
import { draftCues, draftDiffersFromCompiled } from './draft-cues';
import { createMemoryDraftBackend, createMemoryDraftRepository } from './local-draft-store';
import { recordToDraft, resolveSave } from './draft-store';

/**
 * KYN-17 — the editing model against the REAL trusted world: the committed
 * golden fixture, the authoritative reducer/detector context and the golden
 * proposal (the exact document /studio/compile compiles). Every edit is a
 * contract-validated proposal mutation, every rejection carries an exact
 * field path, presets ground in the trusted fixture, and the repository
 * enforces atomic compare-and-save.
 */

async function realWorld(): Promise<{
  readonly draft: StudioDraft;
  readonly scene: NonNullable<ReturnType<typeof buildSceneData>>;
}> {
  const golden = await loadGoldenMatch();
  if (!golden.ok) throw new Error('fixture unavailable');
  const source = buildCompilerSource(golden);
  if (!source.ok) throw new Error('compiler source unavailable');
  const corpus = buildCompileCorpus(source.snapshot.context);
  const scene = buildSceneData(golden, { initialFocusMs: corpus.golden.timeRangeMs[0] });
  if (scene === null) throw new Error('scene unavailable');
  return { draft: createDraft(corpus.golden), scene };
}

describe('studio draft — camera shot edits validate through the contract', () => {
  it('the golden proposal loads into a draft and every golden shot is addressable', async () => {
    const { draft } = await realWorld();
    expect(draft.draftId).toBe('draft-invisible-assist-directed-v1');
    expect(draft.proposal.cameraTracks[0]!.id).toBe('cam-compiled-sequence');
    expect(draft.proposal.overlays.map((overlay) => overlay.id)).toEqual([
      'ov-separation',
      'ov-reception',
      'ov-caption-reading',
    ]);
  });

  it('editing a keyframe time applies when valid; collisions reject with the exact path', async () => {
    const { draft } = await realWorld();
    const trackId = draft.proposal.cameraTracks[0]!.id;
    const applied = setKeyframeTime(draft, trackId, 2, 3000);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.draft.proposal.cameraTracks[0]!.keyframes[2]!.tMs).toBe(3000);

    const rejected = setKeyframeTime(draft, trackId, 1, 0);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(
      rejected.errors.some(
        (error) =>
          error.fieldPath.includes('keyframes') && error.message.includes('strictly increasing'),
      ),
    ).toBe(true);
  });

  it('an unsafe camera pose is rejected with the exact field path (red-team #12)', async () => {
    const { draft } = await realWorld();
    const trackId = draft.proposal.cameraTracks[0]!.id;
    const underground = setKeyframePose(draft, trackId, 0, { position: [10, 10, 0.1] });
    expect(underground.ok).toBe(false);
    if (underground.ok) return;
    expect(underground.errors[0]!.fieldPath).toBe('cameraTracks[0].keyframes[0].position[2]');
    expect(underground.errors[0]!.message).toContain('at least');

    const far = setKeyframePose(draft, trackId, 0, { position: [900, 0, 20] });
    expect(far.ok).toBe(false);
    if (far.ok) return;
    expect(far.errors[0]!.fieldPath).toBe('cameraTracks[0].keyframes[0].position[0]');

    expect(setKeyframePose(draft, trackId, 0, { fovDeg: 180 }).ok).toBe(false);
  });

  it('keyframes can be added (blended between authored poses) and removed, never below two', async () => {
    const { draft } = await realWorld();
    const trackId = draft.proposal.cameraTracks[0]!.id;
    const count = draft.proposal.cameraTracks[0]!.keyframes.length;
    const added = addKeyframe(draft, trackId, 2000);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const track = added.draft.proposal.cameraTracks[0]!;
    expect(track.keyframes.length).toBe(count + 1);
    expect(track.keyframes.find((kf) => kf.tMs === 2000)).toBeDefined();

    const outside = addKeyframe(draft, trackId, 999_999);
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.errors[0]!.code).toBe('outside_time_window');

    const reduced = removeKeyframe(added.draft, trackId, 0);
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;
    expect(reduced.draft.proposal.cameraTracks[0]!.keyframes.length).toBe(count);
  });

  it('shot interval edits keep keyframes inside the interval', async () => {
    const { draft } = await realWorld();
    const trackId = draft.proposal.cameraTracks[0]!.id;
    const windowMs = draft.proposal.timeRangeMs[1] - draft.proposal.timeRangeMs[0];
    expect(setShotInterval(draft, trackId, 0, 100).ok).toBe(false);
    expect(setShotInterval(draft, trackId, 0, windowMs).ok).toBe(true);
  });

  it('a shot interval beyond the MOMENT duration is rejected with the exact field path (review reproducer)', async () => {
    const { draft } = await realWorld();
    const track = draft.proposal.cameraTracks[0]!;
    const windowMs = draft.proposal.timeRangeMs[1] - draft.proposal.timeRangeMs[0];
    // The reproducer: enlarge the track so every existing keyframe still sits
    // inside [startMs, endMs] — the track schema alone cannot catch this;
    // only the moment-window mirror does (the compiler rejects it later).
    const beyond = setShotInterval(draft, track.id, 0, windowMs + 1000);
    expect(beyond.ok).toBe(false);
    if (beyond.ok) return;
    expect(beyond.errors[0]!.fieldPath).toBe('cameraTracks[0].endMs');
    expect(beyond.errors[0]!.code).toBe('outside_time_window');
    expect(beyond.errors[0]!.message).toContain(String(windowMs));

    // Exactly at the moment end is inside — the boundary is inclusive.
    const atEnd = setShotInterval(draft, track.id, 0, windowMs);
    expect(atEnd.ok).toBe(true);
  });
});

describe('studio draft — overlays, captions and the editorial law', () => {
  it('overlay interval edits apply; the window bound mirrors the compiler gate', async () => {
    const { draft } = await realWorld();
    const applied = setOverlayInterval(draft, 'ov-separation', 500, 4000);
    expect(applied.ok).toBe(true);

    const beyond = setOverlayInterval(draft, 'ov-separation', 0, 999_999);
    expect(beyond.ok).toBe(false);
    if (beyond.ok) return;
    expect(beyond.errors[0]!.fieldPath).toBe('overlays[0].endMs');
    expect(beyond.errors[0]!.code).toBe('outside_time_window');
  });

  it('hypothesis text edits apply; numeric editorial text is rejected with the token named (red-team #6)', async () => {
    const { draft } = await realWorld();
    const applied = setHypothesisText(
      draft,
      'claim-run-created-space',
      'The decoy dragged the defender wide and the finish exploited it',
    );
    expect(applied.ok).toBe(true);

    const numeric = setHypothesisText(
      draft,
      'claim-run-created-space',
      'The gap grew by 14 metres',
    );
    expect(numeric.ok).toBe(false);
    if (numeric.ok) return;
    expect(numeric.errors[0]!.fieldPath).toBe('claims[2].text');
    expect(numeric.errors[0]!.message).toContain('14');

    const words = setHypothesisText(draft, 'claim-run-created-space', 'Two runners crossed');
    expect(words.ok).toBe(false);

    expect(
      setHypothesisDisclosure(
        draft,
        'claim-run-created-space',
        'Tactical interpretation from spatial co-occurrence.',
      ).ok,
    ).toBe(true);
  });

  it('the recap headline obeys the same number-free law', async () => {
    const { draft } = await realWorld();
    expect(setRecapHeadline(draft, 'Space made, finish taken').ok).toBe(true);
    expect(setRecapHeadline(draft, 'The 14-metre gap').ok).toBe(false);
  });

  it('lens selection is content — it applies and is meant for the compiled hash', async () => {
    const { draft } = await realWorld();
    const applied = setLenses(draft, ['analyst', 'accessible']);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.draft.proposal.lenses).toEqual(['analyst', 'accessible']);
    expect(setLenses(draft, []).ok).toBe(false);
  });
});

describe('studio history — undo/redo at command boundaries (red-team #7/#8)', () => {
  it('undo restores the previous draft; redo restores the next; new commands clear futures', async () => {
    const { draft } = await realWorld();
    const trackId = draft.proposal.cameraTracks[0]!.id;
    const originalFov = draft.proposal.cameraTracks[0]!.keyframes[0]!.fovDeg;
    const edited = setKeyframePose(draft, trackId, 0, { fovDeg: originalFov + 8 });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    let history = createHistory(draft.proposal);
    history = applyCommand(history, edited.draft.proposal);
    expect(history.present.cameraTracks[0]!.keyframes[0]!.fovDeg).toBe(originalFov + 8);
    expect(history.past).toHaveLength(1);

    history = undo(history);
    expect(history.present.cameraTracks[0]!.keyframes[0]!.fovDeg).toBe(originalFov);
    history = redo(history);
    expect(history.present.cameraTracks[0]!.keyframes[0]!.fovDeg).toBe(originalFov + 8);

    history = undo(history);
    const second = setRecapHeadline({ ...draft, proposal: history.present }, 'Another true story');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    history = applyCommand(history, second.draft.proposal);
    expect(history.future).toHaveLength(0);
  });
});

describe('studio presets — grounded, typed, deterministic', () => {
  it('the winger-follow preset bakes the run’s REAL samples into keyframes', async () => {
    const { draft, scene } = await realWorld();
    const [startMs, endMs] = draft.proposal.timeRangeMs;
    const track = wingerFollow(scene, endMs - startMs, startMs);
    expect(track).not.toBeNull();
    if (track === null) return;
    expect(track.id).toBe('cam-winger-follow');
    expect(track.keyframes.length).toBeGreaterThanOrEqual(2);
    for (const kf of track.keyframes) expect(kf.position[2]).toBeCloseTo(4.4, 6);
    // Deterministic: same inputs, same keyframes.
    const again = wingerFollow(scene, endMs - startMs, startMs);
    expect(JSON.stringify(again)).toBe(JSON.stringify(track));
  });

  it('every registry preset builds and passes the camera contract', async () => {
    const { draft, scene } = await realWorld();
    const [startMs, endMs] = draft.proposal.timeRangeMs;
    for (const id of [
      'cam-overhead-tactical',
      'cam-directed-ride',
      'cam-winger-follow',
      'cam-broadcast-sweep',
    ]) {
      const preset = buildShotPreset(id, scene, endMs - startMs, startMs);
      expect(preset, id).not.toBeNull();
      if (preset === null) continue;
      expect(cameraTrack.safeParse(preset).success, id).toBe(true);
    }
  });

  it('a preset edit recompiles through the REAL compiler into a new manifest and hash', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) throw new Error('fixture unavailable');
    const source = buildCompilerSource(golden);
    if (!source.ok) throw new Error('source unavailable');
    const corpus = buildCompileCorpus(source.snapshot.context);
    const scene = buildSceneData(golden, { initialFocusMs: corpus.golden.timeRangeMs[0] });
    if (scene === null) throw new Error('scene unavailable');

    const baseline = compileMomentProposal(corpus.golden, source.snapshot.context);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    const draft = createDraft(corpus.golden);
    const [startMs, endMs] = draft.proposal.timeRangeMs;
    const preset = buildShotPreset('cam-overhead-tactical', scene, endMs - startMs, startMs);
    expect(preset).not.toBeNull();
    if (preset === null) return;
    const applied = applyShotPreset(draft, 'cam-compiled-sequence', preset);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const result = compileMomentProposal(applied.draft.proposal, source.snapshot.context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.scene.cameraTracks[0]!.id).toBe('cam-overhead-tactical');
    expect(result.manifestHash).not.toBe(baseline.manifestHash); // new content, new identity
  });
});

describe('studio draft cues — verified text, editorial timing (red-team #4)', () => {
  it('re-times REAL compiled cues onto draft intervals; caption text previews the draft words', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) throw new Error('fixture unavailable');
    const source = buildCompilerSource(golden);
    if (!source.ok) throw new Error('source unavailable');
    const corpus = buildCompileCorpus(source.snapshot.context);
    const compiled = compileMomentProposal(corpus.golden, source.snapshot.context);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const view = compiledViewFrom(compiled);

    const draft = createDraft(corpus.golden);
    const [startMs] = draft.proposal.timeRangeMs;
    const timed = setOverlayInterval(draft, 'ov-separation', 100, 2000);
    expect(timed.ok).toBe(true);
    if (!timed.ok) return;
    const words = setHypothesisText(
      timed.draft,
      'claim-run-created-space',
      'The decoy run bent the back line',
    );
    expect(words.ok).toBe(true);
    if (!words.ok) return;

    const cues = draftCues(view, words.draft);
    const metric = cues.find((cue) => cue.id === 'ov-separation')!;
    expect(metric.startMs).toBe(startMs + 100);
    expect(metric.endMs).toBe(startMs + 2000);
    // The metric sentence is compiled content — identical to the artifact's.
    const compiledMetric = view.cues.find((cue) => cue.id === 'ov-separation')!;
    expect(metric.text).toBe(compiledMetric.text);
    const caption = cues.find((cue) => cue.id === 'ov-caption-reading')!;
    expect(caption.text).toBe('The decoy run bent the back line');

    expect(draftDiffersFromCompiled(words.draft, corpus.golden)).toBe(true);
    expect(draftDiffersFromCompiled(draft, corpus.golden)).toBe(false);
  });
});

describe('studio draft repository — atomic compare-and-save (red-team #9/#10)', () => {
  it('resolveSave decides CAS exactly', () => {
    expect(resolveSave(null, 0).proceed).toBe(true);
    expect(resolveSave(null, 2).proceed).toBe(false);
    expect(resolveSave({ revision: 3 }, 3).proceed).toBe(true);
    const stale = resolveSave({ revision: 4 }, 3);
    expect(stale.proceed).toBe(false);
    if (stale.proceed) return;
    expect(stale.currentRevision).toBe(4);
  });

  it('two tabs over one backend: the second save conflicts and names the winner', async () => {
    const backend = createMemoryDraftBackend();
    const tabA = createMemoryDraftRepository(backend);
    const tabB = createMemoryDraftRepository(backend);
    const { draft } = await realWorld();

    const first = await tabA.save(draft, 0);
    expect(first.ok).toBe(true);
    const second = await tabB.save(draft, 0);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe('conflict');
    expect(second.currentRevision).toBe(1);

    const reloaded = await tabB.load(draft.draftId);
    expect(reloaded !== null && reloaded.ok).toBe(true);
    if (reloaded === null || !reloaded.ok) return;
    const retry = await tabB.save(reloaded.draft, reloaded.draft.revision);
    expect(retry.ok).toBe(true);
  });

  it('a corrupt stored record is rejected on load, never coerced', () => {
    const invalid = recordToDraft({ schemaVersion: 'something-else', draftId: 'x' });
    expect(invalid !== null && !invalid.ok).toBe(true);
    expect(recordToDraft('not-a-record') !== null).toBe(true);
    expect(recordToDraft(null) !== null).toBe(true);
  });

  it('reset discards under the same CAS law: stale expectations refuse, fresh lineages restart at revision 0', async () => {
    const backend = createMemoryDraftBackend();
    const repository = createMemoryDraftRepository(backend);
    const { draft } = await realWorld();

    // Nothing stored: reset is an idempotent success.
    expect((await repository.reset(draft.draftId, 0)).ok).toBe(true);

    const saved = await repository.save(draft, 0);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    // A concurrent tab moved the revision: the confirmed discard REFUSES and
    // names the winner — that tab's update survives.
    const raced = await repository.reset(draft.draftId, 0);
    expect(raced.ok).toBe(false);
    if (raced.ok) return;
    expect(raced.kind).toBe('conflict');
    if (raced.kind !== 'conflict') return;
    expect(raced.currentRevision).toBe(1);

    // Discarding the revision the user actually confirmed succeeds, and the
    // next save starts a FRESH lineage from revision 0.
    expect((await repository.reset(draft.draftId, 1)).ok).toBe(true);
    expect(await repository.load(draft.draftId)).toBeNull();
    const fresh = await repository.save(draft, 0);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.revision).toBe(1);
  });
});
