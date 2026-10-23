// KYN-13 — minimal reviewable Azure infrastructure for the live stream.
// STATUS: NOT DEPLOYED (no authenticated subscription on this host).
// Deploy (when authorized):
//   az login
//   az deployment group create -g kyneloom-live-rg -f infra/live-stream.bicep \
//     -p location=eastus matchId=synthetic-derby-01
//
// Scope discipline (docs/09): the SMALLEST viable set — one Event Hubs
// namespace + hub, one Storage account (checkpoints + append-only envelope
// archive + quarantine), one Web PubSub instance. No Kubernetes, no
// databases. Managed identity everywhere practical; no public storage.

@description('Region for all resources')
param location string = resourceGroup().location

@description('The synthetic match id — the Event Hubs partition key')
param matchId string = 'synthetic-derby-01'

@description('Throughput units (minimum viable: 1)')
param eventHubsThroughputUnits int = 1

// ---------------------------------------------------------------------------
// Event Hubs — streaming input, partition key = matchId
// ---------------------------------------------------------------------------
resource eventHubsNamespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: 'kyneloom-live-${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
    capacity: eventHubsThroughputUnits
  }
  properties: {
    zoneRedundant: false
  }
}

resource liveHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: eventHubsNamespace
  name: 'kyneloom-live'
  properties: {
    partitionCount: 1 // one synthetic match; partition key matchId keeps order
    retentionDescription: {
      retentionTimeInHours: 24 // retention is NOT an archive (docs/09)
      cleanupPolicy: 'Delete'
    }
  }
}

// Explicit reducer consumer group — never $Default.
resource reducerConsumerGroup 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  parent: liveHub
  name: 'reducer'
  properties: {}
}

// ---------------------------------------------------------------------------
// Storage — checkpoints + the append-only envelope archive + quarantine
// ---------------------------------------------------------------------------
resource archiveStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'kyneloomlive${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false // no public storage access
    minimumTlsVersion: 'TLS1_2'
  }
}

resource checkpointsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: archiveStorage
  name: 'reducer-checkpoints'
}

resource envelopeArchiveContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: archiveStorage
  name: 'envelope-archive' // append-only; Event Hubs retention is NOT this
}

resource quarantineContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: archiveStorage
  name: 'quarantine'
}

// ---------------------------------------------------------------------------
// Web PubSub — connected live clients (public synthetic demo scope)
// ---------------------------------------------------------------------------
resource webPubSub 'Microsoft.SignalRService/webPubSub@2024-03-01' = {
  name: 'kyneloom-live-${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Standard_S1'
    capacity: 1
  }
  properties: {
    tls: {
      clientCertEnabled: false
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs — the exact env vars azure-adapters.ts expects
// ---------------------------------------------------------------------------
output eventHubsNamespaceName string = eventHubsNamespace.name
output eventHubName string = liveHub.name
output reducerConsumerGroupName string = reducerConsumerGroup.name
output checkpointContainerUrl string = `https://${archiveStorage.name}.blob.core.windows.net/${checkpointsContainer.name}`
output webPubSubEndpoint string = webPubSub.properties.hostName
