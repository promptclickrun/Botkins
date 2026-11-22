// Botkins on an Azure VM, with its own relay. One deployment makes a VM that runs, as systemd
// services and without Docker: Botkins from its signed release, the self-hosted relay, and Caddy
// for HTTPS on the VM's Azure DNS name. The deployment's output is a pairing link to open on a phone.
//
// With screenAccess the VM also runs a virtual display with Google Chrome. A paired phone can see
// and control it, for example to finish a sign-in page that a bot opened.
//
// Build azuredeploy.json from this file with: az bicep build -f main.bicep --outfile azuredeploy.json

@description('Where the VM runs.')
param location string = resourceGroup().location

@description('The VM name. Also the start of its DNS name unless dnsLabel is set.')
@minLength(1)
@maxLength(40)
param vmName string = 'botkins'

@description('Screen access. On: the server also gets a virtual display with Google Chrome, and a paired phone can see and control it. Off: bots, chats and tools work the same, and there is no screen to see.')
param screenAccess bool = false

@description('The VM size. 2 vCPUs and 4 GB is enough, with or without Screen access.')
@allowed([
  'Standard_D2als_v6'
  'Standard_D2ls_v6'
  'Standard_D2als_v7'
  'Standard_D2ls_v7'
  'Standard_D2as_v6'
  'Standard_D2s_v6'
  'Standard_D2as_v7'
  'Standard_D2s_v7'
  'Standard_D4as_v6'
  'Standard_D4s_v6'
])
param vmSize string = 'Standard_D2als_v6'

@description('The name your phone shows for this server.')
@maxLength(60)
param serverName string = 'Botkins on Azure'

@description('Optional. An email address for the HTTPS certificate. It only receives certificate notices, and lets the server fall back to ZeroSSL if Let\'s Encrypt is busy.')
param certificateEmail string = ''

@description('The DNS label: the server becomes <label>.<region>.cloudapp.azure.com. Leave empty for a generated one.')
@maxLength(50)
param dnsLabel string = ''

@description('The VM administrator account. Not `botkins`: that is the name of the account the Botkins service runs as.')
param adminUsername string = 'azureuser'

@description('Optional. Your SSH public key (ssh-ed25519 or ssh-rsa), if you want SSH. Without one, manage the server with Azure Run Command. Password sign-in is always off.')
param sshPublicKey string = ''

@description('An IP address or CIDR range allowed to reach SSH. Leave empty to keep SSH closed (use Azure Run Command instead).')
param sshAllowedFrom string = ''

@description('Leave this as it is. Azure needs a password for a VM without an SSH key. This one is random, nobody is given it, and the setup turns password sign-in off.')
@secure()
param generatedPassword string = 'Bk-${newGuid()}'

@description('Optional. A Claude Code token from `claude setup-token`, so Claude works without signing in on the server.')
@secure()
param claudeCodeToken string = ''

@description('Optional. A GitHub token with Copilot access, so GitHub Copilot works without signing in on the server.')
@secure()
param githubCopilotToken string = ''

@description('Forward notifications for the Botkins iPhone app through relay.botkins.app. Notifications are sealed for your phone; the Botkins relay only passes them to Apple. Off: no notifications, and nothing leaves your server for Botkins\' infrastructure.')
param pushNotifications bool = true

@description('The Botkins sources to install.')
param repositoryUrl string = 'https://github.com/promptclickrun/Botkins'

@description('The branch or tag to install.')
param repositoryRef string = 'main'

@description('Change this to run the setup again on an existing deployment (for example to get a new pairing link).')
param setupRun string = utcNow()

