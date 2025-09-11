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
        console.error('❌ Thiếu biến môi trường hoặc tham số.\n'
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
                console.error(`HTTP ${status} ${config?.method?.toUpperCase()} ${config?.url}`);
                if (typeof data === 'string') console.error(data.slice(0, 2000));
                else console.error(JSON.stringify(data, null, 2));
            } else {
                console.error('HTTP ERROR:', err.message);
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
    const mergeMR = (iid, { whenPipelineSucceeds = false } = {}) => http('post', `merge_requests/${iid}/merge`, {
        json: { merge_when_pipeline_succeeds: !!whenPipelineSucceeds, should_remove_source_branch: false },
        headers: { 'X-HTTP-Method-Override': 'PUT' } // né proxy chặn PUT
    });

    const createMR = (src, dst) => http('post', 'merge_requests', { json: { source_branch: src, target_branch: dst, title: `Sync ${src} into ${dst}` } });

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
        if (!latestTag) return 'v1.0.0____0001';
        const [ver, seq] = latestTag.split('____');
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

    async function syncMainToDeployAndTag(tagSBX, buildMessage = '') {
        // Create MR MAIN_BRANCH -> DEPLOY_BRANCH (or reuse)
        let mrIID;
        try {
            const cr = await createMR(MAIN_BRANCH, DEPLOY_BRANCH);
            if (cr.status === 201 && cr.data?.iid) {
                mrIID = cr.data.iid;
                console.log(`✅ Created deploy MR: !${mrIID}`);
            }
        } catch (_) { /* ignore, fallback to reuse */ }

        if (!mrIID) {
            const opened = await listOpenedMRByBranches(MAIN_BRANCH, DEPLOY_BRANCH);
            if (opened.status !== 200 || !Array.isArray(opened.data) || opened.data.length === 0) {
                throw new Error(`No opened MR from ${MAIN_BRANCH} -> ${DEPLOY_BRANCH}; create failed and reuse not found.`);
            }
            mrIID = opened.data[0].iid;
            console.log(`ℹ️  Reuse deploy MR: !${mrIID}`);
        }

        const status = await pollMergeable(mrIID, RETRIES, DELAY);
        const queueWhenCI = (status === 'ci_must_pass');
        console.log(`🔀 Merge deploy MR !${mrIID} (queueWhenCI=${queueWhenCI})`);
        const merged = await mergeMR(mrIID, { whenPipelineSucceeds: queueWhenCI });
        if (![200, 201, 202].includes(merged.status)) {
            throw new Error(`Deploy merge failed (${merged.status}): ${JSON.stringify(merged.data)}`);
        }
        console.log(`✅ Deploy merge accepted (status=${merged.status})`);

        if ((DO_TAG || '').toLowerCase() !== 'true') {
            console.log('🏷️  Skip tagging (DO_TAG=false).');
            return;
        }
        await createTagsForDeploy(tagSBX, buildMessage)
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
                    || title.includes('merge remote-tracking branch');
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
            console.error(`❌ Error getting incoming changes: ${error.message}`);
            throw error;
        }
    }


    function getChangeLogsMessage(groupBy, commitChanges = []) {
        const messageGroup = _.groupBy(commitChanges, groupBy);
        const mess = [];
        for (const [groupName, commits] of Object.entries(messageGroup)) {
            const authorMess = [];
            authorMess.push(`\n ✾✾✾✾✾✾✾✾ 👉${groupName}👈 ✾✾✾✾✾✾✾✾`);
            commits.forEach((commit, index) => {
                // authorMess.push('--------------------------------------------------------');
                authorMess.push(`👉 CommitID: [${commit.shortSha}]  ⏰ createdAt: [${commit.dateTime}]`)
                authorMess.push(`👳 Author: ${commit.author}`);
                authorMess.push('✍️  Changelogs:');
                commit.messages.forEach((item) => {
                    authorMess.push(`    ✔️  ${item.trim().startsWith('-') ? item.replace('-', '').trim() : `${item}`}`);
                });
                authorMess.push('--------------------------------------------------------');
            });
            mess.push(authorMess.join('\n'));

        }
        return mess.join('\n');
    }

    // ===== MAIN =====
    return {
        ensureTargetIsMain,
        mergeIntoMain,
        syncMainToDeployAndTag,
        getChanges,
        getChangeLogsMessage,
        createTagsForDeploy
    }
}


module.exports = { core: main }
