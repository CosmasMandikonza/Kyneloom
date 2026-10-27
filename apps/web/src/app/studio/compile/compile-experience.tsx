'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CompileResult, CompileSuccess } from '@kyneloom/moment-compiler';
import type { EvidenceProjection } from '@/lib/evidence-data';
import type { SceneData } from '@/lib/scene-data';
import {
  compiledViewFrom,
  sceneWithCompiledTrack,
  type CompiledMomentView,
} from '@/lib/compiled-moment';
import type { CorpusEntryCard } from '@/lib/moment-compiler-service';
import type { AskMomentOutcome } from '@/lib/ask-intent-shared';
import { AskPanel } from './ask-panel';
import { CompiledStage } from './compiled-stage';
import { CompilerWorkbench } from './compiler-workbench';
import { RecapPanel } from './recap-panel';

/**
 * KYN-16 — the ONE client-side owner of compilation state (review blocker C).
 *
 * Selecting and compiling a proposal updates the ACTIVE TRUSTED ARTIFACT
 * here, and every consumer — 3D stage + directed camera, broadcast overlay,
 * recap, identity displays — rebinds to it. A rejected compilation never
 * touches the stage: the previous preview is kept and explicitly labeled as
 * the last successfully compiled moment, with its original hash.
 *
 * Races: every compile request carries a sequence number; only the response
 * matching the LATEST issued request (and the currently selected entry) may
 * commit. Stale responses are dropped silently.
 */
