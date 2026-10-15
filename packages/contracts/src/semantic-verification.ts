/**
 * Separation of schema validation from semantic verification (KYN-02).
 *
 * `parseMomentManifest` and friends prove that a document is *well-formed
 * and internally consistent*. They deliberately cannot prove any of the
 * following, because those require match-state data, source registries,
 * tenant rights, or database access:
 *
 * 1. **Reference existence** — `input.sourceEventIds`, `trackingSampleRefs`,
 *    `evidence[].ref` and `overlays[].metricRef` actually exist in the pinned
 *    `input.reducerRevision`. Verifier input: reducer snapshot or registry.
 * 2. **Numerical consistency** — values quoted by claims match the metric
 *    output computed by the deterministic engine for those refs.
 * 3. **Rights** — `rightsPolicyRef` permits this tenant, these sources and
 *    the destination. Verifier input: rights/policy store.
 * 4. **Authorization** — `approval` was minted by the publication service for
 *    this exact manifest hash; a client-supplied record is never trusted.
 * 5. **Source-revision currency** — `manifestInputFingerprint(manifest)`
 *    still equals the fingerprint recorded when validation/approval ran; a
 *    changed fingerprint means every derived artifact is stale.
 *
 * Consumers implement these checks where the data lives (reducer workers,
 * compiler, publication service). This module exists so the boundary is a
 * named, documented contract rather than an implicit assumption.
 */

export interface ManifestSemanticCheck {
  readonly id: string;
  readonly description: string;
  /** What the verifying system must have access to. */
  readonly requires: string;
}

export const MANIFEST_SEMANTIC_CHECKS: readonly ManifestSemanticCheck[] = [
  {
    id: 'reference-existence',
    description:
      'Every source event id, tracking sample ref, evidence ref and metric ref exists in the pinned reducer revision and is authorized for the tenant.',
    requires: 'match-state snapshot (reducer revision) + source registry',
  },
  {
    id: 'numerical-consistency',
    description:
      'Numbers quoted by claims equal the deterministic metric outputs computed from the referenced inputs.',
    requires: 'match-core metric engine',
  },
  {
    id: 'rights-policy',
    description:
      'The rights policy permits the tenant, inputs, assets and destinations referenced by the manifest.',
    requires: 'rights/policy store',
  },
  {
    id: 'server-issued-approval',
    description:
      'The approval record was minted by the publication service for this exact manifest hash and revision.',
    requires: 'publication service database',
  },
  {
    id: 'input-revision-currency',
    description:
      'manifestInputFingerprint(manifest) is unchanged since the last successful validation; otherwise revalidation is required.',
    requires: 'recorded fingerprint from previous validation',
  },
] as const;
