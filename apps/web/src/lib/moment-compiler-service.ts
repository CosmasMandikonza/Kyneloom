import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '@kyneloom/contracts';
import {
  createTimeline,
  detectMomentCandidates,
  ROSTERS,
  type MomentCandidate,
} from '@kyneloom/match-core';
import {
  buildCompileCorpus,
  compileMomentProposal,
  type CompileResult,
  type CompilerSourceContext,
  type CorpusEntry,
} from '@kyneloom/moment-compiler';
import type { GoldenMatchStatus } from './match-fixture';

/**
 * KYN-16 server-side compiler service: builds the TRUSTED source context from
 * the committed golden fixture (accepted reducer output + deterministic
 * candidate detection + content digests + tenant allowlists), exposes the
 * deterministic local proposal corpus, and compiles proposals through the
 * moment-compiler boundary. The filesystem, reducer and detector stay on this
 * side; clients only ever see typed compile results.
 *
 * This is also the seam a real Microsoft Foundry workflow (KYN-15) plugs
 * into: it posts a MomentProposal, this service supplies the trusted source,
 * and the deterministic compiler adjudicates. No agent credential ever
 * reaches an approval path (docs/10).
 */

const TENANT_ID = 'demo-org';
const RIGHTS_POLICY_ALLOWLIST = ['synthetic-0bsd-demo-v1', 'demo-synthetic-policy-v1'];
const ASSET_URL_PREFIXES = ['https://assets.kyneloom.local/tenants/demo-org/'];

/** The detection profile that grounds the compile corpus (documented). */
const DETECTION_PROFILE = {
  separationPairs: [{ defenderId: 'away-03', strikerId: 'home-09' }],
  movementSubjects: ['home-11'],
  windowMs: [4_717_000, 4_731_000] as const,
};

/** Digest of exactly the accepted content the context was built from. */
function combinedSourceHash(
  acceptedEvents: readonly unknown[],
  acceptedTracking: readonly unknown[],
): string {
  const sha = (value: unknown): string =>
    `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`;
  return sha({ events: sha(acceptedEvents), tracking: sha(acceptedTracking) });
}

export interface CompilerSourceSnapshot {
  readonly context: CompilerSourceContext;
  readonly sourceHash: string;
}

export type CompilerSourceStatus =
  | { readonly ok: true; readonly snapshot: CompilerSourceSnapshot }
  | {
      readonly ok: false;
      readonly reason: 'unavailable' | 'invalid' | 'no-candidates';
      readonly message: string;
    };

/** Build the trusted source context from the committed golden fixture. */
export function buildCompilerSource(golden: GoldenMatchStatus): CompilerSourceStatus {
  if (!golden.ok) return { ok: false, reason: golden.reason, message: golden.message };
  const { projected } = golden.data;
  const timeline = createTimeline(projected.acceptedTracking);
  const candidates = detectMomentCandidates({
    matchId: golden.data.matchId,
    reducerRevision: projected.revisionCount,
    events: projected.acceptedEvents,
    tracking: projected.acceptedTracking,
    timeline,
    separationPairs: DETECTION_PROFILE.separationPairs,
    movementSubjects: DETECTION_PROFILE.movementSubjects,
    windowMs: [...DETECTION_PROFILE.windowMs] as [number, number],
  });
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no-candidates',
      message:
        'The deterministic detector found no candidate moments for this fixture — nothing can be compiled.',
    };
  }
  const rolesByEntity = new Map<string, string>();
  for (const team of ['home', 'away'] as const) {
    for (const profile of ROSTERS[team]) rolesByEntity.set(profile.entityId, profile.role);
  }
  const sourceHash = combinedSourceHash(projected.acceptedEvents, projected.acceptedTracking);
  return {
    ok: true,
    snapshot: {
      sourceHash,
      context: {
        tenantId: TENANT_ID,
        matchId: golden.data.matchId,
        reducerRevision: projected.revisionCount,
        sourceHash,
        timeline,
        tracking: projected.acceptedTracking,
        events: projected.acceptedEvents,
        playerEntityIds: [
          ...new Set(
            projected.acceptedTracking
              .map((sample) => sample.entityId)
              .filter((id) => id !== 'ball'),
          ),
        ].sort(),
        rolesByEntity,
        candidates,
        rightsPolicyAllowlist: RIGHTS_POLICY_ALLOWLIST,
        assetUrlPrefixes: ASSET_URL_PREFIXES,
      },
    },
  };
}

/** Client-visible metadata about the selected source moment. */
export interface SourceMomentCard {
  readonly candidateId: string;
  readonly windowMs: readonly [number, number];
  readonly totalScore: number;
  readonly reasonCodes: readonly string[];
  readonly anchorEventIds: readonly string[];
  readonly eventCount: number;
}

export function sourceMomentCard(candidate: MomentCandidate, eventCount: number): SourceMomentCard {
  return {
    candidateId: candidate.candidateId,
    windowMs: [candidate.startMs, candidate.endMs],
    totalScore: candidate.totalScore,
    reasonCodes: candidate.reasonCodes,
    anchorEventIds: candidate.anchorEventIds,
    eventCount,
  };
}

/** The client-facing corpus entry (the proposal document travels with it). */
export interface CorpusEntryCard {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly expect: CorpusEntry['expect'];
  readonly expectedCode?: string;
  readonly proposal: unknown;
}

export interface WorkbenchPayload {
  readonly source: {
    readonly matchId: string;
    readonly tenantId: string;
    readonly reducerRevision: number;
    readonly sourceHash: string;
    readonly candidate: SourceMomentCard;
    readonly coverageMs: readonly [number, number];
  };
  readonly golden: { readonly proposal: unknown };
  readonly entries: readonly CorpusEntryCard[];
  readonly initialResult: CompileResult;
}

export type WorkbenchStatus =
  | { readonly ok: true; readonly payload: WorkbenchPayload }
  | { readonly ok: false; readonly message: string };

/** Everything the /studio/compile route needs in one server call. */
export function buildWorkbenchPayload(
  golden: GoldenMatchStatus,
  source: CompilerSourceStatus,
): WorkbenchStatus {
  if (!source.ok) return { ok: false, message: source.message };
  const corpus = buildCompileCorpus(source.snapshot.context);
  const initialResult = compileMomentProposal(corpus.golden, source.snapshot.context);
  if (!initialResult.ok) {
    // The committed corpus must compile against the committed fixture; if it
    // does not, the surface fails truthfully instead of improvising.
    return {
      ok: false,
      message: `The deterministic golden proposal failed compilation against the current fixture (${initialResult.errors[0]?.message ?? 'unknown error'}). Nothing is shown rather than an unverified moment.`,
    };
  }
  return {
    ok: true,
    payload: {
      source: {
        matchId: source.snapshot.context.matchId,
        tenantId: source.snapshot.context.tenantId,
        reducerRevision: source.snapshot.context.reducerRevision,
        sourceHash: source.snapshot.sourceHash,
        candidate: sourceMomentCard(corpus.candidate, corpus.candidate.eventIds.length),
        coverageMs: [
          source.snapshot.context.timeline.minTimeMs,
          source.snapshot.context.timeline.maxTimeMs,
        ],
      },
      golden: { proposal: corpus.golden },
      entries: corpus.entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        expect: entry.expect,
        ...(entry.expectedCode === undefined ? {} : { expectedCode: entry.expectedCode }),
        proposal: entry.proposal,
      })),
      initialResult,
    },
  };
}
