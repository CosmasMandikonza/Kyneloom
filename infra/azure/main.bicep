// KYN-14 — the minimal, secure, reproducible Azure deployment for
// Kyneloom's live vertical slice.
//
// CHAIN (docs/09, issue #14):
//   synthetic fixture → Event Hubs (partition key = matchId)
//   → canonical worker (IN-PROCESS in the Container App; the SAME
//   LiveProjectionWorker code as the local SSE path — no second reducer)
//   → durable archive / checkpoint / quarantine (Blob)
//   → Web PubSub fan-out (+ the app's own SSE) → verified consumer state.
//
// STATUS (honest, KYN-14): IaC COMPILES (pinned Bicep, CI-gated) but is
// NOT DEPLOYED — this host has no `az`, no subscription, no owner
// authorization for paid resources. infra/azure/README.md is the deploy
// runbook with the exact two-stage order, cost estimates and teardown.
//
// Supersedes infra/live-stream.bicep (which did not compile — containers
// were parented directly on the storage account).
//
// Scoped OUT (documented, not deployed): PostgreSQL (no code path reads
// or writes a DB yet — adding one would be a second source of truth),
// Foundry settings (KYN-15 owns the agent workflow), Fabric Eventhouse
// (optional analytics), App Insights SDK (runtime tracing not wired).

@description('Region (all services verified available in e.g. eastus — confirm quota at preflight)')
param location string = resourceGroup().location

@description('Environment tag (dev|judge) — names and cost guards are per environment')
@allowed(['dev', 'judge'])
param environmentName string = 'dev'

@description('The synthetic match id — Event Hubs partition key')
param matchId string = 'synthetic-derby-01'

@description('Stage 2: deploy the Container App (requires the Key Vault secret from runbook stage 1)')
param deployApp bool = false

@description('Container image (build from apps/web/Dockerfile, push, then reference)')
@minLength(1)
param containerImage string = 'ghcr.io/cosmasmandikonza/kyneloom-web:replace-me'

var uniqueSuffix = uniqueString(resourceGroup().id)
var names = {
  eventHubsNamespace: 'kyneloom-${environmentName}-eh-${uniqueSuffix}'
  storageAccount: toLower(take('kynl${environmentName}${uniqueSuffix}', 24))
  webPubSub: 'kyneloom-${environmentName}-wps-${uniqueSuffix}'
  keyVault: 'kyneloom-${environmentName}-kv-${uniqueSuffix}'
  logAnalytics: 'kyneloom-${environmentName}-logs'
  caEnvironment: 'kyneloom-${environmentName}-env'
  app: 'kyneloom-${environmentName}-live'
  managedIdentity: 'kyneloom-${environmentName}-live-id'
}

// ---------------------------------------------------------------------------
// The workload identity — least privilege, role assignments by NAME
// (resolved at deploy time against the subscription's built-in roles).
// ---------------------------------------------------------------------------
resource liveIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: names.managedIdentity
  location: location
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------
module eventHubs 'modules/event-hubs.bicep' = {
  name: 'live-event-hubs'
  params: {
    location: location
    namespaceName: names.eventHubsNamespace
    hubName: 'kyneloom-live'
    throughputUnits: 1
    principalId: liveIdentity.properties.principalId
  }
}

module storage 'modules/storage.bicep' = {
  name: 'live-storage'
  params: {
    location: location
    storageAccountName: names.storageAccount
    principalId: liveIdentity.properties.principalId
  }
}

module webPubSub 'modules/webpubsub.bicep' = {
  name: 'live-webpubsub'
  params: {
    location: location
    webPubSubName: names.webPubSub
    units: 1
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'live-key-vault'
  params: {
    location: location
    keyVaultName: names.keyVault
    enablePurgeProtection: false // judge/dev teardown must be immediate
    principalId: liveIdentity.properties.principalId
  }
}

module monitor 'modules/monitor.bicep' = {
  name: 'live-monitor'
  params: {
    location: location
    workspaceName: names.logAnalytics
    retentionDays: 30
  }
}

// Stage 2 (runbook): only after the operator stores the Web PubSub secret
// in the vault can the app's keyVaultUrl secret reference resolve.
module liveApp 'modules/container-apps.bicep' = if (deployApp) {
  name: 'live-container-app'
  params: {
    location: location
    caEnvironmentName: names.caEnvironment
    appName: names.app
    containerImage: containerImage
    targetPort: 3000
    logAnalyticsWorkspaceId: monitor.outputs.workspaceId
    logAnalyticsCustomerId: monitor.outputs.workspaceCustomerId
    managedIdentityId: liveIdentity.id
    keyVaultUri: keyVault.outputs.keyVaultUri
    managedIdentityClientId: liveIdentity.properties.clientId
    eventHubsNamespaceName: eventHubs.outputs.namespaceName
    eventHubName: eventHubs.outputs.eventHubName
    consumerGroupName: eventHubs.outputs.reducerConsumerGroupName
    checkpointContainerUrl: storage.outputs.checkpointContainerUrl
    envelopeArchiveContainerUrl: storage.outputs.envelopeArchiveContainerUrl
    webPubSubHubName: 'live'
    matchId: matchId
  }
}

// ---------------------------------------------------------------------------
// Outputs — the EXACT adapter env contract (apps/web/src/lib/live/azure-
// adapters.ts azureConfigFromEnv). NO secret values are ever output.
// ---------------------------------------------------------------------------
output eventHubsNamespaceName string = eventHubs.outputs.namespaceName
output eventHubName string = eventHubs.outputs.eventHubName
output reducerConsumerGroupName string = eventHubs.outputs.reducerConsumerGroupName
output fixtureSenderRuleName string = eventHubs.outputs.fixtureSenderRuleName
output checkpointContainerUrl string = storage.outputs.checkpointContainerUrl
output envelopeArchiveContainerUrl string = storage.outputs.envelopeArchiveContainerUrl
output webPubSubHostName string = webPubSub.outputs.webPubSubHostName
output keyVaultName string = keyVault.outputs.keyVaultName
output keyVaultUri string = keyVault.outputs.keyVaultUri
output managedIdentityName string = liveIdentity.name
#disable-next-line BCP318 // guarded by deployApp — the module exists whenever accessed
output liveAppFqdn string = deployApp ? liveApp.outputs.liveAppFqdn : ''
output deploymentStage string = deployApp ? 'stage-2-app' : 'stage-1-infra'
