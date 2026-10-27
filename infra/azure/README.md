# infra/azure — minimal secure reproducible Azure deployment (KYN-14)

**STATUS (honest, 2026-10-23): IaC COMPILES (pinned Bicep v0.48.1, CI-gated); NOT DEPLOYED.**
This host has no `az` CLI, no authenticated subscription, and no owner
authorization for paid resources. Everything below marked *blocked* requires
the owner. No cloud traces, connections, or costs are claimed.

## What this deploys (the demonstrable slice — nothing more)

| Resource | Purpose | Code it serves |
|---|---|---|
| Event Hubs namespace + `kyneloom-live` hub + `reducer` consumer group + `fixture-sender` rule (Send-only) | Streaming input; partition key = `matchId`; explicit consumer group | `apps/web/src/lib/live/azure-adapters.ts` → `startEventHubsIngestion` |
| Storage account (`allowBlobPublicAccess: false`) + `envelope-archive` / `reducer-checkpoints` / `quarantine` containers | Durable obligations (retention ≠ archive) | adapter checkpoint store; the same archive/quarantine law as the local path |
| Web PubSub (Standard_S1) | LiveFrame fan-out to viewers | `broadcastViaWebPubSub`, subscribe-only negotiated access |
| Key Vault (RBAC) | The ONLY secret home: `webpubsub-connection-string`, `eventhubs-sender-connection-string` (set by the operator, stage 1) | mounted into the app via managed identity — never in repo/outputs/browser |
| User-assigned managed identity + role assignments (by role name, resource-scoped): Storage Blob Data Contributor, Azure Event Hubs Data Receiver, Key Vault Secrets User | Least-privilege data plane | the in-process worker |
| Container Apps environment + `kyneloom-{env}-live` app (min=max=1 per revision; leased ownership across revisions) with liveness `/api/live/status` and readiness `/api/live/ready` | The ONE service process: Next.js API/SSE + the Event Hubs worker + Web PubSub fan-out in-process | `apps/web/instrumentation.ts` → `src/lib/live/azure-runtime.ts` → the SAME `LiveMatchService` (no second reducer) |
| Log Analytics workspace | Container App system logs + metrics | runbook health/failure inspection |

**Deliberately out of scope (documented, not deployed):** PostgreSQL (no code
path reads/writes a DB — adding one would create a second source of truth),
Foundry settings (KYN-15 owns the agent workflow), Fabric Eventhouse,
App Insights SDK (runtime tracing not wired; CA logs go to Log Analytics).

## Pre-deploy preflight (owner, ~5 min)

```bash
az login                                   # an account with Contributor on the RG scope
az account show --query id -o tsv          # note the subscription
az provider register -n Microsoft.App      # usually registered; verify:
az provider show -n Microsoft.App --query registrationState
# quotas: eastus defaults cover 1×EH TU, 1×WPS unit, consumption Container Apps
```

**No GitHub Actions OIDC is configured.** CI only *compiles* templates;
deployment is a manual owner command. Wiring OIDC (federated credential on
the managed identity + repo secret `AZURE_CLIENT_ID`) is KYN-21-adjacent
work and deliberately not half-built here.

## Stage 0 — build + push the image (owner; registry of your choice)

```bash
docker build -f apps/web/Dockerfile -t <registry>/kyneloom-web:dev .
docker push <registry>/kyneloom-web:dev
```

## Stage 1 — infrastructure (no app yet; the vault is empty)

```bash
az group create -n kyneloom-dev-rg -l eastus
az deployment group create -g kyneloom-dev-rg -f infra/azure/main.bicep \
  -p location=eastus environmentName=dev deployApp=false
# outputs: eventHubsNamespaceName, keyVaultName, fixtureSenderRuleName, …
```

Set the two secrets (values NEVER touch the repo; both commands are local):

```bash
KV=$(az deployment group show -g kyneloom-dev-rg -n main --query properties.outputs.keyVaultName -o tsv)
EH=$(az deployment group show -g kyneloom-dev-rg -n main --query properties.outputs.eventHubsNamespaceName -o tsv)
az webpubsub key list -n <wps-name> -g kyneloom-dev-rg --query connectionString -o tsv \
  | az keyvault secret set --vault-name $KV --name webpubsub-connection-string -f /dev/stdin
az eventhubs namespace authorization-rule keys list -g kyneloom-dev-rg --namespace-name $EH \
  --eventhub-name kyneloom-live --name fixture-sender --query primaryConnectionString -o tsv \
  | az keyvault secret set --vault-name $KV --name eventhubs-sender-connection-string -f /dev/stdin
```

