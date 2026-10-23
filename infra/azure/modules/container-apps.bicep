// KYN-14 — Container Apps: the runtime for the ONE service process of the
// live slice. The Next.js app serves the public API/SSE AND — when the
// Azure env contract is present — runs the Event Hubs ingestion worker
// IN-PROCESS (apps/web/src/lib/live/azure-runtime.ts), which drives the
// SAME canonical LiveProjectionWorker used locally. One authoritative
// projection per generation: minReplicas=maxReplicas=1 deliberately.
//
// The app's Web PubSub connection string is mounted from Key Vault via the
// user-assigned managed identity (secretRef keyVaultUrl + identity) — no
// secret in the repo, in outputs, or in the browser. Deploying this module
// requires the vault secret to EXIST (runbook stage 2), which is why
// main.bicep gates it behind the `deployApp` parameter.
@description('Region')
param location string = resourceGroup().location

@description('Container Apps environment name')
param caEnvironmentName string

@description('App name')
param appName string

@description('Container image to run (built from apps/web/Dockerfile; push first, then reference it here)')
@minLength(1)
param containerImage string

@description('Target port of the Next.js server')
param targetPort int = 3000

@description('Log Analytics workspace resource id (system logs stream to it; the shared key is read at DEPLOY time and never output)')
param logAnalyticsWorkspaceId string

@description('User-assigned managed identity resource id (gets vault + data-plane roles)')
param managedIdentityId string

@description('Key Vault URI (secret: webpubsub-connection-string)')
param keyVaultUri string

@description('Adapter env contract (see apps/web/src/lib/live/azure-adapters.ts)')
param eventHubsNamespaceName string
param eventHubName string
param consumerGroupName string
param checkpointContainerUrl string
param webPubSubHubName string
param matchId string

resource caEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: caEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: reference(split(logAnalyticsWorkspaceId, '/providers/')[0], '2023-09-01').customerId
        sharedKey: listKeys(logAnalyticsWorkspaceId, '2023-09-01').primarySharedKey
      }
    }
  }
}

resource liveApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    environmentId: caEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single' // predictable rollback semantics
      secrets: [
        {
          name: 'webpubsub-connection-string'
          keyVaultUrl: '${keyVaultUri}secrets/webpubsub-connection-string'
          identity: managedIdentityId
        }
      ]
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'http'
        traffic: [
          {
            weight: 100
            latestRevision: true
          }
        ]
      }
    }
    template: {
      // ONE authoritative live projection per stream generation — the
      // Event Hubs consumer is a singleton by design (session semantics).
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      containers: [
        {
          name: 'web'
          image: containerImage
          resources: {
            cpu: json('0.75')
            memory: '1.5Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'KYN_EVENTHUBS_NAMESPACE', value: eventHubsNamespaceName }
            { name: 'KYN_EVENTHUB_NAME', value: eventHubName }
            { name: 'KYN_EVENTHUBS_CONSUMER_GROUP', value: consumerGroupName }
            { name: 'KYN_CHECKPOINT_CONTAINER_URL', value: checkpointContainerUrl }
            { name: 'KYN_WEBPUBSUB_HUB', value: webPubSubHubName }
            { name: 'KYN_WEBPUBSUB_CONNECTION_STRING', secretRef: 'webpubsub-connection-string' }
            { name: 'KYN_LIVE_MATCH_ID', value: matchId }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/live/status'
                port: targetPort
              }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/live/status'
                port: targetPort
              }
              periodSeconds: 10
              failureThreshold: 2
            }
          ]
        }
      ]
    }
  }
}

output liveAppName string = liveApp.name
output liveAppFqdn string = 'https://${liveApp.properties.configuration.ingress.fqdn}'
