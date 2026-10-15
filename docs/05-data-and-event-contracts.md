# 05 — Synthetic data, event contracts and match-state truth

> **Status:** Canonical contract proposal — **implemented as runtime-validated Zod schemas in [`packages/contracts`](../packages/contracts) (KYN-02)**. The JSON examples below are illustrative; the executable source of truth is the code, with a validated fixture corpus in [`tests/fixtures/contracts`](../tests/fixtures/contracts).

## Non-negotiable truth model

**Five distinct data origins** must remain distinguishable:
- `source_observed`: position/event reported by an external licensed tracking source.
- `synthetic_ground_truth`: generated underlying simulation truth for a fictional fixture.
- `interpolated`: computed between known samples, with method/window.
- `extrapolated`: predicted outside observed span, with uncertainty and horizon.
- `hypothesis`: interpretation or alternative outcome, never a physical observation.

A producer must not publish a measured-sounding numerical claim if the underlying facts are only inferred without saying so.

## Canonical incoming event

The schema below is an **illustrative target**, not a checked-in runtime validator:

```json
{
  "schema_version": "1.0",
  "event_id": "evt-0042",
  "provider_id": "kyneloom-simulator",
  "tenant_id": "demo-org",
  "match_id": "synthetic-derby-01",
  "fixture_seed": 24017,
  "source_revision": 1,
  "kind": "pass_completed",
  "occurred_at_ms": 4722000,
  "ingested_at": "2026-10-12T14:30:05Z",
  "sequence": 414,
  "actor_id": "home-08",
  "team_id": "home",
  "position": { "x_m": 21.4, "y_m": -13.8 },
  "attributes": { "target_player_id": "home-09" },
  "provenance": {
    "origin": "synthetic_ground_truth",
    "generator_version": "fixture-engine-v1",
    "license_ref": "synthetic-internal",
    "confidence": 1.0
  },
  "correction_of": null
}
```

**Validation requirements:** identifier formats, monotonic revision for one `event_id`, finite numbers, legal `kind`, allowed teams and actors, event time inside fixture bounds, source-rights metadata, recorded generator version, and no NaN/Infinity.

## Implemented contract decisions (KYN-02)

Runtime validators live in `packages/contracts` (Zod 4, strict mode). Decisions locked by the implementation, with tests as proof:

- **Versions** — events, tracking and state carry `"1.0"` (`major.minor`); unsupported versions fail with a typed `unsupported_version` error naming expected/found. The migration registry is empty until the first breaking change.
- **Unknown fields are rejected** everywhere (strict objects). Extension payloads ride the documented `attributes` map (primitive values only) or a new versioned field.
- **Time convention** — `occurredAtMs`, `sampleTimeMs` and `matchTimeMs` are *absolute match-relative milliseconds*, monotonic from first kickoff, never reset between periods. `ingestedAt` is an ISO-8601 UTC wall-clock instant for arrival ordering only. Moment-manifest camera/overlay times are a different axis (offsets from the moment start; see docs/06).
- **Identifier grammar** — kebab-case ids (`^[a-z0-9][a-z0-9-]*$`) for events, matches, providers, tenants and manifest entities; tracking entities are `"ball"` or `"home-XX"`/`"away-XX"` players (`isBallEntity`/`entityTeam` distinguish them explicitly — ball samples are never assumed to be players).
- **Event kinds** — an allowlist of 26 football kinds (`EVENT_KINDS`); unknown kinds are rejected. Extending the list is a joint founder decision.
- **Origin restrictions** — the five origins remain distinct; events may only carry `source_observed`/`synthetic_ground_truth`; samples may additionally carry `interpolated`/`extrapolated` *with a mandatory disclosure* (method; plus uncertainty horizon for extrapolation). `hypothesis` exists only for manifest claims.
- **Source-rights policy** — `source_observed` events require `provenance.licenseRef`; `synthetic_ground_truth` events require `provenance.generatorVersion`. Licensed data names its license; synthetic data names its generator.
- **Sample visibility is a strict bijection** — `tracked` ⇔ factual origin without a reconstruction disclosure; `partial` ⇔ reconstructed origin with disclosure. There is **no `untracked` sample**: a coordinate-bearing "untracked" record is a contradiction, so the value is rejected; absent data is the absence of samples.
- **Missing data** — absent samples mean absent data; `MatchState.ball.position` carries an explicit `positioned | unavailable` variant (`unavailable` states a reason: `no_tracking_source`, `frames_absent`, `identity_lost`) so event-only projections never invent coordinates, and an unavailable ball can never claim a possessor.
- **MatchState** — reducer revisions are monotonic integers; ball possession is nullable and must reference a present player; duplicate players and the ball-as-player are rejected; a player's `teamId` must agree with its entity id (`home-08` cannot play for `away`).
- **Coordinates** — pitch meters, center origin, `+z` up, values bounded to ±500 m. The single Three.js transform `(x, y, z) → (x, z, -y)` is implemented and tested in `packages/contracts/src/spatial.ts` (hand-checked against the corner flag and goal mouth).

