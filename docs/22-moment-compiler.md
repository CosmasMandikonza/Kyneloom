# 22 — The Playable Moment compiler (KYN-16)

> **Status:** IMPLEMENTED ([#16](https://github.com/CosmasMandikonza/Kyneloom/issues/16)) as `@kyneloom/moment-compiler` + `contracts/moment-proposal.ts` + the `/studio/compile` surface + `POST /api/moment/compile`. Deterministic, fail-closed, content-hashed. **No Microsoft Foundry connectivity is claimed** — the only proposals that exist today are committed `origin: 'local-deterministic'` corpus documents, labeled as such everywhere they appear. No approval or release is ever minted by the compiler (docs/06 gate 7).

## What exists (and what does not)

| Real, verified in repo/tests | Explicitly NOT claimed |
| --- | --- |
| Typed untrusted proposal schema (`MomentProposal` v0.2.0 — status-shaped claims, number-free editorial policy) | A running Foundry agent (KYN-15) |
| Deterministic compiler (`compileMomentProposal`) with field-path errors | Any cloud dependency or secret |
| Content-hash + input-fingerprint law (sha256 over canonical content) | Approval minting / publication (KYN-17/18) |
| Broadcast cues + recap derived from the SAME manifest (#31) | A second renderer — playback is the existing R3F stage |
| Pinned golden artifact (`tests/fixtures/compiled/invisible-assist-directed-v1.json`, hash `sha256:88a9f0d1…c296e6952`) | Auth/tenancy beyond the demo tenant (KYN-21) |

## Architecture

```
committed synthetic fixture
  → authoritative reducer (projectMatch)          ┐
  → deterministic candidates (KYN-12 detector)     ├ TRUSTED source context
  → content digests + tenant/rights allowlists     ┘
                                                  ┌──────────────────────────┐
 UNTRUSTED MomentProposal (v0.2.0) ──────────────▶│ deterministic compiler    │
   (Foundry agent later; local corpus now)        │ schema → gates → recompute│
                                                  └──────────┬───────────────┘
                       TRUSTED MomentManifest v0.2.0 (draft, approval null) ──▶ sha256 content hash
                       + broadcast cues + recap (same clock, same evidence ids)
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
  existing R3F stage            overlay surface                 recap panel
  (directed camera)        (time-coded, absolute ms)      (claims + disclosure)
```

The compiler performs no I/O. It takes `(proposal, CompilerSourceContext)` and returns either a manifest (status `draft`, `approval: null`) plus derivations, or `ContractValidationError[]` with exact field paths. Identical inputs produce identical manifests and identical hashes — pinned by the golden artifact test.

## Compiler gates (all fail closed; all errors carry field paths)

| Gate | Rejection codes | Notes |
| --- | --- | --- |
| 0 Schema (`parseMomentProposal`) | zod-mapped codes | unknown keys, NaN coordinates, assertion-on-hypothesis, end-before-start windows |
| 1 Identity & revision | `cross_tenant_reference`, `missing_reference`, `stale_revision` | tenant, match, `basedOn.reducerRevision` + `basedOn.sourceHash` vs current accepted content |
| 2 Tool allowlist | `unknown_command` | anything outside docs/07's read-only tools |
| 3 Candidate & window | `missing_reference`, `outside_time_window`, `invalid_time_range` | the proposal must interpret exactly one detected candidate, inside tracked coverage, 500 ms–120 s |
| 4 Rights & assets | `rights_violation`, `cross_tenant_reference` (+ schema `unsafe URL` gate) | policy allowlist; https-only, tenant-scoped asset prefixes |
| 5 Scene bounds | `outside_time_window` (+ schema camera bounds) | track/overlay offsets inside the moment window |
| 6 Evidence | `missing_reference`, `insufficient_evidence`, `stale_revision`, `invalid_value`, `duplicate_value` | every derived metric is RECOMPUTED through `kyneloom-get-metric-v1`; only `verified` (exact-source) results pass; declared `inputRefs` must equal the computed dependencies |
| 7 Claims (the TEXT LAW) | `unsupported_claim`, `missing_reference`, `insufficient_evidence`, `constraint_violation` | `calculated` claims carry a REQUIRED `metricAssertion` that must equal the recomputation exactly and be computed by cited evidence — the sentence is then GENERATED from the verified value; `observed` claims cite exactly one source event and the sentence is generated from it; proposing `text` on a verified claim is rejected; hypotheses stay qualitative with a required disclosure |
| Self-check | `constraint_violation` | the compiled manifest must re-parse through `parseMomentManifest` before hashing |

## The factual-text contract (review blocker A)

Untrusted prose can never wear a verified label. The proposal has **no `text` field** on `observed`/`calculated` claims — only references (a metric assertion / a source event). The compiler generates every verified sentence deterministically (`moment-compiler/src/facts.ts`): e.g. *"The measured separation between away-03 and home-09 changed by 16.746 m (from 6.317 m to 23.063 m) between 78:41 and 78:49."* and *"Pass completed by home-08 at 78:46 (evt-0042)."* The one editorial channel is the `hypothesis` claim (required disclosure), plus the recap headline — and ALL editorial text must be **number-free** (`contracts/editorial-text.ts`: digits and English number words are rejected with the token named). Numbers are claims; only the deterministic compiler may put them in audience-facing text. Storytelling survives: the editorial voice interprets; the verified voice measures.

## The artifact/identity contract (review blocker B)

Everything a viewer can see lives INSIDE the content-hashed manifest (schema v0.2.0, registered migration from 0.1.0): scene, claims (generated text), evidence, and the **`presentation` section** — broadcast cues (`broadcast[]`, manifest offset clock) and recap (`headline` + `lines` mirroring claims). `manifestHash = "sha256:" + sha256(canonicalJsonStringify(approvalContentPayload(manifest)))` spreads every content field, so changing a headline, a caption, a cue, a camera keyframe or any evidence-bound word changes the identity (tested); the stored artifact alone — no copy of the proposal — reconstructs the 3D, overlay and recap outputs (round-trip tested). Approvals stay `null`; the compiler can never mint one.

## The KYN-15 proposal boundary (what a Foundry agent must produce)

**Document schema:** `packages/contracts/src/moment-proposal.ts` (`parseMomentProposal`, schemaVersion **`0.2.0`**). Import `@kyneloom/contracts` — no server-only APIs.

**Input hashes / revision identity.** The proposal carries `basedOn`:
- `reducerRevision` — the reducer revision count of the accepted corpus it read (`projectMatch(...).revisionCount`);
- `sourceHash` — `sha256:hex` over `canonicalJsonStringify({events: sha256(events), tracking: sha256(tracking)})` of the ACCEPTED (post-reducer) arrays. Any source correction changes this digest and the compiler rejects the proposal as `stale_revision`.

**Candidate binding.** `candidateRef` must be a `MomentCandidate.candidateId` from the current detection run, and `timeRangeMs` must equal that candidate's window. The web service's detection profile is documented in `apps/web/src/lib/moment-compiler-service.ts`.

**Evidence refs.** Derived-metric evidence carries `metricQuery: { kind, args }` (grammar = `parseMetricQuery`; kinds: `nearest-opponent`, `separation-delta`, `passing-lane-occupancy`, `off-ball-movement`) and `inputRefs` that must equal the metric's computed dependency frames/events. Source events and tracking windows are verified by direct lookup. Numbers are read from `POST /api/agent/metric` (KYN-12) — never supplied.

**Allowed tools.** `tools[]` ⊆ `['get_metric','get_event_window','validate_camera_plan','validate_claims']`; anything else → `unknown_command`. There is no field that can carry executable content.

**Expected validation errors.** `ContractValidationError { fieldPath, code, message }` — see the gate table above; the labeled red-team corpus in `packages/moment-compiler/src/corpus.ts` demonstrates each rejection and is asserted by tests.

**How Foundry plugs in.** POST the proposal document to `POST /api/moment/compile` (JSON body = the proposal; response = `{ ok: true, manifest, manifestHash, … }` — the presentation lives on `manifest.presentation` — or `{ ok: false, errors }`), or call `compileMomentProposal` in-process with a trusted source context. No credentials, no approval authority, no freeform execution — the same boundary the Studio workbench uses. Keep proposal `origin: 'foundry-agent'` for real agent output; `local-deterministic` is corpus material only.

## Presentation derivations (#31 invariant)

One manifest drives three outputs: the 3D stage (directed camera track), the broadcast overlay (`manifest.presentation.broadcast`, offset clock converted to the absolute match clock exactly once at the UI boundary — `apps/web/src/lib/compiled-moment.ts`), and the recap (`manifest.presentation.recap`). Evidence ids and the match clock are identical across all three by construction; the UI performs no football arithmetic. This in-stage overlay is a preview surface; the independently embeddable media-clock-synced overlay remains issue #31's scope — no external broadcast integration is claimed.

## Determinism & hashing law

See the artifact/identity contract above: one hash covers everything. `manifestInputFingerprint` is the stale-detection key verifiers re-check. The compiler emits no timestamps and sorts every derived collection. The pinned artifact must stay byte-identical; regenerate intentionally with `pnpm tsx scripts/generate-compiled-artifact.ts` and treat the hash change as a contract event.

## Surface

`/studio/compile` (linked from Studio): the selected source moment and canonical evidence, the proposal corpus (a second VALID cut plus labeled defects), real compilation through the API, exact field-path errors, and the compiled moment playing in the existing Living Replay. Recompiling a valid proposal swaps the entire experience in place — directed camera, overlay, recap and every identity display rebind to the new hash (one client-side owner, `compile-experience.tsx`); a rejected compilation never touches the stage and the previous artifact is explicitly labeled as the last valid one.

**Related:** [06 — Moment Manifest](06-moment-manifest.md) · [07 — Agent orchestration](07-agent-orchestration.md) · [21 — Football intelligence](21-football-intelligence.md) · [10 — Security & rights](10-security-and-rights.md)
