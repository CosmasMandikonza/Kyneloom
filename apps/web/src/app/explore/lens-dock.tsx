'use client';

import { useEffect, useRef } from 'react';
import { LENS_HINTS, LENS_IDS, LENS_LABELS, type LensId } from '@/lib/lens';
import { stepSpring, type Spring } from '@/lib/spring';

/**
 * The perspective dock (KYN-11) — the one place a viewer changes how they
 * experience the SAME moment.
 *
 * Magnification mechanics ADAPTED (not copied) from Cult UI `Dock` at
 * commit `7f031dc812f7bda10213bab62752dd6d080297ff`
 * (https://github.com/nolly-studio/cult-ui/blob/7f031dc812f7bda10213bab62752dd6d080297ff/apps/www/registry/default/ui/dock.tsx),
 * MIT License, Copyright (c) 2023 Jordan-Gilliam — notice preserved.
 * Adapted from the upstream demo: the shared-pointer/width context and
 * per-card `distance → size` transform with springs are re-expressed with
 * this repository's settle-aware spring integrator and direct style writes
 * (no React re-renders in pointermove, no `motion` dependency, no rAF at
 * rest); the demo's absolute `left-3/4` positioning, image tiles and
 * `parseInt(id)` numeric identity are all replaced with semantic radio
 * controls, safe positioning and stable string ids. Magnification is a
 * fine-pointer enhancement only — touch, keyboard and reduced-motion users
 * get identical static, fully operable targets (≥ 44px class).
 */

export interface LensDockProps {
  readonly lens: LensId;
  readonly onSelect: (lens: LensId) => void;
}

const BASE = 44; // px — minimum touch-target class even unmagnified
const MAX_LIFT = 14; // px magnification amplitude (upstream: 36 — restrained here)
/**
 * Spring tuning bounded by the integrator's stability envelope: the
 * explicit damping term is stable only while 2·ζ·ω·h < 2 with h = 1/240 s
 * (ω < ~266); 60 sits comfortably inside and still settles in ~70 ms.
 */
const OMEGA = 60;
const ZETA = 0.9;

interface ItemController {
  readonly width: Spring;
  readonly lift: Spring;
}

export function LensDock({ lens, onSelect }: LensDockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const controllersRef = useRef<ItemController[]>(
    LENS_IDS.map(() => ({ width: { value: BASE, velocity: 0 }, lift: { value: 0, velocity: 0 } })),
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (reduced || !finePointer) {
      // Static, fully operable presentation — identical semantics.
      for (const button of itemRefs.current) {
        if (button !== null) button.style.width = '';
      }
      return;
    }

    let raf = 0;
    let last = 0;
    let pointerX = Number.NaN;
    const items = controllersRef.current;

    const writeStyles = (): void => {
      for (let index = 0; index < itemRefs.current.length; index += 1) {
        const button = itemRefs.current[index];
        if (button === null || button === undefined) continue;
        const controller = items[index]!;
        button.style.width = `${controller.width.value.toFixed(2)}px`;
        button.style.transform = `translateY(${(-controller.lift.value).toFixed(2)}px)`;
      }
    };

    const frame = (now: number): void => {
      raf = 0;
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
      last = now;
      let busy = false;
      for (let index = 0; index < itemRefs.current.length; index += 1) {
        const button = itemRefs.current[index];
        const controller = items[index];
        if (button === null || button === undefined || controller === undefined) continue;
        let targetWidth = BASE;
        let targetLift = 0;
        if (Number.isFinite(pointerX)) {
          const rect = button.getBoundingClientRect();
          const distance = pointerX - (rect.left + rect.width / 2);
          // Upstream's cosine falloff: full lift at the item center, decaying
          // across ~1.5 dock widths.
          const falloff = Math.cos((Math.min(Math.abs(distance) / 220, 1) * Math.PI) / 2) ** 12;
          targetWidth = BASE + MAX_LIFT * falloff;
          targetLift = MAX_LIFT * 0.55 * falloff;
        }
        busy = stepSpring(controller.width, targetWidth, OMEGA, ZETA, dt) || busy;
        busy = stepSpring(controller.lift, targetLift, OMEGA, ZETA, dt) || busy;
        // Hard clamps: a control must be physically incapable of flying off
        // the screen even if a future tuning breaks the stability envelope.
        controller.width.value = Math.min(
          BASE + MAX_LIFT + 2,
          Math.max(BASE - 2, controller.width.value),
        );
        controller.lift.value = Math.min(MAX_LIFT, Math.max(0, controller.lift.value));
        if (Math.abs(controller.width.velocity) > 1e4) controller.width.velocity = 0;
        if (Math.abs(controller.lift.velocity) > 1e4) controller.lift.velocity = 0;
      }
      writeStyles();
      if (busy) raf = requestAnimationFrame(frame);
    };

    const wake = (): void => {
      if (raf !== 0) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const onMove = (event: PointerEvent): void => {
      pointerX = event.clientX;
      wake();
    };
    const onLeave = (): void => {
      pointerX = Number.NaN;
      wake();
    };
    container.addEventListener('pointermove', onMove, { passive: true });
    container.addEventListener('pointerleave', onLeave);
    return () => {
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
      if (raf !== 0) cancelAnimationFrame(raf);
      for (const button of itemRefs.current) {
        if (button !== null) {
          button.style.width = '';
          button.style.transform = '';
        }
      }
    };
  }, []);

  const groupId = 'lens-dock';

  return (
    <div
      ref={containerRef}
      className="lens-dock"
      role="radiogroup"
      aria-labelledby={`${groupId}-label`}
      data-testid="lens-dock"
    >
      <span id={`${groupId}-label`} className="visually-hidden">
        Viewing perspective — switches presentation only, never the moment
      </span>
      {LENS_IDS.map((id, index) => (
        <button
          key={id}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={lens === id}
          className={`lens-dock__item${lens === id ? ' lens-dock__item--active' : ''}`}
          data-lens={id}
          title={LENS_HINTS[id]}
          onClick={() => onSelect(id)}
        >
          <span className="lens-dock__icon" aria-hidden="true">
            {id === 'fan' ? '◉' : id === 'analyst' ? '◇' : '▤'}
          </span>
          <span className="lens-dock__label">{LENS_LABELS[id]}</span>
        </button>
      ))}
    </div>
  );
}
