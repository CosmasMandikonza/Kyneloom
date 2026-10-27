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
import {
  recordToDraft,
  resolveSave,
  validateEntryShape,
  type StoredDraftRecord,
} from './draft-store';
import { STUDIO_DRAFT_SCHEMA_VERSION } from './draft';

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

describe('studio draft repository — typed generation+revision CAS (red-team #9/#10 + ABA red-team A–E)', () => {
  const token = (generation: number, revision: number) => ({ generation, revision });

  it('resolveSave decides the full-token CAS exactly', () => {
    expect(resolveSave(null, token(1, 0)).proceed).toBe(true);
    expect(resolveSave(null, token(1, 2)).proceed).toBe(false);
    const live = {
      schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
      draftId: 'd',
      generation: 2,
      revision: 3,
      savedAt: 't',
      proposal: null,
    } as unknown as StoredDraftRecord;
    expect(resolveSave(live, token(2, 3)).proceed).toBe(true);
    const staleRevision = resolveSave(live, token(2, 2));
    expect(staleRevision.proceed).toBe(false);
    if (staleRevision.proceed) return;
    expect(staleRevision.current).toEqual(token(2, 3));
    const staleGeneration = resolveSave(live, token(1, 3));
    expect(staleGeneration.proceed).toBe(false);
  });

  it('two tabs over one backend: the second save conflicts and names the winner (legit flow C)', async () => {
    const backend = createMemoryDraftBackend();
    const tabA = createMemoryDraftRepository(backend);
    const tabB = createMemoryDraftRepository(backend);
    const { draft } = await realWorld();

    const first = await tabA.save(draft, token(1, 0));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.token).toEqual(token(1, 1));

    const second = await tabB.save(draft, token(1, 0));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe('conflict');
    expect(second.current).toEqual(token(1, 1));

    // Legitimate recovery: B reloads the latest, then saves the next revision.
    const reloaded = await tabB.load(draft.draftId);
    expect(reloaded.ok && reloaded.kind === 'live').toBe(true);
    if (!reloaded.ok || reloaded.kind !== 'live') return;
    const retry = await tabB.save(reloaded.draft, reloaded.token);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.token).toEqual(token(1, 2));
  });

  it('a corrupt stored record is rejected on load, never coerced', () => {
    const invalid = recordToDraft({
      schemaVersion: 'something-else',
      draftId: 'x',
    } as unknown as StoredDraftRecord);
    expect(invalid.ok).toBe(false);
    const malformed = validateEntryShape(
      {
        schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
        draftId: 'd',
        generation: 'x',
        revision: 1,
        savedAt: 't',
        proposal: null,
      } as unknown as StoredDraftRecord,
      'd',
    );
    expect(malformed.ok).toBe(false);
  });

  it('RED-TEAM A — a stale token cannot save over a recreated lineage (the ABA race)', async () => {
    const backend = createMemoryDraftBackend();
    const repoA = createMemoryDraftRepository(backend);
    const repoB = createMemoryDraftRepository(backend);
    const repoC = createMemoryDraftRepository(backend);
    const { draft } = await realWorld();
    const documentA = draft;
    // A DIFFERENT document: the hypothesis claim's editorial words differ
    // (calculated claims cannot carry text — the contract law enforces that).
    const documentC: typeof draft = {
      ...draft,
      proposal: {
        ...draft.proposal,
        claims: draft.proposal.claims.map((claim) =>
          claim.status === 'hypothesis'
            ? { ...claim, text: 'a different producers take on the same run' }
            : claim,
        ),
      },
    };

    // 1. Tab A saves document A → {gen 1, rev 1}; A keeps the token open.
    const savedA = await repoA.save(documentA, token(1, 0));
    expect(savedA.ok).toBe(true);
    if (!savedA.ok) return;
    const staleToken = savedA.token; // {gen 1, rev 1}

    // 2. Tab B explicitly resets that exact token → tombstone generation 1.
    const reset = await repoB.reset(draft.draftId, staleToken);
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.nextToken).toEqual(token(2, 0));

    // 3. Tab C creates a NEW document, saved with the follow-up fresh token.
    const savedC = await repoC.save(documentC, reset.nextToken);
    expect(savedC.ok).toBe(true);
    if (!savedC.ok) return;
    expect(savedC.token).toEqual(token(2, 1));

    // 4/5. Stale tab A saves with the OLD generation token — revision numbers
    // collide (1 vs 1) but the generations do not. MUST conflict.
    const staleSave = await repoA.save(documentA, staleToken);
    expect(staleSave.ok).toBe(false);
    if (staleSave.ok) return;
    expect(staleSave.kind).toBe('conflict');
    expect(staleSave.current).toEqual(token(2, 1));

    // 6. Generation B's data is UNCHANGED by the attack.
    const after = await repoC.load(draft.draftId);
    expect(after.ok && after.kind === 'live').toBe(true);
    if (!after.ok || after.kind !== 'live') return;
    expect(after.token).toEqual(token(2, 1));
    expect(after.draft.proposal.claims.find((claim) => claim.status === 'hypothesis')?.text).toBe(
      'a different producers take on the same run',
    );
  });

  it('RED-TEAM B — a stale token cannot reset a recreated lineage either', async () => {
    const backend = createMemoryDraftBackend();
    const repoA = createMemoryDraftRepository(backend);
    const repoB = createMemoryDraftRepository(backend);
    const repoC = createMemoryDraftRepository(backend);
    const { draft } = await realWorld();

    const savedA = await repoA.save(draft, token(1, 0));
    expect(savedA.ok).toBe(true);
    if (!savedA.ok) return;
    const staleToken = savedA.token;
    const reset = await repoB.reset(draft.draftId, staleToken);
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    const savedC = await repoC.save(draft, reset.nextToken);
    expect(savedC.ok).toBe(true);
    if (!savedC.ok) return;

    // The stale tab attempts the DISCARD with its old token. MUST reject.
    const staleReset = await repoA.reset(draft.draftId, staleToken);
    expect(staleReset.ok).toBe(false);
    if (staleReset.ok) return;
    expect(staleReset.kind).toBe('conflict');
    if (staleReset.kind !== 'conflict') return;
    expect(staleReset.current).toEqual(token(2, 1));

    // Generation B's document remains intact.
    const after = await repoC.load(draft.draftId);
    expect(after.ok && after.kind === 'live').toBe(true);
    if (!after.ok || after.kind !== 'live') return;
    expect(after.token).toEqual(token(2, 1));
  });

  it('RED-TEAM D — a fresh lineage after discard: save, reload, truthfully numbered', async () => {
    const backend = createMemoryDraftBackend();
    const repository = createMemoryDraftRepository(backend);
    const { draft } = await realWorld();

    const saved = await repository.save(draft, token(1, 0));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const reset = await repository.reset(draft.draftId, saved.token);
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;

    // After the discard the store reports the FOLLOW-UP generation token.
    const emptied = await repository.load(draft.draftId);
    expect(emptied.ok && emptied.kind === 'empty').toBe(true);
    if (!emptied.ok || emptied.kind !== 'empty') return;
    expect(emptied.token).toEqual(token(2, 0));

    // Save a fresh document with that token; reload persists it, generation 2.
    const fresh = await repository.save(draft, emptied.token);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.token).toEqual(token(2, 1)); // revision truthfully restarts at 1
    const reloaded = await repository.load(draft.draftId);
    expect(reloaded.ok && reloaded.kind === 'live').toBe(true);
    if (!reloaded.ok || reloaded.kind !== 'live') return;
    expect(reloaded.token).toEqual(token(2, 1));
    expect(reloaded.draft.revision).toBe(1);
  });

  it('RED-TEAM E — conflicting reset/save races: exactly the allowed operation succeeds', async () => {
    const backend = createMemoryDraftBackend();
    const repoA = createMemoryDraftRepository(backend);
    const repoB = createMemoryDraftRepository(backend);
    const repoC = createMemoryDraftRepository(backend);
    const { draft } = await realWorld();

    const saved = await repoA.save(draft, token(1, 0));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const liveToken = saved.token;

    // Two tabs race the SAME legitimate discard: the first wins, the second
    // (now stale) rejects without side effects.
    const winner = await repoB.reset(draft.draftId, liveToken);
    expect(winner.ok).toBe(true);
    const loser = await repoC.reset(draft.draftId, liveToken);
    expect(loser.ok).toBe(false);
    if (loser.ok) return;
    expect(loser.kind).toBe('conflict');

    // Reset vs save race: after the tombstone, only the follow-up fresh token
    // may save; the discarded lineage's token is dead forever.
    const savedFresh = await repoB.save(draft, winner.ok ? winner.nextToken : token(2, 0));
    expect(savedFresh.ok).toBe(true);
    const zombieSave = await repoA.save(draft, liveToken);
    expect(zombieSave.ok).toBe(false);
    const zombieReset = await repoA.reset(draft.draftId, liveToken);
    expect(zombieReset.ok).toBe(false);
  });

  it('legacy v1 records (no generation) load as generation 1 and are re-stamped on save', async () => {
    const backend = createMemoryDraftBackend();
    const repository = createMemoryDraftRepository(backend);
    const { draft } = await realWorld();
    // A record written by the previous schema (revision-only).
    backend.put({
      schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
      draftId: draft.draftId,
      revision: 2,
      savedAt: new Date().toISOString(),
      proposal: draft.proposal,
    } as unknown as StoredDraftRecord);

    const loaded = await repository.load(draft.draftId);
    expect(loaded.ok && loaded.kind === 'live').toBe(true);
    if (!loaded.ok || loaded.kind !== 'live') return;
    expect(loaded.token).toEqual(token(1, 2)); // legacy lineage read as generation 1

    const next = await repository.save(loaded.draft, loaded.token);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.token).toEqual(token(1, 3)); // CAS continues within the legacy generation

    // Discarding a LEGACY record must produce a well-formed follow-up token
    // (never NaN from the missing generation field).
    const legacyReset = await repository.reset(draft.draftId, next.token);
    expect(legacyReset.ok).toBe(true);
    if (!legacyReset.ok) return;
    expect(legacyReset.nextToken).toEqual(token(2, 0));
    const legacyFresh = await repository.save(draft, legacyReset.nextToken);
    expect(legacyFresh.ok).toBe(true);
    if (!legacyFresh.ok) return;
    expect(legacyFresh.token).toEqual(token(2, 1));
  });
});
