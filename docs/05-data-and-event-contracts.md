# 05 — Synthetic data, event contracts and match-state truth

> **Status:** Canonical contract proposal; no event producer or schema code exists yet.

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