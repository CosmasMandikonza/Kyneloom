// KYN-14 — Storage: durable obligations of the live slice. The append-only
// envelope archive (Event Hubs retention is NOT an archive), the reducer
// checkpoint store, and the quarantine store. No public access, ever.
// NOTE (KYN-14 compile fix): containers live under the implicit 'default'
// blobServices parent — the pre-KYN-14 template parented them directly on
// the storage account and DID NOT COMPILE.
@description('Region')
param location string = resourceGroup().location

@description('Storage account name (lowercase, <= 24 chars)')
param storageAccountName string

@description('Workload identity to grant archive/checkpoint/quarantine write access (Storage Blob Data Contributor, scoped to this account)')
param principalId string

resource archiveStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS' // cheapest durable option for the demo slice
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false // no public storage access
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: archiveStorage
  name: 'default'
}

resource checkpointsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'reducer-checkpoints'
  properties: {
    publicAccess: 'None'
  }
}

resource envelopeArchiveContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'envelope-archive' // append-only durable source record
  properties: {
    publicAccess: 'None'
  }
}

resource quarantineContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'quarantine' // poison envelopes with trace ids, no payloads in logs
  properties: {
    publicAccess: 'None'
  }
}

// Data-plane RBAC (scoped to THIS account, by role name resolved at deploy
// time). guid() over the account name + principal keeps redeploys
// idempotent.
resource blobDataContributorRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: 'Storage Blob Data Contributor'
}

resource storageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: archiveStorage
  name: guid(archiveStorage.name, principalId, 'blob-data-contributor')
  properties: {
    roleDefinitionId: blobDataContributorRole.id
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = archiveStorage.name
#disable-next-line no-hardcoded-env-urls // single public-cloud target; see runbook
output checkpointContainerUrl string = 'https://${archiveStorage.name}.blob.core.windows.net/${checkpointsContainer.name}'
output envelopeArchiveContainerName string = envelopeArchiveContainer.name
output quarantineContainerName string = quarantineContainer.name
