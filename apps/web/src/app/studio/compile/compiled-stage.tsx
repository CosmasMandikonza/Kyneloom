'use client';

import { useMemo, useState } from 'react';
import type { SceneData } from '@/lib/scene-data';
import type { EvidenceProjection } from '@/lib/evidence-data';
import { ReplayStage, type CompiledMomentOverlay } from '@/app/explore/replay-stage';

/**
 * KYN-16 — the compiled-moment stage shell. The stage itself is the EXISTING
 * Living Replay (same R3F scene, transport, cameras, 2D fallback, X-Ray);
 * compilation adds the manifest identity chip, the moment-window marker on
 * the scrubber and the synchronized broadcast overlay. Playback starts only
 * on the explicit "Watch" action — the poster tells the truth about what is
 * about to play (draft status, hash, window) before a single frame moves.
 */
export function CompiledStage({
  scene,
  evidence,
  compiled,
  momentStartMs,
  momentDurationMs,
}: {
  readonly scene: SceneData;
  readonly evidence: EvidenceProjection;
  readonly compiled: CompiledMomentOverlay;
  readonly momentStartMs: number;
  readonly momentDurationMs: number;
}) {
  const [started, setStarted] = useState(false);
  const autoRun = useMemo(
    () => (started ? { camera: 'directed' as const, fromMs: momentStartMs } : null),
    [started, momentStartMs],
  );

  return (
    <section className="compile__stage-wrap" aria-label="Compiled moment stage">
      <ReplayStage scene={scene} evidence={evidence} compiled={compiled} autoRun={autoRun} />
      {!started ? (
        <div className="compile__poster" data-compile-poster="">
          <p className="chip chip--evidence">Compiled manifest · draft</p>
          <p className="compile__poster-title">{compiled.manifestId}</p>
          <p className="compile__poster-hash mono" title={compiled.manifestHash}>
            {compiled.manifestHash}
          </p>
          <p className="compile__poster-body">
            A validated camera sequence, a measured separation overlay and a source-linked recap —
            one manifest, one match clock, one evidence set. Status is{' '}
            <span className="mono">draft</span>; no approval exists.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setStarted(true)}
            data-testid="watch-compiled-moment"
          >
            Watch the compiled moment
          </button>
          <p className="compile__poster-hint mono">
            DIRECTED CAMERA · {(momentDurationMs / 1000).toFixed(1)} s · ESC EXITS TO BROADCAST
          </p>
        </div>
      ) : null}
    </section>
  );
}
