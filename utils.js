const azure = require('azure-storage');
const axios = require('axios');

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
    const header = ['Dashboard','Name', 'Email', 'Permissions'];
    let csvContent = header.join(';') + '\r\n';

    dataObject.forEach(item => {
        item.permissionRows.forEach(row => {
            csvContent += item.name + ";" + row.join(';') + '\r\n';
        });
    });
    return csvContent;
}

const uploadToBlobStorage = (container, blob, filePath, connString) => {
    console.log(`Uploading ${blob}`);
    const OPTIONS = {timeoutIntervalInMs: 6000000,clientRequestTimeoutInMs:6000000,maximumExecutionTimeInMs:6000000};
    var blobService = azure.createBlobService(connString);
    return new Promise((resolve, reject) => {
        blobService.createBlockBlobFromLocalFile(container, blob, filePath, OPTIONS, (error, result, response) => {
            if (!error) {
                resolve(true);
            } else {
                reject(`could not delete blob ${container}/${blob} ${JSON.stringify(error)}`);
            }
        });
    });
};

const downloadFromBlobStorage = (container, blob, filePath, connString) => {
    console.log(`Downloading ${blob}`);
    const OPTIONS = {timeoutIntervalInMs: 6000000,clientRequestTimeoutInMs:6000000,maximumExecutionTimeInMs:6000000};
    var blobService = azure.createBlobService(connString);
    return new Promise((resolve, reject) => {
        blobService.getBlobToLocalFile(container, blob, filePath, OPTIONS, (error, result, response) => {
            if (!error) {
                resolve(true);
            } else {
                reject(`could not delete blob ${container}/${blob} ${JSON.stringify(error)}`);
            }
        });
    });
};

module.exports = {
    sendToTeams,
    convertToCSV,
    uploadToBlobStorage,
    downloadFromBlobStorage
}