# 01 — Product vision and boundaries

> **Status:** Product hypothesis and target specification. **Not yet implemented.**
>
> **One sentence:** Kyneloom turns a time-bounded sporting event into a *Playable Moment*—an interactive, evidence-linked scene that audiences can explore and rights holders can edit and publish.

## Why this product should exist

Video replay is linear, prescriptive and controlled by an editor's selected camera. Sports analytics offers enormous depth but is usually separated from fan storytelling. AI commentary can describe a match while inventing causal explanations. And immersive sport replays exist, but do not necessarily expose a portable, inspectable, producer-editable experience format.

**Kyneloom's wedge** is the *event-to-interactive-experience pipeline*: synthesize a coherent scene from structured data; bind explanations to evidence; let people choose how to understand it; provide professional editorial controls; deliver the resulting version to other viewers.

This is a **differentiation hypothesis**, not a claim that every component is novel or that customer demand has been proven.

## Users, jobs, and permissions

| User | Core job to be done | View access | Privileged actions |
|---|---|---|---|
| Fan | "Show me the part of the goal I didn't notice." | Fan, analyst, accessible perspectives | None by default |
| Football analyst | "Let me investigate movement and explain it responsibly." | All non-privileged perspectives and analysis tools | Save private annotations where authorized |
| Broadcast producer | "Turn this moment into an accurate, polished, publishable experience." | All lenses plus Studio | Edit, submit for review; publish if granted permission |
| Organization admin | "Control access, licensed data, output destinations and auditability." | Org-owned experiences | Grant roles, manage rights and revoke releases |

**Rule:** Experience lens ≠ authentication role. Fans may use an analyst lens. A lens change never elevates privileges.

## The canonical product journey

1. Synthetic event and trajectories arrive with match and source metadata.
2. Deterministic processing selects a meaningful moment and calculates supportable facts.
3. The user opens an interactive scene and manipulates time and perspective.
4. The user selects a claimed observation or tactical hypothesis; provenance and uncertainty become visible in-scene.
5. Agents propose an editable cinematic composition with audience variations.
6. A producer reviews it and approves a specific immutable version.
7. The authorized published experience opens independently in an embedded viewer or shareable destination.

The central demo must complete all seven steps **using actual execution**, not isolated mocked screens.

## Core nouns

- **MatchEvent:** immutable received envelope for a fact/position update, or an explicit correction to one.
- **MatchState:** deterministic projection of ordered, accepted events for a fixture version.
- **Moment:** bounded, anchored window of match state.
- **Evidence:** source-event references, computed metrics, inference flags, and explanatory confidence.
- **Playable Moment / MomentManifest:** versioned, declarative scene with timeline, evidence-bound claims, audience lens variants and publication rules.
- **Scene release:** approved, immutable manifest version plus referenced content hashes/assets; may later be revoked.

See [event contracts](05-data-and-event-contracts.md) and [manifest](06-moment-manifest.md).

## Why an enterprise buyer might pay

**Initial buyer hypothesis:** broadcasters, leagues or sports streaming providers that already own/hold rights to structured match data, but cannot economically build interactive, multi-audience experiences.

**Value proposition hypothesis:** reduce production effort to generate interactive explainers while retaining editorial and rights control; open new engagement or sponsorship formats.

**Business model hypotheses:** integration + platform subscription + volume-based processing/experience delivery. **Do not assert pricing or ROI until customer interviews and production measurements exist.**

**Distribution:** embeddable viewer SDK, API/manifest delivery, professional studio. Consumer sharing is rights-gated, not unconditional.

## Differentiation and honest competition

- **Not** another chat-with-the-match app.
- **Not** a tracking-data provider or CV-based ball detection business.
- **Not** another video highlights engine / generic asset manager.
- **Not** a claim that first-person 3D replay or animated broadcasts were invented here.
- **Yes:** auditable interactive scene compilation + editor control + perspective adaptation over a common match state.

See [competitive landscape](14-competitive-landscape.md).

## What we will explicitly defer

Full-game photorealistic reconstruction; speculative match predictions presented as facts; unconstrained camera or video hallucination; unlicensed real Premier League footage; betting features; automated public publication without human authority; dozens of poorly integrated agents; arbitrary model-authored code.

## North-star measures (proposed)

**Product:** percentage of opened moments meaningfully explored; median time to first meaningful interaction; completed producer-approved releases; producer editing time; viewer comprehension in blinded tests versus 2D replay.

**Trust:** provenance coverage of objective claims; unsupported assertion escape rate; source-correction propagation; release revocation time; tenant-isolation failures.

**Performance and economics:** accepted-event-to-live-view p95; moment-compile latency p50/p95; client FPS by device tier; cost per compiled/released moment.

These are measures to collect—not invented baselines.

## Non-negotiable acceptance story

> Given a seeded synthetic match fixture with positional samples and a late correction, when an eligible moment is detected, the fan can replay it in 3D, trace one calculation and one labeled tactical hypothesis, the producer can revise a generated shot sequence, approve it, and open the correct approved version as a separate interactive experience. Duplicate events and a rejected unsupported claim must not result in duplicate publication.

**Related:** [Experience](02-experience-design.md) · [Architecture](04-system-architecture.md) · [Roadmap](12-delivery-roadmap.md).