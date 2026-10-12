# ADR-0002 — AI generates a typed manifest, never executable scene code

**Status:** Accepted as target design · **Date:** 2026-10-12

## Context

Freeform model-authored HTML/JavaScript, uncontrolled Three.js snippets, or video-only outputs are hard to validate, edit, reproduce and publish safely. The same moment must render for multiple audiences and professional producers.

## Decision

Agents generate **bounded, versioned scene composition proposals**. A deterministic `MomentManifest` compiler resolves references and validates types, timeline bounds, evidence, assets, permissions and visual feasibility. Clients render only known enumerated operations.

Approved releases reference immutable content hashes and source revisions.

## Alternatives rejected

- **Model writes and runs Three.js scripts:** arbitrary code risk, no portable contract.
- **Generate video file only:** loses camera control, transparency and interactive reuse.
- **Each client defines its own scene schema:** inconsistent presentation and auditability.

## Consequences

Adds schema design and compiler work up front; delivers stable interface for viewer, Studio, AI and embeddable SDK. Requires manifest migrations/version-support policy as features evolve.

## Proof obligations

Unknown field rejection, malicious URL/script rejection, source reference validation, deterministic compile, lens-invariance checks and immutable approval behavior.

**References:** [Manifest](../06-moment-manifest.md) · [Security](../10-security-and-rights.md).