/**
 * KYN-15 — Foundry multi-agent experience compiler: typed contracts.
 *
 * STATUS: the orchestration, deterministic verification and job contract in
 * this directory are REAL and fully tested with injected provider responses.
 * The LIVE provider (`live-provider.ts`) is written against the actual
 * `@azure/ai-projects` 2.9.0 SDK surface (`AIProjectClient(endpoint,
 * DefaultAzureCredential).getOpenAIClient().chat.completions`) but is
 * UNVERIFIED: no authorized Foundry project exists in this environment
 * (Phase-0 access gate blocked — see the PR description). It is never
 * invoked unless KYNELOOM_FOUNDRY_ENABLED=true AND a project endpoint AND
 * deployment are configured; absence fails closed to a truthful
 * provider-unavailable status, never to silent local substitution.
 */

/** Bounded read-only tool names an agent may request (docs/07 allowlist). */
export type FoundryToolName =
  'get_metric' | 'get_event_window' | 'validate_camera_plan' | 'validate_claims';

export const FOUNDRY_TOOL_ALLOWLIST: readonly FoundryToolName[] = [
  'get_metric',
  'get_event_window',
  'validate_camera_plan',
  'validate_claims',
];

/** Deterministic tool result — numbers ALWAYS come from here, never the model. */
export interface FoundryToolResult {
  readonly tool: FoundryToolName;
  readonly args: Record<string, string>;
  readonly ok: boolean;
  readonly output: string;
}

export type Uncertainty = 'measured' | 'observed' | 'hypothesis';

/** A model-proposed claim BEFORE deterministic verification — untrusted. */
export interface ProposedClaim {
  readonly text: string;
  readonly uncertainty: Uncertainty;
  readonly evidenceIds: readonly string[];
}

/** Interpretation Agent output — runtime-validated strict JSON. */
export interface InterpretationResult {
  readonly restatedQuestion: string;
  readonly relevantEventIds: readonly string[];
  readonly claims: readonly ProposedClaim[];
  readonly toolRequests: readonly {
    readonly tool: FoundryToolName;
    readonly args: Record<string, string>;
  }[];
}

/** Experience Director output — a bounded edit of the valid golden proposal. */
export interface DirectorPlan {
  readonly baseProposalId: 'golden' | 'broadcast-sweep';
  /** Overlay/claim/timing edits expressed as typed JSON-patch-like ops; the
   * deterministic layer applies them — the model never writes raw proposal
   * JSON that bypasses the contract schemas. */
  readonly focusEventId: string | null;
  readonly captionText: string;
  readonly reason: string;
}

/** Editorial Challenger output — structured defects with repair instructions. */
export interface ChallengerDefect {
  readonly fieldPath: string;
  readonly severity: 'blocker' | 'major' | 'minor';
  readonly kind:
    | 'unsupported_number'
    | 'overstated_causation'
    | 'unsupported_reference'
    | 'confusing_presentation';
  readonly instruction: string;
}

export interface ChallengerVerdict {
  readonly verdict: 'acceptable' | 'needs_revision';
  readonly defects: readonly ChallengerDefect[];
}

/** One provider turn: role label + validated payload + provenance. */
export interface AgentTurn<P> {
  readonly role: 'interpretation' | 'director' | 'challenger';
  readonly payload: P;
  readonly model: string;
  readonly requestId: string | null;
  readonly latencyMs: number;
  readonly usage: { promptTokens?: number; completionTokens?: number } | null;
}

/** Deterministic verifier findings (compiler + policy), machine-checkable. */
export interface VerifierFinding {
  readonly fieldPath: string;
  readonly code: string;
  readonly message: string;
}

export type JobPhase =
  | 'received'
  | 'interpreted'
  | 'directed'
  | 'challenged'
  | 'repaired'
  | 'verified'
  | 'completed'
  | 'needs_review'
  | 'failed';

/** The durable job contract (docs/07: durable, inspectable, resumable). */
export interface FoundryJobRecord {
  readonly jobId: string;
  /** Deterministic idempotency key: hash of (prompt, sourceHash, reducerRevision). */
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly actor: string;
  readonly prompt: string;
  readonly sourceHash: string;
  readonly reducerRevision: number;
  readonly agentVersions: readonly { role: string; model: string; promptVersion: string }[];
  readonly phase: JobPhase;
  /** Completed step identities — resume skips these exactly once. */
  readonly completedSteps: readonly string[];
  readonly toolResults: readonly FoundryToolResult[];
  readonly verifierFindings: readonly VerifierFinding[];
  readonly outputArtifactHash: string | null;
  readonly repairUsed: boolean;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly durationMs: number;
  readonly status: 'running' | 'completed' | 'needs_review' | 'failed' | 'cancelled';
  readonly errorMessage: string | null;
  readonly turns: readonly {
    role: string;
    requestId: string | null;
    latencyMs: number;
    usage: { promptTokens?: number; completionTokens?: number } | null;
  }[];
}
