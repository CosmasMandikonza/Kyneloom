// KYN-14 — Web PubSub: fan-out of LiveFrames to connected viewers (the
// cloud twin of the local SSE delivery; the SAME wire contract). Browsers
// receive only narrowly negotiated join-leave-group access tokens — never
// the service connection string (it lives in Key Vault; the operator
// copies it in with the documented runbook command, never via outputs).
@description('Region')
param location string = resourceGroup().location

@description('Web PubSub instance name')
param webPubSubName string

@description('Unit count — minimum viable is 1')
@minValue(1)
@maxValue(1)
param units int = 1

resource webPubSub 'Microsoft.SignalRService/webPubSub@2024-03-01' = {
  name: webPubSubName
  location: location
  sku: {
    name: 'Standard_S1'
    capacity: units
  }
  properties: {
    tls: {
      clientCertEnabled: false
    }
  }
}

output webPubSubName string = webPubSub.name
output webPubSubHostName string = webPubSub.properties.hostName
