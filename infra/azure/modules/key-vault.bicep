// KYN-14 — Key Vault (RBAC): the ONLY home for the live slice's two
// secrets (Web PubSub connection string; Event Hubs fixture-sender
// connection string). The vault is deployed EMPTY — secret VALUES are set
// by the operator with the documented runbook commands; nothing secret
// ever appears in this repository, in template outputs, or in logs.
@description('Region')
param location string = resourceGroup().location

@description('Key Vault name')
param keyVaultName string

@description('Workload identity to grant secret-read access (Key Vault Secrets User, scoped to this vault)')
param principalId string

@description('Soft-lock teardown? false in dev/judge so `az group delete` fully removes the vault before the purge-protection window')
param enablePurgeProtection bool = false

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    accessPolicies: [] // RBAC authorization only — no access-policy legacy
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: enablePurgeProtection
    publicNetworkAccess: 'Enabled' // the Container App reaches it over TLS
  }
}

// RBAC (scoped to THIS vault, by role name).
// Verified built-in role definition GUID (Key Vault Secrets User, Microsoft Learn
// built-in-roles reference) — display names are NOT stable identifiers.
var keyVaultSecretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17eb-44cb-8b45-409dd3ee2f9e')

resource keyVaultRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.name, principalId, 'keyvault-secrets-user')
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
