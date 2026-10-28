/**
 * KYN-15 — the orchestration: interpretation → tools → director → challenger
 * → (ONE bounded repair) → deterministic verification → compiled DRAFT.
 *
 * Bounds: 3 agent roles, max 1 semantic repair, max 6 tool calls, per-call
 * timeout + one retry (in the provider), end-to-end deadline. Resume: the
 * job store records completed steps; a resumed job skips them (exactly-once
 * APPLICATION, not exactly-once model execution — a provider call with an
 * unknown outcome may be repeated, per the brief).
 */

import { createHash } from 'node:crypto';
import type { CompileResult } from '@kyneloom/moment-compiler';
import { buildCompilerSource } from '@/lib/moment-compiler-service';
import { buildCompileCorpus } from '@kyneloom/moment-compiler';
import type { FoundryProvider } from './provider';
import { FoundryProviderError } from './provider';
import { executeToolCall, buildToolContext } from './tools';
import { applyAndCompile, verifyClaims } from './verify';
import type {
  ChallengerVerdict,
  DirectorPlan,
  FoundryJobRecord,
  FoundryToolResult,
  InterpretationResult,
} from './types';
import type { FoundryJobStore } from './job-store';
import { idempotencyKeyFor, newJobId } from './job-store';

const END_TO_END_TIMEOUT_MS = 120_000;
const AGENT_VERSIONS = [
  { role: 'interpretation', model: 'foundry', promptVersion: 'kyneloom-interpret-v1' },
  { role: 'director', model: 'foundry', promptVersion: 'kyneloom-direct-v1' },
  { role: 'challenger', model: 'foundry', promptVersion: 'kyneloom-challenge-v1' },
] as const;

