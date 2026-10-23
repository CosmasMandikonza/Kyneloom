# 09 — Azure-native platform and operations

> **Status:** Target deployment topology and operational requirements. No Azure infrastructure is currently declared running. The live-match streaming path (KYN-13) is **implemented locally end to end** with contract-true Azure adapters and reviewable Bicep — see [Live streaming implementation status (KYN-13)](#live-streaming-implementation-status-kyn-13).

## Service choices and their jobs

| Component | Proposed Azure service | Why / operational concern |
|---|---|---|
| Append streaming input | Event Hubs | Partition by match for ordered arrival, independent consumer groups |
| Ingestion + match reducer | Container Apps workers | Autoscaling and controlled runtime dependencies; checkpoint offsets |
| Model, agents and evaluation | Microsoft Foundry + Microsoft Agent Framework | Managed model access, tracing, orchestration, evaluation |
| Durable jobs / reviews | Durable Extension / Durable Task-backed workflows (Azure Functions or compatible worker) | Persist completion, recover, pause for human approval |
| Match revisions, tenants, releases | Azure Database for PostgreSQL | Transactions, uniqueness, joins, RBAC mapping and audit/outbox |
| Source archive and compiled assets | Blob Storage | Immutable and content-addressed artifacts; lifecycle policies |
| Connected live clients | Web PubSub | Authenticated fan-out and reconnect handling |
| Secret storage | Key Vault + managed identity | No secrets in code, public repo or browser |
| API/app telemetry | Application Insights / Azure Monitor via OpenTelemetry | Correlation, p95, error rates, cost observability |
| Historical analytics, optional | Fabric Eventhouse | Large historical queries and evaluation analysis off fast path |
| IaC and delivery | Bicep + GitHub Actions | Reproducible environments and reviewable change history |

Avoid premature Kubernetes and multiple database technologies for appearance. Choose the smallest viable service set demonstrating the real system.

## Environments

**Local:** seeded source, containerized reducer/PostgreSQL where feasible, mock identity, offline deterministic renderer and mocked agent responses labeled as mocks.

**Dev:** minimal Azure environment with real auth and Foundry integration; synthetic fixtures only; limited quotas.

**Judge/test:** reproducible scripted fixture, preloaded rights to fictional content, stable reviewer access with no privileged credentials exposed.

**Production (future):** separate tenant isolation and observability, RBAC/MFA for privileged roles, managed key rotation, backup and disaster recovery policy.

## Event Hubs policy

- Use `matchId` partition key and explicit consumer groups for reducer, archive and analytics as needed.
- Persist raw events separately; Event Hubs retention does not replace durable source records.
- Poison-message policy: validation errors sent to a dead-letter/quarantine store with correlation IDs and PII-safe error text.
- Checkpoint processed offsets after durable state/outbox work, honoring at-least-once replay.
- Size partitions and throughput from measured fixture rates; avoid pretend million-event throughput claims.

## Data and publication consistency

PostgreSQL is the transactional source of truth for tenant permissions, approval decisions and release pointers. Content addressed, immutable manifest/assets live in blob. On publish: check tenant + rights + validated hash + expected revision; transact approval and outbox; async notifier distributes the release event idempotently. Browser validates entitlement for asset access.

## Security topology

Use least-privilege managed identities, no public DB, TLS, controlled CORS origins and narrow SAS/content access. Separate agent tool credentials from publication credentials. Use scoped signed access only where necessary; never embed storage keys or model endpoints with keys in front-end code.

See [Security and rights](10-security-and-rights.md).

## Health and operations

**Core signals:**
- stream ingress, consumer lag and rejected envelope rate
- reducer p95 per-event work and checkpoint age
- Web PubSub connected clients/fan-out failures
- Foundry model/tool latency, retries, trace and cost/valid manifest
- compile latency and manifest invalidation rate
- authorization denials / publish approvals / revocations
- client first-interactive-frame, frame-time p95 and fallback usage

Every log/trace should include `tenantId`, `matchId`, `momentId`, `workflowId` as applicable, excluding sensitive payloads. Avoid excessive per-frame tracing.

## Deployment and recovery requirements

- CI validates schemas, deterministic fixtures, rights tests and static checks before build.
- IaC validated in PR; changes are reviewed, environment variables documented without secrets.
- Migration strategy includes backward-read compatibility for supported manifests.
- Backup restore must be tested; specify RPO/RTO after observing cost and usage rather than inventing SLAs.
- A failed worker restart must not duplicate a release.
- A revoked release must not remain accessible through direct assets/manifest URLs.

## Live streaming implementation status (KYN-13)

What exists is a genuine streaming vertical slice, honestly labeled — **no Azure resources are provisioned** (no `az` CLI on this host and no deployment authorization), and every number below was measured on the local transport, never claimed as cloud latency.

**Implemented and running (local):**

- A real async producer replays the committed `synthetic-derby-01` fixture in source-time order (1×/2×/4×), with seeded, deterministic chaos: duplicate envelopes, reordering, dropped tracking frames, and disconnect windows — envelope ids and trace ids stay reproducible.
- One canonical incremental projection (`LiveProjectionWorker`) reuses the reducer's exact semantics (identity, revision chains, conflict tombstones); tracking-only corrections advance a content-fingerprint state version because `revisionCount` provably does not move for them.
- Delivery over SSE with per-subscriber bounded queues: superseded **presentation** deltas are compacted, **authoritative** frames are never dropped; overflow degrades to snapshot resync rather than data loss.
- Durable order on ingest: append-only envelope archive → projection → quarantine file (malformed/mismatched envelopes with trace ids) → checkpoint, all before the checkpoint advances. Archive is a separate store from any transport retention.
- Snapshot + delta resync protocol: the client verifies the base version and sequence contiguity of every delta and **re-snapshots on any gap — it never guesses**; the applied corpus is fingerprint-verified with rollback on mismatch.
- The viewer shows Recorded Replay vs Live Synthetic Stream with truthful status (Connecting / Connected / Reconnecting / Degraded / Resynchronizing / Disconnected); the green LIVE state requires the defined health rule, not optimism.
- Operator interruption is genuine: `/api/live/control` stops the real producer; the SSE loop closes with a truthful `disconnected` frame; the client reconnects and resyncs from a fresh snapshot with no duplicate goals or phantom movement.

**Contract-true but not deployed:** `apps/web/src/lib/live/azure-adapters.ts` implements the Event Hubs ingestion path (partition key `matchId`, explicit reducer consumer group, checkpoint only after the batch's durable work) and Web PubSub fan-out + **narrow negotiation** (the browser token carries join-leave-group for `match:{id}` only — a viewer can never publish match state), compiled against the official SDKs. `infra/live-stream.bicep` declares the smallest honest topology (Event Hubs + dedicated consumer group, Storage for checkpoints/archive/quarantine with no public access, Web PubSub). Activating it requires only environment variables plus an authorized deployment; until then the local transport serves every contract-level test.

**Correctness laws enforced at the wire (review round):**
- The state version fingerprints the **fully normalized accepted fields** — events including team/actor/attributes/provenance, tracking including confidence/visibility/origin/source-frame/reconstruction disclosures — so materially different corpora can never share a version; identical sets in any arrival order always do.
- Snapshot issuance is **read-only with respect to the broadcast sequence**: snapshots carry the current seq; only authoritative publishes advance it. A viewer joining, an HTTP snapshot read, or a resync can never push another viewer into a false gap.
- Corrections and conflict tombstones travel with **reducer-mirroring semantics** (replacement by identity + explicit removals), so client corpora converge byte-equal to the server's accepted set without spurious resyncs — proven end-to-end with two simultaneous viewers.
- **Operator control is fail-closed**: the producer stop/start route is disabled unless `KYNELOOM_LIVE_CONTROL_TOKEN` is provisioned in the server environment, requires the token header (constant-time compare, no cookies → no CSRF surface), and denies anonymous/wrong-token requests with 403 while the public stream keeps running. Never deploy the route without the token.

**Latency honesty:** ingest-to-publish latency is measured with real trace ids on the local path (see `/api/live/status` and `qa/perf-live.txt`). No p50/p95 is quoted for Azure services that were not running.

## Cloud-native judging proof, not slideware

Use actual deployment outputs, reproducible Bicep, trace IDs, run logs, failure injection and before/after metrics. For a two-person team, demonstrate one coherent integration chain rather than a dozen provisioned unused Azure services.

**Sources:** [Event Hubs features](https://learn.microsoft.com/en-us/azure/event-hubs/event-hubs-features) · [Agent Framework Durable Extension](https://learn.microsoft.com/en-us/agent-framework/integrations/durable-extension) · [Azure Web PubSub](https://learn.microsoft.com/en-us/azure/azure-web-pubsub/overview).

**Related:** [Architecture](04-system-architecture.md) · [Evaluation](11-evaluation-and-reliability.md).