## Stage 2 — the app (initial deployment; updates MUST use the handoff below)

```bash
az deployment group create -g kyneloom-dev-rg -f infra/azure/main.bicep \
  -p location=eastus environmentName=dev deployApp=true \
     containerImage='<registry>/kyneloom-web:dev'
curl -fsS "$(az deployment group show -g kyneloom-dev-rg -n main \
  --query properties.outputs.liveAppFqdn -o tsv)/api/live/status"
```

## Stage 3 — load the synthetic fixture (the documented command)

```bash
export KYN_EVENTHUBS_NAMESPACE=$EH
export KYN_EVENTHUB_NAME=kyneloom-live
export KYN_EVENTHUBS_SENDER_CONNECTION_STRING=$(az keyvault secret show \
  --vault-name $KV --name eventhubs-sender-connection-string --query value -o tsv)
SEND_SPEED=4 pnpm live:fixture:send
```

## Downtime-tolerant revision handoff (owner; deployment/rollback updates)

The Bicep uses **Multiple** revision mode, with one replica per revision and one leased worker per match. This avoids Single mode's circular wait (new worker needs the lease; Azure waits for new readiness before stopping the old lease holder). Keep API and worker together; there is no second Container App.

For an existing app, BEFORE updating its image or waiting on a replacement deployment:

1. Record the current image digest and active revision names for rollback. Ensure the replacement understands `commit-v1`/`batches-v2`; rollback to a pre-fencing writer is unsafe.
2. For a previously Single-mode app, set `az containerapp revision set-mode -n <app> -g <rg> --mode multiple` (application configuration change).
3. List active revisions: `az containerapp revision list -n <app> -g <rg> --query "[?properties.active].name" -o tsv`. Deactivate EACH old revision with `az containerapp revision deactivate --revision <revision> -g <rg>`. Confirm no old replicas remain (revision/replica list + system logs). Do not wait for replacement worker readiness before doing this.
4. Deploy the new image with the Stage 2 command. Alternatively, if a replacement is already waiting unready for the lease, let it continue after step 3. Shutdown attempts drain then lease release; an abruptly killed owner requires lease expiry. No fixed downtime bound is promised.
5. Verify replacement `ownershipGeneration` increased, archive replay completed and `/api/live/ready` becomes 200 only after a successful receive. Verify SSE reconnects to a new `cloud-<generation>-<uuid>` session and the authoritative fingerprint matches expected source. Keep all older revisions inactive; traffic targets the latest READY revision.
6. Rollback repeats this entire handoff using the prior **fence-aware** image. Never reactivate a legacy writer against fenced history. If startup fails, remain down and diagnose; never break an active lease to force readiness.

These are documented commands and local handoff simulations, NOT executed Azure evidence. Authorized deployment must verify deactivation, lease expiry/release, traffic routing, SIGTERM/drain, restart and rollback on the actual platform. The lease prevents an accidentally overlapping replica from committing canonical work; manual control avoids readiness deadlock.

The cloud template sets `NEXT_MANUAL_SIG_HANDLE=1`; the Docker command runs Node directly as PID 1. The runtime handles SIGTERM/SIGINT, drains the worker and issued sends, releases ownership, then exits. Next's default signal cleanup is disabled because it can exit before the worker drain. A forced platform kill may interrupt drain; the commit fence and finite lease remain the safety boundary. Failed owners do not restart in-place: restart/deactivate the revision to create a fresh process.

No new secret or Azure resource is needed. Ownership renewal adds Blob transactions. `commit-v1` is a bounded (4 MiB) private commit document; immutable `batches-v2` objects remain the source archive. Orphan uploads are ignored, not deleted. Existing legacy history requires a separately reviewed offline import; there is no automatic adoption or migration tool. See [the failure windows and checkpoint/broadcast limits](../../docs/09-azure-platform.md).

## Health, verification, rollback

- Liveness: `curl <fqdn>/api/live/status`; worker readiness: `/api/live/ready`. Lease contention/failure/recovery never counts as worker readiness.
- Verified consumer state: `/api/live/snapshot` returns the fingerprinted
  canonical snapshot; the viewer at `/explore` toggles Live mode.
- Security checks: anonymous/wrong-token `POST /api/live/control` → **403**;
  storage containers are private (`az storage container list --show-next-object-hierarchy`
  without credentials fails); the vault is RBAC-only.
