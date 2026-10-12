# ADR-0001 — Separate live match state from creative experience generation

**Status:** Accepted as target design · **Date:** 2026-10-12

## Context

Match-event updates need predictable low latency. LLM requests involve variable duration, cost and failure rates. A pipeline that makes the viewer wait for interpretation agents on every incoming pass is not robust enough for a professional live experience.

## Decision

**Split execution:**
1. **Fast path:** accepted event → deterministic reducer → live state delta → authorized client. No model dependency.
2. **Experience path:** selected moment → durable agent workflow → typed manifest → validation → human approval → publish.

Use one authoritative event-time match-state projection for both paths; do not create independent numerical “truth” inside model prompts or render components.

## Alternatives rejected

- **LLM-first every event:** low predictability, unbounded cost, hallucination risk.
- **Single synchronous API from stream to finished scene:** editor/release latency couples to live playback.
- **Two unrelated pipelines with own truth stores:** divergent timestamps/stats and correction inconsistency.

## Consequences

- Requires correlation IDs, source revision mapping and invalidation of compiled moments after upstream corrections.
- Adds asynchronous state and status UX, but protects the viewer from creative-agent stalls.
- Allows independent baseline tests and scaling.

## How to falsify this decision

If measured production workloads show model-mediated fast updates are predictably cheaper, faster, and equally reliable without factual divergence, revisit with a benchmark ADR. Until then, keep model work asynchronous.

**References:** [Architecture](../04-system-architecture.md) · [Evaluation](../11-evaluation-and-reliability.md).