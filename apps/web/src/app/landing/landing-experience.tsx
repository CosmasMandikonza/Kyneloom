'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { detectSceneCapabilities } from '@kyneloom/scene-renderer';
import {
  buildLandingField,
  type LandingFieldInput,
  type LandingFieldSpec,
} from '@/lib/landing-geometry';
import {
  DEFAULT_LANDING_CONFIG,
  initialLandingState,
  isInterruptible,
  stepLandingTransition,
  type LandingEvent,
  type LandingTransitionState,
} from '@/lib/landing-transition';
import { OrbField } from './orb-field';

/**
 * KYN-09 — the landing encounter driver.
 *
 * The pure FSM in lib/landing-transition owns the phase; this component owns
 * the React side: rendering the correct layer per phase, warming /explore's
 * heavy assets while the choreography plays (asset readiness gates the
 * reveal completion), skipping, reduced motion, and the truthful fallback
 * when WebGL is unavailable or dies mid-transition. The CTA stays a real
 * button at every moment; effects never capture pointer events above it.
 */

/** Warmed by the CTA so /explore starts fast (same-origin static assets). */
const EXPLORE_ASSETS = ['/models/footballer.glb'];

export interface LandingExperienceProps {
  readonly fixtureFacts: {
    readonly matchClock: string | null;
    readonly finalScore: string | null;
    readonly sampleCount: number | null;
    readonly seed: number | null;
    readonly fixtureNote: string;
    readonly generatorVersion: string | null;
  };
  /** Real fixture geometry for the fragment field (same truth as Explore). */
  readonly fieldInput: LandingFieldInput;
}

type ReducedState = { state: LandingTransitionState; config: typeof DEFAULT_LANDING_CONFIG };

