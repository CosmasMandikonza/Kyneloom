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

**KYN-14 status:** the canonical IaC is now `infra/azure` (main.bicep + six modules) — compilable against pinned Bicep and CI-gated (`Infra CI` workflow), adding Container Apps runtime (the ONE service process runs the Event Hubs worker + Web PubSub fan-out in-process via `apps/web/src/lib/live/azure-runtime.ts`, driving the SAME LiveMatchService — no second reducer), Key Vault with managed-identity least-privilege RBAC, and Log Analytics. The deploy runbook (two-stage, idempotent), cost estimates and teardown live in `infra/azure/README.md`. Deployment remains BLOCKED on this host (no `az`, no subscription, no owner authorization) — no cloud resources are claimed. Round 2 hardened the slice: verified built-in role GUIDs, direct workspace references, PerGB2018 monitoring, real `DefaultAzureCredential` (user-assigned) through the pinned SDK constructor overloads, a durable Blob envelope archive REPLAYED on worker start (restart recovery) with archive-before-checkpoint ordering, a truthful `/api/live/ready` worker-readiness endpoint, and ONE Web PubSub group identity (`match.{id}`) — with browser Web PubSub consumption honestly deferred (cloud-fed SSE is the verified viewer path). The pre-KYN-14 `infra/live-stream.bicep` was removed: it never compiled (containers were parented directly on the storage account), which the pinned compiler proved. PostgreSQL/Foundry/Eventhouse are scoped out with documented boundaries (below and in the runbook).

**Ownership and canonical recovery (KYN-14; local simulation only, Azure unverified):**

The API and worker remain in one Container App. Production startup acquires a renewable 60-second Blob lease on `<matchId>/commit-v1` BEFORE recovery or ingestion. Acquisition contention waits unready; permission/configuration failures fail closed. The existing Storage Blob Data Contributor role covers these operations. There are no new services, credentials, or shared event/frame schemas.

Next.js builds instrumentation and API routes into separate module contexts. `process-state.ts` keeps the ONE service instance, Azure startup guard/task/controller, ownership and readiness in a typed, versioned `globalThis` registry. Every context captures the same mutable object; no route starts another cloud worker. This shares memory only within one Node global, not across processes or worker threads. The packaged `node …/next start` topology is verified locally with actual HTTP requests; changing to clustering, isolated route workers or a different host requires repeating that verification. Blob fencing still protects canonical storage across replicas/revisions.

Run `pnpm build` then `pnpm live:production:test` for the production regression (also run after build in Application CI). A test-only Node preload replaces the existing Azure dependency boundary with controlled I/O, while the built instrumentation initializes the real service, reducer and leased archive. HTTP checks cover readiness, fingerprinted snapshots, SSE, contention-free repeated starts, ownership loss, signal drain and partial/local modes. No test endpoint or deployment environment switch enables this preload. These are local production-bundle tests, not live Azure connectivity evidence.

The version-1 commit record binds the match, hub, namespace, consumer group and checkpoint container. It stores a monotonically increasing ownership generation and an ordered array of batch SHA-256 identities. Generation changes and receipt appends are writes to THIS SAME blob with both the current lease ID and the previously read ETag. Storage therefore rejects a delayed old-generation commit; ETags also reject stale same-generation writes. Any uncertain commit response retires the process's owner: never refresh an ETag and blindly retry a stale proposal.

For each batch: **immutable upload to `<matchId>/batches-v2/<sha256>.json` → lease/ETag-protected commit → existing reducer admission → Event Hubs checkpoint**. Uploads use the real SDK Buffer/byte-length contract, `If-None-Match: *`, and byte verification on an existing object. Receipt order is the commit-array index, independent of upload completion order. Exact canonical-batch retries reuse their entry. Source corrections/changed batches have different hashes and retain their original boundaries. Business validation and deduplication remain the SAME `LiveProjectionWorker`.

Recovery reads ONLY the committed array, in order, and verifies every referenced object's hash. Uploaded but uncommitted objects are orphans: never replayed or automatically garbage-collected; a subsequent valid owner may reuse identical bytes and explicitly commit them on source redelivery. Missing/corrupt referenced data fails recovery closed. Recovery finishes before ingestion begins; readiness additionally requires a successful receive and current local ownership guard.

