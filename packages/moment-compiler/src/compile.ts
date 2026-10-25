import { createHash } from 'node:crypto';
import {
  PROPOSAL_TOOL_ALLOWLIST,
  approvalContentPayload,
  canonicalJsonStringify,
  manifestInputFingerprint,
  parseMomentManifest,
  parseMomentProposal,
  PITCH_COORDINATE_SYSTEM,
  type Claim,
  type ContractValidationError,
  type EvidenceEntry,
  type MatchEvent,
  type MetricQueryKind,
  type MomentManifest,
  type MomentProposal,
  type ProposalMetricQuery,
  type ProposalOrigin,
} from '@kyneloom/contracts';
import {
  executeMetricQuery,
  parseMetricQuery,
  type MetricQuery,
  type MetricResult,
  type MetricToolResult,
  type MetricVerified,
} from '@kyneloom/match-core';
import { eventFactSentence, metricFactSentence } from './facts';
import { metricToolContextFrom, type CompilerSourceContext } from './source-context';
import { buildManifestPresentation, type OverlayBinding } from './presentation';
import {
  describeAssetLocation,
  isAssetUrlWithinScopes,
  parseAssetScope,
  type AssetScope,
} from './asset-scope';

/**
 * The deterministic Playable Moment compiler (KYN-16, docs/06 gates 1–6).
 *
 * UNTRUSTED IN — MomentProposal (schema-validated first; see
 * contracts/moment-proposal.ts). TRUSTED OUT — a MomentManifest v0.2.0 draft
 * whose numbers, source references, temporal bounds, AUDIENCE-FACING TEXT
 * and hash were established by this module, never by the proposal author.
 * The compiler:
 *
 * 1. verifies revision currency (`basedOn` vs the source context);
 * 2. resolves the candidate moment and window against the deterministic
 *    detector output (KYN-12);
 * 3. verifies rights + tenant scoping for policy refs and asset URLs;
 * 4. recomputes every derived metric through `kyneloom-get-metric-v1`
 *    (the model can read numbers; it can never supply one);
 * 5. validates claims under the TEXT LAW — calculated/observed claim text is
 *    GENERATED from the verified value/event, hypotheses stay qualitative
 *    and number-free, and nothing untrusted can wear a verified label;
 * 6. emits field-path errors (`ContractValidationError`) for every violation
 *    it can name, and NOTHING on any violation — fail closed;
 * 7. self-checks its own output through `parseMomentManifest` before hashing.
 *
 * ONE IDENTITY (review blocker B): the audience-facing broadcast cues and
 * recap live INSIDE the manifest (`presentation`, schema v0.2.0), so the
 * single `manifestHash` — sha256 over canonical `approvalContentPayload`,
 * which spreads every content field — covers everything a viewer can see.
 *
 * Determinism: no clocks, no iteration-order dependence (all derived
 * collections are sorted before hashing), sha256 over canonical JSON.
 * Identical (proposal, source) pairs compile to identical manifests and
 * identical `manifestHash`.
 *
 * The compiler can NEVER mint approval: the output status is `draft` and
 * `approval` is null. Server-issued approvals are the publication service's
 * exclusive workflow (docs/06 gate 7, docs/10).
 */

/** The verified metric a derived-metric evidence entry resolved to. */
export interface VerifiedMetric {
  /** The manifest-facing kebab alias (`evidence[].ref` and `overlays[].metricRef`). */
  readonly alias: string;
  readonly evidenceId: string;
  /** Registry metric id (`metricIdFor` — the full deterministic identity). */
  readonly metricId: string;
  readonly kind: MetricQueryKind;
  readonly algorithmVersion: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly units: string;
  readonly inputFingerprint: string;
  readonly requested: { readonly atMs?: number; readonly windowMs?: readonly [number, number] };
  readonly dependsOn: {
    readonly sourceFrameIds: readonly string[];
    readonly eventIds: readonly string[];
    readonly entityIds: readonly string[];
  };
}

