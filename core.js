#!/usr/bin/env node
/* eslint-disable no-restricted-syntax */

const axios = require('axios');
const moment = require('moment');
const _ = require('lodash')

const { host, gitToken, projects } = require('./config')
// ===== ENV =====
function main(config) {
    const { HOST, PID, TOK, MAIN_BRANCH, DEPLOY_BRANCH, POLL_RETRIES = '20', POLL_DELAY_MS = '2000', DO_TAG = 'true' } = config

    if (!PID || !TOK) {
        console.log('❌ Thiếu biến môi trường hoặc tham số.\n'
            + 'Cần: PID, TOK, (tùy) HOST, DEPLOY_BRANCH; và tham số CLI: MR_IID\n'
            + 'Ví dụ: node buildSBX.js 226');
        process.exit(1);
    }



    const RETRIES = parseInt(POLL_RETRIES, 10);
    const DELAY = parseInt(POLL_DELAY_MS, 10);


    // ===== Axios client =====
    const api = axios.create({
        baseURL: `${HOST.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(PID)}`,
        timeout: 60_000,
        headers: { 'PRIVATE-TOKEN': TOK }
    });

    api.interceptors.response.use(
        (res) => res,
        (err) => {
            if (err.response) {
                const { status, data, config } = err.response;
                console.log(`HTTP ${status} ${config?.method?.toUpperCase()} ${config?.url}`);
                if (typeof data === 'string') console.log(data.slice(0, 2000));
                else console.log(JSON.stringify(data, null, 2));
            } else {
                console.log('HTTP ERROR:', err.message);
            }
            return Promise.reject(err);
        }
    );

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ===== HTTP helpers =====
    async function http(method, path, { json, form, headers } = {}) {
        const cfg = { method, url: `/${String(path).replace(/^\/+/, '')}`, headers: headers || {} };
        if (json !== undefined) {
            cfg.headers['Content-Type'] = 'application/json';
            cfg.data = json;
        } else if (form !== undefined) {
            cfg.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            const usp = new URLSearchParams();
            for (const [k, v] of Object.entries(form)) usp.append(k, String(v));
            cfg.data = usp.toString();
        }
        const res = await api.request(cfg);
        return { status: res.status, data: res.data };
    }

    // ===== GitLab API wrappers =====

    const getMR = (iid) => http('get', `merge_requests/${iid}`);
    const updateMR = (iid, payload) => http('put', `merge_requests/${iid}`, { json: payload });
    const mergeMR = (iid, { whenPipelineSucceeds = false, merge_commit_message } = {}) => http('post', `merge_requests/${iid}/merge`, {
        json: { 
            merge_when_pipeline_succeeds: !!whenPipelineSucceeds, 
            should_remove_source_branch: false ,
            merge_commit_message
        },
        headers: { 'X-HTTP-Method-Override': 'PUT' } // né proxy chặn PUT
    });

    const createMRByAPI = (src, dst, changelogs, title, autoMerge) => http('post', 'merge_requests', {
        json: {
            source_branch: src,
            target_branch: dst,
            title: title ?? `Sync ${src} into ${dst}`,
            description: changelogs,
            merge_when_pipeline_succeeds: !!autoMerge
        }
    });

    const listOpenedMRByBranches = (src, dst) => http('get', `merge_requests?state=opened&source_branch=${encodeURIComponent(src)}&target_branch=${encodeURIComponent(dst)}`);

    const listTags = (perPage = 100, page = 1) => http('get', `repository/tags?per_page=${perPage}&page=${page}`);

    const createTag = (name, ref, message) => http('post', 'repository/tags', { form: { tag_name: name, ref, message } });
    const getBranchDiff = (from, to) => http(
        'get',
        `repository/compare?from=${encodeURIComponent(
            from
        )}&to=${encodeURIComponent(to)}`
    );

    // ===== Helpers: MR polling & tagging =====
    async function pollMergeable(iid, retries, delayMs) {
        let left = retries;
        while (left-- > 0) {
            const det = await getMR(iid);
            if (det.status !== 200) { await sleep(delayMs); continue; }
            const s = det.data || {};
            const status = s.detailed_merge_status || s.merge_status || '';
            const conf = !!s.has_conflicts;
            console.log(`⏳ MR !${iid} status=${status} conflicts=${conf} left=${left}`);
            if (status === 'mergeable' || status === 'can_be_merged' || status === 'ci_must_pass') {
                return status;
            }
            if (['conflicts', 'cannot_be_merged', 'ff_only_enabled', 'not_approved', 'discussions_not_resolved'].includes(status)) {
                throw new Error(`Blocked by: ${status}`);
            }
            await sleep(delayMs);
        }
        throw new Error('Not mergeable within poll window');
    }

    const TAG_REGEX = /^v\d+\.\d+\.\d+____\d{4,}$/;

    function sortVersionThenSeq(a, b) {
        const [va, sa] = a.split('____');
        const [vb, sb] = b.split('____');
        const pa = va.slice(1).split('.').map(Number);
        const pb = vb.slice(1).split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            const da = pa[i] || 0; const
                db = pb[i] || 0;
            if (da !== db) return da - db;
        }
        return parseInt(sa, 10) - parseInt(sb, 10);
    }

    function nextTagFrom(latestTag) {
        if (!latestTag) throw new Error('Lasted tags not found');
        const [ver, seq] = latestTag.split('_').filter(Boolean);
        const num = (parseInt(seq, 10) || 0) + 1;
        const padded = String(num).padStart(4, '0');
        return `${ver}____${padded}`;
    }

    async function computeNextTagName() {
        const names = [];
        for (let page = 1; page <= 3; page++) {
            const res = await listTags(100, page);
            if (res.status !== 200 || !Array.isArray(res.data) || res.data.length === 0) break;
            names.push(...res.data.map((t) => t.name));
            if (res.data.length < 100) break;
        }
        const valid = names.filter((n) => TAG_REGEX.test(n));
        if (!valid.length) return nextTagFrom(null);
        valid.sort(sortVersionThenSeq);
        return nextTagFrom(valid[valid.length - 1]);
    }

    // ===== Flow pieces =====
    async function ensureTargetIsMain(iid) {
        const det = await getMR(iid);
        if (det.status !== 200) throw new Error(`Get MR failed: ${det.status}`);
        const curTarget = det.data?.target_branch;
        const curSource = det.data?.source_branch;
        console.log(`ℹ️ MR !${iid}: ${curSource} -> ${curTarget}`);
        if (curTarget !== MAIN_BRANCH) {
            console.log(`🛠  Retarget MR !${iid} to ${MAIN_BRANCH}`);
            const upd = await updateMR(iid, { target_branch: MAIN_BRANCH });
            if (upd.status !== 200) throw new Error(`Retarget failed: ${upd.status}`);
        }
        return { source: det.data?.source_branch, target: MAIN_BRANCH };
    }

    async function mergeIntoMain(iid) {
        const status = await pollMergeable(iid, RETRIES, DELAY);
        const queueWhenCI = (status === 'ci_must_pass');
        console.log(`🔀 Merge MR !${iid} → ${MAIN_BRANCH} (queueWhenCI=${queueWhenCI})`);
        const merged = await mergeMR(iid, { whenPipelineSucceeds: queueWhenCI });
        if (![200, 201, 202].includes(merged.status)) {
            throw new Error(`Merge failed (${merged.status}): ${JSON.stringify(merged.data)}`);
        }
        console.log(`✅ Merge accepted (status=${merged.status}) state=${merged.data?.state}`);
    }


    async function createMR(fromBranch, toBranch, changLogs, title, autoMerge) {
        let mrIID;
        try {
            const cr = await createMRByAPI(fromBranch, toBranch, changLogs, title, autoMerge);
            if (cr.status === 201 && cr.data?.iid) {
                mrIID = cr.data.iid;
                console.log(`✅ Created deploy MR: !${mrIID}`);
            }
        } catch (_) { /* ignore, fallback to reuse */ }

        if (!mrIID) {
            const opened = await listOpenedMRByBranches(fromBranch, toBranch);
            if (opened.status !== 200 || !Array.isArray(opened.data) || opened.data.length === 0) {
                throw new Error(`No opened MR from ${MAIN_BRANCH} -> ${DEPLOY_BRANCH}; create failed and reuse not found.`);
            }
            mrIID = opened.data[0].iid;
            console.log(`ℹ️  Reuse deploy MR: !${mrIID}`);
        }

        if (!mrIID) {
            throw Error(`Create MR from ${fromBranch} to ${toBranch} failed`)
        }

        return mrIID
    }

    
    async function syncMainToDeployAndTag({ tag, tagsDesc, changelogs }) {
        // Create MR MAIN_BRANCH -> DEPLOY_BRANCH (or reuse)
        const title = `Changelogs SBX - ${moment(new Date()).format('DD/MM/YYYY HH:mm:ss')}`
        const mrIID = await createMR(MAIN_BRANCH, DEPLOY_BRANCH, changelogs, title)

        const status = await pollMergeable(mrIID, RETRIES, DELAY);
        const queueWhenCI = (status === 'ci_must_pass');
        console.log(`🔀 Merge deploy MR !${mrIID} (queueWhenCI=${queueWhenCI})`);
        const mergeMess = `${title}\n ${tagsDesc}`
        const merged = await mergeMR(mrIID, { whenPipelineSucceeds: queueWhenCI, merge_commit_message: mergeMess });
        if (![200, 201, 202].includes(merged.status)) {
            throw new Error(`Deploy merge failed (${merged.status}): ${JSON.stringify(merged.data)}`);
        }
        console.log(`✅ Deploy merge accepted (status=${merged.status})`);

        if ((DO_TAG || '').toLowerCase() !== 'true') {
            console.log('🏷️  Skip tagging (DO_TAG=false).');
            // Build and show merge commit URL even if tagging skipped
            const commitUrl = buildMergeCommitUrl(merged.data);
            if (commitUrl) console.log('🔗 Merge commit URL:', commitUrl);
            return commitUrl;
        }
        await createTagsForDeploy(tag)
        const gitUrl = buildMergeCommitUrl(merged.data);
        console.log('Deploy Succeeded::: ', gitUrl || '(commit URL unavailable)')
        return gitUrl;
    }

    // Build a web URL to the merge commit created by the deploy MR.
    // Prefer using the MR web_url returned by GitLab and replace the tail with the commit path.
    function buildMergeCommitUrl(mergeData) {
        try {
            if (!mergeData) return '';
            const sha = mergeData.merge_commit_sha || mergeData.sha; // possible fields
            const mrUrl = mergeData.web_url; // e.g. https://gitlab.com/group/project/-/merge_requests/123
            if (!sha || !mrUrl) return '';
            // Replace /-/merge_requests/<iid>[...optional suffix] with /-/commit/<sha>
            const url = mrUrl.replace(/\/\-\/merge_requests\/\d+.*$/, `/-/commit/${sha}`);
            return url;
        } catch (_) {
            return '';
        }
    }


    async function createTagsForDeploy(tagSBX, buildMessage) {
        let nextTag = ''
        if (!tagSBX) {
            nextTag = await computeNextTagName();
            console.log(`🏷️  Create tag ${nextTag} on ${DEPLOY_BRANCH}`);
        } else {
            nextTag = tagSBX
        }

        if (!nextTag) {
            console.log(`🏷️  Create tag on ${DEPLOY_BRANCH} failed`);
        }

        let tagsDesc = `Build sbx at: ${moment(new Date()).format('DD/MM/YYYY HH:mm:ss')}`
        if (buildMessage) {
            tagsDesc = buildMessage;
        }

        const tagRes = await createTag(nextTag, DEPLOY_BRANCH, tagsDesc);
        if (tagRes.status !== 201) {
            throw new Error(`Tag create failed (${tagRes.status}): ${JSON.stringify(tagRes.data)}`);
        }
        console.log(`✅ Tag created: ${tagRes.data?.name}`);
    }


    async function getChanges(sourceBranch, destinationBranch) {
        console.log(
            `📥 Getting commits present in ${sourceBranch} but not in ${destinationBranch}...`
        );

        try {
            // Compare from deploy -> main to list commits that exist on main and not on deploy
            const diff = await getBranchDiff(destinationBranch, sourceBranch);
            const commitChanges = [];

            if (diff.status !== 200) {
                throw new Error(`Failed to get diff: ${diff.status}`);
            }

            const { data } = diff;

            console.log(
                `\n=== COMMITS IN ${sourceBranch} NOT IN ${destinationBranch} ===`
            );

            const allCommits = Array.isArray(data.commits) ? data.commits : [];
            const commits = allCommits.filter((commit) => {
                const title = String(
                    commit.title || commit.message || ''
                ).toLowerCase();
                const isMergeByTitle = title.startsWith('merge ')
                    || title.includes('merge branch')
                    || title.includes('merge remote-tracking branch')
                    || title.includes('Changelogs SBX');
                const isMergeByParents = Array.isArray(commit.parent_ids)
                    && commit.parent_ids.length > 1;
                return !(isMergeByTitle || isMergeByParents);
            });

            if (commits.length === 0) {
                console.log(
                    '🎉 No incoming non-merge commits! Deploy branch is up to date with main.'
                );
                return {
                    commitChanges,
                    commits: [],
                    files: data.diffs || [],
                    totalCommits: 0,
                    totalFiles: (data.diffs || []).length
                };
            }

            console.log(
                `📝 ${commits.length} non-merge commits on ${sourceBranch} not in ${destinationBranch}:`
            );

            // Show commits oldest first
            [...commits].reverse().forEach((commit, index) => {
                const shortSha = commit.short_id || commit.id?.slice(0, 8);
                const { title } = commit;
                const messages = commit.message?.split('\n').filter(Boolean) ?? [];
                const author = commit.author_name;

                commitChanges.push(
                    {
                        index,
                        shortSha,
                        date: moment(new Date(commit.created_at || commit.committed_date)).format('DD/MM/YYYY'),
                        dateTime: moment(new Date(commit.created_at || commit.committed_date)).format('DD/MM/YYYY HH:mm'),
                        author,
                        title,
                        messages,

                    }
                )
            });

            return {
                commits,
                commitChanges,
                files: data.diffs || [],
                totalCommits: commits.length,
                totalFiles: (data.diffs || []).length
            };
        } catch (error) {
            console.log(`❌ Error getting incoming changes: ${error.message}`);
            // throw error;
        }
    }


    function getMarkdownChangelog(commits) {
        /**
  * Build changelog Markdown group theo ngày
  * @param {Array<{index:number, shortSha:string, date:string, dateTime:string, author:string, title:string, messages:string[]}>} commits
  * @returns {string}
  */
        if (!Array.isArray(commits) || commits.length === 0) {
            return "## 📝 Changelog\n\n_No commits found_";
        }

        // Gom commit theo ngày, giữ nguyên thứ tự xuất hiện
        const grouped = {};
        for (const c of commits) {
            if (!grouped[c.date]) grouped[c.date] = [];
            grouped[c.date].push(c);
        }

        let md = "## 📝 Changelog\n\n";
        for (const date of Object.keys(grouped)) {
            md += `### 📅 ${date}\n`;
            for (const c of grouped[date]) {
                md += `#### [${c.shortSha}] [${c.author}]: ${c.title}\n`;
                if (c.messages && c.messages.length > 1) {
                    for (let i = 1; i < c.messages.length; i++) {
                        md += ` ${c.messages[i]}\n`;
                    }

                } else {
                    md += '\n'
                }
                
            }
            // md += "\n";
        }

        return md.trim();

    }

    function getChangeLogsMessage(groupBy, commitChanges = [], markdown = true) {

        if(!groupBy || groupBy === 'none') {
            return commitChanges.map(commit => 
                {
                    let mess = `✍️ [${commit.shortSha}] 👳 ${commit.author} - ⏰ (${commit.dateTime})\n`
                    commit.messages.forEach((item, index) => {
                        mess += `   ✔️  ${item.trim().startsWith('-') ? item.replace('-', '').trim() : `${item}`}\n`;
                        
                    });
                    // mess += '________________________________________\n'
                    return mess
                }
            ).join('\n')
        }

        const messageGroup = _.groupBy(commitChanges, groupBy);
        const mess = [];
        for (const [groupName, commits] of Object.entries(messageGroup)) {
            const authorMess = [];
            authorMess.push(`\n ✾✾✾✾✾✾✾✾ 👉${groupName}👈 ✾✾✾✾✾✾✾✾`);
            commits.forEach((commit, index) => {
                // authorMess.push('--------------------------------------------------------');
                authorMess.push(`👉 [${commit.shortSha}] - 👳 ${commit.author} - ⏰ (${commit.dateTime}) `)
                authorMess.push('✍️  Changelogs:');
                commit.messages.forEach((item, index) => {
                    const mess = item.split('.').join('\n');
                    authorMess.push(`    ✔️  ${mess.trim().startsWith('-') ? mess.replace('-', '').trim() : `${mess}`}`);
                });
                authorMess.push('--------------------------------------------------------');
            });
            mess.push(authorMess.join('\n'));

        }
        return mess.join('\n');
    }

    /**
     * List all projects accessible by the token.
     * Auto handles pagination until no more pages.
     * @param {Object} opt
     * @param {number} [opt.perPage=100] - Items per page (max 100 per GitLab docs)
     * @param {number} [opt.maxPages=50] - Safety cap to prevent infinite loops
     * @param {string} [opt.search] - Optional search string
     * @returns {Promise<Array>} All project objects
     */
    async function getAllProjects({ perPage = 100, maxPages = 50, search } = {}) {
        // Use a root-level client because current api instance is scoped to a project id
        const root = axios.create({
            baseURL: `${HOST.replace(/\/+$/, '')}/api/v4`,
            timeout: 60_000,
            headers: { 'PRIVATE-TOKEN': TOK }
        });

        const all = [];
        for (let page = 1; page <= maxPages; page++) {
            const params = new URLSearchParams();
            params.set('per_page', String(perPage));
            params.set('page', String(page));
            // Order by last_activity to surface active projects first
            params.set('order_by', 'last_activity_at');
            params.set('sort', 'desc');
            if (search) params.set('search', search);
            try {
                const res = await root.get(`/projects?${params.toString()}`);
                if (res.status !== 200 || !Array.isArray(res.data)) break;
                all.push(...res.data);
                if (res.data.length < perPage) break; // last page
            } catch (err) {
                console.log('❌ getAllProjects error:', err.message);
                break;
            }
        }
        return all.map(item => ({ PID: item.id, projectName: item.name, mainBranch: item.default_branch, deployBranch: '' }));
    }
    // Usage example (outside):
    // const { getAllProjects } = core(config); (remember config.PID must be any accessible project just for initialization)
    // const projects = await getAllProjects({ search: 'gate' });
    // console.log(projects.map(p => `${p.id}: ${p.path_with_namespace}`));

    // ===== MAIN =====
    return {
        createMR,
        getMarkdownChangelog,
        ensureTargetIsMain,
        mergeIntoMain,
        syncMainToDeployAndTag,
        getChanges,
        getChangeLogsMessage,
        createTagsForDeploy,
        getAllProjects,
    }
}


module.exports = { core: main }
