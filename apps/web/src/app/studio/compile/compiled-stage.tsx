'use client';

import type { EvidenceProjection } from '@/lib/evidence-data';
import type { SceneData } from '@/lib/scene-data';
import type { CompiledMomentView } from '@/lib/compiled-moment';
import { ReplayStage } from '@/app/explore/replay-stage';

/**
 * KYN-16 — the compiled-moment stage. The stage itself is the EXISTING
 * Living Replay (same R3F scene, transport, cameras, 2D fallback, X-Ray);
 * the active compiled artifact supplies the directed camera track, the
 * identity chip, the moment-window marker and the synchronized broadcast
 * overlay. Playback starts only on the explicit "Watch" action — the poster
 * tells the truth about what is about to play (draft status, hash, window)
 * before a single frame moves; after that, every recompile rebinds in place.
 */
export function CompiledStage({
  scene,
  evidence,
  active,
  started,
  onWatch,
  autoRun,
  momentDurationMs,
}: {
  readonly scene: SceneData;
  readonly evidence: EvidenceProjection;
  readonly active: CompiledMomentView;
  readonly started: boolean;
  readonly onWatch: () => void;
  readonly autoRun: { readonly camera: 'directed'; readonly fromMs: number } | null;
  readonly momentDurationMs: number;
}) {
  return (
    <section className="compile__stage-wrap" aria-label="Compiled moment stage">
      <ReplayStage
        scene={scene}
        evidence={evidence}
        compiled={{
          manifestId: active.manifestId,
          manifestHash: active.manifestHash,
          momentWindowMs: active.momentWindowMs,
          cues: active.cues,
        }}
        autoRun={autoRun}
      />
      {!started ? (
        <div className="compile__poster" data-compile-poster="">
          <p className="chip chip--evidence">Compiled manifest · draft</p>
          <p className="compile__poster-title">{active.manifestId}</p>
          <p className="compile__poster-hash mono" title={active.manifestHash}>
            {active.manifestHash}
          </p>
          <p className="compile__poster-body">
            A validated camera sequence, a measured separation overlay and a source-linked recap —
            one manifest, one match clock, one evidence set. Status is{' '}
            <span className="mono">draft</span>; no approval exists.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onWatch}
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
