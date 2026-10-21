'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { detectSceneCapabilities } from '@kyneloom/scene-renderer';
import {
  buildLandingField,
  fragmentBudget,
  type LandingFieldInput,
  type LandingFieldSpec,
} from '@/lib/landing-geometry';
import { ASSET_WARM_TIMEOUT_MS, EXPLORE_ASSETS, warmExploreAssets } from '@/lib/landing-assets';
import { hardNavigate, isNavigationHeld } from '@/lib/hard-navigate';
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
  const [viewportWidth, setViewportWidth] = useState(1280);

  useEffect(() => {
    setWebglOk(detectSceneCapabilities().webgl);
  }, []);

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
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
  // The FSM's config mirrors the LIVE reduced-motion preference (review
  // gate 1): dispatch always reads the CURRENT config, so a preference
  // flipped before pressing the CTA takes the direct idle-to-ready path,
  // never the choreography.
  useEffect(() => {
    setReducer((current) =>
      current.config.reducedMotion === reducedMotion
        ? current
        : { ...current, config: { ...current.config, reducedMotion } },
    );
  }, [reducedMotion]);
  const dispatch = useCallback((event: LandingEvent) => {
    setReducer((current) => ({
      ...current,
      state: stepLandingTransition(current.state, event, current.config, performance.now()),
    }));
  }, []);

  const phase = reducer.state.phase;

  // Device-tuned deterministic fragment budget (same seed → same field):
  // narrow viewports and coarse pointers BOTH drop to the mobile count, so
  // a desktop-pointer emulation at phone width can never hit 900 shards.
  const field: LandingFieldSpec = useMemo(
    () =>
      buildLandingField({
        ...fieldInput,
        fragmentCount: fragmentBudget(viewportWidth, coarsePointer),
      }),
    [fieldInput, viewportWidth, coarsePointer],
  );

  // Asset warm-up starts with the CTA. ASSETS_READY is dispatched ONLY when
  // every required asset genuinely responded ok (review gate 3): a 404, a
  // blocked network or an aborted load stays NOT-ready, and the transition
  // relies on the FSM's bounded assetMaxWaitMs ceiling — the user always
  // reaches /explore, whose own loading chip and WebGL/2D fallbacks take
  // over. Never a fabricated ready, never a trap.
  const warmStarted = useRef(false);
  const startTransition = useCallback((): void => {
    dispatch({ type: 'START' });
    if (!warmStarted.current) {
      warmStarted.current = true;
      void router.prefetch('/explore'); // best-effort, no readiness claim
      const controller = new AbortController();
      const abortTimer = window.setTimeout(() => controller.abort(), ASSET_WARM_TIMEOUT_MS);
      void warmExploreAssets(EXPLORE_ASSETS, (url, init) =>
        fetch(url, { ...init, signal: controller.signal }),
      ).then((ready) => {
        window.clearTimeout(abortTimer);
        if (ready) dispatch({ type: 'ASSETS_READY' });
      });
    }
  }, [dispatch, router]);

  const handlePhaseComplete = useCallback(
    (completed: 'intro' | 'fragments' | 'pitch_reveal') =>
      dispatch({ type: 'PHASE_COMPLETE', phase: completed }),
    [dispatch],
  );

  // READY = hand off to the real replay (exactly once).
  const navigated = useRef(false);
  // A HARD navigation, deliberately: the App Router's transition pipeline
  // runs through passive-effect scheduling that software renderers can
  // starve for many seconds while this canvas still draws (measured: push
  // delayed ~9 s and its transition never committing at ~2 fps).
  // location.assign is frame-rate independent; /explore then runs its own
  // enter choreography.
  useEffect(() => {
    if (phase !== 'ready' || navigated.current) return;
    navigated.current = true;
    // QA may hold the handoff to capture the reveal state (see
    // isNavigationHeld); released polling keeps the wait bounded and the
    // product behavior identical for real users.
    let released = false;
    const timer = window.setInterval(() => {
      if (released || !isNavigationHeld()) {
        released = true;
        window.clearInterval(timer);
        hardNavigate('/explore?enter=orb');
      }
    }, 100);
    return () => {
      if (!released) window.clearInterval(timer);
    };
  }, [phase]);

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
            startCount={reducer.state.startCount}
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
          {phase === 'fallback' ? (
            <Link
              href="/explore"
              className="btn btn--primary landing__cta"
              data-testid="enter-the-moment"
            >
              Enter the moment
              <span aria-hidden="true">→</span>
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn--primary landing__cta"
              onClick={phase === 'idle' ? startTransition : undefined}
              aria-disabled={phase !== 'idle' ? 'true' : undefined}
              data-busy={phase !== 'idle' ? 'true' : undefined}
              data-testid="enter-the-moment"
            >
              {phase === 'idle' ? 'Enter the moment' : 'Entering…'}
              <span aria-hidden="true">→</span>
            </button>
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
