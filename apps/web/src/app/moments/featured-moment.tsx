'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { formatMatchClock } from '@/lib/clock';
import type { GoldenStoryFacts } from '@/lib/match-fixture';
import type { CatalogSeparationMetric, MomentCatalogEntry } from '@/lib/moment-catalog';
import { exploreHrefFor } from '@/lib/moment-catalog';
import type { MotionRecord, PreviewRecord } from './previews';
import { createTiltController } from './tilt';

/**
 * KYN-10 FeaturedMoment — the large-format cinematic presentation of The
 * Invisible Assist. Real scene imagery only: a genuine motion preview
 * captured from the playing Living Replay (paused offscreen, on hidden
 * documents and for reduced-motion users) with the real paused frame as
 * poster/fallback. Pointer depth is the same adapted TiltedCard spring
 * system at featured scale — parallax travel on the media layer and a
 * glare that follows the pointer; the editorial content stays stable.
 */

export interface FeaturedMomentProps {
  readonly entry: MomentCatalogEntry;
  readonly preview: PreviewRecord | null;
  readonly motion: MotionRecord | null;
  readonly story: GoldenStoryFacts | null;
  readonly separationMetric: CatalogSeparationMetric | null;
  readonly seed: number | null;
}

export function FeaturedMoment({
  entry,
  preview,
  motion,
  story,
  separationMetric,
  seed,
}: FeaturedMomentProps) {
  const mediaRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Genuine motion preview lifecycle: play ONLY while onscreen, while the
  // document is visible, and never for reduced-motion users. No orphaned
  // observers/listeners.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || motion === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return; // poster only — the static presentation is complete

    let onscreen = false;
    let visibleDoc = !document.hidden;
    const sync = (): void => {
      if (onscreen && visibleDoc && !reduced.matches) {
        void video.play().catch(() => {
          /* autoplay refused — the poster remains, nothing is fabricated */
        });
      } else {
        video.pause();
      }
    };
    const onVisibility = (): void => {
      visibleDoc = !document.hidden;
      sync();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        onscreen = entries.some((item) => item.isIntersecting);
        sync();
      },
      { threshold: 0.2 },
    );
    observer.observe(video);
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', sync);
      video.pause();
    };
  }, [motion]);

  // Featured depth: bounded spring parallax on the media + pointer glare.
  useEffect(() => {
    const el = mediaRef.current;
    if (el === null) return;
    const section = el.closest('section');
    if (section === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (reduced || !finePointer) return;

    const controller = createTiltController(el, {
      amplitudeDeg: 0,
      liftScale: 1,
      omega: 12,
      zeta: 0.95,
    });
    const onMove = (event: PointerEvent): void => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      controller.pointer(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        ((event.clientY - rect.top) / rect.height) * 2 - 1,
      );
    };
    const onLeave = (): void => controller.pointer(0, 0);
    section.addEventListener('pointermove', onMove, { passive: true });
    section.addEventListener('pointerleave', onLeave);
    return () => {
      section.removeEventListener('pointermove', onMove);
      section.removeEventListener('pointerleave', onLeave);
      controller.destroy();
    };
  }, []);

  const posterSrc = preview?.src ?? motion?.poster ?? null;
  const separation = entry.facts.separationM;

  return (
    <section
      className="featured"
      aria-labelledby="featured-title"
      data-featured-entry={entry.catalogId}
    >
      <div className="featured__media" ref={mediaRef}>
        {motion !== null ? (
          <video
            ref={videoRef}
            className="featured__video"
            src={motion.src}
            poster={posterSrc ?? undefined}
            muted
            loop
            playsInline
            preload="none"
            data-featured-motion={motion.fromMs}
            aria-hidden="true"
          />
        ) : posterSrc !== null ? (
          <img
            className="featured__video"
            src={posterSrc}
            alt="Scene preview: the Living Replay paused at the start of the decoy run"
            decoding="async"
          />
        ) : (
          <div className="featured__video featured__video--missing" aria-hidden="true" />
        )}
        <div className="featured__scrim" aria-hidden="true" />
        <div className="featured__glare" aria-hidden="true" />
      </div>

      <div className="container featured__content">
        <p className="featured__eyebrow mono">
          Featured chapter · {formatMatchClock(entry.focusMs)} · synthetic ground truth
          {seed !== null ? ` · seed ${seed}` : ''}
        </p>
        <h2 className="featured__title" id="featured-title">
          {entry.title}
        </h2>
        <p className="featured__hook">{entry.hook}</p>

        <dl className="featured__facts mono">
          {separationMetric !== null ? (
            <>
              <div>
                <dt>Separation</dt>
                <dd>
                  {separationMetric.beforeM.toFixed(3)} → {separationMetric.afterM.toFixed(3)} m (+
                  {separationMetric.deltaM.toFixed(3)})
                </dd>
              </div>
              {story !== null ? (
                <>
                  <div>
                    <dt>Pass</dt>
                    <dd>
                      {story.pass.distanceM.toFixed(3)} m · release {story.pass.speedMps.toFixed(3)}{' '}
                      m/s
                    </dd>
                  </div>
                  <div>
                    <dt>Strike</dt>
                    <dd>
                      {story.shot.distanceM.toFixed(3)} m · release {story.shot.speedMps.toFixed(3)}{' '}
                      m/s
                    </dd>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <div>
              <dt>Measured separation at opening</dt>
              <dd>{separation !== undefined ? `${separation.toFixed(3)} m` : 'unavailable'}</dd>
            </div>
          )}
        </dl>
        <p className="featured__facts-note">
          Separation from the versioned Evidence X-Ray metric (
          {separationMetric?.algorithmVersion ?? 'unavailable'}) over exact source frames; distances
          cross-checked against accepted tracking; release speeds are generator-recorded values from
          the committed fixture metadata.
        </p>
        <p className="featured__interpretation" data-featured-interpretation="">
          <span className="mono featured__interpretation-tag">Interpretation</span>
          That the decoy run drew the defender and opened the lane is a tactical reading of the
          measured separation — the tracking proves the space and the event order, not the cause.
        </p>

        <div className="featured__actions">
          <Link href={exploreHrefFor(entry)} className="btn btn--primary featured__cta">
            Enter the scene
          </Link>
          <a className="featured__browse" href="#chapters">
            Browse the twelve chapters ↓
          </a>
        </div>
      </div>
    </section>
  );
}
