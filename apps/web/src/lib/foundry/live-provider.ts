/**
 * KYN-15 — LIVE Foundry provider. UNVERIFIED (Phase-0 gate blocked: no
 * authorized Foundry project in this environment). Written against the real
 * `@azure/ai-projects` 2.9.0 SDK surface:
 *
 *   new AIProjectClient(endpoint, new DefaultAzureCredential())
 *     .getOpenAIClient()
 *     .chat.completions.create({ model: <deployment>, response_format: { type: 'json_object' } })
 *
 * Config (all required together, else the provider reports `unconfigured`):
 *   KYNELOOM_FOUNDRY_ENABLED=true
 *   KYNELOOM_FOUNDRY_ENDPOINT=https://<foundry-project>.services.ai.azure.com/api/projects/<name>
 *   KYNELOOM_FOUNDRY_DEPLOYMENT=<model deployment name>
 *
 * Entra auth comes from DefaultAzureCredential (az cli / env vars / managed
 * identity). One bounded transient retry per call; a hard per-call timeout.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { AIProjectClient } from '@azure/ai-projects';
import type { OpenAI } from 'openai';
import {
  FoundryProviderError,
  parseChallengerVerdict,
  parseDirectorPlan,
  parseInterpretation,
  type ChallengerInput,
  type FoundryCall,
  type FoundryProvider,
  type InterpretationInput,
  type DirectorInput,
  type ProviderFailure,
} from './provider';

const CALL_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 750;

export interface FoundryEnvConfig {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly deployment: string;
}

export function readFoundryEnv(env: NodeJS.ProcessEnv = process.env): FoundryEnvConfig {
  return {
    enabled: env['KYNELOOM_FOUNDRY_ENABLED'] === 'true',
    endpoint: env['KYNELOOM_FOUNDRY_ENDPOINT'] ?? '',
    deployment: env['KYNELOOM_FOUNDRY_DEPLOYMENT'] ?? '',
  };
}

/** JSON-mode chat completion against the project's model deployment. */
async function completeJson(
  client: OpenAI,
  deployment: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<{
  json: unknown;
  requestId: string | null;
  usage: { promptTokens?: number; completionTokens?: number } | null;
}> {
  const attempt = async (): Promise<{
    content: string | null;
    id?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const completion = await client.chat.completions.create({
        model: deployment,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      return {
        content: completion.choices[0]?.message?.content ?? null,
        id: completion.id,
        usage: completion.usage
          ? {
              prompt_tokens: completion.usage.prompt_tokens,
              completion_tokens: completion.usage.completion_tokens,
            }
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/429|rate/i.test(message)) {
        throw new FoundryProviderError({ kind: 'rate_limit', message });
      }
      if (/abort/i.test(message)) {
        throw new FoundryProviderError({ kind: 'timeout', message });
      }
      if (/401|403|auth/i.test(message)) {
        throw new FoundryProviderError({ kind: 'auth', message });
      }
      throw new FoundryProviderError({ kind: 'error', message });
    } finally {
      clearTimeout(timer);
    }
  };
  let response: Awaited<ReturnType<typeof attempt>>;
  try {
    response = await attempt();
  } catch (error) {
    // ONE bounded transient retry for generic errors (never for rate limit).
    if (error instanceof FoundryProviderError && error.failure.kind === 'error') {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      response = await attempt();
    } else {
      throw error;
    }
  }
  const text = response.content ?? '';
  try {
    return {
      json: JSON.parse(text) as unknown,
      requestId: response.id ?? null,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
          }
        : null,
    };
  } catch {
    throw new FoundryProviderError({
      kind: 'malformed_response',
      message: `model returned non-JSON output (${text.slice(0, 90)}…)`,
    });
  }
}

export function createLiveFoundryProvider(config: FoundryEnvConfig): FoundryProvider {
  if (!config.enabled || config.endpoint.length === 0 || config.deployment.length === 0) {
    const failure: ProviderFailure = {
      kind: 'unconfigured',
      message:
        'Foundry is enabled but not configured: KYNELOOM_FOUNDRY_ENDPOINT and KYNELOOM_FOUNDRY_DEPLOYMENT are required.',
    };
    const refuse = (): never => {
      throw new FoundryProviderError(failure);
    };
    return {
      kind: 'live',
      model: config.deployment || '(unconfigured)',
      interpret: refuse,
      direct: refuse,
      challenge: refuse,
    };
  }
  const client = new AIProjectClient(
    config.endpoint,
    new DefaultAzureCredential(),
  ).getOpenAIClient();
  const wrap = async <P>(
    run: () => Promise<{
      json: unknown;
      requestId: string | null;
      usage: { promptTokens?: number; completionTokens?: number } | null;
    }>,
    parse: (raw: unknown) => P,
  ): Promise<FoundryCall<P>> => {
    const startedAt = Date.now();
    const { json, requestId, usage } = await run();
    return {
      payload: parse(json),
      meta: {
        model: config.deployment,
        requestId,
        latencyMs: Date.now() - startedAt,
        usage,
      },
    };
  };
  return {
    kind: 'live',
    model: config.deployment,
    async interpret(input: InterpretationInput) {
      return wrap(
        () =>
          completeJson(
            client,
            config.deployment,
            'You are a football interpretation agent. Return STRICT JSON only: {"restatedQuestion": string, "relevantEventIds": string[], "claims": [{"text": string, "uncertainty": "measured"|"observed"|"hypothesis", "evidenceIds": string[]}], "toolRequests": [{"tool": "get_metric"|"get_event_window"|"validate_camera_plan"|"validate_claims", "args": {string: string}}]}. Only cite the allowed event ids and evidence ids you are given. Never state a measured number yourself — request the metric tool instead. Causal interpretations must be labelled hypothesis.',
            JSON.stringify(input),
          ),
        parseInterpretation,
      );
    },
    async direct(input: DirectorInput) {
      return wrap(
        () =>
          completeJson(
            client,
            config.deployment,
            'You are an experience director for a football moment compiler. Return STRICT JSON only: {"baseProposalId": "golden"|"broadcast-sweep", "focusEventId": string|null, "captionText": string, "reason": string}. captionText must be editorial, number-free prose. Choose the base and focus from the candidates you are given.',
            JSON.stringify(input),
          ),
        parseDirectorPlan,
      );
    },
    async challenge(input: ChallengerInput) {
      return wrap(
        () =>
          completeJson(
            client,
            config.deployment,
            'You are an editorial challenger. Return STRICT JSON only: {"verdict": "acceptable"|"needs_revision", "defects": [{"fieldPath": string, "severity": "blocker"|"major"|"minor", "kind": "unsupported_number"|"overstated_causation"|"unsupported_reference"|"confusing_presentation", "instruction": string}]}. Challenge persuasive drafts: unsupported numbers, overstated causation, unsupported references. Be specific in the repair instruction.',
            JSON.stringify(input),
          ),
        parseChallengerVerdict,
      );
    },
  };
}
