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
        const projectName = userInput.pop();
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
        const mergeCR = command['--merge-create'] ?? [];
        const mrIds = command['--merge'] ?? []
        const buildBranch = command['--build'] ?? []


        if (diffs.length !== 0) {
            for (const [source, destination, group] of diffs) {
                try {
                    const groupBy = group ?? 'date';
                    const result = await commandHandler.getChanges(source, destination);
                    const changeMessage = commandHandler.getChangeLogsMessage(groupBy, result.commitChanges)
                    console.log(changeMessage)
                } catch (error) {
                    console.error(error);

                }
            }
        }


        if (command['--merge-create'] && mergeCR.length !== 0) {
            for (const [source, destination] of mergeCR) {
                try {
                    const result = await commandHandler.getChanges(source, destination);

                    console.log(JSON.stringify(result.commitChanges))

                    const changeLogs = commandHandler.getMarkdownChangelog(result.commitChanges)
                    console.log(`Create MR from ${source} to ${destination} with changelogs::: \n${changeLogs}`);
                    const title = `Merge branch ${source} into ${destination}: `
                    const createMR = await commandHandler.createMR(source, destination,changeLogs, title , false)
                    console.log('MR IID', createMR);
                    mrIds.push(createMR)
                } catch (error) {
                    console.error(error);

                }
            }
        }


        if ( command['--merge'] && mrIds.length !== 0) {
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
            let [mainBranch, deployBranch] = buildBranch[0];
            if(!mainBranch) {
                mainBranch = config.MAIN_BRANCH;
            }

            if(!deployBranch) {
                deployBranch = config.DEPLOY_BRANCH;
            }

            const result = await commandHandler.getChanges(mainBranch, deployBranch);
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
