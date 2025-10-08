// 部署一个用于托管 Node.js Express 应用的 Azure Linux Web App
// This Bicep template deploys:
// - Resource Group scope resources (Web App + App Service Plan + Log Analytics Workspace + App Insights)

@description('Location of the resources')
param location string = resourceGroup().location

@description('App Service Plan SKU (e.g. B1, P1v3)')
param skuName string = 'B1'

@description('Web App name (must be globally unique).')
param webAppName string

@description('Node version to use in WEBSITES_ENABLE_APP_SERVICE_STORAGE scenario')
param nodeVersion string = 'NODE|20-lts'

@description('Optional array of allowed origins for CORS.')
param allowedOrigins array = []

// Log Analytics workspace
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${webAppName}-logs'
  location: location
  sku: { name: 'PerGB2018' }
  retentionInDays: 30
}

// Application Insights (classic via component API)
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${webAppName}-ai'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// App Service Plan
resource plan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: '${webAppName}-plan'
  location: location
  sku: {
    name: skuName
    capacity: 1
    tier: skuName == 'B1' ? 'Basic' : ''
  }
  properties: {
    reserved: true // Linux
  }
}

// Web App
resource webApp 'Microsoft.Web/sites@2023-01-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: plan.id
    siteConfig: {
      linuxFxVersion: nodeVersion
      appSettings: [
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE'; value: 'false' }
        { name: 'WEBSITES_PORT'; value: '3000' }
        { name: 'NODE_ENV'; value: 'production' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'; value: appInsights.properties.ConnectionString }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY'; value: appInsights.properties.InstrumentationKey }
      ]
      cors: allowedOriginsLength > 0 ? {
        allowedOrigins: allowedOrigins
      } : null
    }
    httpsOnly: true
  }
}

// Output for pipeline usage
@description('Web App name for deployment use (az webapp deploy)')
output webAppNameOut string = webApp.name
@description('App Service Plan name')
output appServicePlan string = plan.name
@description('Application Insights name')
output appInsightsName string = appInsights.name

var allowedOriginsLength = length(allowedOrigins)