export interface CompileSuccess {
  readonly ok: true;
  readonly manifest: MomentManifest;
  /** sha256 over canonical `approvalContentPayload(manifest)` — the immutable identity. */
  readonly manifestHash: string;
  /** `manifestInputFingerprint(manifest)` — the stale-detection key for verifiers. */
  readonly inputFingerprint: string;
  readonly proposalOrigin: ProposalOrigin;
  /** Every metric the compiled manifest depends on, recomputed and verified. */
  readonly metrics: readonly VerifiedMetric[];
  /** Which of docs/06's named semantic checks this compilation performed. */
  readonly checks: readonly { readonly id: string; readonly status: 'passed' }[];
}

export type CompileResult =
  CompileSuccess | { readonly ok: false; readonly errors: ContractValidationError[] };

const WINDOW_MIN_MS = 500;
const WINDOW_MAX_MS = 120_000;
const MAX_INPUT_REFS = 64;
const MAX_TRACKING_REFS = 2048;

class ErrorCollector {
  readonly errors: ContractValidationError[] = [];

  add(fieldPath: string, code: ContractValidationError['code'], message: string): void {
    this.errors.push({ fieldPath, code, message });
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Deterministic kebab alias for a computed metric. Derived only from the
 * metric's own identity (kind, entities, time scope) so the same measurement
 * always resolves to the same alias across compiles.
 */
function metricAlias(kind: string, entityIds: readonly string[], scopeTag: string): string {
  const entities = [...entityIds].sort().join('-');
  return `metric-${kind}-${entities}-${scopeTag}`;
}

function scopeTagFor(requested: { atMs?: number; windowMs?: readonly [number, number] }): string {
  if (requested.windowMs !== undefined) {
    return `w${String(requested.windowMs[0])}-${String(requested.windowMs[1])}`;
  }
  if (requested.atMs !== undefined) return `t${String(requested.atMs)}`;
  return 't0';
}

/** Flatten a proposal metric query into the raw object parseMetricQuery takes. */
function rawQueryFor(query: ProposalMetricQuery): Record<string, string | number | boolean> {
  return { kind: query.kind, ...query.args };
}

interface ExecutedMetric {
  readonly query: MetricQuery;
  readonly result: MetricResult<unknown>;
}

/** Run one query through the deterministic tool boundary (never throws). */
function executeQuery(
  source: CompilerSourceContext,
  query: ProposalMetricQuery,
  fieldPath: string,
  errors: ErrorCollector,
): ExecutedMetric | null {
  const raw = rawQueryFor(query);
  const parsed = parseMetricQuery(raw);
  if (!parsed.ok) {
    errors.add(
      fieldPath,
      'invalid_value',
      `metric query rejected: ${parsed.code} — ${parsed.detail}`,
    );
    return null;
  }
  const executed: MetricToolResult = executeMetricQuery(
    metricToolContextFrom(source),
    parsed.query,
  );
  if (!executed.ok) {
    const code: ContractValidationError['code'] =
      executed.code === 'unknown-entity'
        ? 'missing_reference'
        : executed.code === 'outside-tracked-window'
          ? 'outside_time_window'
          : 'invalid_value';
    errors.add(
      fieldPath,
      code,
      `metric tool refused the query (${executed.code}): ${executed.detail}`,
    );
    return null;
  }
  return { query: parsed.query, result: executed.result };
}

/** Require a verified (exact-source) metric status; anything else fails closed. */
function requireVerified(
  result: MetricResult<unknown>,
  fieldPath: string,
  what: string,
  errors: ErrorCollector,
): result is MetricVerified<unknown> {
  if (result.status === 'insufficient-evidence') {
    errors.add(
      fieldPath,
      'insufficient_evidence',
      `${what} is insufficient-evidence (${result.failure.code}: ${result.failure.detail}); no number may be asserted and no spatial geometry may be invented`,
    );
    return false;
  }
  if (result.status === 'disclosed') {
    errors.add(
      fieldPath,
      'insufficient_evidence',
      `${what} includes interpolated inputs (${result.disclosure}); editorial use only — it cannot support a verified manifest`,
    );
    return false;
  }
  return true;
}

export function compileMomentProposal(
  rawProposal: unknown,
  source: CompilerSourceContext,
): CompileResult {
  const errors = new ErrorCollector();

  // ---- Gate 0: schema --------------------------------------------------
  const parsedProposal = parseMomentProposal(rawProposal);
  if (!parsedProposal.ok) {
    return { ok: false, errors: parsedProposal.errors };
  }
  const proposal: MomentProposal = parsedProposal.data;

  // ---- Gate 1: identity, tenant, revision currency ----------------------
  if (proposal.tenantId !== source.tenantId) {
    errors.add(
      'tenantId',
      'cross_tenant_reference',
      `proposal targets tenant "${proposal.tenantId}" but this compilation is scoped to "${source.tenantId}"`,
    );
  }
  if (proposal.matchId !== source.matchId) {
    errors.add(
      'matchId',
      'missing_reference',
      `proposal targets match "${proposal.matchId}" which does not exist in this source (expected "${source.matchId}")`,
    );
  }
  if (proposal.basedOn.reducerRevision !== source.reducerRevision) {
    errors.add(
      'basedOn.reducerRevision',
      'stale_revision',
      `proposal was built against reducer revision ${String(proposal.basedOn.reducerRevision)} but the current source revision is ${String(source.reducerRevision)} — re-derive the proposal from the corrected source`,
    );
  }
  if (proposal.basedOn.sourceHash !== source.sourceHash) {
    errors.add(
      'basedOn.sourceHash',
      'stale_revision',
      `proposal source hash does not match the current accepted content (expected ${source.sourceHash}) — a source correction invalidated this proposal`,
    );
  }

  // ---- Gate 2: tool allowlist (unknown commands fail closed) -------------
  for (const [index, tool] of proposal.tools.entries()) {
    if (!(PROPOSAL_TOOL_ALLOWLIST as readonly string[]).includes(tool)) {
      errors.add(
        `tools[${String(index)}]`,
        'unknown_command',
        `"${tool}" is not an allowlisted read-only tool; allowed: ${PROPOSAL_TOOL_ALLOWLIST.join(', ')}`,
      );
    }
  }

  // ---- Gate 3: candidate + window ---------------------------------------
  const candidate =
    source.candidates.find((entry) => entry.candidateId === proposal.candidateRef) ?? null;
  if (candidate === null) {
    errors.add(
      'candidateRef',
      'missing_reference',
      `candidate "${proposal.candidateRef}" does not exist at reducer revision ${String(source.reducerRevision)}; detected candidates: ${source.candidates.map((c) => c.candidateId).join(', ') || '(none)'}`,
    );
  }
  const [startMs, endMs] = proposal.timeRangeMs;
  const windowMs = endMs - startMs;
  if (windowMs < WINDOW_MIN_MS || windowMs > WINDOW_MAX_MS) {
    errors.add(
      'timeRangeMs',
      'invalid_time_range',
      `moment window must be ${String(WINDOW_MIN_MS)}–${String(WINDOW_MAX_MS)} ms, got ${String(windowMs)} ms`,
    );
  }
  if (candidate !== null && (startMs !== candidate.startMs || endMs !== candidate.endMs)) {
    errors.add(
      'timeRangeMs',
      'outside_time_window',
      `proposed window [${String(startMs)}, ${String(endMs)}] is not the candidate's window [${String(candidate.startMs)}, ${String(candidate.endMs)}] — a moment interprets exactly one detected candidate`,
    );
  }
  const coverageStart = source.timeline.minTimeMs;
  const coverageEnd = source.timeline.maxTimeMs;
  if (startMs < coverageStart || endMs > coverageEnd) {
    errors.add(
      'timeRangeMs',
      'outside_time_window',
      `moment window [${String(startMs)}, ${String(endMs)}] extends beyond tracked coverage [${String(coverageStart)}, ${String(coverageEnd)}]`,
    );
  }

  // ---- Gate 4: rights + asset scoping ------------------------------------
  if (!source.rightsPolicyAllowlist.includes(proposal.rightsPolicyRef)) {
    errors.add(
      'rightsPolicyRef',
      'rights_violation',
      `rights policy "${proposal.rightsPolicyRef}" does not permit tenant "${source.tenantId}" for these sources; allowed: ${source.rightsPolicyAllowlist.join(', ')}`,
    );
  }
  // Asset authorization compares the CANONICAL, parsed location against the
  // configured tenant scopes — never raw string prefixes, which accept
  // `../` and percent-encoded traversal into other tenants' directories.
  const assetScopes = source.assetUrlPrefixes.map(parseAssetScope);
  if (source.assetUrlPrefixes.some((_, index) => assetScopes[index] === null)) {
    errors.add(
      '(root)',
      'constraint_violation',
      'a configured asset scope prefix is not a valid https directory URL — fail closed',
    );
  } else {
    for (const [index, url] of proposal.assetUrls.entries()) {
      if (!isAssetUrlWithinScopes(url, assetScopes as readonly AssetScope[])) {
        errors.add(
          `assetUrls[${String(index)}]`,
          'cross_tenant_reference',
          `asset URL resolves to "${describeAssetLocation(url)}", outside this tenant's authorized asset scope (${source.assetUrlPrefixes.join(' or ')})`,
        );
      }
    }
  }

  // ---- Gate 5: camera tracks + overlays vs the window ---------------------
  if (windowMs > 0) {
    for (const [trackIndex, track] of proposal.cameraTracks.entries()) {
      if (track.endMs > windowMs) {
        errors.add(
          `cameraTracks[${String(trackIndex)}].endMs`,
          'outside_time_window',
          `camera track ends at offset ${String(track.endMs)} ms, outside the ${String(windowMs)} ms moment window (offsets are relative to moment start)`,
        );
      }
    }
    for (const [overlayIndex, overlay] of proposal.overlays.entries()) {
      if (overlay.endMs > windowMs) {
        errors.add(
          `overlays[${String(overlayIndex)}].endMs`,
          'outside_time_window',
          `overlay ends at offset ${String(overlay.endMs)} ms, outside the ${String(windowMs)} ms moment window`,
        );
      }
    }
  }

  if (errors.errors.length > 0) {
    return { ok: false, errors: errors.errors };
  }

  // ---- Gate 6: evidence verification (recompute everything) ---------------
  const acceptedFrameIds = new Set(source.tracking.map((sample) => sample.sourceFrameId));

  interface ResolvedEvidence {
    readonly entry: EvidenceEntry;
    readonly metric?: VerifiedMetric;
    readonly event?: MatchEvent;
  }
  const resolved: ResolvedEvidence[] = [];
  const metrics: VerifiedMetric[] = [];
  const aliases = new Set<string>();
  const evidenceIds = new Set<string>();

  for (const [index, entry] of proposal.evidence.entries()) {
    const path = `evidence[${String(index)}]`;
    if (evidenceIds.has(entry.id)) {
      errors.add(`${path}.id`, 'duplicate_value', `duplicate evidence id "${entry.id}"`);
      continue;
    }
    evidenceIds.add(entry.id);

    if (entry.kind === 'source_event') {
      const event = source.events.find((candidateEvent) => candidateEvent.eventId === entry.ref);
      if (event === undefined) {
        errors.add(
          `${path}.ref`,
          'missing_reference',
          `source event "${entry.ref}" does not exist in the accepted corpus at revision ${String(source.reducerRevision)}`,
        );
        continue;
      }
      const computedInputs = [event.eventId];
      if (!inputsMatch(entry.inputRefs, computedInputs)) {
        errors.add(
          `${path}.inputRefs`,
          'missing_reference',
          `declared inputs [${entry.inputRefs.join(', ')}] do not match the event's actual dependencies [${computedInputs.join(', ')}]`,
        );
        continue;
      }
      resolved.push({
        entry: { id: entry.id, kind: entry.kind, ref: entry.ref, inputRefs: computedInputs },
        event,
      });
      continue;
    }

    if (entry.kind === 'tracking_samples') {
      for (const [pos, ref] of [entry.ref, ...entry.inputRefs].entries()) {
        if (!acceptedFrameIds.has(ref)) {
          errors.add(
            pos === 0 ? `${path}.ref` : `${path}.inputRefs[${String(pos - 1)}]`,
            'missing_reference',
            `tracking sample "${ref}" does not exist in the accepted corpus`,
          );
        }
      }
      if (errors.errors.some((e) => e.fieldPath.startsWith(`${path}.`))) {
        continue;
      }
      resolved.push({
        entry: {
          id: entry.id,
          kind: entry.kind,
          ref: entry.ref,
          inputRefs: sortedUnique(entry.inputRefs).slice(0, MAX_INPUT_REFS),
        },
      });
      continue;
    }

    // derived_metric: recompute through the deterministic boundary.
    const query = entry.metricQuery;
    if (query === undefined) {
      // The schema enforces this; kept fail-closed for direct callers.
      errors.add(
        `${path}.metricQuery`,
        'missing_reference',
        'derived_metric evidence has no metric query',
      );
      continue;
    }
    const executed = executeQuery(source, query, `${path}.metricQuery`, errors);
    if (executed === null) continue;
    if (
      !requireVerified(
        executed.result,
        `${path}.metricQuery`,
        `metric for evidence "${entry.id}"`,
        errors,
      )
    ) {
      continue;
    }
    const provenance = executed.result.provenance;
    if (
      provenance.matchId !== source.matchId ||
      provenance.reducerRevision !== source.reducerRevision
    ) {
      errors.add(
        `${path}.metricQuery`,
        'stale_revision',
        `metric provenance (${provenance.matchId} rev ${String(provenance.reducerRevision)}) does not match the source (${source.matchId} rev ${String(source.reducerRevision)})`,
      );
      continue;
    }
    if (
      entry.algorithmVersion !== undefined &&
      entry.algorithmVersion !== provenance.algorithmVersion
    ) {
      errors.add(
        `${path}.algorithmVersion`,
        'invalid_value',
        `declared algorithm version "${entry.algorithmVersion}" ≠ computed "${provenance.algorithmVersion}"; the deterministic recomputation is authoritative`,
      );
      continue;
    }
    const alias = metricAlias(query.kind, provenance.entityIds, scopeTagFor(provenance.requested));
    if (aliases.has(alias)) {
      errors.add(
        `${path}.ref`,
        'duplicate_value',
        `two evidence entries compute the same metric ("${alias}")`,
      );
      continue;
    }
    aliases.add(alias);
    const computedInputs = sortedUnique([
      ...provenance.dependsOn.sourceFrameIds,
      ...provenance.dependsOn.eventIds,
    ]).slice(0, MAX_INPUT_REFS);
    if (!inputsMatch(entry.inputRefs, computedInputs)) {
      errors.add(
        `${path}.inputRefs`,
        'missing_reference',
        `declared inputs [${entry.inputRefs.join(', ')}] do not match the metric's computed dependencies [${computedInputs.join(', ')}] — the number is not grounded in the claimed sources`,
      );
      continue;
    }
    const verifiedValue =
      executed.result.value !== null && typeof executed.result.value === 'object'
        ? (executed.result.value as Readonly<Record<string, unknown>>)
        : {};
    const verified: VerifiedMetric = {
      alias,
      evidenceId: entry.id,
      metricId: provenance.metricId,
      kind: query.kind,
      algorithmVersion: provenance.algorithmVersion,
      value: verifiedValue,
      units: provenance.units,
      inputFingerprint: provenance.inputFingerprint,
      requested: provenance.requested,
      dependsOn: {
        sourceFrameIds: sortedUnique(provenance.dependsOn.sourceFrameIds),
        eventIds: sortedUnique(provenance.dependsOn.eventIds),
        entityIds: sortedUnique(provenance.dependsOn.entityIds),
      },
    };
    metrics.push(verified);
    resolved.push({
      entry: {
        id: entry.id,
        kind: entry.kind,
        ref: alias,
        algorithmVersion: provenance.algorithmVersion,
        inputRefs: computedInputs,
      },
      metric: verified,
    });
  }

  // ---- Gate 6.5: overlay semantic binding (no false provenance) -----------
  // Every overlay's audience-facing content must be SUPPORTED by the
  // evidence it cites — a correct number may never be displayed under
  // mismatched or unrelated evidence attribution (KYN-16 final review,
  // blocker 1). The binding computed here is the ONLY input the
  // presentation builder may use; no opportunistic re-resolution exists.
  const metricsByEvidenceId = new Map(metrics.map((metric) => [metric.evidenceId, metric]));
  const eventsByEvidenceId = new Map(
    resolved.flatMap((item) =>
      item.event === undefined ? [] : [[item.entry.id, item.event] as const],
    ),
  );
  const overlayBindings: OverlayBinding[] = [];

  for (const [index, overlay] of proposal.overlays.entries()) {
    const path = `overlays[${String(index)}]`;
    const citedMetrics = overlay.evidenceIds
      .map((id) => metricsByEvidenceId.get(id))
      .filter((metric): metric is VerifiedMetric => metric !== undefined);
    const citedEventIds = overlay.evidenceIds.filter((id) => eventsByEvidenceId.has(id));

    if (overlay.kind === 'caption') {
      if (overlay.metricRef !== undefined) {
        errors.add(
          `${path}.metricRef`,
          'invalid_value',
          'caption overlays cannot reference metrics — captions are the editorial (hypothesis) channel and must not acquire factual or numerical meaning',
        );
        continue;
      }
      // The caption's text is a hypothesis claim sharing its evidence; the
      // cue cites the CLAIM's own evidence, never unrelated overlay ids.
      const claim = proposal.claims.find(
        (candidate) =>
          candidate.status === 'hypothesis' &&
          candidate.evidenceIds.some((id) => overlay.evidenceIds.includes(id)),
      );
      if (claim === undefined) {
        errors.add(
          `${path}.evidenceIds`,
          'missing_reference',
          'caption overlays must cite evidence shared with a hypothesis claim — that editorial text is the caption',
        );
        continue;
      }
      overlayBindings.push({
        overlay,
        channel: { kind: 'caption', claimId: claim.id },
      });
      continue;
    }

    if (overlay.kind === 'event_marker') {
      if (overlay.metricRef !== undefined) {
        errors.add(
          `${path}.metricRef`,
          'invalid_value',
          `event-marker overlays display a cited source event and cannot reference metrics — metricRef "${overlay.metricRef}" would silently turn the marker into a metric cue (cited evidence: [${overlay.evidenceIds.join(', ')}])`,
        );
        continue;
      }
      if (citedEventIds.length === 0) {
        errors.add(
          `${path}.evidenceIds`,
          'missing_reference',
          'event-marker overlays must cite accepted source-event evidence (the cited evidence contains no source event)',
        );
        continue;
      }
      if (citedMetrics.length > 0) {
        errors.add(
          `${path}.evidenceIds`,
          'invalid_value',
          'event-marker overlays may cite only source-event evidence — citing a derived metric they do not display is false provenance',
        );
        continue;
      }
      if (citedEventIds.length > 1) {
        errors.add(
          `${path}.evidenceIds`,
          'invalid_value',
          `event-marker overlays cite exactly one source event (got ${String(citedEventIds.length)}); the displayed fact would be ambiguous`,
        );
        continue;
      }
      overlayBindings.push({
        overlay,
        channel: { kind: 'event', evidenceId: citedEventIds[0]! },
      });
      continue;
    }

    // Data overlays (distance/trajectory/zone/source_quality) display a
    // verified metric — and ONLY a metric computed by evidence this same
    // overlay cites.
    if (overlay.metricRef !== undefined) {
      if (!aliases.has(overlay.metricRef)) {
        errors.add(
          `${path}.metricRef`,
          'missing_reference',
          `overlay cites metric "${overlay.metricRef}" which no derived_metric evidence in this proposal computes (minted: ${[...aliases].join(', ') || 'none'})`,
        );
        continue;
      }
      const supported = citedMetrics.some((metric) => metric.alias === overlay.metricRef);
      if (!supported) {
        errors.add(
          `${path}.metricRef`,
          'invalid_value',
          `metric "${overlay.metricRef}" is not computed by any evidence this overlay cites ([${overlay.evidenceIds.join(', ')}]) — a correct number may not be displayed under mismatched provenance`,
        );
        continue;
      }
      const metric = citedMetrics.find((candidate) => candidate.alias === overlay.metricRef)!;
      overlayBindings.push({ overlay, channel: { kind: 'metric', evidenceId: metric.evidenceId } });
      continue;
    }
    if (citedMetrics.length === 0) {
      errors.add(
        `${path}.evidenceIds`,
        'missing_reference',
        'data overlays must cite derived-metric evidence — the displayed value is the verified metric',
      );
      continue;
    }
    if (citedMetrics.length > 1) {
      errors.add(
        `${path}.evidenceIds`,
        'invalid_value',
        `overlay cites ${String(citedMetrics.length)} derived-metric evidence entries without a metricRef; the displayed value would be ambiguous`,
      );
      continue;
    }
    overlayBindings.push({
      overlay,
      channel: { kind: 'metric', evidenceId: citedMetrics[0]!.evidenceId },
    });
  }

  // ---- Gate 7: claim validation under the TEXT LAW ------------------------
  // calculated/observed claim text is GENERATED from the verified source;
  // hypotheses pass their (schema-guarded, number-free) editorial text.
  const compiledClaims: Claim[] = [];

  for (const [index, c] of proposal.claims.entries()) {
    const path = `claims[${String(index)}]`;

    if (c.status === 'observed') {
      // An observed fact is the cited source event itself — exactly one.
      if (c.evidenceIds.length !== 1) {
        errors.add(
          `${path}.evidenceIds`,
          'constraint_violation',
          `observed claims cite exactly one source event (got ${String(c.evidenceIds.length)} references)`,
        );
        continue;
      }
      const cited = resolved.find((item) => item.entry.id === c.evidenceIds[0]);
      if (cited === undefined || cited.event === undefined) {
        errors.add(
          `${path}.evidenceIds`,
          'missing_reference',
          `observed claims must cite source_event evidence (the cited evidence is not a verified source event)`,
        );
        continue;
      }
      compiledClaims.push({
        id: c.id,
        text: eventFactSentence(cited.event),
        status: 'observed',
        evidenceIds: [...c.evidenceIds],
        language: c.language,
      });
      continue;
    }

    if (c.status === 'calculated') {
      const assertion = c.metricAssertion;
      // The schema requires it; kept fail-closed for direct callers.
      if (assertion === undefined) {
        errors.add(
          `${path}.metricAssertion`,
          'constraint_violation',
          'calculated claims must carry a metricAssertion; the compiler generates the factual text from the verified value',
        );
        continue;
      }
      const citedEvidence = proposal.evidence.filter((entry) => c.evidenceIds.includes(entry.id));
      const boundQuery = citedEvidence.find(
        (entry) =>
          entry.metricQuery !== undefined &&
          entry.metricQuery.kind === assertion.kind &&
          canonicalJsonStringify(rawQueryFor(entry.metricQuery)) ===
            canonicalJsonStringify(rawQueryFor(assertion)),
      );
      if (boundQuery === undefined) {
        errors.add(
          `${path}.metricAssertion`,
          'missing_reference',
          'the asserted metric is not computed by any evidence this claim cites — every number must trace to declared, verified evidence',
        );
        continue;
      }
      const executed = executeQuery(source, assertion, `${path}.metricAssertion`, errors);
      if (executed === null) continue;
      if (
        !requireVerified(
          executed.result,
          `${path}.metricAssertion`,
          `the metric claim "${c.id}" asserts`,
          errors,
        )
      ) {
        continue;
      }
      const recomputed = (executed.result.value as Readonly<Record<string, unknown>>)[
        assertion.valueField
      ];
      if (typeof recomputed !== 'number' || !Number.isFinite(recomputed)) {
        errors.add(
          `${path}.metricAssertion.valueField`,
          'invalid_value',
          `metric ${executed.result.provenance.metricId} has no numeric field "${assertion.valueField}"`,
        );
        continue;
      }
      if (recomputed !== assertion.assertedValue) {
        errors.add(
          `${path}.metricAssertion.assertedValue`,
          'unsupported_claim',
          `asserted ${String(assertion.assertedValue)} but the deterministic recomputation of ${executed.result.provenance.metricId}.${assertion.valueField} is ${String(recomputed)} — the recomputation is authoritative; revise the claim`,
        );
        continue;
      }
      const boundMetric = metricsByEvidenceId.get(boundQuery.id);
      if (boundMetric === undefined) {
        // Unreachable when the cited evidence itself verified; fail closed.
        errors.add(
          `${path}.evidenceIds`,
          'missing_reference',
          `the cited derived-metric evidence "${boundQuery.id}" did not verify`,
        );
        continue;
      }
      compiledClaims.push({
        id: c.id,
        text: metricFactSentence(boundMetric),
        status: 'calculated',
        evidenceIds: [...c.evidenceIds],
        language: c.language,
      });
      continue;
    }

    // hypothesis: editorial channel — text and disclosure already passed the
    // number-free policy at schema level.
    if (c.text === undefined || c.inferenceDisclosure === undefined) {
      // The schema guarantees both; kept fail-closed for direct callers.
      errors.add(
        `${path}.text`,
        'constraint_violation',
        'hypothesis claims require editorial text and an inference disclosure',
      );
      continue;
    }
    compiledClaims.push({
      id: c.id,
      text: c.text,
      status: 'hypothesis',
      evidenceIds: [...c.evidenceIds],
      language: c.language,
      inferenceDisclosure: c.inferenceDisclosure,
    });
  }

  if (errors.errors.length > 0) {
    return { ok: false, errors: errors.errors };
  }

  // ---- Assemble the trusted manifest --------------------------------------
  const trackingSampleRefs = sortedUnique(
    metrics.flatMap((metric) => metric.dependsOn.sourceFrameIds),
  ).slice(0, MAX_TRACKING_REFS);
  const manifest: MomentManifest = {
    schemaVersion: '0.2.0',
    manifestId: `mom-${proposal.proposalId}`,
    tenantId: proposal.tenantId,
    matchId: proposal.matchId,
    revision: 1,
    status: 'draft',
    timeRangeMs: [startMs, endMs],
    input: {
      reducerRevision: source.reducerRevision,
      sourceEventIds: sortedUnique(candidate?.eventIds ?? []).slice(0, 256),
      trackingSampleRefs,
      sourceHash: source.sourceHash,
    },
    scene: {
      coordinateSystem: PITCH_COORDINATE_SYSTEM,
      cameraTracks: proposal.cameraTracks.map((track) => ({
        ...track,
        keyframes: [...track.keyframes],
      })),
      overlays: proposal.overlays.map((overlay) => ({
        ...overlay,
        evidenceIds: [...overlay.evidenceIds],
      })),
    },
    claims: compiledClaims,
    evidence: resolved.map((item) => item.entry),
    lenses: [...proposal.lenses],
    rightsPolicyRef: proposal.rightsPolicyRef,
    presentation: buildManifestPresentation({
      claims: compiledClaims,
      bindings: overlayBindings,
      metricsByEvidenceId,
      eventsByEvidenceId,
      headline: proposal.recapHeadline,
    }),
    approval: null,
  };

  // ---- Self-check: the compiler's output must satisfy its own contract ----
  const selfCheck = parseMomentManifest(manifest);
  if (!selfCheck.ok) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: '(root)',
          code: 'constraint_violation',
          message: 'internal: compiled manifest failed its own contract validation',
        },
        ...selfCheck.errors,
      ],
    };
  }

  const manifestHash = `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(approvalContentPayload(manifest)))
    .digest('hex')}`;

  return {
    ok: true,
    manifest,
    manifestHash,
    inputFingerprint: manifestInputFingerprint(manifest),
    proposalOrigin: proposal.origin,
    metrics,
    checks: [
      { id: 'reference-existence', status: 'passed' },
      { id: 'numerical-consistency', status: 'passed' },
      { id: 'rights-policy', status: 'passed' },
      { id: 'input-revision-currency', status: 'passed' },
    ],
  };
}

function inputsMatch(declared: readonly string[], computed: readonly string[]): boolean {
  if (declared.length !== computed.length) return false;
  const a = [...declared].sort();
  const b = [...computed].sort();
  return a.every((value, index) => value === b[index]);
}

/**
 * Re-express a manifest camera track's time offsets on a different window
 * start — the single conversion point when a compiled sub-window moment
 * plays inside a scene whose window starts earlier (e.g. the full golden
 * window). Position/target/fov geometry is untouched.
 */
export function rescaleCameraTrackToWindow<
  Track extends {
    readonly startMs: number;
    readonly endMs: number;
    readonly keyframes: readonly { readonly tMs: number }[];
  },
>(track: Track, fromWindowStartMs: number, toWindowStartMs: number): Track {
  const shift = fromWindowStartMs - toWindowStartMs;
  return {
    ...track,
    startMs: track.startMs + shift,
    endMs: track.endMs + shift,
    keyframes: track.keyframes.map((keyframe) => ({ ...keyframe, tMs: keyframe.tMs + shift })),
  };
}
