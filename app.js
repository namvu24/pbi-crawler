const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const moment = require('moment');
const _ = require('lodash');
const { uploadToBlobStorage, downloadFromBlobStorage } = require('./utils.js');

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

const checkDashboardPermissions = async (currentJsonFile, newJsonFile) => {
    const currentJsonFileContent = fs.readFileSync(currentJsonFile, "utf-8");
    const currentDashboards = JSON.parse(currentJsonFileContent);
    const newJsonFileContent = fs.readFileSync(newJsonFile, "utf-8");
    const newDashboards = JSON.parse(newJsonFileContent);
    let dashboardPermissionChanges = [];

    const currentDashboardNames = currentDashboards.map(v => v.name);
    const newDashboardNames = newDashboards.map(v => v.name);
    const newlyCreatedDashboards = _(newDashboardNames).map(i => (currentDashboardNames).includes(i) ? "" : i).value().filter(i => i != "");
    if(newlyCreatedDashboards.length > 0) {
        const text = `New dashboard **${newlyCreatedDashboards.join(', ')}**.`;
        let NotificationPayload = new Object;
        NotificationPayload.text = text; 
        NotificationPayload.mrkdwn = true; 
        console.log("sending notification about new dashboards");
        console.log(JSON.stringify(NotificationPayload));
        await axios.post(process.env.TEAMS_CHANNEL_WEBHOOK, JSON.stringify(NotificationPayload));
    }  
    
    for(let i = 0; i < currentDashboardNames.length; ++i) {
        const dashboardName = dashboardList[i];
        const currentDashboardInfo = currentPermissions.find(x => x.name === dashboardName);
        const newDashboardInfo = newDashboards.find(x => x.name === dashboardName);
        if(!_.isEqual(currentDashboardInfo, newDashboardInfo)) {
            diff = true;
            dashboardPermissionChanges.push(dashboardName);
            console.log(`Found changes in dashboard ${dashboardName}`);
        }
    }

    if(dashboardPermissionChanges.length > 0) {
        const text = `Dashboard **${dashboardPermissionChanges.join(', ')}** 'permissions changed!`;
        let NotificationPayload = new Object;
        NotificationPayload.text = text; 
        NotificationPayload.mrkdwn = true; 
        console.log("sending notification about permissions changed");
        console.log(JSON.stringify(NotificationPayload));
        await axios.post(process.env.TEAMS_CHANNEL_WEBHOOK, JSON.stringify(NotificationPayload));
    }  
}

const openDashboardPage = async (browser, url, name, isFirstTime) => {
    const page = await browser.newPage();
    await page.goto(url); 

    // Login for loading the first page
    if(isFirstTime) {
        try {
            await page.waitFor('#i0116');
            await page.type('#i0116', process.env.SERVICE_ACCOUNT_USERNAME);
            await page.waitFor(1000);
            await page.click('#idSIButton9');
            
            console.log("Logging in...");
            await page.waitFor("#signinsmartcard");
            await page.click(".normalText");
            await page.waitFor('#userNameInput');
            await page.screenshot({path: './data/logging.jpg'});
            await page.type('#passwordInput', process.env.SERVICE_ACCOUNT_PASSWORD);
            await page.waitFor(500);
            await page.click("#submitButton");
            await page.waitFor(5000);
            console.log("Logged in...");
            await page.screenshot({path: './data/logged.jpg'});
        } catch(err) {
            console.log(err);
        }
    }

    await page.waitFor('.permissionTable');
    console.log(`permissionTable showing..`);
    await page.screenshot({path: './data/permission.jpg'});
    // Wait for full permissions
    await page.waitFor(3000);
    
    // Read HTML to get a list of permissions and create csv from the list
    const dashboardInfo = await page.evaluate(name => {
        // Get permission list from HTML
        var permissionRows = [];
        const permissionList = document.querySelectorAll(".permissionTable ul li");
        permissionList.forEach(permission => {
            permissionRows.push(permission.outerText.split('\n'));
        });

        var relatedReports = [];
        const relatedReportList = document.querySelectorAll("button.report.relatedArtifact");
        relatedReportList.forEach(report => {
            relatedReports.push(report.outerText);
        });

        // Transform to object {name:'', rows:[]}
        let dashboardInfo = new Object;
        dashboardInfo.name = name;
        dashboardInfo.permissionRows = permissionRows;
        dashboardInfo.relatedReports = relatedReports;

        return dashboardInfo;
    }, name);

    await page.close();
    return dashboardInfo;
};

