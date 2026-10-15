/**
 * SSR-safe environment capability detection for the future WebGL scene.
 *
 * The renderer will run only in the browser, but its modules are imported by
 * server components and tests. Every browser API access here is guarded so
 * importing this module during server rendering never throws.
 */

export type SceneEnvironment = 'server' | 'browser';

export interface SceneCapabilities {
  readonly environment: SceneEnvironment;
  /** True only when a browser exposes WebGL or WebGL2 context creation. */
  readonly webgl: boolean;
  /** True when the user agent requests reduced motion. */
  readonly prefersReducedMotion: boolean;
  /** Device pixel ratio when available; 1 otherwise. */
  readonly devicePixelRatio: number;
}

/**
 * Detect what the current environment can render.
 * On the server this always reports `{ environment: 'server', webgl: false }`
 * so callers can branch to a non-3D fallback instead of crashing.
 */
export function detectSceneCapabilities(): SceneCapabilities {
  if (typeof window === 'undefined') {
    return {
      environment: 'server',
      webgl: false,
      prefersReducedMotion: false,
      devicePixelRatio: 1,
    };
  }

  return {
    environment: 'browser',
    webgl: detectWebGL(window),
    prefersReducedMotion: matchesReducedMotion(window),
    devicePixelRatio: window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
  };
}

function detectWebGL(win: Window): boolean {
  const canvas = win.document.createElement('canvas');
  try {
    return canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null;
  } catch {
    // A throwing getContext (blocked, unsupported, out of resources) means no WebGL.
    return false;
  }
}

function matchesReducedMotion(win: Window): boolean {
  return win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}
