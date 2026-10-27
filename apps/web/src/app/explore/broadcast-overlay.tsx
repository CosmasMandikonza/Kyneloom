'use client';

import { useEffect, useRef } from 'react';
import type { AbsoluteCue } from '@/lib/compiled-moment';
import { useSceneRuntime } from './scene/scene-context';

/**
 * KYN-16 — the transparent time-coded broadcast overlay surface (issue #31).
 *
 * Renders the compiled moment's typed cues over the SAME R3F stage, driven by
 * the SAME authoritative playheadMs the scene renders from (absolute match
 * milliseconds — the cue clock IS the replay clock, no conversion). Cue text
 * is compiler-verified content only: a verified metric value, a verified
 * claim's own words, or a source event's kind/actor. Nothing is invented or
 * interpolated client-side.
 *
 * Per the transport-loop law: DOM textContent updates from a rAF loop, never
 * per-frame React renders. The static recap panel (same texts, same evidence
 * ids) is the accessible non-transient alternative.
 */
export function BroadcastOverlay({ cues }: { readonly cues: readonly AbsoluteCue[] }) {
  const { engine } = useSceneRuntime();
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const metaRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let lastSync = 0;
    const loop = (now: number): void => {
      if (now - lastSync > 90) {
        lastSync = now;
        const t = engine.playheadMs;
        const active = cues.find((cue) => t >= cue.startMs && t < cue.endMs) ?? null;
        if (boxRef.current !== null) boxRef.current.hidden = active === null;
        if (active !== null) {
          if (textRef.current !== null) textRef.current.textContent = active.text;
          if (metaRef.current !== null) {
            metaRef.current.textContent = `${active.kind.toUpperCase()} · ${active.evidenceIds.join(', ')}`;
          }
        }
        const hook = (
          window as unknown as {
            __kyneloomCompiled?: { setActiveCue(text: string | null): void };
          }
        ).__kyneloomCompiled;
        hook?.setActiveCue(active === null ? null : active.text);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cues, engine]);

  return (
    <div className="bcoverlay" ref={boxRef} data-broadcast-overlay="" hidden>
      <span className="bcoverlay__text mono" ref={textRef} />
      <span className="bcoverlay__meta mono" ref={metaRef} />
    </div>
  );
}
