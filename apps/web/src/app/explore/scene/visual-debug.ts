/**
 * Rendered-object probe registry (KYN-06 review QA affordance).
 *
 * Scene components register cheap getters over their REAL Three.js objects
 * (mesh transforms, camera position). The QA hook exposes them as
 * `window.__kyneloomScene.visual` so Playwright can assert RENDERED poses —
 * not just the source-data snapshot — e.g. "the ball mesh sits exactly at
 * the authoritative coordinates" or "the same playhead yields the same
 * orientation after arbitrary scrubs". Clearly labeled debug affordance;
 * never used by app logic.
 */

export interface SceneVisualProbe {
  /** Ball mesh world position [x, y, z] in Three meters, or null if absent. */
  readonly ballWorldPosition?: () => readonly [number, number, number] | null;
  /** Ball mesh world quaternion [x, y, z, w], or null if absent. */
  readonly ballQuaternion?: () => readonly [number, number, number, number] | null;
  /** A player root's rotation.y (radians), or null if the actor is absent. */
  readonly playerYaw?: (entityId: string) => number | null;
  /** Active camera world position [x, y, z], or null if absent. */
  readonly cameraWorldPosition?: () => readonly [number, number, number] | null;
}

const probes = new Map<string, SceneVisualProbe>();

export function registerVisualProbe(key: string, probe: SceneVisualProbe): () => void {
  probes.set(key, probe);
  return () => {
    probes.delete(key);
  };
}

/** Combined read-only view across all registered probes (first hit wins). */
export function sceneVisual(): SceneVisualProbe {
  return {
    ballWorldPosition: () => first('ballWorldPosition'),
    ballQuaternion: () => first('ballQuaternion'),
    playerYaw: (entityId) => {
      for (const probe of probes.values()) {
        if (probe.playerYaw !== undefined) {
          const value = probe.playerYaw(entityId);
          if (value !== null) return value;
        }
      }
      return null;
    },
    cameraWorldPosition: () => first('cameraWorldPosition'),
  };
}

function first<K extends keyof SceneVisualProbe>(
  key: K,
): SceneVisualProbe[K] extends (...args: never[]) => infer R | null ? R | null : never {
  for (const probe of probes.values()) {
    const getter = probe[key] as (() => unknown) | undefined;
    if (getter !== undefined) {
      const value = getter();
      if (value !== null && value !== undefined) return value as never;
    }
  }
  return null as never;
}
