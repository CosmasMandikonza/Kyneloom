# 10 — Security, rights and editorial governance

> **Status:** Required security design, not a claim of current certification or implementation. Formal legal/rights review will be needed before commercial use.

## Assets requiring protection

Licensed positional tracking/events, authored graphics and audio, private studio drafts, published scene manifests, producer identity and approval history, tenant data, API credentials, signed embed tokens and internal model/tool prompts.

**Trust boundaries:** third-party data → ingestion; user → API; agent → tools; tenant A → tenant B; studio → publication; public viewer → private assets; browser → cloud resources.

## Authorization matrix

| Operation | Viewer | Analyst | Producer | Org admin |
|---|---:|---:|---:|---:|
| View authorized published moment | ✓ | ✓ | ✓ | ✓ |
| Change personal perspective / inspect approved evidence | ✓ | ✓ | ✓ | ✓ |
| Save private notes (if licensed) | — | ✓ | ✓ | ✓ |
| Draft or edit organization scene | — | — | ✓ | ✓ |
| Approve / publish / revoke | — | — | Only with explicit publisher grant | By explicit policy |
| Manage rights, roles and destinations | — | — | — | ✓ |

Enforce **tenant ownership and grants server-side on every read and write**. Never grant publisher rights simply because the UI shows Studio.

## Rights-first publication

Every source fixture, footage/asset or tracking feed stores rights identity, usage permissions, territory/destination restrictions where applicable, and time-bound expiry. Every manifest points to a rights policy revision.

A publish request must revalidate:
1. Authenticated user and publisher grant.
2. Tenant/source ownership and all asset permissions.
3. Destination and expiry allowances.
4. Exact validated manifest hash and current source revision.
5. Required editorial and claim review status.
6. Replay-safe idempotency key.

If any check fails: **do not publish**; persist a sanitized audit reason.

**Synthetic hackathon footage:** create fictional teams, jerseys, stadium assets and player IDs. Avoid unlicensed Premier League match footage, marks, likenesses and protected music.

## Threat model

| Threat | Defense and test |
|---|---|
| Cross-tenant ID enumeration | Tenant-filtered queries, row-level security where appropriate, negative integration tests |
| Prompt injection in event/metadata | Treat upstream strings as data; structured allowlisted tools; bounded read-only agent credentials |
| Model emits malicious script/URL | JSON schema enums, no executable fields, trusted asset origin allowlist, CSP |
| Forged approval via client/API | Server-side role check, approval transaction referencing immutable manifest hash |
| Signed URL/content leak | Short token TTL, destination restrictions, revocation and private storage |
| Stale published fact after correction | Dependency map, publish state invalidation, audited revoke/replace |
| Duplicate request/retry | Unique keys + transactional outbox and consumer-side deduplication |
| Replay manipulation | Source version hashes and audit trail for inputs, transforms and releases |
| Secret extraction | Managed identity and Key Vault; never secrets in repo/client logs |
| Resource exhaustion | Rate limits, tenant quotas, max fixture length/overlay count, token budgets |

## AI safety and integrity

Treat source metadata, custom prompts and embedded content as untrusted. An agent cannot approve, publish, access cross-tenant resources, execute SQL or arbitrary code, or bypass factual checks. Tool scopes are predefined and enforce server-side auth. Model responses are untrusted proposals.

Numerical facts use a deterministic verifier. Interpretations remain hypotheses where causality is not proven. Translations must preserve semantics and uncertainty markers; an alternate language must not become more confident than the original claim.

## Privacy and retention

Use synthetic identities for the competition. For eventual real customers, define data-processing roles, source-contract retention, access/deletion workflows, telemetry minimization and regional policies with counsel. Never claim GDPR/SOC 2/ISO certification without audit evidence.

Audit logs should store event/decision IDs, timestamps, principal, tenant, action, manifest/input hashes, outcome, policy version and trace ID. Avoid model prompt dumps containing licensed or confidential material.

## Security exit criteria

- Tenant A cannot read, edit, export or approve tenant B's drafts/releases by any direct API route.
- Viewer tokens cannot be reused to publish.
- Expired/revoked content access fails on manifest and asset endpoints.
- Malicious agent response fails schema and never executes script.
- Late source corrections produce stale-marked/revoked release behavior.
- Agent credentials cannot call a publication endpoint.
- All denials/audits are visible to authorized operators.

**Related:** [Manifest](06-moment-manifest.md) · [Azure platform](09-azure-platform.md) · [Evaluation](11-evaluation-and-reliability.md).