export function LandingExperience({ fixtureFacts, fieldInput }: LandingExperienceProps) {
  const router = useRouter();
  // Hydration-safe capability gate: SSR and the first client paint agree
  // (poster), the real check swaps the canvas in after mount. Without this
  // the server/client HTML diverges (React error #418).
  const [webglOk, setWebglOk] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);

  useEffect(() => {
    setWebglOk(detectSceneCapabilities().webgl);
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarse = window.matchMedia('(pointer: coarse)');
    const apply = (): void => {
      setReducedMotion(reduced.matches);
      setCoarsePointer(coarse.matches);
    };
    apply();
    reduced.addEventListener('change', apply);
    coarse.addEventListener('change', apply);
    return () => {
      reduced.removeEventListener('change', apply);
      coarse.removeEventListener('change', apply);
    };
  }, []);

  const [reducer, setReducer] = useState<ReducedState>(() => ({
    state: initialLandingState(),
    config: DEFAULT_LANDING_CONFIG,
  }));
  const dispatch = useCallback((event: LandingEvent) => {
    setReducer((current) => ({
      ...current,
      state: stepLandingTransition(current.state, event, current.config, performance.now()),
    }));
  }, []);

  const phase = reducer.state.phase;

  // Device-tuned deterministic fragment budget (same seed → same field).
  const field: LandingFieldSpec = useMemo(
    () =>
      buildLandingField({
        ...fieldInput,
        fragmentCount: coarsePointer ? 320 : 900,
      }),
    [fieldInput, coarsePointer],
  );

  // Asset warm-up starts with the CTA; readiness gates the reveal's exit.
  const warmStarted = useRef(false);
  const startTransition = useCallback((): void => {
    dispatch({ type: 'START' });
    if (!warmStarted.current) {
      warmStarted.current = true;
      void router.prefetch('/explore');
      void Promise.all(
        EXPLORE_ASSETS.map(async (url) => {
          try {
            await fetch(url, { priority: 'low' as RequestPriority });
          } catch {
            /* warm-up is best-effort; /explore loads honestly on its own */
          }
        }),
      ).then(() => dispatch({ type: 'ASSETS_READY' }));
      // The FSM's assetMaxWaitMs ceiling makes this a soft gate only.
      window.setTimeout(() => dispatch({ type: 'ASSETS_READY' }), 3200);
    }
  }, [dispatch, router]);

  const handlePhaseComplete = useCallback(
    (completed: 'intro' | 'fragments' | 'pitch_reveal') =>
      dispatch({ type: 'PHASE_COMPLETE', phase: completed }),
    [dispatch],
  );

  // READY = hand off to the real replay (exactly once).
  const navigated = useRef(false);
  useEffect(() => {
    if (phase === 'ready' && !navigated.current) {
      navigated.current = true;
      router.push('/explore?enter=orb');
    }
  }, [phase, router]);

  const webglUsable = webglOk && phase !== 'fallback';

  // No WebGL at all: fail truthfully to the poster + direct CTA path.
  useEffect(() => {
    if (webglOk || phase !== 'idle') return;
    const timer = window.setTimeout(() => {
      if (!detectSceneCapabilities().webgl) {
        dispatch({ type: 'FAIL', reason: 'webgl-unavailable' });
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [webglOk, phase, dispatch]);

  // Stable failure handler (inline identities would re-run canvas effects).
  const handleFail = useCallback(
    (reason: 'context-lost') => dispatch({ type: 'FAIL', reason }),
    [dispatch],
  );
  const choreographing = isInterruptible(phase);

  return (
    <section
      className="landing__stage"
      aria-labelledby="landing-title"
      data-phase={phase}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
    >
      {/* The single WebGL canvas: orb → fragments → real stadium reveal. */}
      {webglUsable ? (
        <div className="landing__canvas-layer" aria-hidden="true">
          <OrbField
            phase={phase}
            phaseEnteredAtMs={reducer.state.phaseEnteredAtMs}
            field={field}
            introMs={reducer.config.introMs}
            fragmentsMs={reducer.config.fragmentsMs}
            revealMs={reducer.config.revealMs}
            reducedMotion={reducedMotion}
            onPhaseComplete={handlePhaseComplete}
            onFail={handleFail}
          />
        </div>
      ) : (
        <div className="landing__poster" aria-hidden="true">
          <div className="landing__poster-orb" />
        </div>
      )}

      <div className="landing__content">
        <p className="landing__eyebrow">
          <span className="mono">SYNTHETIC&nbsp;FIXTURE&nbsp;·</span> The Invisible Assist
        </p>
        <h1 id="landing-title" className="landing__title">
          Every moment
          <br />
          has a <em>world</em> inside.
        </h1>
        <p className="landing__lede">
          One 78th-minute goal, held inside a single measured moment. Enter the world, follow the
          run nobody filmed, and open the evidence behind every number.
        </p>
        <div className="landing__actions">
          {phase === 'idle' ? (
            <button
              type="button"
              className="btn btn--primary landing__cta"
              onClick={startTransition}
              data-testid="enter-the-moment"
            >
              Enter the moment
              <span aria-hidden="true">→</span>
            </button>
          ) : (
            <Link
              href="/explore"
              className="btn btn--primary landing__cta"
              data-testid="enter-the-moment"
            >
              Enter the moment
              <span aria-hidden="true">→</span>
            </Link>
          )}
          <Link href="/studio" className="btn btn--ghost">
            Open Studio
          </Link>
        </div>

        {phase === 'idle' || phase === 'fallback' ? (
          <dl className="landing__facts" aria-label="Committed golden fixture facts">
            <div>
              <dt>Match clock</dt>
              <dd className="mono">{fixtureFacts.matchClock ?? '—'}</dd>
            </div>
            <div>
              <dt>Final score</dt>
              <dd className="mono">{fixtureFacts.finalScore ?? '—'}</dd>
            </div>
            <div>
              <dt>Tracking samples</dt>
              <dd className="mono">
                {fixtureFacts.sampleCount === null
                  ? '—'
                  : fixtureFacts.sampleCount.toLocaleString('en-US')}
              </dd>
            </div>
            <div>
              <dt>Seed</dt>
              <dd className="mono">{fixtureFacts.seed ?? '—'}</dd>
            </div>
          </dl>
        ) : null}

        {phase === 'fallback' ? (
          <p className="landing__fallback-note" role="status">
            The cinematic entry needs WebGL — falling back to the direct replay. Everything except
            the transition works exactly the same.
          </p>
        ) : null}

        {choreographing ? (
          <p className="landing__phase mono" role="status" aria-live="polite">
            {phase === 'intro'
              ? 'ENTERING THE MOMENT'
              : phase === 'fragments'
                ? 'THE MOMENT IS ASSEMBLING'
                : 'THE PITCH APPEARS'}
          </p>
        ) : null}
      </div>

      {choreographing ? (
        <button
          type="button"
          className="landing__skip"
          onClick={() => dispatch({ type: 'SKIP' })}
          data-testid="skip-intro"
        >
          Skip intro <span aria-hidden="true">»</span>
        </button>
      ) : null}
    </section>
  );
}
