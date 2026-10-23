// KYN-14 — Event Hubs: the streaming input of the live vertical slice.
// Partition key = matchId (ordered per match); an EXPLICIT 'reducer'
// consumer group (never $Default); a least-privilege hub-scoped sender rule
// for the synthetic fixture loader (its key is read by the OPERATOR into
// Key Vault post-deploy — never emitted as a template output).
@description('Region')
param location string = resourceGroup().location

@description('Namespace name (unique per resource group)')
param namespaceName string

@description('Throughput units — minimum viable is 1')
@minValue(1)
@maxValue(1)
param throughputUnits int = 1

@description('Event hub name')
param hubName string = 'kyneloom-live'

@description('Workload identity to grant consume access (Azure Event Hubs Data Receiver, scoped to this namespace)')
param principalId string

resource namespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: namespaceName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
    capacity: throughputUnits
  }
  properties: {
    zoneRedundant: false
  }
}

resource hub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: namespace
  name: hubName
  properties: {
    partitionCount: 1 // one synthetic match; partition key matchId keeps order
    retentionDescription: {
      retentionTimeInHours: 24 // retention is NOT an archive (docs/09 law)
      cleanupPolicy: 'Delete'
    }
  }
}

// The canonical worker consumes through an EXPLICIT consumer group so
// replay/checkpoint positions never collide with any other reader.
resource reducerConsumerGroup 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  parent: hub
  name: 'reducer'
  properties: {}
}

// Least-privilege SENDER for the synthetic fixture loader (Send only).
// The connection string key NEVER appears in outputs/logs/repo — the
// deploy runbook shows the operator command that copies it into Key Vault.
resource fixtureSenderRule 'Microsoft.EventHub/namespaces/eventhubs/authorizationRules@2024-01-01' = {
  parent: hub
  name: 'fixture-sender'
  properties: {
    rights: [
      'Send'
    ]
  }
}

// Data-plane RBAC (scoped to THIS namespace, by role name).
resource eventHubsReceiverRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: 'Azure Event Hubs Data Receiver'
}

resource eventHubsRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: namespace
  name: guid(namespace.name, principalId, 'eventhubs-receiver')
  properties: {
    roleDefinitionId: eventHubsReceiverRole.id
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output namespaceName string = namespace.name
output eventHubName string = hub.name
output reducerConsumerGroupName string = reducerConsumerGroup.name
output fixtureSenderRuleName string = fixtureSenderRule.name
