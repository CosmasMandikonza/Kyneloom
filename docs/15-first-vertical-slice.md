# 15 — Build brief: the first complete Playable Moment

> **Purpose:** provide two founders and coding agents one unambiguous, end-to-end implementation target. **Status:** the seeded golden fixture EXISTS (KYN-03: `tests/fixtures/generated/synthetic-derby-01`, seed 24017, `fixture-engine-v1`); streaming, reducer, scene and publishing remain planned.

## The slice

**"The invisible assist":** a synthetic goal in the 78th minute, with a decoy run and defensive displacement. The viewer can follow the winger, scrub time, inspect measured separation and read an explicitly labeled interpretation. An agent proposes a camera composition, a producer revises and approves it, and an independent viewer opens the immutable release.

Do **not** split this into 15 unrelated mock pages. Design one golden fixture and use it through every system.

**Competition-critical extra output:** the same manifest must render a **transparent, timestamped broadcast overlay** on a separately owned synthetic match feed, with a verified claim/recap and shared evidence IDs. This is [Issue #31](https://github.com/CosmasMandikonza/Kyneloom/issues/31), not a separate proof-of-concept disconnected from 3D.

## Required sequence and observable outcomes

| # | Trigger | Backend contract | Visible outcome | Test |
|---|---|---|---|---|
| 1 | Load fixture seed | `POST /fixtures/simulate` in dev/test only; outputs `matchId`, generator version | Match and minute shown | Same seed returns same data |
| 2 | Stream events | Schema-enforced Event Hubs messages | Live clock, state, event tick | Duplicate/out-of-order replay |
| 3 | Select candidate | Deterministic selector `MomentCandidate` | “Enter moment” highlight | Same version → same window |
| 4 | Open scene | `GET /matches/{id}/state?atMs=...` / authorized sample window | Render pitch, player/ball, camera and scrub | Pose is invariant across camera modes |
| 5 | Inspect fact | `GET /moments/{id}/evidence/{ref}` | Measured distance and source IDs | Factual number matches reducer output |
| 6 | Ask for composition | `POST /moments/{id}/compile` returns async `workflowId` | Studio job status | Real Foundry agent and tool trace |
| 7 | Reject false claim | Validated typed draft / findings | Unsupported stat highlighted, removed/revised | No invalid manifest can be approved |
| 8 | Change shot | `PATCH /moments/{id}/drafts/{rev}` + expected revision | Timeline/camera preview changes | Concurrent stale edit fails |
| 9 | Approve | `POST /moments/{id}/releases` bound to hash and rights | Release ID and approved status | Unauthorized request denied |
| 10 | Open separate viewer | `GET /releases/{releaseId}` + private asset access | Published interactive scene | Correct version; revocation denies access |

**These are proposed endpoint contracts**. Specify exact request/response schemas and error codes in code before implementation; do not build routes solely from this table.

## One supported fact, one hypothesis

**Calculated fact:** separation between defender and winger increased over a defined sample interval; include coordinates/frame refs, metric version and unit.

**Tactical hypothesis:** the winger's movement likely contributed to opening a passing lane. Display confidence/disclosure. Never upgrade causality to certainty based only on spatial proximity.

## Folder layout suggestion (create only as code is built)

```text
apps/
  web/                  # Next.js product shell and Studio
  viewer/               # optional standalone player; only if justified
services/
  ingest/               # event adapters and reducers
  experience-worker/    # durable Foundry workflow
packages/
  contracts/            # canonical event and manifest types/schema
  match-core/           # reducers and metric code
  scene-renderer/       # shared viewer, camera/overlay grammar
  ui/                   # tested visual components
infra/
  azure/                # Bicep
tests/
  fixtures/             # golden and adversarial synthetic match data
```

Avoid premature microservices for modules that can live in a single deployable. **This is a suggested structure, not an existing folder tree.**

## Founders' contract handshake

**Shared first:** event JSON fixtures, world coordinate transform, timestamp conventions, manifest JSON schema, evidence IDs and scenario hash.

**Founder A:** fixture generator, reducer, schema, metric functions, API routes, Foundry worker, rights check, trace/tests.

**Founder B:** 3D fixture player, camera, time controller, evidence layers, lens switching, Studio preview and editing.

**Integration rule:** every day, load the *same golden fixture* through the whole current path; no component invents its own player arrays or time conversions.

## Reviewable engineering stories

**Story FE-01:** pitch + 22 simplified player markers + ball follow timestamped sample positions. Acceptance: paused frame unchanged between refreshes, free orbit and mobile 2D fallback.

**Story BE-01:** canonical event stream + reducer. Acceptance: duplicate/out-of-order events and correction process covered by tests.

**Story FE-02:** select running player and show metric overlay + evidence drawer. Acceptance: overlay anchored to data IDs; inferred motion visibly labeled.

**Story AI-01:** compile camera plan with a true Foundry execution. Acceptance: tool and model calls visible in redacted trace; invalid number denied.

**Story STUDIO-01:** editable draft and immutable approval. Acceptance: stale edit rejected, published output opens separately and revoked release becomes inaccessible.

## No-progress theater

A demo is **not** complete because panels animate through `Agent 1 → Agent 2 → Agent 3`. It is complete when we have actual source inputs, a traceable model/tool execution, a source-linked manifest, a rendered browser view and a real authorized release.

**See:** [Roadmap](12-delivery-roadmap.md) · [Manifest](06-moment-manifest.md) · [UX](02-experience-design.md).