/**
 * KYN-15 — the provider port. All agent invocations go through
 * `FoundryProvider`; the orchestrator never talks to a SDK directly, so the
 * same orchestration runs against the live service or an injected test
 * provider (the deterministic test law: injected responses, REAL
 * orchestration and compiler boundaries).
 */

import type { ChallengerVerdict, DirectorPlan, InterpretationResult } from './types';

export interface FoundryCallMeta {
  readonly model: string;
  readonly requestId: string | null;
  readonly latencyMs: number;
  readonly usage: { promptTokens?: number; completionTokens?: number } | null;
}

export interface FoundryCall<Payload> {
  readonly payload: Payload;
  readonly meta: FoundryCallMeta;
}

export type ProviderFailure =
  | { readonly kind: 'unconfigured'; readonly message: string }
  | { readonly kind: 'timeout'; readonly message: string }
  | { readonly kind: 'rate_limit'; readonly message: string }
  | { readonly kind: 'malformed_response'; readonly message: string }
  | { readonly kind: 'auth'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export class FoundryProviderError extends Error {
  constructor(public readonly failure: ProviderFailure) {
    super(failure.message);
    this.name = 'FoundryProviderError';
  }
}

export interface InterpretationInput {
  readonly prompt: string;
  readonly sourceHash: string;
  readonly reducerRevision: number;
  readonly allowedEventIds: readonly string[];
  readonly verifiedEvidenceIds: readonly string[];
}

export interface DirectorInput {
  readonly interpretation: InterpretationResult;
  readonly toolOutputs: readonly string[];
  readonly focusEventIdCandidates: readonly string[];
}

export interface ChallengerInput {
  readonly plan: DirectorPlan;
  readonly claims: readonly { text: string; uncertainty: string }[];
  readonly verifierFindings: readonly { fieldPath: string; code: string; message: string }[];
}

/**
 * One bounded transient retry is handled INSIDE the provider (per-call
 * timeout + single retry); callers never loop.
 */
export interface FoundryProvider {
  readonly kind: 'live' | 'injected';
  readonly model: string;
  interpret(input: InterpretationInput): Promise<FoundryCall<InterpretationResult>>;
  direct(input: DirectorInput): Promise<FoundryCall<DirectorPlan>>;
  challenge(input: ChallengerInput): Promise<FoundryCall<ChallengerVerdict>>;
}

// ---------------------------------------------------------------------------
// Runtime validation of model output: strict shapes, untrusted until parsed.
// ---------------------------------------------------------------------------

const UNCERTAINTIES = new Set(['measured', 'observed', 'hypothesis']);
const SEVERITIES = new Set(['blocker', 'major', 'minor']);
const DEFECT_KINDS = [
  'unsupported_number',
  'overstated_causation',
  'unsupported_reference',
  'confusing_presentation',
] as const;
type DefectKind = (typeof DEFECT_KINDS)[number];
const BASE_PROPOSALS = new Set(['golden', 'broadcast-sweep']);

export function parseInterpretation(raw: unknown): InterpretationResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('interpretation is not an object');
  const s = raw as Record<string, unknown>;
  const restatedQuestion = requireString(s['restatedQuestion'], 'restatedQuestion');
  const relevantEventIds = stringArray(s['relevantEventIds'], 'relevantEventIds');
  const claims = Array.isArray(s['claims']) ? s['claims'] : [];
  const parsedClaims = claims.map((claim, index) => {
    if (typeof claim !== 'object' || claim === null) {
      throw new Error(`claims[${String(index)}] is not an object`);
    }
    const c = claim as Record<string, unknown>;
    const uncertainty = requireString(c['uncertainty'], `claims[${String(index)}].uncertainty`);
    if (!UNCERTAINTIES.has(uncertainty)) {
      throw new Error(
        `claims[${String(index)}].uncertainty "${uncertainty}" is not in the vocabulary`,
      );
    }
    return {
      text: requireString(c['text'], `claims[${String(index)}].text`),
      uncertainty: uncertainty as InterpretationResult['claims'][number]['uncertainty'],
      evidenceIds: stringArray(c['evidenceIds'], `claims[${String(index)}].evidenceIds`),
    };
  });
  const toolRequests = Array.isArray(s['toolRequests']) ? s['toolRequests'] : [];
  const parsedTools = toolRequests.map((request, index) => {
    if (typeof request !== 'object' || request === null) {
      throw new Error(`toolRequests[${String(index)}] is not an object`);
    }
    const t = request as Record<string, unknown>;
    return {
      tool: requireString(t['tool'], `toolRequests[${String(index)}].tool`) as never,
      args: recordOfStrings(t['args'], `toolRequests[${String(index)}].args`),
    };
  });
  return { restatedQuestion, relevantEventIds, claims: parsedClaims, toolRequests: parsedTools };
}

export function parseDirectorPlan(raw: unknown): DirectorPlan {
  if (typeof raw !== 'object' || raw === null) throw new Error('plan is not an object');
  const s = raw as Record<string, unknown>;
  const baseProposalId = requireString(s['baseProposalId'], 'baseProposalId');
  if (!BASE_PROPOSALS.has(baseProposalId)) {
    throw new Error(`baseProposalId "${baseProposalId}" is not an allowed base`);
  }
  const focus = s['focusEventId'];
  return {
    baseProposalId: baseProposalId as DirectorPlan['baseProposalId'],
    focusEventId: typeof focus === 'string' && focus.length > 0 ? focus : null,
    captionText: requireString(s['captionText'], 'captionText'),
    reason: requireString(s['reason'], 'reason'),
  };
}

export function parseChallengerVerdict(raw: unknown): ChallengerVerdict {
  if (typeof raw !== 'object' || raw === null) throw new Error('verdict is not an object');
  const s = raw as Record<string, unknown>;
  const verdict = requireString(s['verdict'], 'verdict');
  if (verdict !== 'acceptable' && verdict !== 'needs_revision') {
    throw new Error(`verdict "${verdict}" is not recognized`);
  }
  const defects = Array.isArray(s['defects']) ? s['defects'] : [];
  const parsed = defects.map((defect, index) => {
    if (typeof defect !== 'object' || defect === null) {
      throw new Error(`defects[${String(index)}] is not an object`);
    }
    const d = defect as Record<string, unknown>;
    const severity = requireString(d['severity'], `defects[${String(index)}].severity`);
    const kind = requireString(d['kind'], `defects[${String(index)}].kind`);
    if (!SEVERITIES.has(severity)) throw new Error(`defects[${String(index)}].severity invalid`);
    if (!(DEFECT_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`defects[${String(index)}].kind invalid`);
    }
    return {
      fieldPath: requireString(d['fieldPath'], `defects[${String(index)}].fieldPath`),
      severity: severity as 'blocker' | 'major' | 'minor',
      kind: kind as DefectKind,
      instruction: requireString(d['instruction'], `defects[${String(index)}].instruction`),
    };
  });
  return { verdict, defects: parsed };
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} is not a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} is not an array`);
  return value.map((item, index) => requireString(item, `${path}[${String(index)}]`));
}

function recordOfStrings(value: unknown, path: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} is not an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = requireString(item, `${path}.${key}`);
  }
  return out;
}