export interface FoundryRunResult {
  readonly status: 'completed' | 'needs_review' | 'failed';
  readonly job: FoundryJobRecord;
  readonly compile: CompileResult | null;
  readonly focusPlayheadMs: number | null;
  readonly explanation: string | null;
  readonly provenance: {
    readonly agentRoles: readonly string[];
    readonly correctionOccurred: boolean;
    readonly toolResults: readonly FoundryToolResult[];
    readonly verifiedEvidenceIds: readonly string[];
    readonly turns: FoundryJobRecord['turns'];
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceUnavailableResult(provider: FoundryProvider): FoundryRunResult {
  const now = new Date().toISOString();
  const job: FoundryJobRecord = {
    jobId: newJobId(),
    idempotencyKey: 'unavailable',
    tenantId: 'synthetic-demo',
    actor: 'local-demo-operator',
    prompt: '',
    sourceHash: '',
    reducerRevision: 0,
    agentVersions: AGENT_VERSIONS.map((a) => ({ ...a, model: provider.model })),
    phase: 'failed',
    completedSteps: [],
    toolResults: [],
    verifierFindings: [],
    outputArtifactHash: null,
    repairUsed: false,
    startedAt: now,
    updatedAt: now,
    durationMs: 0,
    status: 'failed',
    errorMessage: 'compiler source unavailable',
    turns: [],
  };
  return {
    status: 'failed',
    job,
    compile: null,
    focusPlayheadMs: null,
    explanation: null,
    provenance: {
      agentRoles: [],
      correctionOccurred: false,
      toolResults: [],
      verifiedEvidenceIds: [],
      turns: [],
    },
  };
}

export async function runFoundryExperience(
  prompt: string,
  provider: FoundryProvider,
  store: FoundryJobStore,
): Promise<FoundryRunResult> {
  const startedAt = Date.now();
  const ctx = await buildToolContext();
  if (ctx === null) {
    return sourceUnavailableResult(provider);
  }
  const golden = await (await import('@/lib/match-fixture')).loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) return sourceUnavailableResult(provider);
  const corpus = buildCompileCorpus(source.snapshot.context);
  const verifiedEvidenceIds = corpus.golden.evidence.map((entry) => entry.id);

  const finalizeWith = async (
    status: 'needs_review' | 'failed',
    message: string,
    applied: {
      result: CompileResult;
      focusPlayheadMs: number;
      findings: readonly { fieldPath: string; code: string; message: string }[];
    } | null,
  ): Promise<FoundryRunResult> => {
    job = {
      ...job,
      phase: status === 'needs_review' ? 'needs_review' : 'failed',
      toolResults,
      verifierFindings: applied?.findings ?? job.verifierFindings,
      outputArtifactHash: null,
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      status,
      errorMessage: message,
      turns: turnsMutable,
    };
    await store.compareAndSwap(job, job.phase).catch(() => undefined);
    return {
      status,
      job,
      compile: applied?.result.ok ? applied.result : null,
      focusPlayheadMs: applied?.focusPlayheadMs ?? null,
      explanation: null,
      provenance: {
        agentRoles: AGENT_VERSIONS.map((a) => a.role),
        correctionOccurred: job.repairUsed,
        toolResults,
        verifiedEvidenceIds,
        turns: turnsMutable,
      },
    };
  };
  const finalize = (
    status: 'needs_review' | 'failed',
    message: string,
  ): Promise<FoundryRunResult> => finalizeWith(status, message, null);

  const idempotencyKey = idempotencyKeyFor(prompt, ctx.sourceHash, ctx.reducerRevision);
  // Idempotency: an identical job (same prompt + same source) returns the
  // EXISTING record; no externally visible artifact is duplicated.
  const existing = await store.findByIdempotencyKey(idempotencyKey);
  const baseJob: FoundryJobRecord = existing ?? {
    jobId: newJobId(),
    idempotencyKey,
    tenantId: source.snapshot.context.tenantId,
    actor: 'local-demo-operator',
    prompt,
    sourceHash: ctx.sourceHash,
    reducerRevision: ctx.reducerRevision,
    agentVersions: AGENT_VERSIONS.map((a) => ({ ...a, model: provider.model })),
    phase: 'received',
    completedSteps: [],
    toolResults: [],
    verifierFindings: [],
    outputArtifactHash: null,
    repairUsed: false,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    durationMs: 0,
    status: 'running',
    errorMessage: null,
    turns: [],
  };
  if (
    existing !== null &&
    (existing.status === 'completed' || existing.status === 'needs_review')
  ) {
    return {
      status: existing.status,
      job: existing,
      compile: null, // resumed/duplicate submission: the record IS the answer
      focusPlayheadMs: null,
      explanation: null,
      provenance: {
        agentRoles: existing.agentVersions.map((a) => a.role),
        correctionOccurred: existing.repairUsed,
        toolResults: existing.toolResults,
        verifiedEvidenceIds: [],
        turns: existing.turns,
      },
    };
  }
  const created = await store.createIfAbsent(baseJob);
  if (!created.ok && created.kind === 'conflict') {
    // Duplicate concurrent submission: the first writer wins.
    return {
      status: created.existing.status === 'completed' ? 'completed' : 'needs_review',
      job: created.existing,
      compile: null,
      focusPlayheadMs: null,
      explanation: null,
      provenance: {
        agentRoles: created.existing.agentVersions.map((a) => a.role),
        correctionOccurred: created.existing.repairUsed,
        toolResults: created.existing.toolResults,
        verifiedEvidenceIds: [],
        turns: created.existing.turns,
      },
    };
  }
  let job = created.ok ? created.record : baseJob;
  const turns: FoundryJobRecord['turns'] = [];
  const turnsMutable = turns as unknown as {
    role: string;
    requestId: string | null;
    latencyMs: number;
    usage: { promptTokens?: number; completionTokens?: number } | null;
  }[];
  const completed = new Set(job.completedSteps);
  const step = async (
    name: string,
    phase: FoundryJobRecord['phase'],
    run: () => Promise<void>,
  ): Promise<void> => {
    if (completed.has(name)) return; // resume: never applied twice
    const fromPhase = job.phase;
    await run();
    completed.add(name);
    job = {
      ...job,
      phase,
      completedSteps: [...completed],
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
    await store.compareAndSwap(job, fromPhase).catch(() => undefined);
  };

  const deadline = startedAt + END_TO_END_TIMEOUT_MS;
  const withinDeadline = (): boolean => Date.now() < deadline;

  let interpretation: InterpretationResult | null = null;
  let toolResults: FoundryToolResult[] = [];
  let plan: DirectorPlan | null = null;
  let verdict: ChallengerVerdict | null = null;
  let repairPlan: DirectorPlan | null = null;
  let claimFindings: ReturnType<typeof verifyClaims> = [];

  try {
    // ---- Phase 1: interpretation (+ bounded tools) ----
    await step('interpret', 'interpreted', async () => {
      const call = await provider.interpret({
        prompt,
        sourceHash: ctx.sourceHash,
        reducerRevision: ctx.reducerRevision,
        allowedEventIds: ctx.allowedEventIds,
        verifiedEvidenceIds,
      });
      turnsMutable.push({
        role: 'interpretation',
        requestId: call.meta.requestId,
        latencyMs: call.meta.latencyMs,
        usage: call.meta.usage,
      });
      interpretation = call.payload;
      claimFindings = verifyClaims(call.payload.claims, verifiedEvidenceIds, ctx.allowedEventIds);
    });
    if (!withinDeadline()) return await finalize('needs_review', 'end-to-end timeout');

    await step('tools', 'interpreted', async () => {
      let index = 0;
      for (const request of interpretation?.toolRequests ?? []) {
        toolResults = [
          ...toolResults,
          await executeToolCall(ctx, request.tool, request.args, index),
        ];
        index += 1;
      }
    });

    // ---- Phase 2: experience director ----
    await step('direct', 'directed', async () => {
      const call = await provider.direct({
        interpretation: interpretation!,
        toolOutputs: toolResults.map((result) => result.output),
        focusEventIdCandidates: ctx.allowedEventIds,
      });
      turnsMutable.push({
        role: 'director',
        requestId: call.meta.requestId,
        latencyMs: call.meta.latencyMs,
        usage: call.meta.usage,
      });
      plan = call.payload;
    });
    if (!withinDeadline()) return await finalize('needs_review', 'end-to-end timeout');

    // ---- Phase 3: editorial challenge (with the deterministic findings) ----
    const appliedFirst = await applyAndCompile(plan!, claimFindings);
    if (appliedFirst === null) return await finalize('failed', 'compiler source unavailable');
    await step('challenge', 'challenged', async () => {
      const call = await provider.challenge({
        plan: plan!,
        claims: interpretation?.claims ?? [],
        verifierFindings: [...claimFindings, ...appliedFirst.findings],
      });
      turnsMutable.push({
        role: 'challenger',
        requestId: call.meta.requestId,
        latencyMs: call.meta.latencyMs,
        usage: call.meta.usage,
      });
      verdict = call.payload;
    });

    // ---- Phase 3b: ONE bounded repair if challenged OR deterministic findings exist ----
    const verdictRef = verdict as {
      verdict: string;
      defects: readonly { instruction?: string }[];
    } | null;
    const needsRepair =
      verdict !== null &&
      ((verdictRef !== null && verdictRef.verdict === 'needs_revision') ||
        appliedFirst.findings.some(
          (finding) =>
            finding.code === 'unsupported_number' || finding.code === 'overstated_causation',
        ) ||
        claimFindings.length > 0);
    if (needsRepair && !job.repairUsed) {
      await step('repair', 'repaired', async () => {
        const defect = verdictRef?.defects[0];
        // Bounded repair: strip numbers from the caption, keep causation as
        // hypothesis language — deterministic guidance from the instruction.
        const repairedCaption = repairCaption(plan!.captionText, defect?.instruction ?? '');
        const call = await provider.direct({
          interpretation: interpretation!,
          toolOutputs: toolResults.map((result) => result.output),
          focusEventIdCandidates: ctx.allowedEventIds,
        });
        turnsMutable.push({
          role: 'director',
          requestId: call.meta.requestId,
          latencyMs: call.meta.latencyMs,
          usage: call.meta.usage,
        });
        repairPlan = { ...call.payload, captionText: repairedCaption };
      });
      job = { ...job, repairUsed: true };
    }

    // ---- Phase 4: deterministic verification of the FINAL plan ----
    const finalPlan = repairPlan ?? plan!;
    const appliedFinal = await applyAndCompile(finalPlan, claimFindings);
    if (appliedFinal === null) return await finalize('failed', 'compiler source unavailable');
    if (!appliedFinal.result.ok) {
      return await finalizeWith(
        'needs_review',
        'the deterministic compiler rejected the proposal',
        appliedFinal,
      );
    }
    const artifactHash = sha256(JSON.stringify(appliedFinal.result));
    job = {
      ...job,
      phase: 'completed',
      completedSteps: [...completed, 'verify'],
      toolResults,
      verifierFindings: appliedFinal.findings,
      outputArtifactHash: artifactHash,
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      status: 'completed',
      errorMessage: null,
      turns,
    };
    await store.compareAndSwap(job, 'repaired').catch(() => undefined);
    const explanation =
      finalPlan.captionText.length > 0
        ? `${finalPlan.reason} ${finalPlan.captionText}`.trim()
        : finalPlan.reason;
    return {
      status: 'completed',
      job,
      compile: appliedFinal.result,
      focusPlayheadMs: appliedFinal.focusPlayheadMs,
      explanation,
      provenance: {
        agentRoles: AGENT_VERSIONS.map((a) => a.role),
        correctionOccurred: repairPlan !== null,
        toolResults,
        verifiedEvidenceIds,
        turns,
      },
    };
  } catch (error) {
    if (error instanceof FoundryProviderError) {
      const message = `${error.failure.kind}: ${error.failure.message}`;
      return await finalize(
        error.failure.kind === 'unconfigured' ? 'needs_review' : 'needs_review',
        `provider unavailable — ${message}`,
      );
    }
    return await finalize('failed', error instanceof Error ? error.message : String(error));
  }
}

/** Deterministic repair guidance: numbers out, causation qualified. */
function repairCaption(caption: string, instruction: string): string {
  let repaired = caption
    .replace(/\b\d+(?:\.\d+)?\s*(?:m|metres|meters|ms|seconds?)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (/(caused|directly led)/i.test(repaired)) {
    repaired = repaired
      .replace(/caused/gi, 'may have contributed to')
      .replace(/directly led/gi, 'likely contributed to');
  }
  if (repaired.length === 0)
    repaired = 'The reading below stays a labelled interpretation of the measured evidence.';
  void instruction;
  return repaired;
}
