'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ContractValidationError, MomentProposal } from '@kyneloom/contracts';
import type { CompileResult, CompileSuccess } from '@kyneloom/moment-compiler';
import type { EvidenceProjection } from '@/lib/evidence-data';
import type { SceneData } from '@/lib/scene-data';
import { compiledViewFrom, type CompiledMomentView } from '@/lib/compiled-moment';
import {
  addKeyframe,
  applyShotPreset,
  removeKeyframe,
  setHypothesisDisclosure,
  setHypothesisText,
  setKeyframePose,
  setKeyframeTime,
  setOverlayInterval,
  setShotInterval,
  STUDIO_DRAFT_SCHEMA_VERSION,
  type EditResult,
  type StudioDraft,
} from '@/lib/studio/draft';
import { applyCommand, createHistory, redo, undo, type DraftHistory } from '@/lib/studio/history';
import { buildShotPreset } from '@/lib/studio/presets';
import { draftCues, proposalDiffers } from '@/lib/studio/draft-cues';
import { sceneWithDraftCamera } from '@/lib/studio/draft-scene';
import {
  createLocalDraftRepository,
  type StudioDraftRepository,
} from '@/lib/studio/local-draft-store';
import type { ReplayEngine } from '@/app/explore/scene/scene-context';
import { ReplayStage } from '@/app/explore/replay-stage';
import { ProductionBar, type CompilePhase } from './production-bar';
import { LayerRail } from './layer-rail';
import { Timeline } from './timeline';
import { Inspector } from './inspector';
import { ClaimsPanel } from './claims-panel';
import { StageFrame } from './stage-frame';
import { captionClaimIdFor, type StudioSelection } from './selection';

/**
 * KYN-17 — the ONE client-side owner of Studio editing state (the same law
 * as CompileExperience): the draft (a typed MomentProposal), its undo/redo
 * history, the single selection, local persistence and every compilation
 * phase. All edit intents from the timeline, rail and inspector flow through
 * validated operations HERE; the stage, cues and recap rebind to the
 * resulting document.
 *
 * Draft vs compiled is always distinguishable: the stage is bound to the last
 * successfully COMPILED artifact's verified content, re-timed by the draft's
 * editorial structure (draftCues) and re-framed by the draft's camera
 * (sceneWithDraftCamera) — with an explicit draft-preview flag until the
 * producer recompiles and a new hash exists.
 */
