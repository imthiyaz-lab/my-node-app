#!/bin/bash

# Wait for SQL Server to become healthy and available
echo "Waiting for SQL Server to start..."
until /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "${MSSQL_SA_PASSWORD}" -Q "SELECT 1" &>/dev/null; do
    sleep 2
done

echo "SQL Server is up. Running initialization scripts..."

# 1. Create the database if it doesn't exist
/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "${MSSQL_SA_PASSWORD}" -Q "IF DB_ID('imtu') IS NULL CREATE DATABASE imtu;"

# 2. Create the table and seed the data
/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "${MSSQL_SA_PASSWORD}" -d imtu -Q "
IF OBJECT_ID('dbo.tb5r','U') IS NULL 
BEGIN
    CREATE TABLE dbo.tb5r (SourceServer NVARCHAR(255), DatabaseName NVARCHAR(255));
END

IF NOT EXISTS (SELECT 1 FROM dbo.tb5r) 
BEGIN
    INSERT INTO dbo.tb5r (SourceServer, DatabaseName) VALUES 
    ('usidc01', 'BillingServices'), ('usidc01', 'InventoryDB'), 
    ('usidc02', 'CustomerData'), ('usidc02', 'OrderProcessing'), 
    ('usidc03', 'HumanResources'), ('usidc03', 'PayrollSystem'), 
    ('usidc04', 'AnalyticsWarehouse'), ('usidc04', 'ReportingService'), 
    ('usidc05', 'IdentityManagement'), ('usidc05', 'AuditLogs'), 
    ('usidc06', 'MarketingDB'), ('usidc06', 'CampaignTracker'), 
    ('usidc07', 'LogisticsMaster'), ('usidc07', 'FleetManagement'), 
    ('usidc08', 'VendorPortal'), ('usidc08', 'ProcurementDB'), 
    ('usidc09', 'SupportTickets'), ('usidc09', 'KnowledgeBase'), 
    ('usidc10', 'ProductCatalog'), ('usidc10', 'PricingEngine'), 
    ('usidc11', 'AuthenticationDB'), ('usidc11', 'SessionStore'), 
    ('usidc12', 'NotificationHub'), ('usidc12', 'EmailQueue'), 
    ('usidc13', 'FinancialLedger'), ('usidc13', 'TaxReporting'), 
    ('usidc14', 'UserProfiles'), ('usidc14', 'PreferenceStore'), 
    ('usidc15', 'ContentRepository'), ('usidc15', 'MediaAssets');
END"

echo "Initialization complete!"