var label = empty(dnsLabel) ? toLower('${take(replace(vmName, '_', '-'), 30)}-${uniqueString(resourceGroup().id, vmName)}') : toLower(dnsLabel)
var fqdn = '${label}.${location}.cloudapp.azure.com'
var b64 = {
  fqdn: base64(fqdn)
  email: base64(certificateEmail)
  name: base64(serverName)
  repo: base64(repositoryUrl)
  ref: base64(repositoryRef)
  claude: base64(claudeCodeToken)
  github: base64(githubCopilotToken)
  push: base64(pushNotifications ? 'https://relay.botkins.app' : 'off')
  screen: base64(screenAccess ? 'true' : 'false')
}
var setupCommand = 'echo ${base64(loadTextContent('install.sh'))} | base64 -d > /root/botkins-install.sh && BK_FQDN=${b64.fqdn} BK_EMAIL=${b64.email} BK_NAME=${b64.name} BK_REPO=${b64.repo} BK_REF=${b64.ref} BK_CLAUDE_TOKEN=${b64.claude} BK_GITHUB_TOKEN=${b64.github} BK_PUSH=${b64.push} BK_SCREEN=${b64.screen} bash /root/botkins-install.sh'

var webRules = [
  {
    name: 'https'
    properties: {
      priority: 100
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: 'Internet'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '443'
    }
  }
  {
    // Needed by the certificate authority's HTTP check; Caddy answers everything else with a redirect.
    name: 'http-certificate-check'
    properties: {
      priority: 110
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: 'Internet'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '80'
    }
  }
]
// SSH opens only for a key, and only from the address given.
var sshRule = empty(sshAllowedFrom) || empty(sshPublicKey) ? [] : [
  {
    name: 'ssh'
    properties: {
      priority: 120
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: sshAllowedFrom
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '22'
    }
  }
]

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${vmName}-nsg'
  location: location
  properties: {
    securityRules: concat(webRules, sshRule)
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${vmName}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.20.0.0/24'] }
    subnets: [
      {
        name: 'default'
        properties: {
          addressPrefix: '10.20.0.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${vmName}-ip'
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: { domainNameLabel: label }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig'
        properties: {
          subnet: { id: vnet.properties.subnets[0].id }
          publicIPAddress: { id: publicIp.id }
          privateIPAllocationMethod: 'Dynamic'
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: { vmSize: vmSize }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }
    }
    osProfile: {
      computerName: take(replace(vmName, '_', '-'), 15)
      adminUsername: adminUsername
      // Without a key Azure needs a password. Nobody is given it, and install.sh turns password sign-in off.
      adminPassword: empty(sshPublicKey) ? generatedPassword : null
      linuxConfiguration: {
        disablePasswordAuthentication: !empty(sshPublicKey)
        ssh: empty(sshPublicKey) ? null : {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: trim(sshPublicKey)
            }
          ]
        }
        patchSettings: { patchMode: 'AutomaticByPlatform', assessmentMode: 'AutomaticByPlatform' }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: 64
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
        deleteOption: 'Delete'
      }
    }
    networkProfile: {
      networkInterfaces: [{ id: nic.id, properties: { deleteOption: 'Delete' } }]
    }
  }
}

// Installs Botkins, its relay and Caddy, waits for HTTPS and the relay, and prints the pairing link. Settings, including the optional tokens, travel only in the encrypted protected settings.
resource setup 'Microsoft.Compute/virtualMachines/extensions@2024-07-01' = {
  parent: vm
  name: 'botkins-setup'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.Extensions'
    type: 'CustomScript'
    typeHandlerVersion: '2.1'
    autoUpgradeMinorVersion: true
    forceUpdateTag: setupRun
    protectedSettings: {
      commandToExecute: setupCommand
    }
  }
}

var setupOutput = setup.properties.instanceView.statuses[0].message

@description('Open this on your phone, or scan its QR code from a computer, to pair the Botkins app. It works once and expires in an hour.')
output pairingLink string = trim(split(split(setupOutput, '[stdout]')[1], '[stderr]')[0])

@description('Your server\'s relay. Phones reach the server through it.')
output relayUrl string = 'https://${fqdn}'

@description('Run this to get a new pairing link later, for example for another phone.')
output newPairingLink string = 'az vm run-command invoke -g ${resourceGroup().name} -n ${vmName} --command-id RunShellScript --scripts "botkins-server pair" --query "value[0].message" -o tsv'

output sshCommand string = empty(sshAllowedFrom) || empty(sshPublicKey) ? 'SSH is closed. Use: az vm run-command invoke -g ${resourceGroup().name} -n ${vmName} --command-id RunShellScript --scripts "botkins-server status"' : 'ssh ${adminUsername}@${fqdn}'
