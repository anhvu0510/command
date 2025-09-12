const moment = require('moment');
const { gitToken, host, projects } = require('./config')
const { core } = require('./core')


function parseArgs(arr) {
    const result = {};
    let currentKey = null;

    for (const item of arr) {
        if (item.startsWith('--')) {
            currentKey = item;
            if (!result[currentKey]) result[currentKey] = [];
        } else if (currentKey) {
            if (item.includes(':')) {
                result[currentKey].push(item.split(':'));

            } else if (item.includes(',')) {
                result[currentKey].push(...item.split(','));
            } else {
                result[currentKey].push(item);
            }
        }
    }

    return result;
}


(async () => {
    try {

        const userInput = process.argv.slice(2);
        const projectName = userInput.shift();
        const projectConfig = projects.find(item => projectName === item.projectName)
        if (!projectConfig) {
            throw new Error(`Project ${projectName} chưa được config`)
        }

        const command = parseArgs(userInput);
        console.log('command', command);


        const config = {
            HOST: host,
            PID: projectConfig.PID,
            TOK: gitToken,
            MAIN_BRANCH: projectConfig.mainBranch,
            DEPLOY_BRANCH: projectConfig.deployBranch,
            POLL_RETRIES: '20',
            POLL_DELAY_MS: '2000',
            DO_TAG: 'true',
        }

        const commandHandler = core(config)

        const diffs = command['--diff'] ?? [];
        if (diffs.length !== 0) {
            for (const [source, destination] of diffs) {
                try {
                    const result = await commandHandler.getChanges(source, destination);
                    const changeMessage = commandHandler.getChangeLogsMessage('date', result.commitChanges)
                    console.log(changeMessage)
                } catch (error) {
                    console.error(error);

                }
            }
        }


        const mergeCR = command['--merge-create'] ?? [];
        if (mergeCR.length !== 0) {
            for (const [source, destination] of mergeCR) {
                try {
                    const result = await commandHandler.getChanges(source, destination);

                    console.log(JSON.stringify(result.commitChanges))

                    const changeLogs = commandHandler.getMarkdownChangelog(result.commitChanges)
                    console.log(`Create MR from ${source} to ${destination} with changelogs::: \n${changeLogs}`);
                    const createMR = await commandHandler.createMR(source, destination, changeLogs, false)
                    console.log('MR IID', createMR);
                } catch (error) {
                    console.error(error);

                }
            }
        }


        const mrIds = command['--merge'] ?? []
        if (mrIds.length !== 0) {
            for (const mergeId of mrIds) {
                try {
                    console.log(`🔧[Merge to ${config.MAIN_BRANCH}] Host=${config.HOST} PID=${config.PID} Merge RequestID: ${mergeId}`);
                    await commandHandler.ensureTargetIsMain(mergeId);
                    await commandHandler.mergeIntoMain(mergeId);
                } catch (error) {
                    console.error(error);

                }
            }
        }



        if (command['--build']) {
            const result = await commandHandler.getChanges(config.MAIN_BRANCH, config.DEPLOY_BRANCH);
            if (result.commitChanges.length !== 0) {
                const tagBuildSbx = command['--tags']?.shift() ?? null;
                const changeLogs = commandHandler.getChangeLogsMessage(null, result.commitChanges)
                const changeLogsMD = commandHandler.getMarkdownChangelog(result.commitChanges)

                let tagsDesc = command['--tags-desc'] ?? null;
                if (!tagsDesc) {
                    tagsDesc = changeLogs
                } else {
                    tagsDesc = `Build SBX at: ${moment().format('DD/MM/YYYY HH:mm')}\nChangelogs:\n${tagsDesc.map(item => ` - ${item.trim()}`).join('\n')}`
                }

                await commandHandler.syncMainToDeployAndTag({ tag: tagBuildSbx, tagsDesc: changeLogs, changelogs: changeLogsMD });
            } else {
                console.log(`[Error]: Not have commits changes from ${config.MAIN_BRANCH} to ${config.DEPLOY_BRANCH}`)
            }
        }

        if (command['--build-tags']) {
            const destination = command['--build-tags'][0]
            const result = await commandHandler.getChanges(config.DEPLOY_BRANCH, destination);
            if (result.commitChanges.length !== 0) {
                const tagBuildSbx = command['--tags']?.shift() ?? null;
                const changeLogs = null;
                let tagsDesc = command['--tags-desc'] ?? null;
                if (!tagsDesc) {
                    tagsDesc = changeLogs
                } else {
                    tagsDesc = `Build SBX at: ${moment().format('DD/MM/YYYY HH:mm')}\nChangelogs:\n${tagsDesc.map(item => ` - ${item.trim()}`).join('\n')}`
                }



                await commandHandler.createTagsForDeploy(null, changeLogs)
                // await syncMainToDeployAndTag(tagBuildSbx, changeLogs);
            } else {
                console.log(`[Error]: Not have commits changes from ${config.MAIN_BRANCH} to ${config.DEPLOY_BRANCH}`)
            }
        }


    } catch (error) {
        console.error(`[Command] Error::: ${error?.message}`)
    }
})()
