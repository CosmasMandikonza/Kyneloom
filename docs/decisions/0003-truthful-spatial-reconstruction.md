# ADR-0003 — Reconstruction provenance is part of the scene contract

**Status:** Accepted as target design · **Date:** 2026-10-12

## Context

A sparse football event feed cannot reconstruct the exact spatial movement of every player. Even tracking feeds may interpolate, extrapolate or lose identity. Cinematic camera movement can create a misleading impression of certainty.

## Decision

All positions and related visual overlays carry source class and relevant sample/frame references. We maintain distinct classes for observed, synthetic ground truth, interpolated, extrapolated, and hypothesis.

The renderer never represents predicted trajectories as measured data. Missing tracking triggers a labeled fallback. Tactical causality is treated as an explainable hypothesis, not proof derived from correlation.

## Alternatives rejected

- **Fill in realistic motion without disclosure:** compelling visuals but false match evidence.
- **No interpolation at all:** jerky 10 Hz sampling and unusable real-time replay.
- **Make the language model reconstruct positions:** unsupported numerical/geometric claims.

## Consequences

Visual language for uncertainty, interpolation limits and source quality is required in every lens. Scenes must be tested against ground-truth or known synthetic trajectories; free camera cannot change physical match state.

**References:** [Event and tracking contracts](../05-data-and-event-contracts.md) · [3D engine](../08-3d-engine.md) · [Design system](../03-design-system.md).