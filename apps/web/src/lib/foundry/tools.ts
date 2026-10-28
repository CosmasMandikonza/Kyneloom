/**
 * KYN-15 — bounded read-only tool adapters over the DETERMINISTIC source.
 * Every number an agent can quote comes from here (ultimately from the
 * existing kyneloom-get-metric-v1 boundary / corpus), never from the model.
 */

import { buildCompilerSource } from '@/lib/moment-compiler-service';
import { buildCompileCorpus } from '@kyneloom/moment-compiler';
import type { FoundryToolResult, FoundryToolName } from './types';
import { FOUNDRY_TOOL_ALLOWLIST } from './types';

const MAX_TOOL_CALLS = 6;

export interface ToolContext {
  readonly sourceHash: string;
  readonly reducerRevision: number;
  readonly allowedEventIds: readonly string[];
}

export async function buildToolContext(): Promise<ToolContext | null> {
  const { loadGoldenMatch } = await import('@/lib/match-fixture');
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) return null;
  const corpus = buildCompileCorpus(source.snapshot.context);
  return {
    sourceHash: source.snapshot.sourceHash,
    reducerRevision: source.snapshot.context.reducerRevision,
    allowedEventIds: corpus.candidate.anchorEventIds,
  };
}

export async function executeToolCall(
  ctx: ToolContext,
  tool: string,
  args: Record<string, string>,
  callIndex: number,
): Promise<FoundryToolResult> {
  // Allowlist: unknown/malicious tool names are refused outright.
  if (!(FOUNDRY_TOOL_ALLOWLIST as readonly string[]).includes(tool)) {
    return {
      tool: tool as FoundryToolName,
      args,
      ok: false,
      output: `REFUSED: "${tool}" is not an allowlisted tool. Allowed: ${FOUNDRY_TOOL_ALLOWLIST.join(', ')}.`,
    };
  }
  if (callIndex >= MAX_TOOL_CALLS) {
    return {
      tool: tool as FoundryToolName,
      args,
      ok: false,
      output: 'REFUSED: tool-call budget exhausted.',
    };
  }
  const { loadGoldenMatch } = await import('@/lib/match-fixture');
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) {
    return {
      tool: tool as FoundryToolName,
      args,
      ok: false,
      output: 'unavailable: compiler source is down.',
    };
  }
  // Stale-source fail closed: the context must match the CURRENT source.
  if (
    ctx.sourceHash !== source.snapshot.sourceHash ||
    ctx.reducerRevision !== source.snapshot.context.reducerRevision
  ) {
    return {
      tool: tool as FoundryToolName,
      args,
      ok: false,
      output: 'REFUSED: stale source — the fixture moved under this job.',
    };
  }
  switch (tool) {
    case 'get_metric': {
      // Reuse the deterministic separation truth the corpus itself quotes.
      const corpus = buildCompileCorpus(source.snapshot.context);
      const claim = corpus.golden.claims.find(
        (candidate) =>
          candidate.status === 'calculated' && candidate.evidenceIds.includes('ev-separation'),
      );
      const assertion =
        claim !== undefined && claim.status === 'calculated' ? claim.metricAssertion : undefined;
      if (assertion === undefined) {
        return { tool, args, ok: false, output: 'no verified separation metric is available.' };
      }
      return {
        tool,
        args,
        ok: true,
        output: JSON.stringify({
          kind: assertion.kind,
          defenderId: assertion.args.defenderId,
          strikerId: assertion.args.strikerId,
          fromMs: assertion.args.fromMs,
          toMs: assertion.args.toMs,
          [assertion.valueField]: assertion.assertedValue,
          note: 'deterministic recomputation from accepted tracking (kyneloom-get-metric-v1 boundary)',
        }),
      };
    }
    case 'get_event_window': {
      const corpus = buildCompileCorpus(source.snapshot.context);
      return {
        tool,
        args,
        ok: true,
        output: JSON.stringify({
          startMs: corpus.candidate.startMs,
          endMs: corpus.candidate.endMs,
          anchorEventIds: corpus.candidate.anchorEventIds,
          reasonCodes: corpus.candidate.reasonCodes,
        }),
      };
    }
    case 'validate_camera_plan':
    case 'validate_claims': {
      const corpus = buildCompileCorpus(source.snapshot.context);
      const base =
        args['base'] === 'broadcast-sweep'
          ? corpus.entries.find((entry) => entry.id === 'broadcast-sweep')?.proposal
          : corpus.golden;
      return {
        tool,
        args,
        ok: true,
        output: JSON.stringify({
          validBaseIds: corpus.entries
            .filter((entry) => entry.expect === 'valid')
            .map((entry) => entry.id),
          checkedBase: base?.proposalId ?? 'golden',
          note: 'full validation happens in the deterministic compiler at verify time',
        }),
      };
    }
    default:
      return { tool: tool as FoundryToolName, args, ok: false, output: 'REFUSED: unknown tool.' };
  }
}
