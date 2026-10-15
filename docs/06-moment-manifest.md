# 06 — Moment Manifest: the center of the platform

> **Status:** v0.1 proposal — **implemented as a runtime-validated Zod schema in [`packages/contracts/src/moment-manifest.ts`](../packages/contracts/src/moment-manifest.ts) (KYN-02)**, version `0.1.0`, with a validated corpus in [`tests/fixtures/contracts`](../tests/fixtures/contracts) and a shared example exported as `exampleMomentManifest()`.

## Why this exists

The model does not deliver a video, execute JavaScript or directly manipulate a Three.js scene. It proposes a **declarative, allowlisted scene specification**. A deterministic compiler validates it and a viewer renders it. This keeps the scene reproducible, editable, auditable and portable.

**One manifest is the common contract** among agents, 3D engine, Studio, evidence verifier and publication SDK.

## A minimal illustrative manifest

```json
{
  "schemaVersion": "0.1.0",
  "manifestId": "mom-synthetic-78m",
  "tenantId": "demo-org",
  "matchId": "synthetic-derby-01",
  "revision": 1,
  "status": "draft",
  "timeRangeMs": [4717000, 4731000],
  "input": {
    "reducerRevision": "state-rev-11",
    "sourceEventIds": ["evt-0042"],
    "trackingSampleRefs": ["frame-47170", "frame-47310"],
    "sourceHash": "sha256:PLACEHOLDER_NOT_A_REAL_HASH"
  },
  "scene": {
    "coordinateSystem": "pitch-meters-center-origin-v1",
    "cameraTracks": [{
      "id": "cam-01",
      "mode": "overhead",
      "startMs": 0,
      "endMs": 14000,
      "keyframes": [
        { "tMs": 0, "position": [0, 46, 48], "target": [0, 0, 0], "fovDeg": 48 },
        { "tMs": 14000, "position": [12, 35, 25], "target": [21, 0, 2], "fovDeg": 43 }
      ]
    }],
    "overlays": [{
      "id": "ov-01",
      "kind": "distance",
      "startMs": 6000,
      "endMs": 11000,
      "metricRef": "metric-defender-separation-01",
      "evidenceIds": ["evidence-01"]
    }]
  },
  "claims": [{
    "id": "claim-01",
    "text": "The defender separation increased during the run.",
    "status": "calculated",
    "evidenceIds": ["evidence-01"],
    "language": "en"
  }],
  "evidence": [{
    "id": "evidence-01",
    "kind": "derived_metric",
    "ref": "metric-defender-separation-01",
    "algorithmVersion": "separation-v1",
    "inputRefs": ["frame-47170", "frame-47310"]
  }],
  "lenses": ["fan", "analyst", "accessible"],
  "rightsPolicyRef": "demo-synthetic-policy-v1",
  "approval": null
}
```

**Note:** the sample hash is intentionally a placeholder; compute real content hashes in the implementation. `approval` becomes a typed, server-issued record tied to a specific manifest hash, never a client-set boolean.

## Implemented contract decisions (KYN-02)

