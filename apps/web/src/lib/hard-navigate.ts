/**
 * KYN-09/KYN-12 — a frame-rate-independent navigation for the landing →
 * replay handoff. The App Router's transition pipeline runs through
 * passive-effect scheduling that software renderers can starve for many
 * seconds while a WebGL canvas keeps drawing (measured on SwiftShader:
 * router.push delayed ~9 s, its transition never committing at ~2 fps). A
 * hard navigation is un-starvable; isolated here so tests can mock it.
 */
export function hardNavigate(url: string): void {
  window.location.assign(url);
}

/**
 * QA seam: when `window.__kyneloomLandingHold` is true, the landing's READY
 * navigation waits (polled) instead of firing. Visual QA uses this to
 * capture the reveal state deterministically before releasing the handoff.
 * No product code sets it; users are never held.
 */
export function isNavigationHeld(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as { __kyneloomLandingHold?: boolean }).__kyneloomLandingHold === true
  );
}
