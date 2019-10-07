const azure = require('azure-storage');

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
    uploadToBlobStorage,
    downloadFromBlobStorage
}