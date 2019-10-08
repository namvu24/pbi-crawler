const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const moment = require('moment');
const _ = require('lodash');

const { convertToCSV, uploadToBlobStorage, downloadFromBlobStorage } = require('./utils.js');

const checkDashboardPermissions = async (currentJsonFile, newJsonFile) => {
    console.log("Checking dashboard for changes...");
    const currentJsonFileContent = fs.readFileSync(currentJsonFile, "utf-8");
    const currentDashboards = JSON.parse(currentJsonFileContent);
    const newJsonFileContent = fs.readFileSync(newJsonFile, "utf-8");
    const newDashboards = JSON.parse(newJsonFileContent);

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
    
    let dashboardPermissionChanges = [];
    for(let i = 0; i < currentDashboardNames.length; ++i) {
        const dashboardName = currentDashboardNames[i];
        const currentDashboardInfo = currentDashboards.find(x => x.name === dashboardName);
        const newDashboardInfo = newDashboards.find(x => x.name === dashboardName);
        if(!_.isEqual(currentDashboardInfo, newDashboardInfo)) {
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

const getDashboardListFromNav = async (browser, url) => {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitFor(5000);
    const loginPanelInput = await page.$$('#idSIButton9');

    try {
        if(loginPanelInput.length > 0) {
            console.log("Login panel showing...");
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
            console.log("Logged in");
            await page.screenshot({path: './data/logged.jpg'});
            const yesBtn = await page.$$('#idSIButton9');
            const noBtn = await page.$$('#idBtn_Back');
            if(yesBtn.length > 0 && noBtn.length > 0) {
                console.log("Stay in page showing...");
                await page.click('#idSIButton9');
                await page.waitFor(5000);
                await page.screenshot({path: './data/logged2.jpg'});
            }
        }
    } catch(err) {
        console.log(err);
    }

    await page.waitFor(".settingsTab");
    await page.screenshot({path: './data/dashboardsettings.jpg'});
    await page.$$(".settingsTab");
    console.log("getting dashboard infos from dashboard settings");

    const dashboards = await page.evaluate(async () => {
        let dbs = [];
        const settDashboards = document.getElementsByClassName('settingsTab');
        const baseURL = "https://msit.powerbi.com/groups/72c32b07-0f58-440b-99b2-06babaf96a00/permission/dashboard/1/";
        for(let i = 0; i < settDashboards.length; ++i) {
            settDashboards[i].getElementsByTagName("button")[0].click();
            await new Promise(function(resolve) { 
                setTimeout(resolve, 1000);
            });
            const url = baseURL + window.location.href.split('/').pop();
            const dashboard = {
                name: settDashboards[i].innerText,
                url
            };
            dbs.push(dashboard);
        }
        return dbs;
    });
    console.log(dashboards);
    return dashboards;
}

const openDashboardPage = async (browser, url, name) => {
    const page = await browser.newPage();
    await page.goto(url);  
    console.log(`checking permissionTable of ${name}..`);
    await page.screenshot({path: './data/check_permission.jpg'});
    await page.waitFor('.permissionTable');
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
        const dashboardFile = 'dashboards.txt';
        const dashboardFilePath = path.resolve(downloadFolder, dashboardFile);
        const currentJsonFile = "pbi-dashboard-permissions.json";
        const containerName = 'pbi-dashboard';
        const currentJsonFilePath = path.resolve(downloadFolder, "pbi-dashboard-permissions-current.json");
        if(env === "prod") {
            await downloadFromBlobStorage(containerName, currentJsonFile, currentJsonFilePath, process.env.STORAGE_ACC_CONNSTR);
        }

        const dashboardSettingsURL = "https://msit.powerbi.com/groups/72c32b07-0f58-440b-99b2-06babaf96a00/settings/dashboards";
        const dashboardList = await getDashboardListFromNav(browser, dashboardSettingsURL);
        let dashboardInfos = [];
        // Loop through all dashboards to get permissions
        for(let i = 0; i < dashboardList.length; i++) {
            console.log(dashboardList[i]);
            const dashboardInfo = await openDashboardPage(browser, dashboardList[i].url, dashboardList[i].name);
            if(dashboardInfo && dashboardInfo.permissionRows && dashboardInfo.permissionRows.length > 0 )
                dashboardInfos.push(dashboardInfo);
        }

        if(dashboardInfos.length === 0) {
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
        if(fs.existsSync(currentJsonFilePath))
            await checkDashboardPermissions(currentJsonFilePath, jsonFilePath, dashboardList);

        // Clean up generated/downloaded files
        fs.unlinkSync(csvFilePath);
        fs.unlinkSync(jsonFilePath);
        fs.unlinkSync(currentJsonFilePath);
        if(env === "prod")
            fs.unlinkSync(dashboardFilePath);
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