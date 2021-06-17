const azure = require('azure-storage');
const axios = require('axios');
const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

const sendToTeams = async (webhookURL, text) => {
    let NotificationPayload = {
        text,
        mrkdwn: true
    };
    console.log("sending notification to Teams");
    console.log(JSON.stringify(NotificationPayload));
    await axios.post(webhookURL, JSON.stringify(NotificationPayload));
}

// Convert dashboards json to CSV format with header and delimiter
const convertToCSV = (dataObject) => {
    const header = ['Dashboard', 'Name', 'Id', 'Email', 'Permissions'];
    let csvContent = header.join(';') + '\r\n';

    dataObject.forEach(item => {
        item.permissionRows.forEach(row => {
            csvContent += item.name + ";" + row.join(';') + '\r\n';
        });
    });
    return csvContent;
}

const uploadToBlobStorage = (container, blob, filePath, storageAccountName, storageAccountKey) => {
    console.log(`Uploading ${blob}`);
    const OPTIONS = {timeoutIntervalInMs: 6000000,clientRequestTimeoutInMs:6000000,maximumExecutionTimeInMs:6000000};
    var blobService = azure.createBlobService(storageAccountName, storageAccountKey);
    return new Promise((resolve, reject) => {
        blobService.createBlockBlobFromLocalFile(container, blob, filePath, OPTIONS, (error, result, response) => {
            if (!error) {
                resolve(true);
            } else {
                reject(`could not upload blob ${container}/${blob} ${JSON.stringify(error)}`);
            }
        });
    });
};

const downloadFromBlobStorage = (container, blob, filePath, storageAccountName, storageAccountKey) => {
    console.log(`Downloading ${blob}`);
    const OPTIONS = {timeoutIntervalInMs: 6000000,clientRequestTimeoutInMs:6000000,maximumExecutionTimeInMs:6000000};
    var blobService = azure.createBlobService(storageAccountName, storageAccountKey);
    return new Promise((resolve, reject) => {
        blobService.getBlobToLocalFile(container, blob, filePath, OPTIONS, (error, result, response) => {
            if (!error) {
                resolve(true);
            } else {
                reject(`could not download blob ${container}/${blob} ${JSON.stringify(error)}`);
            }
        });
    });
};

const createKeyVaultClient = async (keyVaultUri) => {
    // MSI authentication
    const credential = new DefaultAzureCredential();
    return new SecretClient(keyVaultUri, credential);
}

const getVaultSecret = async (kvClient, secretName) => {
    // MSI authentication
    try {
        return (await kvClient.getSecret(secretName)).value;
    } catch (error) {
        // Exit process here so docker run fails > ACI has failure status to trigger retry
        console.log("No MSI found or lacking of permissions to get secret from key vault!")
        console.error(error);
        process.exit(1)
    }
}

module.exports = {
    sendToTeams,
    convertToCSV,
    uploadToBlobStorage,
    downloadFromBlobStorage,
    createKeyVaultClient,
    getVaultSecret
}