const main = async () => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox']
        });
        const env = process.env.PRODUCTION === true ? "prod" : "dev";

        // Download dashboard list from blob storgage
        const downloadFolder = 'data';
        const dashboardFile = 'dashboard-list.txt';
        const dashboardFilePath = path.resolve(downloadFolder, dashboardFile);
        const currentJsonFile = "pbi-dashboard-permissions.json";
        const containerName = 'pbi-dashboard';
        const currentJsonFilePath = path.resolve(downloadFolder, "pbi-dashboard-permissions-current.json");
        if(env === "prod") {
            await downloadFromBlobStorage(containerName, dashboardFile, dashboardFilePath, process.env.STORAGE_ACC_CONNSTR);
            await downloadFromBlobStorage(containerName, currentJsonFile, currentJsonFilePath, process.env.STORAGE_ACC_CONNSTR);
        }

        const dataContent = fs.readFileSync(path.resolve(env === "prod" ? dashboardFilePath : './data/dashboards.csv'), "utf-8");
        const contentRows = dataContent.split('\r\n');
        let dashboardList = [];
        contentRows.forEach(r => dashboardList.push(r.split(';')));
        let dashboardInfos = [];
        
        // Loop through all dashboards to get permissions
        for(let i = 0; i < dashboardList.length; i++) {
            const name = dashboardList[i][0];
            const url = dashboardList[i][1];
            console.log(dashboardList[i]);
            
            if(!name || !url)
                continue;

            const dashboardInfo = await openDashboardPage(browser, url, name, isFirstTime = i === 0 ? true : false, console);
            if(dashboardInfo && dashboardInfo.permissionRows && dashboardInfo.permissionRows.length > 0 )
                dashboardInfos.push(dashboardInfo);
        }

        if(dashboardList.length === 0) {
            console.log(`Something wrong. No dashboard permissions found`);
            return;
        }

        // Write dasboards' permissions to csv file
        const csvContent = convertToCSV(dashboardInfos);
        const csvFileName = "pbi-dashboard-permissions" + moment().format('HHmmss_DDMMYYYY') + ".csv";
        const jsonFileName = "pbi-dashboard-permissions.json";
        const csvFilePath = path.resolve(downloadFolder, csvFileName);
        const jsonFilePath = path.resolve(downloadFolder, jsonFileName);
        
        fs.writeFileSync(csvFilePath, csvContent);
        fs.writeFileSync(jsonFilePath, JSON.stringify(dashboardInfos));

        // Upload to blob storgage   
        await uploadToBlobStorage(containerName, jsonFileName, jsonFilePath, process.env.STORAGE_ACC_CONNSTR);
        await uploadToBlobStorage(containerName, csvFileName, csvFilePath, process.env.STORAGE_ACC_CONNSTR);

        // Compare to find new dashboards
        await checkDashboardPermissions(currentJsonFilePath, jsonFilePath, dashboardList);

        // Clean up generated/downloaded files
        fs.unlinkSync(csvFilePath);
        fs.unlinkSync(jsonFilePath);
        fs.unlinkSync(dashboardFilePath);
        fs.unlinkSync(currentJsonFilePath);
    }
    catch (error) {
        console.log(error);
    } 
    finally {
        if(browser)
            await browser.close();
    }
}

main();