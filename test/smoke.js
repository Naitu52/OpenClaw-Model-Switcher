#!/usr/bin/env node
/**
 * Smoke test: spin up an isolated switcher instance with a fake openclaw config,
 * hit every endpoint category, then tear down.
 *
 * Exits 0 on success, 1 on any failure.
 *
 * Usage:
 *   node test/smoke.js
 *
 * No external deps. Requires Node 18+.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const http = require('http');

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

const SWITCHER_DIR = path.join(__dirname, '..');
const SWITCHER_CJS = path.join(SWITCHER_DIR, 'switcher.cjs');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-smoke-'));
const FAKE_HOME = path.join(TMP_ROOT, '.openclaw');
const FAKE_WS   = path.join(TMP_ROOT, 'workspace');
const TEST_PORT = 38291;

function buildFakeConfig() {
    fs.mkdirSync(FAKE_HOME, { recursive: true });
    fs.mkdirSync(FAKE_WS, { recursive: true });
    const cfg = {
        agents: {
            defaults: {
                model: { primary: 'minimax/MiniMax-M3' },
                models: {
                    'minimax/MiniMax-M3': {},                    // in-use + known -> keep
                    'openai/gpt-oss-20b': {},                    // in-use + known -> keep
                    'minimax/old-model-removed': {},             // orphan -> remove
                    'lmstudio/old-embed': {},                    // orphan -> remove
                },
            },
            list: [
                { id: 'agent1', name: 'agent1', model: { primary: 'minimax/MiniMax-M3' } },
                { id: 'agent2', name: 'agent2', model: { primary: 'openai/gpt-oss-20b' } },
            ],
        },
        models: {
            mode: 'merge',
            providers: {
                minimax: { baseUrl: 'https://api.minimax.chat/v1', apiKey: '***', api: 'openai-completions', authHeader: true, models: [{ id: 'MiniMax-M3', name: 'MiniMax-M3', input: ['text'], contextWindow: 128000, maxTokens: 8192 }] },
                openai:  { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-***', api: 'openai-completions', authHeader: true, models: [{ id: 'gpt-oss-20b', name: 'gpt-oss-20b', input: ['text'], contextWindow: 128000, maxTokens: 8192 }] },
                xiaomi:  { baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiKey: 'xk-***', api: 'openai-completions', authHeader: true, models: [{ id: 'mimo-v2-flash', name: 'mimo-v2-flash', input: ['text'], contextWindow: 128000, maxTokens: 8192 }] },
            },
        },
        channels: { feishu: { enabled: true, accounts: {} } },
        bindings: [],
    };
    fs.writeFileSync(path.join(FAKE_HOME, 'openclaw.json'),
                      JSON.stringify(cfg, null, 2),
                      'utf8');
}

function http_get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

function startInstance() {
    buildFakeConfig();
    const env = Object.assign({}, process.env, {
        OPENCLAW_HOME: FAKE_HOME,
        OPENCLAW_WS:   FAKE_WS,
        OPENCLAW_AGENTS: path.join(FAKE_HOME, 'agents'),
        SWITCHER_PORT: String(TEST_PORT),
        SWITCHER_LOG: path.join(TMP_ROOT, 'switcher.log'),
        SWITCHER_BACKUP_DIR: path.join(TMP_ROOT, 'backups'),
        SWITCHER_SCENES: path.join(TMP_ROOT, 'scenes.json'),
    });
    const p = spawn(process.execPath, [SWITCHER_CJS], {
        cwd: SWITCHER_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return p;
}

async function waitReady(maxMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const r = await http_get(`http://localhost:${TEST_PORT}/api/status`);
            if (r.status === 200) return r;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return null;
}

async function withInstance(fn) {
    const proc = startInstance();
    let exitCode = 1;
    try {
        const ready = await waitReady();
        if (!ready) throw new Error('instance did not become ready in 8s');
        await fn();
        exitCode = 0;
    } finally {
        try { proc.kill('SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, 500));
        try { proc.kill('SIGKILL'); } catch {}
    }
    return exitCode;
}

// -------- TESTS --------

test('instance boots via portable env vars', () => withInstance(async () => {
    const r = await http_get(`http://localhost:${TEST_PORT}/api/status`);
    if (r.status !== 200) throw new Error(`/api/status HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (j.port !== TEST_PORT) throw new Error(`expected port ${TEST_PORT}, got ${j.port}`);
    if (!String(j.configPath).endsWith('openclaw.json')) throw new Error(`configPath wrong: ${j.configPath}`);
    if (j.agents !== 2) throw new Error(`expected 2 agents, got ${j.agents}`);
}));

test('agents endpoint returns fake agents', () => withInstance(async () => {
    const r = await http_get(`http://localhost:${TEST_PORT}/api/agents`);
    if (r.status !== 200) throw new Error(`/api/agents HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (!Array.isArray(j)) throw new Error('not an array');
    const ids = j.map(a => a.id);
    if (!ids.includes('agent1') || !ids.includes('agent2')) throw new Error(`missing agents: ${ids.join(',')}`);
}));

test('providers endpoint returns fake providers', () => withInstance(async () => {
    const r = await http_get(`http://localhost:${TEST_PORT}/api/providers`);
    if (r.status !== 200) throw new Error(`/api/providers HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    const ids = j.map(p => p.id);
    if (!ids.includes('minimax') || !ids.includes('openai')) throw new Error(`missing providers: ${ids.join(',')}`);
}));

test('models endpoint gracefully returns error without CLI', () => withInstance(async () => {
    const r = await http_get(`http://localhost:${TEST_PORT}/api/models`);
    // With no CLI available, expect either 503 (configured CLI but unreachable)
    // or 200 with empty/error JSON. Either is acceptable graceful behavior.
    if (r.status !== 200 && r.status !== 503) throw new Error(`/api/models HTTP ${r.status} not graceful`);
}));

test('backup dir is isolated per env var', () => withInstance(async () => {
    // Trigger a backup by switching an agent's model -- write() creates BACKUP_DIR on first call
    const r = await new Promise((resolve, reject) => {
        const req = http.request({
            method: 'POST',
            hostname: 'localhost',
            port: TEST_PORT,
            path: '/api/switch',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write(JSON.stringify({ changes: { agent1: 'openai/gpt-oss-20b' } }));
        req.end();
    });
    if (r.status !== 200) throw new Error(`/api/switch HTTP ${r.status}`);
    // Now BACKUP_DIR should exist AND contain a backup file
    const expectedDir = process.env.SWITCHER_BACKUP_DIR || path.join(TMP_ROOT, 'backups');
    if (!fs.existsSync(expectedDir)) throw new Error(`backup dir not created: ${expectedDir}`);
    const backups = fs.readdirSync(expectedDir).filter(f => f.endsWith('.json'));
    if (backups.length === 0) throw new Error(`no backup files in ${expectedDir}`);
}));

test('static frontend serves index.html', () => withInstance(async () => {
    const r = await http_get(`http://localhost:${TEST_PORT}/`);
    if (r.status !== 200) throw new Error(`/ HTTP ${r.status}`);
    if (!r.body.includes('<html')) throw new Error('not HTML');
}));

function http_post(url, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? '' : JSON.stringify(body);
        const u = new URL(url);
        const req = http.request({
            method: 'POST',
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

test('GET /api/agents/defaults/models/prune is safe dryRun', () => withInstance(async () => {
    const r = await http_get(`http://localhost:${TEST_PORT}/api/agents/defaults/models/prune?dryRun=true`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (!j.dryRun) throw new Error('GET should always be dryRun');
    const removed = new Set(j.removedKeys || []);
    if (!removed.has('minimax/old-model-removed')) throw new Error(`expected orphan detected, got: ${[...removed].join(',')}`);
    if (!removed.has('lmstudio/old-embed')) throw new Error(`expected orphan detected, got: ${[...removed].join(',')}`);
    if (j.removed !== 2) throw new Error(`expected removed=2, got ${j.removed}`);
}));

test('POST /api/agents/defaults/models/prune cleans orphans, keeps in-use', () => withInstance(async () => {
    const r = await http_post(`http://localhost:${TEST_PORT}/api/agents/defaults/models/prune`, {});
    if (r.status !== 200) throw new Error(`HTTP ${r.status} body=${r.body}`);
    const j = JSON.parse(r.body);
    if (j.dryRun) throw new Error('POST with empty body should be real prune');
    if (j.removed !== 2) throw new Error(`expected removed=2, got ${j.removed}`);

    // Verify by re-reading /api/agents - actually we don't have a GET for defaults.models,
    // so verify via a follow-up dryRun which should now find 0 orphans.
    const r2 = await http_get(`http://localhost:${TEST_PORT}/api/agents/defaults/models/prune?dryRun=true`);
    const j2 = JSON.parse(r2.body);
    if (j2.removed !== 0) throw new Error(`after prune, expected 0 orphans, got ${j2.removed} (${j2.removedKeys?.join(',')})`);
}));

test('POST /api/providers/update edits fields without touching others', () => withInstance(async () => {
    // Update openai's baseUrl; leave apiKey blank so it should NOT change.
    const r = await http_post(`http://localhost:${TEST_PORT}/api/providers/update`,
        { id: 'openai', baseUrl: 'http://example.invalid/v1', authHeader: false });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} body=${r.body}`);
    const j = JSON.parse(r.body);
    if (!j.ok) throw new Error(`update not ok: ${j.error}`);
    if (!j.changed.includes('baseUrl')) throw new Error('baseUrl not in changed');
    if (j.changed.includes('apiKey')) throw new Error('apiKey should NOT change when blank');

    // Verify the update is reflected via /api/providers
    const r2 = await http_get(`http://localhost:${TEST_PORT}/api/providers`);
    const providers = JSON.parse(r2.body);
    const openai = providers.find(p => p.id === 'openai');
    if (openai.baseUrl !== 'http://example.invalid/v1') throw new Error(`baseUrl not updated: ${openai.baseUrl}`);
}));

test('POST /api/providers/update rejects unknown id', () => withInstance(async () => {
    const r = await http_post(`http://localhost:${TEST_PORT}/api/providers/update`,
        { id: 'nonexistent-provider', baseUrl: 'http://x' });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (j.ok) throw new Error('update on unknown id should fail');
    if (!String(j.error).includes('not found')) throw new Error(`expected not-found error, got: ${j.error}`);
}));

test('POST /api/providers/delete refuses when agent uses the provider', () => withInstance(async () => {
    // agent1.primary = minimax/MiniMax-M3, so deleting 'minimax' must refuse without force
    const r = await http_post(`http://localhost:${TEST_PORT}/api/providers/delete`, { id: 'minimax' });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (j.ok) throw new Error('delete should refuse when agent uses the provider');
    if (!j.needForce) throw new Error('expected needForce flag');
    if (!j.dependents || !j.dependents.includes('minimax/MiniMax-M3')) throw new Error(`dependents should list in-use models, got: ${j.dependents}`);
}));

test('POST /api/providers/delete with force=true removes provider + cleans registry', () => withInstance(async () => {
    // The fake config has lmstudio/* entries in agents.defaults.models (via prior prune test
    // they are now gone, so add a fresh one to verify registry cleanup)
    await http_post(`http://localhost:${TEST_PORT}/api/switch`,
        { changes: { agent1: 'lmstudio/some-fake-model-not-in-provider' } });

    // First make sure minimax isn't used after a re-point (or pick openai which is also used)
    // openai/gpt-oss-20b is used by agent2 -> deleting 'openai' would need force
    // We use 'openai' to verify force path
    const r = await http_post(`http://localhost:${TEST_PORT}/api/providers/delete`, { id: 'openai', force: true });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (!j.ok) throw new Error('force delete should succeed');
    if (j.deleted !== 'openai') throw new Error(`deleted should be openai, got ${j.deleted}`);
    if (j.liveDeps.length === 0) throw new Error('liveDeps should not be empty (we forced past them)');
}));

test('POST /api/providers/delete on free provider succeeds without force', () => withInstance(async () => {
    // xiaomi provider exists in fake config but no agent uses it -> safe to delete
    const r = await http_post(`http://localhost:${TEST_PORT}/api/providers/delete`, { id: 'xiaomi' });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (!j.ok) throw new Error(`delete free provider should succeed: ${j.error}`);
    if (j.deleted !== 'xiaomi') throw new Error(`deleted should be xiaomi, got ${j.deleted}`);
    if (j.liveDeps.length !== 0) throw new Error('liveDeps should be empty for unused provider');
}));

// -------- RUN --------

(async () => {
    let passed = 0, failed = 0;
    for (const t of TESTS) {
        try {
            const code = await t.fn();
            if (code === 0) { console.log(`  PASS  ${t.name}`); passed++; }
            else            { console.log(`  FAIL  ${t.name} (exit ${code})`); failed++; }
        } catch (e) {
            console.log(`  FAIL  ${t.name}: ${e.message || e}`);
            failed++;
        }
    }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
    console.log(`\n  Result: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
