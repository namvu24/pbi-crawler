const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const moment = require('moment');
const _ = require('lodash');
require('dotenv').config();

const { sendToTeams, convertToCSV, uploadToBlobStorage, downloadFromBlobStorage } = require('./utils.js');

const checkDashboardChanges = async (currentJsonFile, newJsonFile) => {
    console.log("Checking dashboard for changes...");
    const currentJsonFileContent = fs.readFileSync(currentJsonFile, "utf-8");
    const currentDashboards = JSON.parse(currentJsonFileContent);
    const newJsonFileContent = fs.readFileSync(newJsonFile, "utf-8");
    const newDashboards = JSON.parse(newJsonFileContent);

    const currentDashboardNames = currentDashboards.map(v => v.name);
    const newDashboardNames = newDashboards.map(v => v.name);

    // Check if new dashboards come
    const newlyCreatedDashboards = _(newDashboardNames).map(i => (currentDashboardNames).includes(i) ? "" : i).value().filter(i => i != "");
    if(newlyCreatedDashboards.length > 0) {
        newlyCreatedDashboards.forEach(async (newDashboardName) => {
            const newDashboard = _.find(newDashboards, { 'name': newDashboardName });
            const text = `New dashboard **${newDashboardName}**.\n\n`
                        + `**ID**: ${newDashboard.id}\n\n`
                        + `**URL**: ${newDashboard.url}\n\n`
                        + `**Access**: \n\n${newDashboard.permissionRows.join('\n\n')}\n\n`;
            await sendToTeams(process.env.TEAMS_E2E_CHANNEL_WEBHOOK, text);
        });
    }  
    
    // Check if permissions or reports changed
    for(let i = 0; i < currentDashboardNames.length; ++i) {
        try {
            const dashboardName = currentDashboardNames[i];
            const currentDashboardInfo = currentDashboards.find(x => x.name.trim().toLowerCase() === dashboardName.trim().toLowerCase());
            const newDashboardInfo = newDashboards.find(x => x.name.trim().toLowerCase() === dashboardName.trim().toLowerCase());
            if(!_.isEqual(currentDashboardInfo.permissionRows.sort(), newDashboardInfo.permissionRows.sort())) {
                console.log(`Found permission changes in dashboard ${dashboardName}`);
                const text = `Dashboard **${dashboardName}** permissions changed!\n\n`
                            + `**From:** ${currentDashboardInfo.permissionRows.join('\n\n')}\n\n`
                            + `**To:** ${newDashboardInfo.permissionRows.join('\n\n')}`;
                await sendToTeams(process.env.TEAMS_E2E_CHANNEL_WEBHOOK, text);
            }
            if(!_.isEqual(currentDashboardInfo.relatedReports.sort(), newDashboardInfo.relatedReports.sort())) {
                console.log(`Found report changes in dashboard ${dashboardName}`);
                const text = `Dashboard **${dashboardName}** related reports changed!\n\n`
                            + `**From:** ${currentDashboardInfo.relatedReports.join('\n\n')}\n\n`
                            + `**To:** ${newDashboardInfo.relatedReports.join('\n\n')}`;
                await sendToTeams(process.env.TEAMS_E2E_CHANNEL_WEBHOOK, text);
            }
        } catch(err) {
            console.log(`Error when reading json dashboard ${currentDashboardNames[i]}`);
            console.log(err);
        }
    }
}