**Consuming the contracts — both founders use the same code:**

```ts
// Fixture generator / reducer side (packages/match-core):
import { locateEvent } from '@kyneloom/match-core';
const located = locateEvent(rawEnvelope, pitch); // validates + applies pitch geometry

// Renderer side (packages/scene-renderer):
import { parseManifestCameras } from '@kyneloom/scene-renderer';
const { tracks } = parseManifestCameras(manifestJson); // validated + Three-space keyframes
```

## Position tracking sample

```json
{
  "match_id": "synthetic-derby-01",
  "sample_time_ms": 4722100,
  "player_id": "away-04",
  "x_m": 4.35,
  "y_m": -8.2,
  "z_m": 0.0,
  "origin": "synthetic_ground_truth",
  "confidence": 1.0,
  "visibility": "tracked",
  "source_frame_id": "frame-47221"
}
```

**Coordinates:** ground-plane center `(0,0)`, `+x` towards the designated attacking right goal, `+y` towards the upper touchline in canonical 2D, `+z` vertically upward. Explicit pitch dimensions per fixture (e.g., 105 m × 68 m synthetic default). Team directions stored **per half**; never infer from color. Renderer maps world units to meters through one documented transform.

**Sampling:** authoritative timestamps, not frame index assumptions. Render at 60 Hz with interpolation from lower-rate samples. Interpolation is visual reconstruction and **is not source-observed evidence**. Large gaps trigger “no spatial data” handling, not invented teleport paths.

## Implemented reducer (KYN-04)

The authoritative event-time reducer lives in `packages/match-core/src/reducer/`
and runs locally with no cloud dependencies (the future stream adapter wraps
these pure functions).

- **Supersession policy** — an event's identity is `(providerId, eventId)`;
  within an identity the highest `sourceRevision` supersedes lower revisions.
  `correctionOf` referencing the SAME eventId means "revision bump of one
  logical event" (exactly what the simulator's `lateCorrection` emits) and is
  explicitly NOT a circular correction — no distinct revision-specific
  envelope id is required. A cross-id `correctionOf` must reference a known
  event id with a lower revision, otherwise the envelope is quarantined.
- **Order independence** — acceptance is resolved per identity over the whole
  batch with a deterministic canonical-payload tie-break, so duplicate,
  reordered or shuffled delivery produces the identical projection and
  checksum. Exact duplicates collapse (counted, never re-applied);
  conflicting payloads for one (identity, revision) quarantine every sibling.
- **Lateness** — evaluated against each envelope's own `sequence` field (the
  generator's emission order), not array position: non-correction events
  trailing the sequence watermark by more than the window (default 30 s) are
  quarantined as late; corrections are exempt at any delay. UI expectations:
  a late-but-within-window event updates state on arrival; beyond-window
  input lands in quarantine for operator review.
- **Quarantine** — malformed envelopes, cross-match/cross-provider
  contamination, unknown correction targets, invalid revision ordering,
  lateness and conflicting duplicate payloads are all captured with indexed,
  categorized reasons; nothing corrupts state. Conflicting duplicate TRACKING
  samples tombstone the `(sampleTimeMs, entityId)` pair — every payload is
  rejected and no later third sample can resurrect it, so a corrupted frame
  can never become a verified spatial fact. Conflicting duplicate EVENT
  payloads for one (identity, revision) poison that revision entirely (no
  invented winner) until a legitimately higher valid revision resolves it.
- **Invalid corrections never erase facts** — revisions are validated in
  ascending order and only VALID ones are promoted; a rejected higher
  revision quarantines itself while the previously accepted valid revision
  remains authoritative (an unknown-target or forward-pointing "correction"
  cannot rescind an accepted goal or erase a kickoff).
- **History & as-of checkpoints** — every VALID envelope (superseded
  revisions included) stays inspectable via `eventHistory()` in application
  order (base events by event time, then corrections by source revision).
  `revision N` in `matchStateAt(timeMs, revision)` = the state after the
  first N envelopes were applied, so genuinely historical snapshots exist:
  the score before and after a goal rescission are both addressable.