**Failure windows:**
- Crash after upload, before commit: orphan excluded; uncheckpointed source is redelivered.
- Commit succeeds but response/admission/checkpoint fails: the replacement replays that committed batch; redelivery is duplicate-safe. No exactly-once external side effects are claimed.
- Old upload or commit arrives after takeover: upload can leave an orphan; Storage rejects the old lease/ETag on the commit record. It cannot allocate a canonical receipt.
- Event Hubs checkpoints remain SDK resume hints, NOT the authority. Guards recheck cancellation/ownership before EACH update, after durable commit. A request already issued may complete late or regress the hint; it still points only to source already durably committed in this stream. The replacement always replays the complete committed prefix before using the hint. No transaction across Event Hubs/Storage or physical fencing of checkpoint metadata is claimed. The single-partition ordered source and retention of all uncommitted source remain required.

Renewal runs every 10 seconds, with a conservative local deadline 45 seconds after request start. Renewal failure/deadline detection aborts ingestion, withdraws readiness and invalidates callbacks; HTTP readiness also checks the deadline. There is no instantaneous server-push notification of a lease break. **Canonical safety comes from Storage's conditional commit, not timers.** Shutdown stops accepting work, drains processing/checkpoint callbacks and issued broadcasts while renewal continues, then releases only its own lease. The cloud template sets `NEXT_MANUAL_SIG_HANDLE=1` and the image runs Node directly as PID 1; the worker signal handler exits only after drain/release, avoiding Next's independent early exit. A failed owner is not restarted in-place; a fresh process is required (or an already-waiting contender can take over). If Azure kills a hung process before drain, the finite lease expires; delayed requests still face the storage commit fence.

Broadcasts are non-authoritative delivery. Cloud sessions use `cloud-<generation>-<uuid>` in the EXISTING `sessionId`; SSE checks active ownership and retires old connections. An already-issued Web PubSub message may arrive after loss/shutdown; future Web PubSub consumers must bind to the current authoritative snapshot's session and reject other generations. Browser Web PubSub remains unwired, so no complete Web PubSub viewer fencing is claimed.

**Deployment:** Multiple revision mode enables an explicit downtime-tolerant handoff: deactivate the old revision BEFORE waiting for the replacement's worker readiness. A waiting replacement does not process or claim readiness; after release/expiry it acquires, recovers, then receives. Do not use Single mode's readiness-gated automatic rollout with this ownership design. See the [runbook](../infra/azure/README.md). Multiple mode is manual deployment control, not permission to run multiple authoritative workers.

**Bounded slice / compatibility:** the commit document is capped at 4 MiB and fails closed when full. This is deliberately not a scalable journal service. The pre-fencing v1 reader remains available for offline inspection/tests but refuses fenced history. Legacy history is NOT auto-imported: an existing legacy archive or missing commit record alongside objects requires a reviewed offline migration/restore after stopping all legacy writers. No migration tool or orphan cleanup is claimed. Never roll back to a binary that lists uncommitted objects. Never delete/truncate/restore the commit record independently of the source/checkpoints, or change reducer semantics silently.

Local SDK-pipeline tests exercise contention, renewal, expiry, delayed raw writes and commits, ambiguous acknowledgments, orphan replay exclusion, immutable retries and serialized receipt allocation. Runtime tests use the existing reducer to compare recovery and continuation, withdraw readiness on loss, block stale callbacks/checkpoints and drain shutdown. Deployment overlap is simulated, not a live Container Apps handoff. Quarantine diagnostics can repeat; durable audit/publication exactly-once behavior remains out of scope.

**Contract-true but not deployed:** `apps/web/src/lib/live/azure-adapters.ts` implements the Event Hubs ingestion path (partition key `matchId`, explicit reducer consumer group, checkpoint only after the batch's durable work) and Web PubSub fan-out + **narrow negotiation** (the browser token carries join-leave-group for `match:{id}` only — a viewer can never publish match state), compiled against the official SDKs. The legacy `infra/live-stream.bicep` described the initial topology; `infra/azure` now declares the runtime topology (Event Hubs + dedicated consumer group, Storage for checkpoints/archive/quarantine with no public access, Web PubSub). Activation requires an authorized deployment and the ownership/handoff checks above; until then the local transport serves every contract-level test.

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
