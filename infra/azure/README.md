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
| Container Apps environment + `kyneloom-{env}-live` app (min=max=1 replicas: ONE authoritative projection per generation) with liveness/readiness probes on `/api/live/status` | The ONE service process: Next.js API/SSE + the Event Hubs worker + Web PubSub fan-out in-process | `apps/web/instrumentation.ts` → `src/lib/live/azure-runtime.ts` → the SAME `LiveMatchService` (no second reducer) |
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

## Stage 2 — the app (idempotent: stage 1 reruns as a no-op, then the app lands)

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

## Health, verification, rollback

- Health: `curl <fqdn>/api/live/status` (liveness+readiness probes use it too).
- Verified consumer state: `/api/live/snapshot` returns the fingerprinted
  canonical snapshot; the viewer at `/explore` toggles Live mode.
- Security checks: anonymous/wrong-token `POST /api/live/control` → **403**;
  storage containers are private (`az storage container list --show-next-object-hierarchy`
  without credentials fails); the vault is RBAC-only.
- Worker restart: `az containerapp revision restart` — Event Hubs redelivers
  from the last checkpoint; the worker's envelope-id dedupe makes
  redelivery idempotent (no duplicate externally visible publication —
  the KYN-13 round-1/2 regressions prove the law).
- Rollback: `az deployment group create … -p …` with the previous
  `containerImage` (activeRevisionsMode Single makes revisions explicit);
  or `az containerapp revision list` → reactivate the previous revision.
- **Teardown (everything, immediately):**
  `az group delete -n kyneloom-dev-rg --yes --no-wait`

## Cost (LIST-PRICE ESTIMATES — not measured; verify against your billing)

| Resource | Config | Rough list price | ~Month | ~48h judge window |
|---|---|---|---|---|
| Event Hubs | Standard, 1 TU | ~$0.03/hr | ~$22 | ~$1.50 |
| Web PubSub | Standard_S1 ×1 | ~$1.6/unit-day | ~$47 | ~$3 |
| Storage | LRS, GBs | ~$0.02/GB + tx | <$1 | <$0.10 |
| Container Apps | consumption, 0.75 vCPU/1.5 GiB always-on | ~$0.000024/vCPU-s | ~$56 | ~$4 |
| Key Vault | standard ops | ~$0.03/10k ops | <$1 | <$0.10 |
| Log Analytics | 5 GB/mo free tier | first 5 GB free | ~$0 | ~$0 |
| **Total** | | | **≈ $125/mo** | **≈ $9** |

Destroy with the teardown command immediately after judging to pay only the
window. These are public list prices as of 2026-10 assembled for planning —
**not measured billing**; the first invoice is the real number.

## Cloud-status matrix (KYN-14 deliverable)

| Item | Status |
|---|---|
| IaC code (`infra/azure`, 7 templates) | ✅ implemented |
| Bicep compilation (pinned v0.48.1, CI-gated) | ✅ validated (local + `Infra CI` workflow) |
| Runtime seam (instrumentation → azure-runtime → same LiveMatchService) | ✅ implemented, unit-tested (env gating, wiring) |
| Fixture sender command | ✅ implemented, type-checked (not executed — no hub) |
| Container image | ⛔ not built (no registry auth on this host) — Dockerfile authored |
| Cloud resources provisioned | ⛔ blocked: no `az`, no subscription, no owner authorization |
| Runtime integration exercised | ⛔ blocked by the above |
| Deployment evidence | ⛔ none — and none claimed |
| Superseded `infra/live-stream.bicep` | 🗑 removed — it never compiled (containers parented on the storage account) |
