import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import type { MetricToolContext, MomentCandidate, Timeline } from '@kyneloom/match-core';

/**
 * The TRUSTED side of the compiler boundary (KYN-16).
 *
 * Everything in a `CompilerSourceContext` is source-derived truth the
 * compiler may rely on: the accepted reducer output, the deterministic
 * candidate detection (KYN-12), the current revision identity, and the
 * tenant/rights allowlists. Nothing here is ever taken from the proposal.
 *
 * Builders (web service, tests, a future Foundry worker) construct this from
 * the authoritative pipeline — `projectMatch` → accepted events/tracking →
 * `createTimeline` → `detectMomentCandidates` — plus the content digests of
 * exactly those arrays. The compiler itself performs no I/O: identical
 * contexts compile identical proposals to identical manifests.
 */

export interface CompilerSourceContext {
  /** The tenant this compilation is scoped to; proposals must match it. */
  readonly tenantId: string;
  readonly matchId: string;
  /** Current reducer revision of the accepted corpus. */
  readonly reducerRevision: number;
  /**
   * Digest of the accepted content this context was built from
   * (`sha256:<hex>`). A proposal's `basedOn.sourceHash` must equal it — a
   * source correction changes the digest and invalidates stale proposals.
   */
  readonly sourceHash: string;
  readonly timeline: Timeline;
  readonly tracking: readonly TrackingSample[];
  readonly events: readonly MatchEvent[];
  /** All tracked player entity ids (the metric tool's candidate set). */
  readonly playerEntityIds: readonly string[];
  /** Authoritative roster roles, when the builder has them. */
  readonly rolesByEntity?: ReadonlyMap<string, string>;
  /** Deterministic candidate moments detected for this corpus (KYN-12). */
  readonly candidates: readonly MomentCandidate[];
  /** Rights policies this tenant may publish under. */
  readonly rightsPolicyAllowlist: readonly string[];
  /**
   * Tenant-scoped https prefixes every proposed asset URL must fall under.
   * A well-formed URL outside these prefixes is a cross-tenant reference.
   */
  readonly assetUrlPrefixes: readonly string[];
}

/** The metric-tool execution context derived from a source context. */
export function metricToolContextFrom(source: CompilerSourceContext): MetricToolContext {
  return {
    matchId: source.matchId,
    reducerRevision: source.reducerRevision,
    timeline: source.timeline,
    tracking: source.tracking,
    events: source.events,
    playerEntityIds: source.playerEntityIds,
    ...(source.rolesByEntity === undefined ? {} : { rolesByEntity: source.rolesByEntity }),
  };
}