export function CompileExperience({
  baseScene,
  evidence,
  entries,
  initialResult,
  sourcePanel,
}: {
  readonly baseScene: SceneData;
  readonly evidence: EvidenceProjection;
  readonly entries: readonly CorpusEntryCard[];
  readonly initialResult: CompileSuccess;
  /** Server-rendered static source/evidence panel (children stay RSC). */
  readonly sourcePanel: ReactNode;
}) {
  const [active, setActive] = useState<CompiledMomentView>(() => compiledViewFrom(initialResult));
  const [started, setStarted] = useState(false);
  const [selectedId, setSelectedId] = useState(entries[0]?.id ?? 'golden');
  const [verdict, setVerdict] = useState<CompileResult>(initialResult);
  const [verdictEntryId, setVerdictEntryId] = useState<string>(entries[0]?.id ?? 'golden');
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [lastRejected, setLastRejected] = useState<{
    readonly entryId: string;
    readonly label: string;
    readonly errorCount: number;
  } | null>(null);
  const requestSeq = useRef(0);

  // "Ask Kyneloom" (deterministic intent input): its OWN sequence guard so
  // rapid submissions cannot commit stale resolutions, and a focus playhead
  // that rebinds the stage to the resolved instant.
  const askSeq = useRef(0);
  const [askBusy, setAskBusy] = useState(false);
  const [askOutcome, setAskOutcome] = useState<AskMomentOutcome | null>(null);
  const [askFocusMs, setAskFocusMs] = useState<number | null>(null);

  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];

  const ask = useCallback(async (prompt: string): Promise<void> => {
    // Rapid submissions are allowed: the sequence guard owns ordering, so
    // a stale resolution can never commit over a newer question.
    const seq = (askSeq.current += 1);
    setAskBusy(true);
    try {
      const response = await fetch('/api/moment/intent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (seq !== askSeq.current) return; // a newer question owns the state
      const payload = (await response.json()) as AskMomentOutcome;
      if (seq !== askSeq.current) return; // re-check after the await
      setAskOutcome(payload);
      if (payload.ok && payload.result.ok) {
        // Rebind the ACTIVE artifact exactly like a successful compile:
        // stage, camera/cues, recap and validated manifest identity all
        // follow. Playback starts focused on the resolved instant.
        setActive(compiledViewFrom(payload.result));
        setAskFocusMs(payload.focusPlayheadMs);
        setStarted(true);
        setLastRejected(null);
      }
      // Unsupported / invalid / rejected: the stage keeps the LAST
      // successfully compiled moment — nothing is substituted.
    } catch (error) {
      if (seq !== askSeq.current) return;
      setAskOutcome({
        ok: false,
        routeVersion: 'kyneloom-ask-intent-v1',
        resolver: 'Local deterministic interpretation · Synthetic match',
        kind: 'unsupported',
        message:
          error instanceof Error
            ? `The intent request failed: ${error.message} — the current moment is unchanged.`
            : 'The intent request failed — the current moment is unchanged.',
        supportedExamples: [],
      });
    } finally {
      if (seq === askSeq.current) setAskBusy(false);
    }
  }, []);

  const askStatus = useMemo(() => {
    if (askBusy) return 'Resolving your question against the verified evidence…';
    if (askOutcome === null) {
      return 'Ask about the off-ball run, the build-up to the goal, or request a wide broadcast view — answers are compiled from this moment’s verified evidence.';
    }
    if (!askOutcome.ok) {
      return askOutcome.message;
    }
    if (!askOutcome.result.ok) return null; // type narrowing; unreachable for displayed outcomes
    return (
      <p className="ask__answer" data-testid="ask-answer">
        <span className="mono ask__answer-intent">{askOutcome.intentId}</span>{' '}
        {askOutcome.explanation} <span className="ask__answer-note">{askOutcome.evidenceNote}</span>{' '}
        <span className="mono ask__answer-hash" title={askOutcome.result.manifestHash}>
          {askOutcome.result.manifestHash.slice(7, 19)}…
        </span>
      </p>
    );
  }, [askBusy, askOutcome]);

  const compile = useCallback(async (): Promise<void> => {
    if (selected === undefined || busy) return;
    const entry = selected;
    const seq = (requestSeq.current += 1);
    setBusy(true);
    setRequestError(null);
    try {
      const response = await fetch('/api/moment/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry.proposal),
      });
      if (seq !== requestSeq.current) return; // a newer request owns the state
      if (!response.ok) {
        setRequestError(
          `The compile endpoint answered ${String(response.status)} — no result is shown.`,
        );
        return;
      }
      const payload = (await response.json()) as CompileResult;
      if (seq !== requestSeq.current) return; // re-check after the await
      setVerdict(payload);
      setVerdictEntryId(entry.id);
      if (payload.ok) {
        setActive(compiledViewFrom(payload));
        setLastRejected(null);
      } else {
        setLastRejected({
          entryId: entry.id,
          label: entry.label,
          errorCount: payload.errors.length,
        });
      }
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setRequestError(
        error instanceof Error
          ? `Compilation request failed: ${error.message}`
          : 'Compilation request failed.',
      );
    } finally {
      if (seq === requestSeq.current) setBusy(false);
    }
  }, [selected, busy]);

  // The stage rebinds to the ACTIVE artifact: fresh directed track, fresh
  // identity, fresh cues. A new autoRun object per artifact intentionally
  // seeks to the moment start so the new sequence plays from its beginning.
  const scene = useMemo(
    () => sceneWithCompiledTrack(baseScene, active.manifest),
    [baseScene, active.manifest],
  );
  const momentDurationMs = active.momentWindowMs[1] - active.momentWindowMs[0];
  const autoRun = useMemo(
    () =>
      started
        ? { camera: 'directed' as const, fromMs: askFocusMs ?? active.momentWindowMs[0] }
        : null,
    [started, active.momentWindowMs, askFocusMs],
  );

  return (
    <>
      <AskPanel busy={askBusy} status={askStatus} onSubmit={(text) => void ask(text)} />
      <div className="compile__stage-zone">
        <CompiledStage
          scene={scene}
          evidence={evidence}
          active={active}
          started={started}
          onWatch={() => setStarted(true)}
          autoRun={autoRun}
          momentDurationMs={momentDurationMs}
        />
        {lastRejected !== null ? (
          <p className="compile__last-valid mono" role="status" data-last-valid-banner="">
            PREVIEWING THE LAST SUCCESSFULLY COMPILED MOMENT · {active.manifestId} ·{' '}
            {active.manifestHash.slice(7, 23)}… — “{lastRejected.label}” was rejected (
            {String(lastRejected.errorCount)} error
            {lastRejected.errorCount === 1 ? '' : 's'}); nothing from it entered the scene.
          </p>
        ) : null}
      </div>

      <div className="compile__grid">
        {sourcePanel}
        <CompilerWorkbench
          entries={entries}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCompile={() => void compile()}
          busy={busy}
          verdict={verdict}
          verdictEntryId={verdictEntryId}
          requestError={requestError}
          activeHash={active.manifestHash}
        />
      </div>

      <RecapPanel active={active} />
    </>
  );
}