export function StudioExperience({
  baseScene,
  evidence,
  initialProposal,
  initialResult,
  sourcePanel,
}: {
  readonly baseScene: SceneData;
  readonly evidence: EvidenceProjection;
  readonly initialProposal: MomentProposal;
  readonly initialResult: CompileSuccess;
  readonly sourcePanel: ReactNode;
}) {
  const draftId = `draft-${initialProposal.proposalId}`;

  /** One editor state: the document AND its selection undo together. */
  interface EditorState {
    readonly proposal: MomentProposal;
    readonly selection: StudioSelection | null;
  }

  const [history, setHistory] = useState<DraftHistory<EditorState>>(() =>
    createHistory({ proposal: initialProposal, selection: null }),
  );
  const { proposal, selection } = history.present;
  const [editErrors, setEditErrors] = useState<readonly ContractValidationError[]>([]);
  const [compiled, setCompiled] = useState<CompiledMomentView>(() =>
    compiledViewFrom(initialResult),
  );
  const [compiledProposal, setCompiledProposal] = useState<MomentProposal>(initialProposal);
  const [compiledMetrics, setCompiledMetrics] = useState<
    readonly CompileSuccess['metrics'][number][]
  >(() => initialResult.metrics);
  const [compilePhase, setCompilePhase] = useState<CompilePhase>({ kind: 'idle' });
  const [savedRevision, setSavedRevision] = useState(0);
  const [savedProposal, setSavedProposal] = useState<MomentProposal | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [conflict, setConflict] = useState<{ readonly theirRevision: number } | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<{ readonly revision: number } | null>(null);
  const [restoreOffer, setRestoreOffer] = useState<
    | { readonly kind: 'checking' }
    | { readonly kind: 'none' }
    | {
        readonly kind: 'offer';
        readonly proposal: MomentProposal;
        readonly revision: number;
        readonly savedAt: string;
      }
    | { readonly kind: 'invalid'; readonly message: string }
  >({ kind: 'checking' });
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [previewMode, setPreviewMode] = useState(false);

  const engineRef = useRef<ReplayEngine | null>(null);
  const repositoryRef = useRef<StudioDraftRepository | null>(null);
  const repository = (): StudioDraftRepository => {
    if (repositoryRef.current === null) {
      repositoryRef.current = createLocalDraftRepository();
    }
    return repositoryRef.current;
  };
  const compileSeq = useRef(0);

  const asDraft = useCallback(
    (document: MomentProposal): StudioDraft => ({
      schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
      draftId,
      revision: savedRevision,
      proposal: document,
    }),
    [draftId, savedRevision],
  );

  /** Apply a validated edit as ONE history command; surface rejections verbatim. */
  const applyEdit = useCallback(
    (operation: (draft: StudioDraft) => EditResult, nextSelection?: StudioSelection): void => {
      const result = operation({
        ...asDraft(history.present.proposal),
        proposal: history.present.proposal,
      });
      if (!result.ok) {
        setEditErrors(result.errors);
        return;
      }
      setEditErrors([]);
      // A conflict is NOT cleared by editing: the tab's saved revision is
      // still stale, and the banner stays until the user reloads the latest
      // draft or a save succeeds. Hiding it would invite a guaranteed-fail
      // save (review blocker: the banner vanished with no recovery path).
      setHistory((current) =>
        applyCommand(current, {
          proposal: result.draft.proposal,
          selection: nextSelection ?? current.present.selection,
        }),
      );
    },
    [asDraft, history.present.proposal],
  );

  /** Selection without an edit is view state — it never opens an undo step. */
  const setSelection = useCallback((next: StudioSelection | null): void => {
    setHistory((current) => ({ ...current, present: { ...current.present, selection: next } }));
  }, []);

  // Local persistence: offer (never auto-apply) a saved draft on entry. A
  // storage FAILURE keeps the read-only compiled baseline fully usable and
  // surfaces honestly — never an unhandled rejection.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await repository().load(draftId);
        if (cancelled) return;
        if (loaded === null) {
          setRestoreOffer({ kind: 'none' });
        } else if (!loaded.ok) {
          setRestoreOffer({ kind: 'invalid', message: loaded.message });
        } else {
          setRestoreOffer({
            kind: 'offer',
            proposal: loaded.draft.proposal,
            revision: loaded.draft.revision,
            savedAt: loaded.savedAt,
          });
        }
      } catch (error) {
        if (cancelled) return;
        setRestoreOffer({ kind: 'none' });
        setStorageError(
          `the saved local draft could not be read (${error instanceof Error ? error.message : 'storage failure'}) — the compiled baseline stays fully usable`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const restoreSavedDraft = useCallback((offer: { proposal: MomentProposal; revision: number }) => {
    setHistory(createHistory({ proposal: offer.proposal, selection: null }));
    setSavedRevision(offer.revision);
    setSavedProposal(offer.proposal);
    setEditErrors([]);
    setConflict(null);
    setRestoreOffer({ kind: 'none' });
    setConfirmDiscard(null);
  }, []);

  /** Re-read the store and refresh the restore offer (used when a reset raced). */
  const refreshRestoreOffer = useCallback(async (): Promise<void> => {
    try {
      const loaded = await repository().load(draftId);
      if (loaded === null) {
        setRestoreOffer({ kind: 'none' });
      } else if (!loaded.ok) {
        setRestoreOffer({ kind: 'invalid', message: loaded.message });
      } else {
        setRestoreOffer({
          kind: 'offer',
          proposal: loaded.draft.proposal,
          revision: loaded.draft.revision,
          savedAt: loaded.savedAt,
        });
      }
    } catch (error) {
      setStorageError(
        `the saved local draft could not be read (${error instanceof Error ? error.message : 'storage failure'})`,
      );
    }
  }, [draftId]);

  /**
   * Discard the saved local draft — the explicit "Start from baseline"
   * confirmation. Atomic compare-and-discard under the same CAS law: if
   * another tab saved a newer revision in between, the reset REFUSES and the
   * offer refreshes so the user re-decides against the real stored state.
   */
  const discardSavedDraft = useCallback(
    async (expectedRevision: number): Promise<void> => {
      try {
        const outcome = await repository().reset(draftId, expectedRevision);
        if (outcome.ok) {
          setSavedRevision(0);
          setSavedProposal(null);
          setConflict(null);
          setConfirmDiscard(null);
          setRestoreOffer({ kind: 'none' });
          return;
        }
        if (outcome.kind === 'conflict') {
          // The saved draft moved on — re-offer the newer revision; the user
          // re-decides with current facts. Nothing was discarded.
          setConfirmDiscard(null);
          await refreshRestoreOffer();
          return;
        }
        setStorageError(outcome.message);
      } catch (error) {
        setStorageError(
          error instanceof Error ? error.message : 'the local draft could not be discarded',
        );
      }
    },
    [draftId, refreshRestoreOffer],
  );

  /**
   * Conflict recovery: adopt the latest stored draft (explicit user action on
   * the conflict banner). This tab's divergent edits are REPLACED by the
   * stored proposal — the revision lineage continues, no update is lost.
   */
  const reloadSavedDraft = useCallback(async (): Promise<void> => {
    try {
      const loaded = await repository().load(draftId);
      if (loaded === null) {
        // The stored draft vanished (another tab discarded it). Adopt the
        // fresh lineage honestly: this tab saves from revision 0 next.
        setSavedRevision(0);
        setSavedProposal(null);
        setConflict(null);
        setStorageError(null);
        return;
      }
      if (!loaded.ok) {
        setStorageError(loaded.message);
        return;
      }
      restoreSavedDraft(loaded.draft);
      setStorageError(null);
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : 'the saved local draft could not be reloaded',
      );
    }
  }, [draftId, restoreSavedDraft]);

  const save = useCallback(async (): Promise<void> => {
    if (saveBusy) return;
    setSaveBusy(true);
    try {
      const outcome = await repository().save(asDraft(proposal), savedRevision);
      if (outcome.ok) {
        setSavedRevision(outcome.revision);
        setSavedProposal(proposal);
        setConflict(null);
        setStorageError(null);
      } else if (outcome.kind === 'conflict') {
        setConflict({ theirRevision: outcome.currentRevision });
      }
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : 'the local draft could not be saved',
      );
    } finally {
      setSaveBusy(false);
    }
  }, [asDraft, proposal, saveBusy, savedRevision]);

  const recompile = useCallback(async (): Promise<void> => {
    if (compilePhase.kind === 'busy') return;
    const sent = proposal;
    const seq = (compileSeq.current += 1);
    setCompilePhase({ kind: 'busy' });
    try {
      const response = await fetch('/api/moment/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sent),
      });
      if (seq !== compileSeq.current) return;
      if (!response.ok) {
        setCompilePhase({
          kind: 'unavailable',
          message: `The compile endpoint answered ${String(response.status)} — the draft was NOT compiled and nothing changed.`,
        });
        return;
      }
      const payload = (await response.json()) as CompileResult & { routeVersion?: string };
      if (seq !== compileSeq.current) return;
      if (payload.ok) {
        setCompiled(compiledViewFrom(payload));
        setCompiledProposal(sent);
        setCompiledMetrics(payload.metrics);
        setCompilePhase({ kind: 'ok', hash: payload.manifestHash });
      } else {
        const stale = payload.errors.find((error) => error.code === 'stale_revision');
        if (stale !== undefined) {
          setCompilePhase({ kind: 'stale', message: stale.message });
        } else {
          setCompilePhase({ kind: 'rejected', errors: payload.errors });
        }
      }
    } catch (error) {
      if (seq !== compileSeq.current) return;
      setCompilePhase({
        kind: 'unavailable',
        message: error instanceof Error ? error.message : 'the compile request failed',
      });
    }
  }, [compilePhase.kind, proposal]);

  const doUndo = useCallback((): void => {
    setHistory((current) => undo(current));
    setEditErrors([]);
  }, []);
  const doRedo = useCallback((): void => {
    setHistory((current) => redo(current));
    setEditErrors([]);
  }, []);

  // Keyboard: undo/redo/save; never while typing in a field (inputs own their keys).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable="true"]') !== null
      ) {
        return;
      }
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) doRedo();
        else doUndo();
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        doRedo();
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doRedo, doUndo, save]);

  const seekTo = useCallback(
    (absoluteMs: number): void => {
      const engine = engineRef.current;
      if (engine === null) return;
      engine.playheadMs = Math.min(
        baseScene.windowMs[1],
        Math.max(baseScene.windowMs[0], Math.round(absoluteMs)),
      );
      engine.revision += 1;
    },
    [baseScene.windowMs],
  );

  const draftDirty = proposalDiffers(proposal, compiledProposal);
  const unsaved =
    savedProposal === null
      ? proposalDiffers(proposal, initialProposal)
      : proposalDiffers(proposal, savedProposal);

  // The stage binds to the draft camera immediately (safe: framing only) and
  // to the compiled VERIFIED cues re-timed by the draft's editorial structure.
  const visibleTracks = useMemo(
    () => proposal.cameraTracks.filter((track) => !hiddenIds.has(track.id)),
    [proposal.cameraTracks, hiddenIds],
  );
  const scene = useMemo(
    () => sceneWithDraftCamera(baseScene, { ...proposal, cameraTracks: visibleTracks }),
    [baseScene, proposal, visibleTracks],
  );
  const cues = useMemo(
    () => draftCues(compiled, asDraft(proposal)).filter((cue) => !hiddenIds.has(cue.id)),
    [compiled, asDraft, proposal, hiddenIds],
  );

  // Enter the moment cinematically ONCE (the director's cut plays on load);
  // later edits preserve the playhead (the transport law).
  const autoRun = useMemo(
    () => ({ camera: 'directed' as const, fromMs: initialProposal.timeRangeMs[0] }),
    [initialProposal.timeRangeMs],
  );

  const applyPreset = useCallback(
    (trackId: string, presetId: string): void => {
      const windowMs = proposal.timeRangeMs[1] - proposal.timeRangeMs[0];
      const preset = buildShotPreset(presetId, baseScene, windowMs, proposal.timeRangeMs[0]);
      if (preset === null) {
        setEditErrors([
          {
            fieldPath: 'cameraTracks',
            code: 'insufficient_evidence',
            message: `the preset "${presetId}" cannot be grounded in this scene's tracked data — nothing was applied`,
          },
        ]);
        return;
      }
      applyEdit((draft) => applyShotPreset(draft, trackId, preset), {
        kind: 'shot',
        id: preset.id,
      });
    },
    [applyEdit, baseScene, proposal.timeRangeMs],
  );

  const captionClaimId = useCallback(
    (overlayId: string): string | null => {
      const overlay = proposal.overlays.find((candidate) => candidate.id === overlayId);
      if (overlay === undefined) return null;
      return captionClaimIdFor(overlay, proposal.claims);
    },
    [proposal],
  );

  const toggleVisibility = useCallback((id: string): void => {
    setHiddenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Clearly-labeled QA/debug hook (not user-facing): the state Playwright
  // needs to prove the editor and the stage share one clock and one truth.
  useEffect(() => {
    const hook = window as unknown as Record<string, unknown>;
    hook['__kyneloomStudio'] = {
      draftId,
      draftDirty: (): boolean => draftDirty,
      unsaved: (): boolean => unsaved,
      playheadMs: (): number | null => engineRef.current?.playheadMs ?? null,
      seek: (ms: number): void => seekTo(ms),
      selectedShotId: (): string | null => (selection?.kind === 'shot' ? selection.id : null),
      shotIds: (): readonly string[] => proposal.cameraTracks.map((track) => track.id),
      /** Committed commands in the undo stack — lets QA verify an edit
       * actually entered history (not just that the DOM changed). */
      undoDepth: (): number => history.past.length,
    };
    return () => {
      delete hook['__kyneloomStudio'];
    };
  }, [draftId, draftDirty, unsaved, selection, proposal.cameraTracks, seekTo, history.past.length]);

  return (
    <div className="studio-app" data-preview-mode={previewMode ? 'true' : undefined}>
      <ProductionBar
        momentName="The Invisible Assist"
        draftId={draftId}
        savedRevision={savedRevision}
        unsaved={unsaved}
        draftDirty={draftDirty}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        compilePhase={compilePhase}
        saveBusy={saveBusy}
        previewMode={previewMode}
        onUndo={doUndo}
        onRedo={doRedo}
        onSave={() => void save()}
        onRecompile={() => void recompile()}
        onTogglePreview={() => setPreviewMode((current) => !current)}
      />

      {restoreOffer.kind === 'offer' ? (
        <div
          className="studio-restore"
          role="region"
          aria-label="Saved local draft"
          data-restore-banner=""
        >
          <p className="studio-restore__text">
            <span className="chip chip--compiled mono">SAVED LOCAL DRAFT</span> A draft of this
            moment exists in THIS browser (revision {String(restoreOffer.revision)}, saved{' '}
            {restoreOffer.savedAt}). Restore it, or start from the compiled baseline.
          </p>
          <div className="studio-restore__actions">
            <button
              type="button"
              className="btn btn--primary"
              data-restore-draft=""
              onClick={() => restoreSavedDraft(restoreOffer)}
            >
              Restore saved draft
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              data-start-fresh=""
              onClick={() => setConfirmDiscard({ revision: restoreOffer.revision })}
            >
              Start from baseline
            </button>
          </div>
        </div>
      ) : null}
      {confirmDiscard !== null && restoreOffer.kind === 'offer' ? (
        <div
          className="studio-restore studio-restore--confirm"
          role="alertdialog"
          aria-label="Discard saved local draft"
          data-discard-confirm=""
        >
          <p className="studio-restore__text">
            <span className="chip chip--amber mono">DISCARD SAVED DRAFT?</span> Starting from the
            baseline permanently discards the saved local draft (revision{' '}
            {String(restoreOffer.revision)}) from THIS browser. This is atomic and refuses if
            another session saved a newer revision meanwhile.
          </p>
          <div className="studio-restore__actions">
            <button
              type="button"
              className="btn btn--primary"
              data-discard-draft=""
              onClick={() => void discardSavedDraft(restoreOffer.revision)}
            >
              Discard and start fresh
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              data-keep-draft=""
              onClick={() => setConfirmDiscard(null)}
            >
              Keep saved draft
            </button>
          </div>
        </div>
      ) : null}
      {restoreOffer.kind === 'invalid' ? (
        <div className="studio-restore studio-restore--invalid" role="alert">
          <p className="studio-restore__text">
            <span className="chip chip--amber mono">LOCAL DRAFT REJECTED</span>{' '}
            {restoreOffer.message}
          </p>
        </div>
      ) : null}

      <div className="studio-app__body">
        <LayerRail
          proposal={proposal}
          scene={baseScene}
          selection={selection}
          hiddenIds={hiddenIds}
          onSelect={setSelection}
          onToggleVisibility={toggleVisibility}
          onSeekTo={seekTo}
        />

        <div className="studio-app__center">
          <StageFrame
            proposal={proposal}
            engineRef={engineRef}
            selectedShotId={selection?.kind === 'shot' ? selection.id : null}
            draftDirty={draftDirty}
          >
            <ReplayStage
              scene={scene}
              evidence={evidence}
              compiled={{
                manifestId: compiled.manifestId,
                manifestHash: compiled.manifestHash,
                momentWindowMs: compiled.momentWindowMs,
                cues,
              }}
              autoRun={autoRun}
              engineRef={engineRef}
            />
          </StageFrame>

          <ol
            className="studio-workflow"
            aria-label="Revision workflow state"
            data-workflow-strip=""
          >
            <li data-state={draftDirty ? 'off' : 'on'}>compiled baseline</li>
            <li data-state={draftDirty ? 'on' : 'off'}>draft</li>
            <li
              data-state={
                saveBusy ? 'on' : unsaved ? 'todo' : savedProposal !== null ? 'on' : 'off'
              }
            >
              saved locally
            </li>
            <li data-state={compilePhase.kind === 'busy' ? 'on' : 'off'}>validating</li>
            <li data-state={compilePhase.kind === 'ok' ? 'on' : 'off'}>validated</li>
            <li data-state={compilePhase.kind === 'rejected' ? 'bad' : 'off'}>rejected</li>
            <li data-state={compilePhase.kind === 'stale' ? 'bad' : 'off'}>stale source</li>
            <li data-state={conflict !== null ? 'bad' : 'off'}>conflict</li>
            <li data-state={compilePhase.kind === 'unavailable' ? 'bad' : 'off'}>
              compiler unavailable
            </li>
            <li
              data-state="locked"
              title="Approval is a separate authorized server workflow (KYN-18)"
            >
              approval unavailable
            </li>
            <li data-state="locked" title="Publishing requires KYN-18 + authentication (KYN-21)">
              publishing unavailable
            </li>
          </ol>

          <Timeline
            proposal={proposal}
            scene={baseScene}
            engineRef={engineRef}
            selection={selection}
            hiddenIds={hiddenIds}
            onSelect={setSelection}
            onTrimOverlay={(overlayId, startMs, endMs) =>
              applyEdit((draft) => setOverlayInterval(draft, overlayId, startMs, endMs))
            }
            onTrimShot={(trackId, startMs, endMs) =>
              applyEdit((draft) => setShotInterval(draft, trackId, startMs, endMs))
            }
            captionClaimId={captionClaimId}
          />
        </div>

        <aside className="studio-app__right">
          <Inspector
            proposal={proposal}
            scene={baseScene}
            selection={selection}
            editErrors={editErrors}
            onSetShotInterval={(trackId, startMs, endMs) =>
              applyEdit((draft) => setShotInterval(draft, trackId, startMs, endMs))
            }
            onSetKeyframeTime={(trackId, index, tMs) =>
              applyEdit((draft) => setKeyframeTime(draft, trackId, index, tMs))
            }
            onSetKeyframePose={(trackId, index, pose) =>
              applyEdit((draft) => setKeyframePose(draft, trackId, index, pose))
            }
            onAddKeyframe={(trackId, atMs) =>
              applyEdit((draft) => addKeyframe(draft, trackId, atMs))
            }
            onRemoveKeyframe={(trackId, index) =>
              applyEdit((draft) => removeKeyframe(draft, trackId, index))
            }
            onApplyPreset={applyPreset}
            onSetOverlayInterval={(overlayId, startMs, endMs) =>
              applyEdit((draft) => setOverlayInterval(draft, overlayId, startMs, endMs))
            }
            onSetCaptionText={(claimId, text) =>
              applyEdit((draft) => setHypothesisText(draft, claimId, text))
            }
            onSetCaptionDisclosure={(claimId, disclosure) =>
              applyEdit((draft) => setHypothesisDisclosure(draft, claimId, disclosure))
            }
            onSeekTo={seekTo}
          />
          <ClaimsPanel
            proposal={proposal}
            compiled={compiled}
            metrics={compiledMetrics}
            compileErrors={compilePhase.kind === 'rejected' ? compilePhase.errors : []}
            staleMessage={compilePhase.kind === 'stale' ? compilePhase.message : null}
            conflict={conflict}
            storageError={storageError}
            onReloadSavedDraft={() => void reloadSavedDraft()}
          />
          {sourcePanel}
        </aside>
      </div>
    </div>
  );
}
