import { buildCompileCorpus, compileMomentProposal } from '@kyneloom/moment-compiler';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildCompilerSource } from '@/lib/moment-compiler-service';
import {
  ASK_ROUTE_VERSION,
  ASK_RESOLVER_LABEL,
  SUPPORTED_INTENTS,
  resolveAskIntent,
} from './ask-intent-shared';

export {
  ASK_ROUTE_VERSION,
  ASK_RESOLVER_LABEL,
  SUPPORTED_INTENTS,
  MAX_PROMPT_LENGTH,
  resolveAskIntent,
} from './ask-intent-shared';
export type { AskIntentId, IntentClassification, AskMomentOutcome } from './ask-intent-shared';

/**
 * Server-side grounding + compilation (see ask-intent-shared for the laws).
 * Needs the authoritative fixture — NEVER import this module from a client
 * component (it transitively loads node:fs); clients use ask-intent-shared.
 */
export async function resolveAskMoment(
  prompt: string,
): Promise<import('./ask-intent-shared').AskMomentOutcome> {
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) {
    return {
      ok: false,
      routeVersion: ASK_ROUTE_VERSION,
      resolver: ASK_RESOLVER_LABEL,
      kind: 'unsupported',
      message: 'The compiler source is currently unavailable — nothing was resolved.',
      supportedExamples: SUPPORTED_INTENTS.map((intent) => intent.example),
    };
  }
  const corpus = buildCompileCorpus(source.snapshot.context);
  const candidate = corpus.candidate;
  const classification = resolveAskIntent(prompt);

  if (classification.kind === 'unsupported') {
    return {
      ok: false,
      routeVersion: ASK_ROUTE_VERSION,
      resolver: ASK_RESOLVER_LABEL,
      kind: 'unsupported',
      message:
        "This question is outside what the current deterministic interpretation supports. It only answers questions grounded in this moment's verified evidence — nothing was substituted in its place.",
      supportedExamples: SUPPORTED_INTENTS.map((intent) => intent.example),
    };
  }

  // Goal build-up: select the finish event BY KIND from the authoritative
  // source events — never a fabricated timestamp.
  const goalEvent =
    candidate.anchorEventIds.length > 0
      ? (source.snapshot.context.events.find(
          (event) => candidate.anchorEventIds.includes(event.eventId) && event.kind === 'goal',
        ) ?? source.snapshot.context.events.find((event) => event.kind === 'goal'))
      : source.snapshot.context.events.find((event) => event.kind === 'goal');

  let proposal = corpus.golden;
  let explanation: string;
  let evidenceNote: string;
  let sourceEventIds: readonly string[];
  let focusPlayheadMs: number;

  switch (classification.intentId) {
    case 'off-ball-run': {
      // The verified spatial metric over the candidate window.
      const metric = corpus.golden.claims.find((claim) =>
        claim.evidenceIds.includes('ev-separation'),
      );
      const measurement = metric?.status === 'calculated' ? metric : null;
      const windowStart = corpus.golden.timeRangeMs[0];
      const separationClaim = corpus.golden.claims.find((claim) =>
        claim.evidenceIds.includes('ev-separation'),
      );
      const hypothesis = corpus.golden.claims.find((claim) => claim.status === 'hypothesis');
      sourceEventIds = ['ev-separation', ...(hypothesis ? [hypothesis.id] : [])];
      focusPlayheadMs = windowStart;
      explanation =
        `The directed cut follows the moment from ${String(windowStart)} ms. ` +
        (separationClaim !== undefined && separationClaim.status === 'calculated'
          ? `The verified measurement behind this answer: ${separationClaim.text} `
          : '') +
        (hypothesis !== undefined
          ? `Tactical reading, kept as interpretation: ${hypothesis.text ?? ''}`
          : '');
      evidenceNote =
        'Grounded in the verified separation metric recomputed from accepted tracking over the candidate window. The connection between the off-ball run and the created space stays a labelled hypothesis — the evidence supports it as a likely contribution, not as an established causal fact.';
      void measurement;
      break;
    }
    case 'goal-buildup': {
      if (goalEvent === undefined) {
        return {
          ok: false,
          routeVersion: ASK_ROUTE_VERSION,
          resolver: ASK_RESOLVER_LABEL,
          kind: 'unsupported',
          message:
            'No goal event exists in the current fixture — a finish-focused answer would require evidence this match does not have.',
          supportedExamples: SUPPORTED_INTENTS.map((intent) => intent.example),
        };
      }
      proposal = corpus.golden;
      sourceEventIds = [goalEvent.eventId];
      focusPlayheadMs = goalEvent.occurredAtMs;
      explanation = `The directed cut plays the build-up to the finish: the source event of kind "goal" (${goalEvent.eventId}) by ${goalEvent.actorId} at ${String(goalEvent.occurredAtMs)} ms anchors the answer, and playback focuses there.`;
      evidenceNote = `Cited directly from the authoritative source events (kind "goal", id ${goalEvent.eventId}) — no fabricated timestamps.`;
      break;
    }
    case 'broadcast-wide': {
      const sweep = corpus.entries.find((entry) => entry.id === 'broadcast-sweep');
      if (sweep === undefined) {
        return {
          ok: false,
          routeVersion: ASK_ROUTE_VERSION,
          resolver: ASK_RESOLVER_LABEL,
          kind: 'unsupported',
          message: 'The broadcast sweep cut is not available in the current corpus.',
          supportedExamples: SUPPORTED_INTENTS.map((intent) => intent.example),
        };
      }
      proposal = sweep.proposal;
      sourceEventIds = candidate.anchorEventIds;
      focusPlayheadMs = corpus.golden.timeRangeMs[0];
      explanation =
        'A different director for the same verified facts: the high broadcast sweep camera covers the whole move, with its own headline and caption timing. It compiles to a different validated artifact than the directed cut.';
      evidenceNote =
        'Same candidate window and the same verified claims as the directed cut — only the camera direction and presentation differ.';
      break;
    }
  }

  const result = compileMomentProposal(proposal, source.snapshot.context);
  if (!result.ok) {
    return {
      ok: false,
      routeVersion: ASK_ROUTE_VERSION,
      resolver: ASK_RESOLVER_LABEL,
      kind: 'unsupported',
      message: `The deterministic compiler rejected the resolved proposal (${result.errors[0]?.fieldPath ?? '(root)'}: ${result.errors[0]?.message ?? 'unknown'}) — nothing was played.`,
      supportedExamples: SUPPORTED_INTENTS.map((intent) => intent.example),
    };
  }

  return {
    ok: true,
    routeVersion: ASK_ROUTE_VERSION,
    resolver: ASK_RESOLVER_LABEL,
    intentId: classification.intentId,
    sourceEventIds,
    explanation,
    evidenceNote,
    focusPlayheadMs,
    result,
  };
}