const getDashboardListFromSettings = async (browser, url, userName, userPassword) => {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitFor(5000);
    await page.screenshot({path: './data/signin-page.jpg'});

    // Login automatically if login dialog opens and not in DEV
    try {
        if(process.env.ENVIRONMENT !== "dev") {
            console.log("Login panel showing...");
            await page.waitFor('#i0116');
            await page.screenshot({path: './data/username.jpg'});
            await page.type('#i0116', userName);
            await page.screenshot({path: './data/username2.jpg'});
            await page.waitFor(1000);
            await page.click('#idSIButton9');
            
            console.log("Logging in...");
            await page.screenshot({path: './data/enterredusername.jpg'});
            await page.waitFor("#FormsAuthentication");
            await page.click("#FormsAuthentication");
            await page.waitFor('#userNameInput');
            await page.screenshot({path: './data/logging.jpg'});
            await page.type('#passwordInput', userPassword);
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

    // Get all dashboards infos from settings tab
    await page.waitFor(".settingsTab");
    await page.screenshot({path: './data/dashboardsettings.jpg'});
    await page.$$(".settingsTab");
    console.log("getting dashboard infos from dashboard settings");

    const dashboards = await page.evaluate(async (tenantID) => {
        let dbs = [];
        const settDashboards = document.getElementsByClassName('settingsTab');
        // Powerbi takes few seconds to load the first dashboard setting after click > wait 10 secs
        settDashboards[0].getElementsByTagName("button")[0].click();
        await new Promise(function(resolve) { 
            setTimeout(resolve, 10000);
        });
        const baseURL = `https://app.powerbi.com/groups/${tenantID}/permission/dashboard/1/`;
        for(let i = 0; i < settDashboards.length; ++i) {
            // By clicking to each dashboard, we can get its ID from its url
            settDashboards[i].getElementsByTagName("button")[0].click();
            await new Promise(function(resolve) { 
                setTimeout(resolve, 1000);
            });
            // We only care about its ID that can be extract from https://app.powerbi.com/groups/tenant/xxx/xxx/<ID>
            const id = window.location.href.split('/').pop();
            const url = baseURL + id;
            const dashboard = {
                name: settDashboards[i].innerText,
                url,
                id
            };
            dbs.push(dashboard);
        }
        return dbs;
    }, process.env.TENANT_ID);
    console.log(dashboards);
    return dashboards;
}

const openDashboardPage = async (browser, url, name, id) => {
    const page = await browser.newPage();
    await page.screenshot({path: './data/check_permission.jpg'});
    await page.goto(url);
    console.log(`checking permissionTable of ${name}..`);
    
    // Retry 3 times (and reload) if permissionTable table is not showing
    let tries = 0;
    while(tries < 3) {
        // UI changed! permissionTable was replaced with direct-access-table element
        if (await page.waitForSelector('direct-access-table')) {
            await page.screenshot({path: './data/permission.jpg'});
            console.log(`permissionTable of ${name} displayed`);
            break;
        }

        await page.reload();
        tries++;
    }
    // Wait for full permissions
    await page.waitFor(3000);
    
    // Read HTML to get a list of permissions and create csv from the list
    const dashboardInfo = await page.evaluate((name, id, url) => {
        // Get permission list from HTML
        var permissionRows = [];
        // Permission list can be found under .row element
        const permissionList = document.querySelectorAll(".row");
        permissionList.forEach(permission => {
            let permissions = permission.outerText.split('\n');
            // Discard the first element if it is icon with 2 characters
            if(permissions[0].length <= 2)
                permissions.shift();
            permissionRows.push(permissions);
        });

        var relatedReports = [];
        // Report list can be found under the first .node-header (Report list) then query .artifactLink
        const relatedReportList = document.querySelectorAll(".node-header")[0].querySelectorAll(".artifactLink");
        relatedReportList.forEach(report => {
            relatedReports.push(report.outerText.trim());
        });

        // Transform to object {name:'', rows:[]}
        let dashboardInfo = {
            name,
            id,
            url,
            permissionRows,
            relatedReports
        };

        return dashboardInfo;
    }, name, id, url);

    await page.close();
    return dashboardInfo;
};

const main = async () => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: process.env.ENVIRONMENT === "dev" ? false : true,
            args: ['--no-sandbox'] // to fix Error: Failed to launch chrome!
        });
        
        const downloadFolder = 'data';
        const currentJsonFile = "pbi-dashboard-permissions.json";
        const containerName = 'pbi-dashboard';
        const currentJsonFilePath = path.resolve(downloadFolder, "pbi-dashboard-permissions-current.json");
        // Download existing json file in order to compare it with a new one later
        await downloadFromBlobStorage(containerName, currentJsonFile, currentJsonFilePath, process.env.STORAGE_ACCOUNT_NAME, process.env.STORAGE_ACCOUNT_KEY);

        // Get Service account password from key vault and get dashboard list by logging in to PowerBI
        const dashboardSettingsURL = `https://app.powerbi.com/?route=groups/${process.env.TENANT_ID}/settings/dashboards&noSignUpCheck=1`;

        const dashboardList = await getDashboardListFromSettings(browser, dashboardSettingsURL, process.env.SERVICE_ACCOUNT_USERNAME, process.env.SERVICE_ACCOUNT_PWD);
        let dashboardInfos = [];
        
        // Loop through all dashboards to get permissions
        for(let i = 0; i < dashboardList.length; i++) {
            console.log(dashboardList[i]);
            const dashboardInfo = await openDashboardPage(browser, dashboardList[i].url, dashboardList[i].name, dashboardList[i].id);
            if(dashboardInfo && dashboardInfo.permissionRows && dashboardInfo.permissionRows.length > 0 )
                dashboardInfos.push(dashboardInfo);
        }

        if(dashboardInfos.length === 0) {
            const text = `cap-powerbi-crawler: Something wrong. No dashboard permissions found.`;
            console.log(text);
            throw new Error(text);
        }

        const csvFileName = "pbi-dashboard-permissions" + moment().format('HHmmss_DDMMYYYY') + ".csv";
        const currentJsonFileName = "pbi-dashboard-permissions" + moment().format('HHmmss_DDMMYYYY') + ".json";
        const jsonFileName = "pbi-dashboard-permissions.json";
        const csvFilePath = path.resolve(downloadFolder, csvFileName);
        const jsonFilePath = path.resolve(downloadFolder, jsonFileName);
        
         // Write dasboards' permissions to csv file
        fs.writeFileSync(csvFilePath, convertToCSV(dashboardInfos));
        fs.writeFileSync(jsonFilePath, JSON.stringify(dashboardInfos));

        // Compare to find new dashboards
        if(fs.existsSync(currentJsonFilePath))
            await checkDashboardChanges(currentJsonFilePath, jsonFilePath, dashboardList);

        // Upload to blob storgage
        if (process.env.ENVIRONMENT !== "dev") {
            await uploadToBlobStorage(containerName, currentJsonFileName, currentJsonFilePath, process.env.STORAGE_ACCOUNT_NAME, process.env.STORAGE_ACCOUNT_KEY);
            await uploadToBlobStorage(containerName, jsonFileName, jsonFilePath, process.env.STORAGE_ACCOUNT_NAME, process.env.STORAGE_ACCOUNT_KEY);
            await uploadToBlobStorage(containerName, csvFileName, csvFilePath, process.env.STORAGE_ACCOUNT_NAME, process.env.STORAGE_ACCOUNT_KEY);
        }

        // Clean up generated/downloaded files
        console.log("Removing generated files...");
        fs.unlinkSync(csvFilePath);
        fs.unlinkSync(jsonFilePath);
        fs.unlinkSync(currentJsonFilePath);
        console.log("Crawler finished.");
    }
    catch (error) {
        console.log(error);
        const text = `cap-powerbi-crawler: Error when checking pbi dashboards\n\n${error}`;
        await sendToTeams(process.env.TEAMS_INFRA_CHANNEL_WEBHOOK, text);
    } 
    finally {
        if(browser)
            await browser.close();
    }
}

main();