# This notebook triggers ACI instance with retry mechanism
# It retries a few times before sending notifications to Teams if not succeeded
# Hosted in automation account CAPInfraAutomationAccount2/PBICrawlerTrigger
# The RunAsAccount of automation account needs to have Contributor permission of ACI

$connectionName = "AzureRunAsConnection"
$servicePrincipalConnection=Get-AutomationConnection -Name $connectionName         
"Logging in to Azure..."
Connect-AzureRmAccount `
    -ServicePrincipal `
    -TenantId $servicePrincipalConnection.TenantId `
    -ApplicationId $servicePrincipalConnection.ApplicationId `
    -CertificateThumbprint $servicePrincipalConnection.CertificateThumbprint
"Login complete."
Select-AzureRmSubscription -SubscriptionName 'CMR CAP Public Cloud - SVC MGMT'

# Send notification to Teams Infra channel
function Send-MSTeamsMessage {
    param ([string]$Message)   

    Write-Host "Sends to #infra-notifications"
    $Hook = "https://microsoft.webhook.office.com/webhookb2/401e90cc-e20c-42f7-ba74-a41fa99a0f5c@72f988bf-86f1-41af-91ab-2d7cd011db47/IncomingWebhook/9f1b4d2647fd4fffaac8287ce1324a84/0a9ee0ae-7de2-40d3-b6de-0e5431078ab4"
    
    $NotificationPayload = @{ text="$Message"; mrkdwn="true"; username="CAP Notifications machine"}
    
    Write-host "Sending MSTeams message"
    Write-Host "$Message"
    Invoke-RestMethod -Uri $Hook -Method Post -Body (ConvertTo-Json $NotificationPayload)
}

# Get Access token of RunAsAccount for authentication with ACI REST API
function Get-AccessToken($tenantId) {
    $azureRmProfile = [Microsoft.Azure.Commands.Common.Authentication.Abstractions.AzureRmProfileProvider]::Instance.Profile;
    $profileClient = New-Object Microsoft.Azure.Commands.ResourceManager.Common.RMProfileClient($azureRmProfile);
    $profileClient.AcquireAccessToken($tenantId).AccessToken;
}

# Get status of last ACI run, return instanceview.state
function Get-ContainerGroupStatus($resourceGroupName, $containerGroupName) {
    $azContext = Get-AzureRMContext
    $subscriptionId = $azContext.Subscription.Id
    $commandUri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$resourceGroupName/providers/Microsoft.ContainerInstance/containerGroups/$containerGroupName" + "?api-version=2018-10-01"
    $accessToken = Get-AccessToken $azContext.Tenant.TenantId
    $response = Invoke-RestMethod -Method Get -Uri $commandUri -Headers @{ Authorization="Bearer $accessToken" }
    return $response.properties.instanceView.state
}

# Send command to ACI
function Send-ContainerGroupCommand($resourceGroupName, $containerGroupName, $command) {
    $azContext = Get-AzureRMContext
    $subscriptionId = $azContext.Subscription.Id
    $commandUri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$resourceGroupName/providers/Microsoft.ContainerInstance/containerGroups/$containerGroupName/$command" + "?api-version=2018-10-01"
    $accessToken = Get-AccessToken $azContext.Tenant.TenantId
    $response = Invoke-RestMethod -Method Post -Uri $commandUri -Headers @{ Authorization="Bearer $accessToken" }
    $response
}

# Variables
$containerName = "cap-pbi-crawler"
$resourceGroup = "cap-powerbi-monitor"
$retryTimes = 5
$retryCount = 0
$intervalInSecond = 30
$lastRunStatus = "NotStarted"

# Rery mechanism
while($true) {
    if($lastRunStatus -eq "Failed" -or $lastRunStatus -eq "NotStarted") {
        Send-ContainerGroupCommand -resourceGroupName $resourceGroup -containerGroupName $containerName -command "start"
        Write-Host "Starting container, retry time: $retryCount"
        $retryCount++
    }
    $lastRunStatus = Get-ContainerGroupStatus -resourceGroupName $resourceGroup -containerGroupName $containerName
    Write-Host "Status: $lastRunStatus, retry count: $retryCount, sleep for $intervalInSecond seconds"
    
    if($lastRunStatus -eq "Succeeded") {
        Write-Host "Stop restarting container $containerName because run status is $lastRunStatus or Retry reached $retryCount times"
        break
    }
    if($retryCount -ge $retryTimes) {
        Send-MSTeamsMessage -Message "ACI $containerName failed to start. Retry reached $retryCount times"
        break
    }

    Start-Sleep -Seconds $intervalInSecond
}