- **API** — `projectMatch({matchId, events, tracking})` →
  `matchStateAt(timeMs, revision?)` (canonical `MatchState`, as-of revision
  checkpoints described above), `timeline.sampleAt(timeMs)` and evidence
  metrics (below). Score is derived ONLY from accepted goal/own-goal events
  (own-goal: `teamId` = benefiting team). The first half derives from an
  accepted kickoff when no explicit first-half `period_start` exists.
- **Possession is source-verified only** — `ball.possessorEntityId` is
  populated exclusively when an accepted event explicitly identifies the
  possessor (kickoff actor, `pass_completed` target, `shot_attempted`
  actor), expires after `possessionValidityMs` (default 10 s) or at the next
  possession-changing event (pass in flight → null, goal → null, period
  boundary → null), and is never inferred from spatial proximity —
  nearest-player estimation is a presentation-layer heuristic that stays
  outside the canonical contract.

## Implemented generator (KYN-03)

The seeded deterministic simulator lives in `packages/match-core/src/simulator/`
(`fixture-engine-v1`), producing contract-valid envelopes and samples for the
golden fixture and, via CLI `pnpm fixture:generate --seed <int>`, any seed:

- **Determinism** — fixed 100 ms ticks, mulberry32 PRNG only, no wall clock;
  same seed + generator version ⇒ byte-identical canonical output (tested).
- **Two-pass ball derivation** — pass 1 records player tracks; pass 2 derives
  the ball from them, so a pass lands exactly where the recorded receiver
  stands and ball/actor agreement at event timestamps is exact.
- **Movement envelope** — role-based speed caps (5.2 GK … 8.6 winger),
  braking-distance arrival, 3.4 m/s² acceleration, pitch bounds + 2 m;
  passes ≈ 7–12 m/s, shots ≤ 30 m/s; no unexplained teleports (tested).
- **Sampling** — 10 Hz inside the golden window, 1 Hz context; frame ids
  `frame-<sampleTimeMs/100>`; every event time sits on the tick grid so each
  event has an exact frame. Missing data stays missing (the full-time event
  deliberately has no frames).
- **Own-goal semantics** — actor = the player who scored into their own net;
  teamId = the benefiting team (documented, no own goal in the golden data).
- **Simplifications** — scripted narrative beats over emergent AI play;
  background possession transitions are movement-coherent but not
  event-logged; not a physics-accurate simulation and never claimed as one.

## Synthetic fixture requirements

- Seeded deterministic fixture + versioned generator.
- Two teams, players with stable IDs, match clock, ball, score and periods.
- Physically plausible max speed/acceleration envelopes and ball movement, but **explicitly synthetic**, not a FIFA-grade physics model claim.
- An event-to-tracking consistency check: passes, shots, possession, goals correspond to coherent ball and player trajectories.
- Ability to inject duplicate events, identity swaps, time skew, missing frames, corrections and stream disconnections with reproducible seeds.
- No commercial Premier League footage or player likeness required for the MVP.

## Match-state projection

Reducer input = canonical source envelopes, keyed by match, with correction chains.

Reducer output includes period/time, teams, score, ball position/possessor (where supported), player positions + statuses, last accepted event, source/reducer revision, and deterministic tactical metrics.

**Deterministic metric examples:** pass count, nearest-defender distance, pass-lane angle, defensive line displacement, time-window separation change. Each metric stores input frame/event IDs and algorithm version.

**Do not implement yet as “verified”:** intended tactical causality, emotional state, player's conscious plan, counterfactual impact, win probability without model calibration.

## Invariants to test

1. Same seed/generator version produces byte-equivalent canonical events after normalization.
2. Same canonical event set and correction order produces the same state revision.
3. Duplicate envelope never increments a match counter twice.
4. Out-of-order arrival produces correct event-time projection after a defined lateness window.
5. Goal and score invariants match all accepted scoring events.
6. All position coordinates and velocities fall within configured simulator allowances.
7. Missing samples are explicitly absent—not filled with unlabeled fabrication.
8. A correction invalidates every derived metric and manifest that depends on the corrected event.

## Open data for format learning

[SkillCorner Open Data](https://github.com/SkillCorner/opendata) provides structured broadcast tracking from 10 2024/25 A-League matches and event data useful for studying sampling, IDs and extrapolation flags. **Do not import, relicense or represent these matches as competition fixtures without reviewing the dataset terms and event constraints.** [Reference list](REFERENCES.md).

**Related:** [Architecture](04-system-architecture.md) · [Manifest](06-moment-manifest.md) · [3D](08-3d-engine.md).