- Worker restart: `az containerapp revision restart` — on boot the runtime
  REPLAYS the durable envelope archive (Blob) into a fresh session before
  consuming, so the authoritative corpus is reconstructed even for source
  the Event Hubs checkpoints already consumed; envelope-id dedupe makes any
  redelivery idempotent for authoritative state. Original batch boundaries and
  receipt order are preserved. Local failure-injection tests verify state recovery,
  not exactly-once external publication or live Azure restart safety. Follow the
  [recovery invariant and ownership assumptions](../../docs/09-azure-platform.md)
  before attempting this check; stop/quiesce the old writer before replacement.
  The fenced commit record protects canonical recovery during overlap; SDK checkpoints and best-effort broadcasts are not globally exactly-once.
- **Authorized deployment smoke test (post stage 3):**
  1. `curl <fqdn>/api/live/ready` → 503 before ingestion, `mode:"cloud-fed"`
     + 200 only after ownership, committed recovery and a successful receive.
  2. `curl <fqdn>/api/live/status` → `azureRuntime.replayedEnvelopes` and
     `archivedBatches` grow as the fixture streams.
  3. Open `<fqdn>/explore` → toggle **Live Synthetic Stream** → connected
     with 22 streamed players (the verified SSE judge path).
  4. Anonymous/wrong-token `POST /api/live/control` → 403.
  5. `az containerapp revision restart` → replay + recovery without
     duplicate goals.
- Rollback: follow the downtime-tolerant handoff above with a fence-aware image; never reactivate old revisions concurrently as an ownership workaround.
- **Teardown (everything, immediately):**
  `az group delete -n kyneloom-dev-rg --yes --no-wait`

## The judge path (one real transport, honestly labeled)

**Cloud-fed SSE is the verified viewer path**: browsers consume the SAME
SSE/snapshot/resync protocol used locally, fed by the Event Hubs worker
through the one LiveMatchService. **Direct browser Web PubSub consumption
is DEFERRED and unverified**: the server-side broadcast adapter and the
narrow join-only negotiation exist and are unit-tested, but no browser
Web PubSub route is wired into the app — a server-side `sendToAll` is NOT
evidence a viewer received anything, so none is claimed. The provisioned
Web PubSub instance serves the (tested) server fan-out capability.

## Cost (LIST-PRICE ESTIMATES — not measured; verify against your billing)

| Resource | Config | Rough list price | ~Month | ~48h judge window |
|---|---|---|---|---|
| Event Hubs | Standard, 1 TU | ~$0.03/hr | ~$22 | ~$1.50 |
| Web PubSub | Standard_S1 ×1 | ~$1.6/unit-day | ~$47 | ~$3 |
| Storage | LRS, GBs | ~$0.02/GB + tx | <$1 | <$0.10 |
| Container Apps | consumption, 0.75 vCPU/1.5 GiB always-on | ~$0.000024/vCPU-s | ~$56 | ~$4 |
| Key Vault | standard ops | ~$0.03/10k ops | <$1 | <$0.10 |
| Log Analytics | **PerGB2018** pay-as-you-go | first 5 GB/mo free, then ~$2.3/GB | ~$0 (demo volume) | ~$0 |
| **Total** | | | **≈ $125/mo** | **≈ $9** |

Destroy with the teardown command immediately after judging to pay only the
window. These are public list prices as of 2026-10 assembled for planning —
**not measured billing**; the first invoice is the real number.

## Cloud-status matrix (KYN-14 deliverable)

| Item | Status |
|---|---|
| IaC code (`infra/azure`, 7 templates) | ✅ implemented — role GUIDs verified, workspace references direct, PerGB2018 |
| Bicep compilation (pinned v0.48.1, CI-gated) | ✅ validated + **compiled-ARM semantic assertions** (`pnpm infra:validate`, in Infra CI) |
| Real AAD auth in adapters (DefaultAzureCredential, user-assigned; FQDN; credentialed Blob) | ✅ implemented; **constructor boundary verified locally against the pinned SDKs** (real client instances, FQDN/hub getters) |
| Runtime seam (replay → external session → durable-before-checkpoint ingestion) | ✅ implemented; unit-tested incl. failure injection (archive failure, startup failure, duplicate starts) |
| Fixture sender command | ✅ implemented, type-checked (not executed — no hub) |
| Browser viewer path | ✅ cloud-fed SSE (the judge path); browser Web PubSub **deferred/unverified** |
| Container image | ⛔ not built (no registry auth on this host) — Dockerfile authored |
| Cloud resources provisioned | ⛔ blocked: no `az`, no subscription, no owner authorization |
| Runtime integration exercised | ⛔ blocked by the above (all local tests use fakes/real-clients-unconnected) |
| Deployment evidence | ⛔ none — and none claimed |
| Superseded `infra/live-stream.bicep` | 🗑 removed — it never compiled (containers parented on the storage account) |