- **Version** — exactly `"0.1.0"` (semver). Unsupported versions fail with `unsupported_version`; the first breaking change registers a migration before acceptance.
- **Two time axes, never conflated** — `timeRangeMs` is absolute match-relative ms; every `startMs`/`endMs`/`tMs` in `scene` is an *offset from `timeRangeMs[0]`*. Using an absolute timestamp as an offset is rejected as out-of-window.
- **Scene space** — all manifest positions/targets are pitch meters (z up); `coordinateSystem` must be the literal `pitch-meters-center-origin-v1`. Three.js conversion happens once, via the shared `pitchToThree` transform (docs/08).
- **Safe bounds** — moment window 500 ms–120 s; keyframes 2–64 per track, strictly increasing, inside **both** the moment window *and* their own camera track's `[startMs, endMs]` interval; FOV 20°–120°; cameras at least 0.5 m above the pitch plane; every camera position/target component within the shared ±500 m coordinate radius; overlay/claim/evidence array caps.
- **Collection identity** — ids must be unique within `scene.cameraTracks`, `scene.overlays`, `claims` and `evidence`; duplicates are reported at the repetition's own field path.
- **Declarative only** — strict unknown-key rejection removes any unmodeled "script"/"command" field; there is no field that can carry executable content; asset URLs (future fields) validate against an https-only gate rejecting `javascript:`, `data:`, credentials and fragments.
- **Evidence and claims** — internal referential integrity is enforced at schema level (every cited evidence id must be declared in the manifest). Data overlays must cite evidence (editorial captions excepted); `observed`/`calculated` claims must cite evidence; `hypothesis` claims must carry an `inferenceDisclosure` and can never be labeled observed.
- **Approval semantics** — client-editable statuses (`draft`, `validating`, `needs_revision`, `awaiting_approval`) must have `approval: null`; authorized statuses (`approved`, `published`, `revoked`) must carry the server-issued `ApprovalRecord` (approvedBy, approvedAt, manifest hash, policy version). A `ReleaseRecord` type captures immutable, revocable releases (revocations must record when and why). Minting approvals stays a server workflow.
- **Approval hashing payload** — `approvalContentPayload(manifest)` defines exactly what the server hashes: every immutable content field (schemaVersion, ids, revision, timeRangeMs, input, scene, claims, evidence, lenses, rightsPolicyRef), **excluding** the mutable `status` and the `approval` record itself (which carries the resulting hash). Status transitions and approval attachment therefore never change the content hash; any content edit does. The sha256 operation stays server-side.
- **Schema vs semantics** — schema parsing cannot prove external facts. `MANIFEST_SEMANTIC_CHECKS` documents the five verifier obligations (reference existence, numerical consistency, rights, server-issued approval, input-revision currency). `manifestInputFingerprint()` canonicalizes the input block so verifiers can detect changed source revisions; real sha256 hashing stays server-side (contracts ship no server-only APIs).
- **Snapshot** — the parsed golden manifest is snapshot-tested; the on-disk corpus file must stay identical to `exampleMomentManifest()`.

## Required type families

`MatchInputRef`: match/reducer revision, source hashes, sample window and provenance.

`CameraTrack`: allowed mode, bounded keyframes, easing policy, safe focal ranges, viewport constraints.

`VisualOverlay`: enumerated kinds (`distance`, `trajectory`, `zone`, `event_marker`, `caption`, `source_quality`), time range, spatial references and evidence links.

`Claim`: ID, status (`observed`, `calculated`, `hypothesis`), localized text, evidence refs, inference disclosure.

`AudienceVariant`: language, verbosity, accessible narration/captions and per-lens layer visibility—**not** modified football truth.

`RightsPolicy`: input/asset license references, approved tenant, destination allowlist, expiry, geo or other restrictions where applicable.

`Release`: immutable `manifestHash`, `approvedBy`, `approvedAt`, `policyVersion`, `releaseId`, revocation state, audit correlation.

## Validation gates: reject by default

1. **Schema:** valid semver, required IDs, finite coordinates, sane durations, no excessive arrays or unknown commands.
2. **Reference:** every entity and metric exists in the named input revision, and is authorized for current tenant.
3. **Temporal:** keyframes monotonic, within moment, overlays inside allowed time ranges; trajectories do not exceed available data.
4. **Evidence:** numerical claims have computable metric links; hypotheses are explicitly labeled; no unreferenced “verified” statement.
5. **Visual:** camera poses within allowed constraints, asset allowlist, overlays below budget; avoid nausea/occlusion and invalid target.
6. **Rights:** input source, asset and destination permitted for the publisher/tenant.
7. **Approval:** only an authorized server action can approve a hash of a validated manifest.

If invalid, emit structured errors with field paths and actionable diagnostics, not silent correction. An agent may be asked to revise within a bounded budget.

## Revision and publication state machine

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> validating
    validating --> needs_revision: rejected
    needs_revision --> draft: edit
    validating --> awaiting_approval: passed
    awaiting_approval --> draft: producer edits
    awaiting_approval --> approved: authorized approval
    approved --> published: authorized destination release
    published --> revoked: expiry / rights change / explicit action
    approved --> revoked: rights change
```

**Rules:**
- `published` never points to a mutable `draft` version.
- Editor saves use optimistic concurrency (`If-Match`/expected revision).
- Any input evidence correction invalidates relevant claims; published releases are flagged/revoked or replaced by *new* approved versions.
- Revoked URLs stop granting access even if cached assets persist briefly; protect source assets separately.

## Compiler acceptance tests

- A valid fixture produces equivalent rendering instructions every replay.
- Unknown overlay kind or malicious asset URL is rejected.
- Claim with no evidence cannot be `observed` or `calculated`.
- Camera values containing NaN or unsafe duration are rejected.
- Rights mismatch cannot enter `approved`.
- Stale revision rejects editor save.
- Changing one claim changes hash and requires new approval.
- Lens toggling never mutates `input`, geometry or verified metrics.

**ADR:** [typed manifests over executable AI scene code](decisions/0002-typed-manifest.md).