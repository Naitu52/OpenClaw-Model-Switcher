#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');

// ============================================================
// PORTABLE PATH CONFIGURATION  v6
// Override via env vars:
//   OPENCLAW_HOME   .openclaw directory
//   OPENCLAW_WS     workspace directory
//   OPENCLAW_AGENTS agents directory
//   OPENCLAW_CLI    path to openclaw.mjs / dist/index.js
//   FEISHU_REG      path to app-registration-*.js
//   OPENCLAW_NODE   node binary (default: node on PATH)
//   SWITCHER_PORT   TCP port (default 2325)
// Detection order: env > machine-known > OS default > CWD relative
// Missing things degrade gracefully (warnings logged, API returns 503).
// ============================================================

function firstExisting(...paths) {
    for (const p of paths) if (p && fs.existsSync(p)) return p;
    return null;
}

// ============================================================
// DEEP SEARCH HELPERS  (Step 5 of detection order — slower,
// bounded, but thorough when env + conventions fail)
// ============================================================

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'recycle.bin', 'system volume information',
    'windows', 'program files', 'program files (x86)',
    'programdata', 'recovery', 'perflogs', '$winre',
    'config.msi', '.cache', '.local', '.npm', '.nvm',
    '.config', '.gradle', '.m2', '.vscode', '.idea',
    'snap', 'proc', 'sys', 'dev', 'run', 'lost+found',
    'var', 'private', 'tmp', 'etc',
]);

// Enumerate mounted Windows drive roots (A: through Z:). Replaces the old
// hardcoded 'D:\\' hint so users with openclaw on any drive get discovered.
function listWindowsDrives() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const drive = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(drive)) out.push(drive); } catch (e) {}
  }
  return out;
}

function quickParents() {
    const all = process.platform === 'win32' ? [
        ...listWindowsDrives(),
        process.env.ProgramFiles || 'C:\\Program Files',
        path.join(process.env.APPDATA || '', '..', '..'),
        path.join(os.homedir(), '..'),
    ] : process.platform === 'darwin' ? [
        '/opt', '/usr/local', path.join(os.homedir(), '..'), os.homedir(),
    ] : [
        '/opt', '/usr/local', '/srv',
        path.join(os.homedir(), '..'), os.homedir(),
    ];
    return all.filter(p => p && fs.existsSync(p));
}

function boundedHomeScan(roots, maxDepth, maxDirsPerLevel, timeoutMs) {
    const start = Date.now();
    const found = [];
    const seen = new Set();
    function check(dir) {
        if (Date.now() - start > timeoutMs || found.length >= 5) return false;
        if (seen.has(dir)) return false;
        seen.add(dir);
        try { if (fs.existsSync(path.join(dir, 'openclaw.json'))) return dir; } catch {}
        return false;
    }
    function walk(parent, depth) {
        if (Date.now() - start > timeoutMs || found.length >= 5) return;
        if (depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return; }
        let n = 0;
        for (const e of entries) {
            if (Date.now() - start > timeoutMs || found.length >= 5) return;
            if (n >= maxDirsPerLevel) break;
            n++;
            const lower = e.name.toLowerCase();
            // NOTE: do NOT skip all dot-dirs — OpenClaw's home dir is named
            // `.openclaw`; skipping dots made deep-search never find it.
            // Known-noise dot dirs live in SKIP_DIRS instead.
            if (!e.isDirectory() || SKIP_DIRS.has(lower) || e.name.startsWith('$')) continue;
            const sub = path.join(parent, e.name);
            if (check(sub)) { found.push(sub); continue; }
            walk(sub, depth + 1);
        }
    }
    for (const r of roots) {
        if (Date.now() - start > timeoutMs || found.length >= 5) break;
        try { if (fs.existsSync(r)) walk(r, 0); } catch {}
    }
    return found;
}

function findOpenClawFromNpmGlobal() {
    try {
        // npm is a .cmd on Windows; spawn it directly (no shell:true, which
        // triggers Node 22+ DEP0190 and concatenates args unsafely).
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const sp = spawnSync(npmCmd, ['root', '-g'], {
            encoding: 'utf8', timeout: 5000
        });
        if (!sp.stdout) return null;
        const npmRoot = sp.stdout.trim();
        const npmParent = path.dirname(npmRoot);
        const candidates = [
            path.join(npmParent, '.openclaw'),
            path.join(npmRoot, 'openclaw', '.openclaw'),
            path.join(npmRoot, '.openclaw'),
            path.join(npmRoot, '..', '.openclaw'),
        ];
        for (const r of candidates) {
            try { if (fs.existsSync(path.join(r, 'openclaw.json'))) return r; } catch {}
        }
    } catch {}
    return null;
}

function findOpenClawCliViaNpmGlobal() {
    try {
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const sp = spawnSync(npmCmd, ['root', '-g'], {
            encoding: 'utf8', timeout: 5000
        });
        if (sp.stdout) {
            const cli = path.join(sp.stdout.trim(), 'openclaw', 'openclaw.mjs');
            if (fs.existsSync(cli)) return cli;
        }
    } catch {}
    return null;
}

function findOpenClawViaPathCmd() {
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const sp = spawnSync(cmd, ['openclaw'], {
            encoding: 'utf8', timeout: 3000, shell: true
        });
        if (!sp.stdout) return null;
        for (const line of sp.stdout.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const ext = path.extname(trimmed).toLowerCase();
            if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
                if (fs.existsSync(trimmed)) return trimmed;
                continue;
            }
            // npm shim (.cmd or extension-less shell script): node can't run
            // it, but its directory reveals the real module layout:
            //   <bin-dir>/node_modules/openclaw/openclaw.mjs
            const shimDir = path.dirname(trimmed);
            for (const cand of [
                path.join(shimDir, 'node_modules', 'openclaw', 'openclaw.mjs'),
                path.join(shimDir, '..', 'node_modules', 'openclaw', 'openclaw.mjs'),
                path.join(shimDir, '..', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'),
            ]) {
                try { if (fs.existsSync(cand)) return cand; } catch {}
            }
        }
    } catch {}
    return null;
}

function detectOpenClawHome() {
    // Validate by checking openclaw.json exists inside the dir
    if (process.env.OPENCLAW_HOME
        && fs.existsSync(path.join(process.env.OPENCLAW_HOME, 'openclaw.json')))
        return process.env.OPENCLAW_HOME;

    const wins = [
        'C:\\openclaw\\.openclaw',
        path.join(process.env.APPDATA || '', 'openclaw'),
    ];
    const nix = [
        path.join(os.homedir(), '.openclaw'),
        path.join(os.homedir(), '.config', 'openclaw'),
        '/opt/openclaw',
        '/srv/openclaw',
    ];
    const cands = process.platform === 'win32' ? wins : nix;

    // Prefer directories that actually contain openclaw.json
    for (const p of cands) {
        if (p && fs.existsSync(path.join(p, 'openclaw.json'))) return p;
    }

    // Deep search 1: npm root -g finds globally-installed openclaw,
    //              then look for .openclaw in standard siblings
    const fromNpm = findOpenClawFromNpmGlobal();
    if (fromNpm) return fromNpm;

    // Deep search 2: bounded parent-directory scan for openclaw.json
    //  (skips node_modules/system dirs, depth <= 3, 3-second timebox)
    const parents = quickParents();
    const bounded = boundedHomeScan(parents, 3, 30, 3000);
    if (bounded.length) return bounded[0];

    // Fallback: first existing dir (caller will see Config read failed)
    return firstExisting(...cands) || cands[0] || path.join(os.homedir(), '.openclaw');
}

function detectOpenClawWs(home) {
    if (process.env.OPENCLAW_WS && fs.existsSync(process.env.OPENCLAW_WS))
        return process.env.OPENCLAW_WS;
    const sibling = path.join(path.dirname(home), 'workspace');
    if (fs.existsSync(sibling)) return sibling;
    // Never return null: `sibling` is the last resort even if it doesn't
    // exist yet (agent create will mkdir it). A null WS_ROOT made every
    // agent/file endpoint crash with TypeError.
    return firstExisting(
        'C:\\openclaw\\workspace',
        path.join(os.homedir(), 'workspace'),
        sibling
    ) || sibling;
}

function detectOpenClawAgents(home) {
    return process.env.OPENCLAW_AGENTS
        && fs.existsSync(process.env.OPENCLAW_AGENTS)
        ? process.env.OPENCLAW_AGENTS
        : path.join(home, 'agents');
}

function detectOpenClawCli() {
    if (process.env.OPENCLAW_CLI && fs.existsSync(process.env.OPENCLAW_CLI))
        return process.env.OPENCLAW_CLI;

    // Deep search 1: npm root -g
    const fromNpmCli = findOpenClawCliViaNpmGlobal();
    if (fromNpmCli) return fromNpmCli;

    // Deep search 2: which (Unix) / where (Windows)
    const fromPath = findOpenClawViaPathCmd();
    if (fromPath) return fromPath;

    const cands = process.platform === 'win32' ? [
        'C:\\Program Files\\nodejs\\node_modules\\openclaw\\openclaw.mjs',
        path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'),
        path.join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'),
    ] : process.platform === 'darwin' ? [
        '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
        '/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs',
        path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'),
    ] : [
        '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
        '/usr/lib/node_modules/openclaw/openclaw.mjs',
        path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'),
    ];
    for (let d = process.cwd(); d !== path.dirname(d); d = path.dirname(d)) {
        cands.push(path.join(d, 'node_modules', 'openclaw', 'openclaw.mjs'));
    }
    return firstExisting(...cands);
}

function detectFeishuReg(cliPath) {
    if (process.env.FEISHU_REG && fs.existsSync(process.env.FEISHU_REG))
        return process.env.FEISHU_REG;
    if (!cliPath) return null;
    const dirs = [
        path.join(path.dirname(cliPath), '..', 'dist'),
        path.join(path.dirname(cliPath), 'dist'),
        path.join(path.dirname(cliPath), '..', '..', 'dist'),
    ];
    for (const d of dirs) {
        if (!fs.existsSync(d)) continue;
        try {
            const m = fs.readdirSync(d).find(f =>
                f.startsWith('app-registration-') && f.endsWith('.js')
            );
            if (m) return path.join(d, m);
        } catch {}
    }
    return null;
}

const SCRIPT_DIR      = __dirname;
const OPENCLAW_HOME   = detectOpenClawHome();
const WS_ROOT         = detectOpenClawWs(OPENCLAW_HOME);
const AGENT_ROOT      = detectOpenClawAgents(OPENCLAW_HOME);
const CLI             = detectOpenClawCli();
const FEISHU_REG_PATH = detectFeishuReg(CLI);

const CONFIG     = path.join(OPENCLAW_HOME, 'openclaw.json');
const HTML       = path.join(SCRIPT_DIR, 'index.html');
// Mutable state paths: env override > user-writable home dir (multi-instance safe)
const USER_DATA_DIR = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'OpenClawModelSwitcher')
    : path.join(os.homedir(), '.openclaw-model-switcher');
const LOG        = process.env.SWITCHER_LOG        || path.join(USER_DATA_DIR, 'switcher.log');
const BACKUP_DIR = process.env.SWITCHER_BACKUP_DIR || path.join(USER_DATA_DIR, 'backups');
const SCENES     = process.env.SWITCHER_SCENES     || path.join(USER_DATA_DIR, 'scenes.json');

let PORT = parseInt(process.env.SWITCHER_PORT) || 2325;
const MAX_PORT_TRIES = 10;

// 兜底：未捕获异常 / 拒绝 promise 不再静默退出 —— 把 stack 写日志并继续跑。
// 不修老问题，只确保以后再崩也能看到原因。
process.on('uncaughtException', (e) => {
  try { log(`UNCAUGHT: ${e?.stack || e}`); } catch {}
});
process.on('unhandledRejection', (e) => {
  try { log(`UNHANDLED-REJECTION: ${e?.stack || e}`); } catch {}
});

// Node binary used for every CLI invocation: OPENCLAW_NODE > process.execPath.
// process.execPath is the node that launched THIS process — always resolvable,
// unlike bare 'node' which depends on PATH and silently fails under the
// scheduled-task environment (whose PATH has no node) → empty model lists.
const NODE_BIN = (process.env.OPENCLAW_NODE || '').trim() || process.execPath;

// Package version, surfaced via /api/status so the UI badge never drifts.
const PACKAGE_VERSION = (() => {
  try { return require(path.join(SCRIPT_DIR, 'package.json')).version; } catch { return '6.5.3'; }
})();

// Boot diagnostic
console.log('[paths] home=' + OPENCLAW_HOME);
console.log('[paths] ws=' + WS_ROOT);
console.log('[paths] agents=' + AGENT_ROOT);
console.log('[paths] cli=' + (CLI || 'NONE'));
console.log('[paths] feishu_reg=' + (FEISHU_REG_PATH || 'NONE'));
console.log('[paths] port=' + PORT);
console.log('[paths] user_data=' + USER_DATA_DIR);
console.log('[paths] log=' + LOG);
console.log('[paths] backup_dir=' + BACKUP_DIR);
console.log('[paths] scenes=' + SCENES);

// Frontend assets served over HTTP; everything else in SCRIPT_DIR stays private.
const STATIC_ALLOW = new Set(['index.html', 'vue.global.prod.js']);

const CATALOG = [
  { id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com' },
  { id:'openai',name:'OpenAI',baseUrl:'https://api.openai.com/v1' },
  { id:'anthropic',name:'Anthropic',baseUrl:'https://api.anthropic.com' },
  { id:'qwen',name:'Qwen (阿里)',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id:'kimi',name:'Kimi (月之暗面)',baseUrl:'https://api.moonshot.cn/v1' },
  { id:'glm',name:'GLM (智谱)',baseUrl:'https://open.bigmodel.cn/api/paas/v4' },
  { id:'xiaomi',name:'Xiaomi MiMo',baseUrl:'https://api.xiaomi.ai' },
  { id:'volcengine',name:'豆包 (火山引擎)',baseUrl:'https://ark.cn-beijing.volces.com/api/v3' },
  { id:'stepfun',name:'阶跃星辰',baseUrl:'https://api.stepfun.com/v1' },
  { id:'mistral',name:'Mistral AI',baseUrl:'https://api.mistral.ai/v1' },
  { id:'minimax',name:'MiniMax',baseUrl:'https://api.minimax.chat/v1' },
  { id:'minimax-cn',name:'MiniMax 国内',baseUrl:'https://api.minimax.chat/v1' },
  { id:'minimax-portal',name:'MiniMax Portal',baseUrl:'https://api.minimax.chat/v1' },
  { id:'minimax-portal-cn',name:'MiniMax Portal CN',baseUrl:'https://api.minimax.chat/v1' },
  { id:'moonshot',name:'月之暗面 (Moonshot)',baseUrl:'https://api.moonshot.cn/v1' },
  { id:'nvidia',name:'NVIDIA',baseUrl:'https://integrate.api.nvidia.com/v1' },
  { id:'lmstudio',name:'LM Studio (本地)',baseUrl:'http://localhost:1234/v1' },
  { id:'volcengine-plan',name:'火山引擎计划版',baseUrl:'https://ark.cn-beijing.volces.com/api/v3' },
  { id:'byteplus',name:'BytePlus',baseUrl:'https://ark.cn-beijing.volces.com/api/v3' },
  { id:'byteplus-plan',name:'BytePlus Plan',baseUrl:'https://ark.cn-beijing.volces.com/api/v3' },
  { id:'novita',name:'Novita AI',baseUrl:'https://api.novita.ai/v3/openai' },
  { id:'ollama',name:'Ollama (本地)',baseUrl:'http://localhost:11434/v1' },
  { id:'ollama-cloud',name:'Ollama Cloud',baseUrl:'https://api.ollama.com/v1' },
];

function ts() {
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
function log(m) { const l=`[${ts()}] ${m}`; try { fs.appendFileSync(LOG,l+'\n'); } catch {} console.log(l); }
function read() { return JSON.parse(fs.readFileSync(CONFIG,'utf8')); }

// ---- Write lock + backup debounce ----
// All mutations to openclaw.json route through mutate(fn) so concurrent
// requests can't race (read-modify-write was unprotected before). Each
// mutation runs strictly serially.
let writeChain = Promise.resolve();
let lastBackupAt = 0;
const BACKUP_DEBOUNCE_MS = 3000;  // skip backup if last backup was within 3s
const BACKUP_KEEP = 20;          // 快照保留份数（100 份 = 14MB，20 份足够回滚）
async function mutate(fn) {
  const prev = writeChain;
  let release;
  writeChain = new Promise(r => { release = r; });
  try {
    await prev;             // wait for any in-flight write to finish
    const cfg = read();
    const result = await fn(cfg);
    write(cfg);
    return result;
  } finally {
    release();
  }
}

// 同步版 mutate（用于 secrets 迁移这种：内部多次 set + 一次写）。注意：调用方要确保不与 mutate 并发。
function mutateSync(fn) {
  const cfg = read();
  const result = fn(cfg);
  if (result === false) return false;
  write(cfg);
  return result !== undefined ? result : true;
}

// 递归 diff 两个 JSON 对象，返回 [{path, op, oldVal, newVal}] 列表。
// op ∈ {added, removed, changed}。只记录叶子节点差异。
function computeJsonDiff(a, b, prefix) {
  const out = [];
  const seen = new Set();
  if (a && typeof a === 'object' && b && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const ap = prefix ? `${prefix}.${k}` : k;
      seen.add(k);
      if (!(k in a)) out.push({ path: ap, op: 'added', newVal: b[k] });
      else if (!(k in b)) out.push({ path: ap, op: 'removed', oldVal: a[k] });
      else if (typeof a[k] === 'object' && typeof b[k] === 'object' && a[k] && b[k] && !Array.isArray(a[k]) && !Array.isArray(b[k])) {
        out.push(...computeJsonDiff(a[k], b[k], ap));
      } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        out.push({ path: ap, op: 'changed', oldVal: a[k], newVal: b[k] });
      }
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path: prefix || '<root>', op: 'changed', oldVal: a, newVal: b });
  }
  return out;
}

// #6b: scenes 文件独立串行链——readScenes+writeScenes 全程在锁内，
// 防并发覆盖（rename 迁移场景键 vs scenes/save 同时写）。
let scenesChain = Promise.resolve();
async function mutateScenes(fn) {
  const prev = scenesChain;
  let release;
  scenesChain = new Promise(r => { release = r; });
  try {
    await prev;
    const r = readScenes();
    if (!r.ok) return r;
    const result = await fn(r.scenes);
    if (result && result.changed) writeScenes(r.scenes);
    return result;
  } finally {
    release();
  }
}

function write(cfg) {
  // 内容没变就完全不碰文件。
  // openclaw.json 的 mtime 变化会被 gateway 的配置 watcher 捕获；一旦改到
  // models.providers.*.models 就会触发整机重启（实测停机 200~330s）。
  // 所以只有内容真的变了才写、才清缓存、才备份。
  const next = JSON.stringify(cfg,null,2);
  let cur = null;
  try { cur = fs.readFileSync(CONFIG,'utf8'); } catch(e){}
  if (cur !== null && cur === next) return false;
  // 配置已变更：CLI 模型列表缓存与飞书诊断缓存立即失效，
  // 否则 probe/update 之后最多滞后 10s/15s（非实时）。
  modelsCache = null; modelsCacheAt = 0;
  diagCache = null; diagCacheAt = 0;
  provAvailCache = null; provAvailCacheAt = 0;
  const tmp=CONFIG+'.new';
  fs.writeFileSync(tmp,next,'utf8');
  fs.renameSync(tmp,CONFIG);
  if(!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR,{recursive:true});
  // Debounce: skip backup if one was made very recently (avoids 3 backups
  // for a doSwitch+doProbe+doUpdate sequence within a second).
  const now = Date.now();
  if (now - lastBackupAt > BACKUP_DEBOUNCE_MS) {
    const bak=path.join(BACKUP_DIR,`openclaw-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    try { fs.copyFileSync(CONFIG,bak); lastBackupAt = now; } catch(e) {}
  }
  try { fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json')).sort().reverse().slice(BACKUP_KEEP).forEach(f=>fs.unlinkSync(path.join(BACKUP_DIR,f))); } catch(e) {}
  return true;
}

// ---- Error codes (stable, machine-readable) ----
const E = {
  NOT_FOUND: 'NOT_FOUND',
  IN_USE: 'IN_USE',
  INVALID_ID: 'INVALID_ID',
  MISSING_FIELD: 'MISSING_FIELD',
  INVALID_FIELD: 'INVALID_FIELD',
  CLI_MISSING: 'CLI_MISSING',
  FEISHU_MISSING: 'FEISHU_MISSING',
  PROBE_FAILED: 'PROBE_FAILED',
  IO_ERROR: 'IO_ERROR',
  PATH_DENIED: 'PATH_DENIED',
};
function err(res, code, message, http=400, extra={}) {
  return json(res, { ok: false, error: message, code, ...extra }, http);
}

// ---- Validation helpers ----
function validateAgentId(id) {
  return typeof id === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{1,30}$/.test(id);
}
function validateProviderId(id) {
  // 支持中文等 Unicode id（用户可能用「空氧API」这类名字），但拒绝：
  //   - 原型污染键（H2）
  //   - 路径分隔符/空字节（防拼接逃逸）
  //   - '..' 与首尾空格（防混淆）
  return typeof id === 'string' && id.length >= 1 && id.length <= 40
    && !/^(__proto__|constructor|prototype)$/.test(id)
    && !/[\/\\\0]/.test(id)
    && !id.includes('..')
    && id.trim() === id;
}

// ============================================================================
// 2026.9+ openclaw 适配：agents.list (array) → agents.entries (keyed),
//                          agents.defaults.models (dict) → modelPolicy.allow (array)
// 详见 README "OpenClaw 2026.9+ Compatibility" 段
// ============================================================================

// 读 agents.entries (keyed object) → 数组形式 [{id, ...entry}]
// openclaw 2026.9 把 agents.list (array) 改为 agents.entries (keyed map)：
//   旧: agents.list = [{id:"main", model:{primary:"..."}, workspace:"..."}, ...]
//   新: agents.entries = { main: {model:{primary:"..."}, workspace:"..."}, ... }
// 用这个 helper 保留老代码语义（list 数组、.id 字段、.find/.filter）。
function entriesAsList(c) {
  const e = c && c.agents && c.agents.entries;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    return Object.entries(e).map(([id, v]) => Object.assign({ id }, v || {}));
  }
  // Fallback: 旧结构 agents.list 数组仍存在时（升级半途状态）照样要能列出 agent，
  // 否则 dashboard 会显示 0 个 agent，且依赖 agent 的保护逻辑（如 provider 删除
  // 的 in-use 判定）会失效。
  const l = c && c.agents && c.agents.list;
  if (Array.isArray(l)) return l.filter(a => a && typeof a === 'object').map(a => Object.assign({}, a));
  return [];
}

// 从 c.agents.entries 取单个 entry (兼容 list 旧形态做 fallback)
function entryById(c, id) {
  if (!c || !c.agents) return undefined;
  if (c.agents.entries && Object.prototype.hasOwnProperty.call(c.agents.entries, id)) {
    return Object.assign({ id }, c.agents.entries[id] || {});
  }
  // Fallback: 老结构 agents.list 仍存在时（升级半途状态）
  if (Array.isArray(c.agents.list)) {
    return c.agents.list.find(a => a && a.id === id);
  }
  return undefined;
}

// 取默认 agent id：先 default:true 标记的，没有就 list/entries 第一个，再没有 'main'
function resolveDefaultAgentId(c) {
  const list = entriesAsList(c);
  const defs = list.filter(a => a.default);
  return String((defs.length ? defs[0] : list[0] || {}).id || 'main').trim();
}

// 写入/删除单个 agent entry
function setEntry(c, id, entry) {
  if (!c.agents) c.agents = { defaults: {}, entries: {} };
  if (!c.agents.entries || typeof c.agents.entries !== 'object') c.agents.entries = {};
  if (entry === null || entry === undefined) {
    delete c.agents.entries[id];
  } else {
    // entry 不应含 id 字段（id 已经在 key 里）
    const { id: _drop, ...rest } = entry;
    c.agents.entries[id] = rest;
  }
  return c.agents.entries[id];
}
function deleteEntry(c, id) {
  if (c && c.agents && c.agents.entries) delete c.agents.entries[id];
}

// ---- model policy (替代老的 agents.defaults.models dict) ----
// openclaw 2026.9+ 用 agents.defaults.modelPolicy.allow (字符串数组)
// 表达"可用模型白名单"，老代码用 agents.defaults.models[key]={} (dict)
// 作为"已注册模型" 集合；用 helper 把两种写法都支持。
function getAllowList(c) {
  const mp = c && c.agents && c.agents.defaults && c.agents.defaults.modelPolicy;
  if (mp && Array.isArray(mp.allow)) return mp.allow;
  // Fallback: 老结构 agents.defaults.models 的 key 集合（升级未完成时）
  const m = c && c.agents && c.agents.defaults && c.agents.defaults.models;
  if (m && typeof m === 'object') return Object.keys(m);
  return [];
}
function ensureModelPolicy(c) {
  if (!c.agents) c.agents = {};
  if (!c.agents.defaults) c.agents.defaults = {};
  if (!c.agents.defaults.modelPolicy) c.agents.defaults.modelPolicy = {};
  if (!Array.isArray(c.agents.defaults.modelPolicy.allow)) c.agents.defaults.modelPolicy.allow = [];
  return c.agents.defaults.modelPolicy.allow;
}
function addModelToAllowList(c, modelKey) {
  const allow = ensureModelPolicy(c);
  if (!allow.includes(modelKey)) allow.push(modelKey);
}
function removeModelFromAllowList(c, modelKey) {
  const allow = ensureModelPolicy(c);
  const i = allow.indexOf(modelKey);
  if (i >= 0) allow.splice(i, 1);
}
function hasModelInAllowList(c, modelKey) {
  return getAllowList(c).includes(modelKey);
}

// Feishu account keys must be safe identifiers: openclaw normalizes illegal
// characters (observed: ':' → '-'), so a key like 'v1:eyJhb_bot' never
// matches → account stays "not configured, stopped". Force keys to
// [a-z0-9_-] and always end with _bot.
function normalizeBotKey(raw, fallback) {
  const clean = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const base = clean || String(fallback || '');
  return base.endsWith('_bot') ? base : base + '_bot';
}

function json(res,data,code=200) {
  res.writeHead(code,{
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

// Mask secrets: short values never leak through the overlapping-slice bug.
function maskSecret(s) {
  if (s === null || s === undefined || s === '') return '';
  // SecretRef 对象形式（{source, provider, id}）不是明文串，显示引用来源而不是值。
  // 旧代码直接 s.slice() 会抛 "s.slice is not a function"，把整个接口打成 500。
  if (typeof s === 'object') {
    const src = s.source || 'ref';
    const prov = s.provider ? ':' + s.provider : '';
    return '🔒 ' + src + prov;
  }
  const str = String(s);
  if (str.length <= 8) return '••••••';
  return str.slice(0, 4) + '●●●' + str.slice(-4);
}

// Resolve `rel` inside `root` and refuse anything that escapes it
// (path traversal guard for file read/write endpoints).
function resolveWithin(root, rel) {
  const base = path.resolve(root);
  const fp = path.resolve(base, String(rel || ''));
  if (fp !== base && !fp.startsWith(base + path.sep)) return null;
  return fp;
}

// Async PowerShell runner: spawn, bounded output, hard timeout.
// Used by gateway-restart to find/kill node + drive the scheduled task.
// CRITICAL: write script to temp file and pass via -File (not -Command) —
// passing complex PS via -Command mangles quotes/backticks in Windows arg parsing.
function runPowerShell(script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child, tmp;
    try {
      tmp = path.join(os.tmpdir(), `ps-${Date.now()}-${process.pid}.ps1`);
      fs.writeFileSync(tmp, script, 'utf8');
      // 调试用：把每次的 ps 脚本也写到 switcher.log 方便诊断
      try { log(`PS script (${script.length} chars): ${script.replace(/\s+/g, ' ').slice(0, 200)}...`); } catch (_) {}
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], { windowsHide: true });
    } catch (e) {
      try { if (tmp) fs.unlinkSync(tmp); } catch {}
      return resolve({ out: '', err: String(e), error: e.message });
    }
    const timer = setTimeout(() => {
      if (!done) { done = true; killTree(child.pid); resolve({ out, err, timedOut: true }); }
    }, timeoutMs);
    child.stdout.on('data', d => { if (!done) out += d; });
    child.stderr.on('data', d => { if (!done) err += d; });
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); try { if (tmp) fs.unlinkSync(tmp); } catch {} resolve({ out, err, error: e.message }); } });
    child.on('close', () => { if (!done) { done = true; clearTimeout(timer); try { if (tmp) fs.unlinkSync(tmp); } catch {} resolve({ out, err }); } });
  });
}

// 杀掉整棵进程树，而不是只杀父进程。
// openclaw CLI 会再 spawn 一个 node 子进程（--stack-size=8192 那个），
// 只 child.kill() 父进程的话孙进程会活下来，一直占着 openclaw.sqlite 的写事务；
// 几个叠加就会把 gateway 饿死（症状：/health 要 30s+ 才响应、channels status 报
// "database is locked" / WAL checkpoint blocked）。
function killTree(pid){
  if(!pid) return;
  try{
    if(process.platform === 'win32'){
      const r = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' });
      r.on('error', ()=>{});
    } else {
      try { process.kill(-pid, 'SIGKILL'); }
      catch(e){ try { process.kill(pid, 'SIGKILL'); } catch(e2){} }
    }
  }catch(e){ /* 进程已退出 */ }
}

// 同一命令并发去重：dashboard 有 10s / 30s 两个轮询器，
// gateway 一慢就会叠出一堆同款 CLI 进程互相抢锁。
const CLI_INFLIGHT = new Map();

// Async CLI runner: spawn (never blocks the event loop), bounded output,
// hard timeout, structured result. Used by getModels + diagnostics.
function runCli(args, timeoutMs, maxOut = 4 * 1024 * 1024) {
  const key = args.join('|');
  if (CLI_INFLIGHT.has(key)) return CLI_INFLIGHT.get(key);
  const p = new Promise((resolve) => {
    let out = '', err = '', done = false, child;
    try {
      child = spawn(NODE_BIN, args, { windowsHide: true });
    } catch (e) {
      return resolve({ out: '', err: String(e), error: e.message });
    }
    const timer = setTimeout(() => {
      if (!done) { done = true; killTree(child.pid); resolve({ out, err, timedOut: true }); }
    }, timeoutMs);
    child.stdout.on('data', d => {
      if (done) return;
      out += d;
      if (out.length > maxOut) { done = true; clearTimeout(timer); killTree(child.pid); resolve({ out, err }); }
    });
    child.stderr.on('data', d => { if (!done) err += d; });
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ out, err, error: e.message }); } });
    child.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve({ out, err }); } });
  });
  CLI_INFLIGHT.set(key, p);
  p.then(() => { if (CLI_INFLIGHT.get(key) === p) CLI_INFLIGHT.delete(key); },
         () => { if (CLI_INFLIGHT.get(key) === p) CLI_INFLIGHT.delete(key); });
  return p;
}

function cliMissing() { return !CLI || !fs.existsSync(CLI); }

// ---- openclaw 本体更新支持 ----
// 官方没有独立更新命令，openclaw 就是 npm 全局包（openclaw）。
// 更新 = `npm install -g openclaw@<version>`；历史版本 = npm registry 的 versions。
// 包名固定 'openclaw'；版本号校验严格，防注入。
const OPENCLAW_PKG = 'openclaw';
const NPM_BIN = (process.env.OPENCLAW_NPM || '').trim() || 'npm';
const UPDATE_CACHE = { at: 0, data: null };   // 30s 缓存 npm 查询结果
const UPDATE_CACHE_MS = 30000;

// npm 11 起默认不执行 install scripts。openclaw 的 postinstall 负责恢复捆绑插件和
// fs-safe 的预编译原生二进制；不放行的话 gateway 启动会报
// "Cannot find module '@openclaw/fs-safe/advanced'"。所以全局安装必须显式放行。
let npmMajorCache = null;
async function npmMajorVersion(){
  if (npmMajorCache !== null) return npmMajorCache;
  const r = await runNpm(['--version'], 20000);
  const v = parseInt(String((r && r.out) || '').trim(), 10);
  npmMajorCache = Number.isFinite(v) ? v : 0;
  return npmMajorCache;
}
async function npmAllowScriptsArg(){
  return (await npmMajorVersion()) >= 11 ? ['--allow-scripts=' + OPENCLAW_PKG] : [];
}

// 目标版本要求的 node 范围 vs 当前 node —— 不满足就提前拦，
// 别让 npm 跑一两分钟才在 openclaw 的 preinstall 里报错。
function parseSemver(v){
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpSemver(a, b){
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}
function satisfiesComparator(ver, cmp){
  const m = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(cmp || '').trim());
  if (!m) return true;               // 不认识的写法一律放行 —— 宁可漏拦，不误拦
  const op = m[1] || '=';
  const target = [Number(m[2]), m[3] === undefined ? 0 : Number(m[3]), m[4] === undefined ? 0 : Number(m[4])];
  const c = cmpSemver(ver, target);
  if (op === '>=') return c >= 0;
  if (op === '>')  return c > 0;
  if (op === '<=') return c <= 0;
  if (op === '<')  return c < 0;
  return c === 0;
}
function nodeSatisfies(ver, range){
  const s = String(range || '').trim();
  if (!s) return true;
  const cur = parseSemver(ver);
  if (!cur) return true;
  return s.split('||').some((branch) => {
    const parts = branch.trim().split(/\s+/).filter(Boolean);
    return parts.every((p) => satisfiesComparator(cur, p));
  });
}
async function checkNodeEngineFor(version){
  const spec = version ? `${OPENCLAW_PKG}@${version}` : OPENCLAW_PKG;
  const r = await runNpm(['view', spec, 'engines', '--json'], 60000);
  let eng = null;
  try { eng = JSON.parse(String((r && r.out) || '').trim()); } catch { eng = null; }
  const range = eng && eng.node ? String(eng.node) : '';
  if (!range) return { ok:true, range:'', current:process.version };
  if (nodeSatisfies(process.version, range)) return { ok:true, range, current:process.version };
  return { ok:false, range, current:process.version,
    error:`当前 Node ${process.version} 不满足 openclaw ${version || 'latest'} 的要求（需要 ${range}）。请先用「安装 Node.js LTS」升级 Node，再回来更新。` };
}
// #10: 安装/更新进程内互斥（UI 有 installBusy，但 API 层并发概率仍存在）
let installRunning = false;

// ---- openclaw 更新实时进度缓冲 ----
// npm install -g 是同步阻塞的（最多 4 分钟），输出原本全部缓冲到结束才返回，
// 前端只能看到「更新中...」然后突然蹦出结果。这里把 npm 的 stdout/stderr
// 实时收进缓冲，提供 /api/openclaw/update/progress 供前端轮询渲染。
const OC_UPDATE_MAX_LINES = 400;
let ocUpdateProgress = { running:false, version:'', startedAt:0, finishedAt:0, ok:null, error:null, lines:[] };
// 持久化到磁盘：switcher 重启后仍能回看上一次更新的完整输出
const OC_UPDATE_LOG_FILE = path.join(USER_DATA_DIR, 'last-update.json');
let ocUpdateLastSave = 0;
function ocUpdatePersist(force){
  const now = Date.now();
  if (!force && now - ocUpdateLastSave < 800) return;
  ocUpdateLastSave = now;
  try {
    fs.mkdirSync(path.dirname(OC_UPDATE_LOG_FILE), { recursive:true });
    fs.writeFileSync(OC_UPDATE_LOG_FILE, JSON.stringify(ocUpdateProgress), 'utf8');
  } catch(e){ /* 持久化失败不影响主流程 */ }
}
function ocUpdateLoadPersisted(){
  try {
    if (!fs.existsSync(OC_UPDATE_LOG_FILE)) return;
    const j = JSON.parse(fs.readFileSync(OC_UPDATE_LOG_FILE,'utf8'));
    if (j && Array.isArray(j.lines)) ocUpdateProgress = Object.assign({}, ocUpdateProgress, j, { running:false });
  } catch(e){ /* 读不到就用空态 */ }
}
function ocUpdateReset(version){
  ocUpdateProgress = { running:true, version:String(version||'latest'), startedAt:Date.now(), finishedAt:0, ok:null, error:null, lines:[] };
  ocUpdatePersist(true);
}
function ocUpdatePush(chunk){
  if (chunk === null || chunk === undefined) return;
  const text = String(chunk).replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  for (const line of text.split('\n')) {
    const t = line.trimEnd();
    if (!t.trim()) continue;
    ocUpdateProgress.lines.push(t);
  }
  while (ocUpdateProgress.lines.length > OC_UPDATE_MAX_LINES) ocUpdateProgress.lines.shift();
  ocUpdatePersist(false);
}
function ocUpdateFinish(ok, error){
  ocUpdateProgress.running = false;
  ocUpdateProgress.finishedAt = Date.now();
  ocUpdateProgress.ok = !!ok;
  ocUpdateProgress.error = error || null;
  ocUpdatePersist(true);
}
// 定位 npm-cli.js（npm.cmd 内部最终执行 node <dp0>\node_modules\npm\bin\npm-cli.js）。
// 用 node 直接执行可完全避开 cmd.exe 的引号/空格拆词问题（C8：安装位置含空格时）。
let npmCliResolved = null;
function resolveNpmCli() {
  if (npmCliResolved) return npmCliResolved;
  try {
    const where = require('child_process').execFileSync('where',['npm'],{encoding:'utf8',windowsHide:true})
      .split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    for (const w of where) {
      if (!/\.cmd$/i.test(w)) continue;
      const dir = path.dirname(w);
      for (const c of [
        path.join(dir,'node_modules','npm','bin','npm-cli.js'),
        path.join(dir,'..','node_modules','npm','bin','npm-cli.js'),
        path.join(dir,'npm','bin','npm-cli.js'),
      ]) {
        if (fs.existsSync(c)) { npmCliResolved = c; return c; }
      }
    }
  } catch {}
  return null;
}

function runNpm(args, timeoutMs, onChunk) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child;
    const cli = resolveNpmCli();
    if (!cli) {
      // 兜底（非 Windows 或找不到 npm-cli.js）：直接执行 npm 命令
      try {
        if (process.platform === 'win32') {
          const q = a => /[\s"]/.test(String(a)) ? '"' + String(a).replace(/"/g,'\\"') + '"' : String(a);
          child = spawn('cmd.exe', ['/d','/c','npm ' + args.map(q).join(' ')], { windowsHide: true });
        } else {
          child = spawn(NPM_BIN, args, { windowsHide: true });
        }
      } catch (e) {
        return resolve({ out: '', err: String(e), error: e.message });
      }
    } else {
      try {
        child = spawn(process.execPath, [cli, ...args], { windowsHide: true });
      } catch (e) {
        return resolve({ out: '', err: String(e), error: e.message });
      }
    }
    const timer = setTimeout(() => {
      if (!done) { done = true; killTree(child.pid); resolve({ out, err, timedOut: true }); }
    }, timeoutMs);
    child.stdout.on('data', d => { if (!done) { out += d; if (onChunk) { try { onChunk(String(d)); } catch {} } if (out.length > 8*1024*1024) { done = true; clearTimeout(timer); killTree(child.pid); resolve({ out, err }); } } });
    child.stderr.on('data', d => { if (!done) { err += d; if (onChunk) { try { onChunk(String(d)); } catch {} } } });
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ out, err, error: e.message }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ out, err, code }); } });
  });
}

// 读取当前安装的 openclaw 版本（读全局包 package.json）
function currentOpenclawVersion() {
  try {
    // CLI 指向 node_modules/openclaw/openclaw.mjs → 向上找 package.json
    let dir = path.dirname(CLI);
    for (let i = 0; i < 4; i++) {
      const pj = path.join(dir, 'package.json');
      if (fs.existsSync(pj)) {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (j.name === OPENCLAW_PKG && j.version) return { version: j.version, path: pj };
      }
      dir = path.dirname(dir);
    }
  } catch {}
  return { version: 'unknown', path: '' };
}

// npm 查询：latest dist-tag + 全部历史版本（含 beta/rc）。带 30s 缓存。
// #11: force 刷新加 5s 冷却——防连点打爆 npm registry，同时保留更新前强制验证的能力。
let lastForceFetchAt = 0;
const FORCE_FETCH_COOLDOWN_MS = 5000;
async function queryOpenclawVersions(force) {
  const now = Date.now();
  if (!force && UPDATE_CACHE.data && now - UPDATE_CACHE.at < UPDATE_CACHE_MS) return UPDATE_CACHE.data;
  if (force && UPDATE_CACHE.data && now - lastForceFetchAt < FORCE_FETCH_COOLDOWN_MS) return UPDATE_CACHE.data;
  if (force) lastForceFetchAt = now;
  const latest = await runNpm(['view', OPENCLAW_PKG, 'version'], 30000);
  const versions = await runNpm(['view', OPENCLAW_PKG, 'versions', '--json'], 60000);
  let list = [];
  try { const j = JSON.parse(versions.out.trim()); if (Array.isArray(j)) list = j; } catch {}
  // 语义化排序（版本号含 -beta.x 时按 npm 顺序即可，保持 registry 顺序）
  const data = {
    latest: String(latest.out || '').trim() || null,
    latestError: latest.error || (latest.timedOut ? 'npm 查询超时' : null),
    versions: list,
    fetchedAt: Date.now(),
  };
  UPDATE_CACHE.data = data; UPDATE_CACHE.at = Date.now();
  return data;
}

// 版本号校验：只允许 semver 风格字符，长度限制；禁止参数注入
const VERSION_RE = /^[0-9][0-9A-Za-z.\-+]*$/;
function validVersion(v) { return typeof v === 'string' && v.length <= 64 && VERSION_RE.test(v); }

// ---- openclaw 安装向导支持 ----
// 前置环境：Node.js 满足 openclaw 的最低版本要求（22.22.3+ / 24.15+ / 25.9+）
// 安装 = npm install -g openclaw；安装位置 = npm 全局 prefix（可自定义，会同时 set prefix）
// 默认工作区 = 安装后写入 agents.defaults.workspace（配置不存在则创建最小配置）

function nodeVersionOk(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v||'').trim());
  if (!m) return false;
  const major = +m[1], minor = +m[2], patch = +m[3];
  if (major > 25) return true;
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 3);
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  if (major === 25) return minor > 9 || (minor === 9 && patch >= 0);
  return false;
}

// 环境检查：node/npm/openclaw/prefix/winget（Windows 一键装 Node 用）
let installStatusCache = { at: 0, data: null };
const INSTALL_STATUS_CACHE_MS = 30000;
async function getInstallStatus(force) {
  if (!force && installStatusCache.data && Date.now() - installStatusCache.at < INSTALL_STATUS_CACHE_MS)
    return installStatusCache.data;
  const npmV = await runNpm(['--version'], 20000);
  const prefix = await runNpm(['config','get','prefix'], 20000);
  const cur = currentOpenclawVersion();
  let winget = false;
  if (process.platform === 'win32') {
    winget = await new Promise((resolve)=>{
      try {
        const c = require('child_process').spawn('where',['winget'],{windowsHide:true});
        c.on('error', ()=>resolve(false));
        c.on('close', (code)=>resolve(code===0));
        setTimeout(()=>{ killTree(c.pid); resolve(false); }, 5000);
      } catch { resolve(false); }
    });
  }
  const data = {
    node: process.version,
    nodeOk: nodeVersionOk(process.version),
    nodeMin: '22.22.3+ / 24.15+ / 25.9+',
    npm: String(npmV.out||'').trim() || null,
    npmError: npmV.error || (npmV.timedOut?'npm 查询超时':null),
    prefix: String(prefix.out||'').trim() || null,
    winget,
    openclawInstalled: cur.version !== 'unknown',
    openclawVersion: cur.version,
    openclawPath: cur.path,
    workspace: (()=>{ try { const c=read(); return String(c.agents?.defaults?.workspace||'').trim()||WS_ROOT; } catch { return WS_ROOT; } })(),
    configExists: fs.existsSync(CONFIG),
  };
  installStatusCache = { at: Date.now(), data };
  return data;
}

// 安装 openclaw：{prefix?, root?} — prefix 留空 = 当前 npm 全局位置（程序本体位置）；
// root = openclaw 数据根目录（自动创建 .openclaw 状态根 + workspace，并设置 OPENCLAW_HOME 用户环境变量）
async function doInstallOpenclaw(prefix, root) {
  // 1) 设置全局 prefix（程序本体安装位置）
  if (prefix && prefix.trim()) {
    const p = prefix.trim();
    if (!path.isAbsolute(p)) return { ok:false, error:'安装位置必须是绝对路径' };
    const set = await runNpm(['config','set','prefix',p], 30000);
    if (set.error || set.code !== 0) return { ok:false, error:'设置 npm prefix 失败: '+(set.error||set.err||'unknown') };
  }
  // 2) 安装 openclaw 程序本体
  const args = ['install','-g', ...(await npmAllowScriptsArg()), 'openclaw'];
  const r = await runNpm(args, 300000);
  const ok = !r.error && !r.timedOut && r.code===0;
  // 3) 数据根目录：创建 .openclaw + workspace，设置 OPENCLAW_HOME
  let rootMsg = null;
  if (ok && root && root.trim()) {
    try {
      const rt = path.resolve(root.trim());
      if (!path.isAbsolute(root.trim())) return { ok:false, error:'根目录必须是绝对路径' };
      const homeDir = path.join(rt, '.openclaw');
      const wsDir = path.join(rt, 'workspace');
      fs.mkdirSync(homeDir, {recursive:true});
      fs.mkdirSync(wsDir, {recursive:true});
      if (fs.existsSync(path.join(homeDir,'openclaw.json'))) {
        // 已有配置：复用，仅确保默认工作区指向根/workspace（若未显式设置）
        const cfg = JSON.parse(fs.readFileSync(path.join(homeDir,'openclaw.json'),'utf8'));
        if (!cfg.agents) cfg.agents = {defaults:{},list:[]};
        if (!cfg.agents.defaults) cfg.agents.defaults = {};
        if (!cfg.agents.defaults.workspace) cfg.agents.defaults.workspace = wsDir;
        fs.writeFileSync(path.join(homeDir,'openclaw.json'), JSON.stringify(cfg,null,2), 'utf8');
      } else {
        // 全新安装：最小配置
        const cfg={agents:{defaults:{workspace:wsDir,models:{}},list:[]},models:{mode:'merge',providers:{}},channels:{}};
        fs.writeFileSync(path.join(homeDir,'openclaw.json'), JSON.stringify(cfg,null,2), 'utf8');
      }
      // 设置用户级 OPENCLAW_HOME（setx；仅影响新进程 → 需重启面板/gateway）
      let envMsg = null;
      try {
        const setx = await new Promise((resolve)=>{
          try {
            const c = require('child_process').spawn('setx',['OPENCLAW_HOME', homeDir], {windowsHide:true, shell:false});
            let out='',err='',done=false;
            const timer=setTimeout(()=>{ if(!done){done=true;killTree(c.pid); resolve({out,err,timedOut:true});} },15000);
            c.stdout.on('data',d=>{if(!done)out+=d;});
            c.stderr.on('data',d=>{if(!done)err+=d;});
            c.on('error',e=>{if(!done){done=true;clearTimeout(timer);resolve({out,err,error:e.message});}});
            c.on('close',(code)=>{if(!done){done=true;clearTimeout(timer);resolve({out,err,code});}});
          } catch(e){ resolve({error:e.message}); }
        });
        envMsg = (!setx.error && !setx.timedOut && setx.code===0) ? 'OPENCLAW_HOME 已设置为 '+homeDir : ('OPENCLAW_HOME 设置失败: '+(setx.error||setx.err||'code '+setx.code));
      } catch(e) { envMsg = 'OPENCLAW_HOME 设置失败: '+e.message; }
      rootMsg = { root: rt, home: homeDir, workspace: wsDir, env: envMsg };
    } catch (e) { rootMsg = { error: '数据目录创建失败: '+e.message }; }
  }
  return { ok, code:r.code, error:r.error||(r.timedOut?'npm 安装超时（5 分钟）':null), output:(r.out+r.err).slice(-6000), root: rootMsg };
}

// 飞书扫码注册会话存储
const regSessions=new Map();
function body(req) {
  return new Promise((resolve,reject)=>{
    let b='';req.on('data',c=>b+=c);
    req.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){reject(e)}});
    req.on('error',reject);
  });
}

// ---- API handlers ----

// 解析 agent 的工作区——完全对齐 openclaw 的 resolveAgentWorkspaceDir：
//   1) agent 配置显式 workspace 优先
//   2) 默认 agent（agents.list 中 default:true 的第一个，没有则 list 第一个，
//      再没有才是 'main'——不按名字猜）→ defaults.workspace 或默认目录
//   3) 非默认 agent → defaults.workspace/<id> 或 WS_ROOT/<id>
// #9: 支持传入已读配置（cfg）避免 N+1 读盘；不传则内部读一次。
function resolveAgentWorkspace(id, cfg) {
  const c = cfg || (()=>{ try { return read(); } catch { return {}; } })();
  const list = entriesAsList(c);
  const entry = list.find(a => a.id === id);
  if (entry?.workspace) return entry.workspace;
  const defs = list.filter(a => a.default);
  const defaultAgentId = String((defs.length ? defs[0] : list[0] || {}).id || 'main').trim();
  const fallback = String(c.agents?.defaults?.workspace || '').trim();
  if (id === defaultAgentId) {
    if (fallback) return fallback;
    return WS_ROOT;  // 等价 openclaw 默认：OPENCLAW_WORKSPACE_DIR 或 ~/.openclaw/workspace
  }
  if (fallback) return path.join(fallback, id);
  return path.join(WS_ROOT, id);
}

// 计算默认 agent id（对齐 resolveAgentWorkspace 的语义）
// (重定义在下面 entriesAsList 之后；这里保留 stub 防止旧引用找不到——新版定义在 L475 之后)

// 计算 agent 未显式配置 workspace 时的默认路径（defaults.workspace/<id> 或 WS_ROOT/<id>；
// 默认 agent 直接用 defaults.workspace 或 WS_ROOT）
function resolveDefaultWorkspaceFor(cfg, id) {
  const fallback = String(cfg?.agents?.defaults?.workspace || '').trim();
  const base = fallback || WS_ROOT;
  return id === resolveDefaultAgentId(cfg) ? base : path.join(base, id);
}

// 校验用户提供的 workspace 路径：必须绝对路径；若已存在则不能是文件
function validateWorkspacePath(ws) {
  const s = String(ws || '').trim();
  if (!s) return { ok: false, error: '工作区路径不能为空' };
  if (s.length > 500) return { ok: false, error: '工作区路径过长' };
  if (!path.isAbsolute(s)) return { ok: false, error: '工作区路径必须是绝对路径（如 D:\\openclaw\\workspace\\mybot）' };
  if (/\0/.test(s)) return { ok: false, error: '工作区路径包含非法字符' };
  const abs = path.resolve(s);
  try { if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { ok: false, error: '工作区路径指向一个文件（应为目录）' }; } catch {}
  return { ok: true, path: abs };
}

// 迁移工作区目录：旧目录存在且新目录不存在 → 搬过去；返回报告
// 新目录已存在（非空）→ 拒绝，避免覆盖/合并数据
function migrateWorkspaceDir(oldWs, newWs) {
  const report = [];
  const oldExists = oldWs && fs.existsSync(oldWs);
  if (newWs && fs.existsSync(newWs)) {
    let nonEmpty = false;
    try { nonEmpty = fs.readdirSync(newWs).length > 0; } catch {}
    if (nonEmpty && (!oldExists || path.resolve(newWs) !== path.resolve(oldWs))) {
      return { ok: false, error: `目标工作区已存在且非空: ${newWs}` };
    }
  }
  if (oldExists && newWs && path.resolve(oldWs) !== path.resolve(newWs)) {
    try {
      fs.renameSync(oldWs, newWs);
      report.push(`工作区目录迁移: ${oldWs} → ${newWs}`);
    } catch (e) {
      return { ok: false, error: '工作区目录迁移失败: ' + e.message };
    }
  }
  return { ok: true, report };
}

function getAgents() {
  let c; try { c=read(); } catch(e) { return []; }
  const dm = c.agents?.defaults?.model?.primary || 'minimax/MiniMax-M3';
  let list = entriesAsList(c);
  if(!list.length && fs.existsSync(AGENT_ROOT)) {
    list = fs.readdirSync(AGENT_ROOT).filter(d=>{try{return fs.statSync(path.join(AGENT_ROOT,d)).isDirectory();}catch{return false;}}).map(id=>{
      const ws=resolveAgentWorkspace(id, c);
      return {id,name:id,workspace:fs.existsSync(ws)?ws:'',agentDir:path.join(AGENT_ROOT,id,'agent')};
    });
  }
  return list.map(a=>{
    // openclaw 对默认 agent（main）不写 workspace 字段——按语义回退
    const ws = resolveAgentWorkspace(a.id, c);
    return {
      id:a.id, name:a.name||a.id,
      model:a.model?.primary||dm, default:dm,
      workspace:ws, agentDir:a.agentDir||'',
      tools:a.tools||null,   // tool allow/deny config, surfaced for the UI
      // 实时解析默认 agent：第一个 default:true，没有则 list 第一个，再没有才是 'main'
      // （不一定是 id='main' 的那个）
      isDefault: a.id === resolveDefaultAgentId(c),
      status:'active'
    };
  });
}

// Cached model list from the CLI (10s TTL). The CLI call is async so a slow
// or hung `models list` can never block the HTTP server.
let modelsCache = null;
let modelsCacheAt = 0;
const MODELS_CACHE_MS = 10000;

// Cached Feishu diagnostics (15s TTL).
let diagCache = null;
let diagCacheAt = 0;

// Cached openclaw provider catalog (30s TTL, from CLI).
let provAvailCache = null;
let provAvailCacheAt = 0;
// in-flight 去重：同一时刻只允许一个 provider 能力 CLI 在跑
let provAvailInFlight = null;

// gateway 是否在服务（2.5s 超时的轻量 health 探测，5s 缓存）。
// 存在的理由：openclaw CLI 会持有 openclaw 的 state 库，而 gateway 启动期间
// state 库被占住会直接让 gateway bootstrap 失败（2026-10-22 实测：
// "cli.main.gateway-run-bootstrap ... failed" / "The CLI command failed."）。
// 所以 gateway 不在服务时，switcher 绝不能 spawn 任何 openclaw CLI。
let gwReachCache = { at: 0, ok: false };
async function gatewayReachable(){
  const now = Date.now();
  if (now - gwReachCache.at < 5000) return gwReachCache.ok;
  const ok = await new Promise((resolve) => {
    let done = false, req = null;
    const finish = (v) => { if (done) return; done = true; try { if(req) req.destroy(); } catch{} resolve(v); };
    try {
      req = require('http').get('http://127.0.0.1:18888/health', { timeout: 2500 }, r => {
        r.resume();
        r.on('end', () => finish(r.statusCode === 200));
      });
      req.on('error', () => finish(false));
      req.on('timeout', () => finish(false));
    } catch { finish(false); }
  });
  gwReachCache = { at: now, ok };
  return ok;
}

// 取 model 列表 — 2026.9+ 适配：
// openclaw 把"可用模型"从 CLI 探测改为 agents.defaults.modelPolicy.allow 静态列表。
// 优先用 CLI（保持旧行为 + 探测最新），失败/慢时回退到读 modelPolicy.allow。
async function getModels(q) {
  const now = Date.now();
  let r = null;
  if (!cliMissing() && (!modelsCache || now - modelsCacheAt > MODELS_CACHE_MS)) {
    // 2026.9+ 的 openclaw models list 必须指定 --agent，否则会报
    // "Multiple agents are configured, but model inspection has no explicit owner"。
    // 优先从 openclaw.json 拿默认 agent id；拿不到用 'main' 兜底。
    let defaultAgent = 'main';
    try {
      const cc = read();
      defaultAgent = resolveDefaultAgentId(cc) || 'main';
    } catch {}
    const res = await runCli([CLI, 'models', 'list', '--all', '--json', '--agent', defaultAgent], 15000);
    try { r = JSON.parse(res.out); } catch (e) {
      log(`Models CLI parse fail: out=${res.out.length}B stderr=${JSON.stringify((res.err||'').slice(0,200))} error=${res.error||'none'} timedOut=${!!res.timedOut} cli=${CLI} node=${NODE_BIN}`);
      r = null;
    }
    if (r && Array.isArray(r.models)) { modelsCache = r; modelsCacheAt = now; }
    else { modelsCache = null; r = null; }
  } else {
    r = modelsCache;
  }
  // Fallback: 直接从 openclaw.json 读 modelPolicy.allow（2026.9+ 路径）
  if (!r) {
    try {
      const cc = read();
      const allow = getAllowList(cc);
      r = { models: allow.map(key => ({ key, name: key, provider: String(key).split('/')[0] })) };
    } catch {}
  }
  if (!r) return [];
  let c; try { c=read(); } catch(e) { c={}; }
  const keyed=new Set();
  if(c.models?.providers) Object.keys(c.models.providers).forEach(k=>{ if(c.models.providers[k].apiKey) keyed.add(k); });
  const seen=new Set();
  return (r.models||[]).filter(m=>{
    if(seen.has(m.key)) return false; seen.add(m.key);
    if(!q) return true;
    const lq=q.toLowerCase();
    return String(m.key||'').toLowerCase().includes(lq)||(m.name||'').toLowerCase().includes(lq);
  }).map(m=>({
    key:m.key, name:m.name, provider:String(m.key||'').split('/')[0],
    available:m.available||keyed.has(String(m.key||'').split('/')[0]),
    hasKey:keyed.has(String(m.key||'').split('/')[0]),
    ctx:m.contextWindow, input:m.input
  }));
}

// 按点号路径读取配置子树，支持 a.b.c 与 a.b[0].c（与 openclaw `config get --json <path>` 一致）
function resolveConfigPath(obj, path) {
  const parts = String(path).split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    const m = /^([^\[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    const key = m[1];
    if (key !== '*') {
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
      cur = cur[key];
    } else {
      if (!Array.isArray(cur)) return undefined;
      const out = [];
      for (const el of cur) {
        const sub = resolveConfigPath({ v: el }, 'v' + m[2]);
        if (sub !== undefined) out.push(sub);
      }
      return out;
    }
    const idxs = m[2].match(/\d+/g);
    if (idxs) {
      for (const i of idxs) {
        if (!Array.isArray(cur)) return undefined;
        const n = parseInt(i, 10);
        if (!Number.isFinite(n) || n < 0 || n >= cur.length) return undefined;
        cur = cur[n];
      }
    }
  }
  return cur;
}

function getProviders() {
  let c; try { c=read(); } catch(e) { return []; }
  if(!c.models?.providers) return [];
  return Object.entries(c.models.providers).map(([k,v])=>{
    if (!v || typeof v !== 'object') return { id:k, baseUrl:'', key:'', models:[] };
    return {
      id:k, baseUrl:v.baseUrl||'',
      key:v.apiKey?maskSecret(v.apiKey):'',
      models:(v.models||[]).map(m=>`${k}/${m.id}`)
    };
  });
}

function getCatalogWithModels() {
  // 只返回 openclaw 配置里真实存在的供应商（实时拉取）——
  // 不再包含静态预设，保证下拉/目录与配置完全一致。
  let c; try { c=read(); } catch(e) { c={}; }
  const configProviders = c.models?.providers || {};
  return Object.entries(configProviders)
    .filter(([pid,p]) => pid && p && typeof p === 'object')
    .map(([pid,p]) => {
      const models = (p.models||[]).map(m=>({
        id:m.id, key:`${pid}/${m.id}`, name:m.name||m.id,
        ctx:m.contextWindow, input:m.input
      }));
      return {
        id:pid, name:pid, baseUrl:p.baseUrl||'',
        hasKey:!!p.apiKey, modelCount:models.length,
        models
      };
    })
    .sort((a,b)=>a.id.localeCompare(b.id));
}

function getBackups(all) {
  if(!fs.existsSync(BACKUP_DIR)) return {list:[],total:0};
  const names=fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json')).sort().reverse();
  return {
    total: names.length,
    list: names.slice(0, all?100:10).map(f=>{
      const fp=path.join(BACKUP_DIR,f);
      const s=fs.statSync(fp);
      return {name:f,time:s.mtime.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),path:fp,size:s.size};
    })
  };
}

// #5/#6: scenes 读取失败不静默丢数据——坏文件备份 + 抛错让调用方拒绝写；
// 写入一律 tmp+rename 原子化（与主 config 一致）。
// 注意：文件不存在（首次使用/用户没建过场景）是正常情况，返回空数组，不算损坏。
function getScenesOrThrow() {
  const raw = fs.readFileSync(SCENES,'utf8');
  return JSON.parse(raw);
}
function readScenes() {
  try { return { ok:true, scenes: getScenesOrThrow() }; }
  catch(e) {
    if (e && e.code === 'ENOENT') return { ok:true, scenes: [] };   // 文件不存在 = 空场景，正常
    // 备份坏文件，防止后续基于空数组覆盖导致旧场景全丢
    try {
      const bak = `${SCENES}.corrupt-${new Date().toISOString().replace(/[:.]/g,'-')}`;
      fs.copyFileSync(SCENES, bak);
      log(`Scenes corrupt, backed up: ${path.basename(bak)} (${e.message})`);
      return { ok:false, scenes:[], error:`scenes.json 解析失败，已备份到 ${path.basename(bak)}`, backup:path.basename(bak) };
    } catch(bakErr) {
      return { ok:false, scenes:[], error:'scenes.json 解析失败且无法备份: '+bakErr.message };
    }
  }
}
function writeScenes(scenes) {
  const tmp=SCENES+'.new';
  fs.writeFileSync(tmp, JSON.stringify(scenes,null,2), 'utf8');
  fs.renameSync(tmp, SCENES);
}

function getLog(n=80) {
  try {
    const all = fs.readFileSync(LOG,'utf8').trim().split('\n');
    // 倒序返回：最新的一条排在最前面（看日志的习惯），旧的往下排
    return all.slice(-Math.min(Math.max(parseInt(n)||80, 10), 5000)).reverse();
  } catch(e) { return []; }
}

async function getStatus() {
  let c; try { c=read(); } catch(e) { return {error:'Config read failed'}; }
  const agents = getAgents();
  const providers = getProviders();
  // Never trigger a CLI call from /api/status — it's the health/overview
  // endpoint and must answer in milliseconds even when the CLI is slow/hung.
  // 1) 优先用缓存的 CLI 结果
  // 2) 缓存空 → 用 modelPolicy.allow 做 fallback（2026.9+ 静态列表）
  let cachedModels = modelsCache && Array.isArray(modelsCache.models) ? modelsCache.models : [];
  if (!cachedModels.length) {
    const keyed = new Set();
    if (c.models?.providers) Object.keys(c.models.providers).forEach(k => { if (c.models.providers[k].apiKey) keyed.add(k); });
    cachedModels = getAllowList(c).map(k => {
      const provider = String(k).split('/')[0];
      return { key: k, provider, available: keyed.has(provider), hasKey: keyed.has(provider) };
    });
  }
  return {
    version:PACKAGE_VERSION,
    port:PORT,
    configPath:CONFIG,
    agents:agents.length,
    providers:providers.filter(p=>p.key).length,
    modelsTotal:cachedModels.length,
    modelsAvailable:cachedModels.filter(m=>m.available).length,
    backups:getBackups().total,
    scenes:readScenes().scenes.length,
    defaultModel:c.agents?.defaults?.model?.primary||'N/A',
    defaultWorkspace:String(c.agents?.defaults?.workspace||'').trim()||WS_ROOT,
    defaultWorkspaceExplicit:!!String(c.agents?.defaults?.workspace||'').trim(),
    uptime:process.uptime(),
    nodeVersion:process.version,
    pid:process.pid,
  };
}

function doSwitch(changes) {
  return mutate((c) => {
    if (!c.agents) c.agents = { defaults: {} };
    if (!c.agents.defaults) c.agents.defaults = {};
    ensureModelPolicy(c);   // 确保 modelPolicy.allow 存在
    const log_entries = [];
    Object.entries(changes||{}).forEach(([id,nm]) => {
      const e = entryById(c, id); if (!e) return;
      const old = e.model?.primary || '(inherit)';
      if (!e.model) e.model = {};
      e.model.primary = nm;
      // 把新模型加入 allow list（如果还没有）
      addModelToAllowList(c, nm);
      log_entries.push(`${id}: ${old} → ${nm}`);
    });
    return log_entries;
  }).then(log_entries => {
    if (log_entries.length) log(`Switch: ${log_entries.join(' | ')}`);
    return log_entries.length;
  });
}

// Shared: apply a fresh probe result + auto-prune. Called by both doProbe
// (with the same provider's apiKey/baseUrl) and refreshOneProviderFast
// (which reuses the stored baseUrl/apiKey from the existing config).
// All writes go through mutate() so concurrent refresh/probe/etc. serialize.
async function applyProbeResult(providerId, modelList, baseUrl, apiKey) {
  return mutate((c) => {
    if (!c.models) c.models = { mode: 'merge', providers: {} };
    if (!c.models.providers) c.models.providers = {};
    // 上游 /v1/models 里可能混着「模式型」条目（例如 "gemini-2.5-flash-thinking-*"），
    // 那不是可用的模型 id。写进 modelPolicy.allow 会让 openclaw 判定**整个配置非法**
    // ("invalid model policy ref")，直接拒绝加载配置 —— 必须过滤掉，不能写回。
    const usable = modelList.filter(m => m && m.id && !/[*?]/.test(m.id));
    const skippedPatterns = modelList.length - usable.length;
    const prevProv = c.models.providers[providerId] || {};
    c.models.providers[providerId] = {
      ...prevProv,                       // 保留 provider 上的其它字段（name / api / authHeader …）
      baseUrl: baseUrl,
      apiKey: apiKey,                    // 原样写回（可能是 SecretRef 引用，不落明文）
      api: prevProv.api || 'openai-completions',
      authHeader: prevProv.authHeader !== undefined ? prevProv.authHeader : true,
      // 保留每个模型上一轮的附加字段（如 compat.supportsUsageInStreaming）。
      // 否则每次刷新都会把用户手工加的 compat / reasoning 等配置抹掉。
      models: usable.map(m => {
        const prevModel = Array.isArray(prevProv.models) ? prevProv.models.find(x => x && x.id === m.id) : null;
        return {
          ...(prevModel || {}),
          id: m.id,
          name: m.id,
          input: prevModel && Array.isArray(prevModel.input) && prevModel.input.length ? prevModel.input : ['text'],
          contextWindow: prevModel && Number.isFinite(prevModel.contextWindow) ? prevModel.contextWindow : 128000,
          maxTokens: prevModel && Number.isFinite(prevModel.maxTokens) ? prevModel.maxTokens : 8192,
        };
      }),
    };
    if (!c.agents) c.agents = { defaults: {} };
    if (!c.agents.defaults) c.agents.defaults = {};
    ensureModelPolicy(c);
    for (const m of usable) {
      const key = `${providerId}/${m.id}`;
      addModelToAllowList(c, key);   // 新增到 modelPolicy.allow
    }
    // Auto-prune stale modelPolicy.allow entries: a key is an orphan if
    // X is no longer in the freshly-probed list AND no agent's
    // model.primary uses it. probe() is thus a real-time read.
    const probedIds = new Set(usable.map(m => m.id));

    // 大小写归一：openclaw 的 provider id 匹配是大小写敏感的。历史上 agent 的
    // model.primary 被写成 '空氧api/xxx'（provider 实际 id 是 '空氧API'），
    // 于是该 agent 的模型永远解析不到 provider（面板显示「供应商未配置」），
    // allow 列表也积下一批同前缀的历史残留。刷新时按规范 id 归一引用，
    // 只在模型确实还在上游时才改写。
    let fixedRefs = 0;
    const entries = c.agents && c.agents.entries;
    if (entries && typeof entries === 'object') {
      for (const ent of Object.values(entries)) {
        const pr = ent && ent.model && ent.model.primary;
        if (typeof pr !== 'string') continue;
        const slash = pr.indexOf('/');
        if (slash < 0) continue;
        const pid = pr.slice(0, slash), mid = pr.slice(slash + 1);
        if (pid === providerId) continue;
        if (pid.toLowerCase() !== providerId.toLowerCase()) continue;
        if (!probedIds.has(mid)) continue;
        ent.model.primary = providerId + '/' + mid;
        fixedRefs++;
      }
    }

    // 被 agent 实际占用的 key（归一之后重新统计，别把刚归一的引用当成孤儿剪掉）
    const usedByAgent = new Set();
    for (const a of entriesAsList(c)) {
      const pr = a?.model?.primary;
      if (typeof pr === 'string') usedByAgent.add(pr);
    }

    const lowerPrefix = providerId.toLowerCase() + '/';
    let removed = 0, staleRemoved = 0;
    const allow = c.agents.defaults.modelPolicy.allow;

    // 清掉 allow 列表里非法的通配符 ref（如 "provider/model-*"）——
    // 这类条目会让 openclaw 判定整个配置非法。
    let removedInvalid = 0;
    for (let i = allow.length - 1; i >= 0; i--) {
      const k = allow[i];
      if (typeof k !== 'string' || !/[*?]/.test(k)) continue;
      const parts = k.split('/');
      const last = parts[parts.length - 1];
      const ok = last === '*' && parts.length >= 2 && parts.slice(0, -1).every(x => x && !/[*?]/.test(x));
      if (ok) continue;
      allow.splice(i, 1);
      removedInvalid++;
    }
    for (let i = allow.length - 1; i >= 0; i--) {
      const key = allow[i];
      if (!key.toLowerCase().startsWith(lowerPrefix)) continue;  // 本 provider 的条目（含大小写残留）
      if (usedByAgent.has(key)) continue;                          // 仍被 agent 引用 → 保留
      const slash = key.indexOf('/');
      const pid = key.slice(0, slash);
      const mid = key.slice(slash + 1);
      if (pid !== providerId) { allow.splice(i, 1); staleRemoved++; removed++; continue; }  // 大小写残留条目
      if (!probedIds.has(mid)) { allow.splice(i, 1); removed++; }
    }
    return { count: usable.length, removed, staleRemoved, fixedRefs, skippedPatterns, removedInvalid };
  });
}

async function doProbe(provider,apiKey,baseUrl) {
  // apiKey 允许为空：此时复用 config 里该 provider 已配置的 key（可能是 SecretRef 引用对象）。
  let rawKey = apiKey;
  if(!rawKey) {
    try { const cfg = read(); rawKey = (cfg && cfg.models && cfg.models.providers && cfg.models.providers[provider]) ? (cfg.models.providers[provider].apiKey || '') : ''; } catch(e){}
  }
  const secretKey = resolveApiKey(rawKey);
  if(!secretKey) return { ok: false, error: `No api key for ${provider}`, code: E.PROBE_FAILED };
  if(!baseUrl) { const cat=CATALOG.find(x=>x.id===provider); baseUrl=cat?cat.baseUrl:`https://api.${provider}.com`; }
  baseUrl = String(baseUrl).replace(/\/+$/,'');   // strip trailing slashes
  if (!baseUrl) return { ok: false, error: `No baseUrl for ${provider}`, code: E.PROBE_FAILED };
  // Try multiple URL patterns
  const urls = [];
  if(!baseUrl.includes('/v1')) urls.push(baseUrl+'/v1/models');
  urls.push(baseUrl.replace(/\/v1$/,'')+'/v1/models');
  urls.push(baseUrl+'/models');

  for(const probeUrl of urls) {
    try {
      let resp = await fetch(probeUrl,{headers:{'Authorization':'Bearer '+secretKey},signal:AbortSignal.timeout(15000)});
      let data;
      if(!resp.ok) {
        // 尝试不带 Bearer 前缀（Anthropic 风格）
        resp = await fetch(probeUrl,{headers:{'Authorization':secretKey},signal:AbortSignal.timeout(8000)});
        if(!resp.ok) continue; // try next URL
        data = await resp.json();
      } else { data = await resp.json(); }
      const raw = data.data || data;
      if(!Array.isArray(raw)||!raw.length) continue;
      const modelList = raw.map(m => ({ id: m.id }));
      const r = await applyProbeResult(provider, modelList, baseUrl, rawKey);
      if (r.removed) log(`Probe ${provider}: pruned ${r.removed} orphan(s) from agents.defaults.models`);
      log(`Probe ${provider}: ${r.count} models via ${probeUrl}`);
      return { ok: true, count: r.count, models: modelList.map(m => ({ id: m.id, key: `${provider}/${m.id}` })) };
    } catch(e) { continue; }
  }
  return { ok: false, error: `All probe URLs failed for ${provider}`, code: E.PROBE_FAILED };
}

// ---- Orphan pruning (global, no API call needed) ----
// Removes keys from agents.defaults.modelPolicy.allow that are:
//   - NOT in use by any agent's model.primary
//   - AND NOT present in any models.providers[*].models[*].id
// In-use keys (e.g. minimax/MiniMax-M3) are kept even if no provider has them
// (handles remote-only models registered outside the switcher).
async function doPruneOrphans({dryRun=false}={}) {
  // For both dry-run and real, the read+analyze is the same. The actual
  // delete + write is the part that goes through mutate() for safety.
  const scan = read();
  if (!scan.agents?.defaults?.modelPolicy?.allow && !scan.agents?.defaults?.models)
    return { ok: true, removed: 0, removedKeys: [], dryRun, knownCount: 0, inUseCount: 0 };

  const known = new Set();
  if (scan.models?.providers) {
    for (const [pid, p] of Object.entries(scan.models.providers)) {
      for (const m of (p.models || [])) {
        if (m?.id) known.add(`${pid}/${m.id}`);
      }
    }
  }
  const inUse = new Set();
  for (const a of entriesAsList(scan)) {
    if (a?.model?.primary) inUse.add(a.model.primary);
  }

  // Build the universe of allow-list keys (from modelPolicy.allow; fallback
  // to legacy models dict keys if allow is missing).
  const allow = (scan.agents?.defaults?.modelPolicy && Array.isArray(scan.agents.defaults.modelPolicy.allow))
    ? scan.agents.defaults.modelPolicy.allow
    : Object.keys(scan.agents?.defaults?.models || {});

  const removedKeys = [];
  for (const key of allow) {
    if (inUse.has(key)) continue;
    if (known.has(key)) continue;
    removedKeys.push(key);
  }
  if (dryRun || !removedKeys.length) {
    return { ok: true, removed: removedKeys.length, removedKeys, dryRun, knownCount: known.size, inUseCount: inUse.size };
  }
  // Real delete — go through mutate() for write serialization
  return mutate((c) => {
    const removedSet = new Set(removedKeys);
    if (c.agents?.defaults?.modelPolicy && Array.isArray(c.agents.defaults.modelPolicy.allow)) {
      c.agents.defaults.modelPolicy.allow = c.agents.defaults.modelPolicy.allow.filter(k => !removedSet.has(k));
    }
    // 兼容清老结构
    if (c.agents?.defaults?.models) {
      for (const k of removedKeys) delete c.agents.defaults.models[k];
    }
    return { ok: true, removed: removedKeys.length, removedKeys, dryRun: false, knownCount: known.size, inUseCount: inUse.size };
  }).then(r => {
    if (r.ok && r.removed) log(`Prune orphans: removed ${r.removed} (${r.removedKeys.join(', ')})`);
    return r;
  });
}

// ---- Provider CRUD ----
// Update mutable fields of an existing provider: apiKey, baseUrl, api, authHeader.
// Does NOT change id (that would orphan references) or models (use /api/probe to refresh).
async function doUpdateProvider(id, patch) {
  if (!validateProviderId(id)) return { ok: false, error: `Invalid provider id`, code: E.INVALID_ID };
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'Body must be JSON object', code: E.INVALID_FIELD };
  return mutate((c) => {
    if (!c.models?.providers?.[id]) return { ok: false, error: `Provider "${id}" not found`, code: E.NOT_FOUND };
    const p = c.models.providers[id];
    const changed = [];
    for (const f of ['apiKey','baseUrl','api','authHeader']) {
      if (patch[f] !== undefined) { p[f] = patch[f]; changed.push(f); }
    }
    if (!changed.length) return { ok: false, error: 'Nothing to update (no fields provided)', code: E.MISSING_FIELD };
    return { ok: true, updated: id, changed };
  }).then(r => {
    if (r.ok) log(`Update provider ${id}: ${r.changed.join(', ')}`);
    return r;
  });
}

// Delete a provider config. Safety:
//   - Refuses if any agent's model.primary starts with `${id}/` (would break live assignment).
//   - Pass force=true to override (caller takes responsibility for re-pointing agents).
//   - Always cleans `agents.defaults.models[provider/X]` registry entries (they are
//     just historical references to a no-longer-existing provider, not live use).
async function doDeleteProvider(id, force=false) {
  if (!validateProviderId(id)) return { ok: false, error: `Invalid provider id`, code: E.INVALID_ID };
  const result = await mutate((c) => {
    if (!c.models?.providers?.[id]) return { ok: false, error: `Provider "${id}" not found`, code: E.NOT_FOUND };
    const liveDeps = new Set();
    for (const a of entriesAsList(c)) {
      const p = a?.model?.primary;
      if (p && p.startsWith(id + '/')) liveDeps.add(p);
    }
    if (liveDeps.size && !force) {
      return { ok: false, error: 'Provider is in use by agents', dependents: [...liveDeps], needForce: true, code: E.IN_USE };
    }
    delete c.models.providers[id];
    let orphansCleaned = 0;
    if (c.agents?.defaults?.modelPolicy && Array.isArray(c.agents.defaults.modelPolicy.allow)) {
      const prefix = id + '/';
      c.agents.defaults.modelPolicy.allow = c.agents.defaults.modelPolicy.allow.filter(k => {
        if (k.startsWith(prefix)) { orphansCleaned++; return false; }
        return true;
      });
    }
    // 兼容老结构
    if (c.agents?.defaults?.models) {
      const prefix = id + '/';
      for (const key of Object.keys(c.agents.defaults.models)) {
        if (key.startsWith(prefix)) { delete c.agents.defaults.models[key]; }
      }
    }
    return { ok: true, deleted: id, orphansCleaned, liveDeps: [...liveDeps] };
  });
  if (result.ok) log(`Delete provider ${id} (force=${force}, liveDeps=${result.liveDeps.length}, orphansCleaned=${result.orphansCleaned})`);
  return result;
}

// ---- SecretRef 解析（openclaw secret store） ----
// openclaw 把 apiKey / appSecret 等明文迁进 secret store 后，openclaw.json 里存的是
// {source:'store', provider:'team', id:'NAME'} 引用对象。之前这里直接拿 p.apiKey 拼
// 'Bearer ' + p.apiKey → 实际发出 "Bearer [object Object]" → 全部 401，
// 表现为「全部刷新」对每个供应商都失败、模型数永远更新不了。
// 注意：解析只用于「发请求」；写回 openclaw.json 时一律写原始引用对象，不落明文。
const SECRET_DB = path.join(OPENCLAW_HOME, '.openclaw', 'state', 'openclaw.sqlite');
let _secretCache = { at: 0, map: new Map() };

function loadSecretStore() {
  const now = Date.now();
  if (_secretCache.map.size && now - _secretCache.at < 15000) return _secretCache.map;
  const map = new Map();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(SECRET_DB, { readOnly: true });
    for (const r of db.prepare('SELECT name, value FROM secret_store_entries').all()) {
      map.set(String(r.name), String(r.value));
    }
    db.close();
  } catch (e) {
    log('Secret store read failed: ' + (e && e.message ? e.message : e));
    return _secretCache.map;            // 读失败时用旧缓存兜底
  }
  _secretCache = { at: now, map };
  return map;
}

// 把 config 里的 apiKey 字段（明文字符串 或 SecretRef 对象）解析成真正可用的 key。
// 支持三种来源：
//   1) 明文字符串
//   2) {source:'env', id:'MINIMAX_API_KEY'}  → 读进程环境变量
//   3) {source:'store', id:'XXX'}           → 读 openclaw secret store
function resolveApiKey(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    // env 引用：key 放在环境变量里，config / sqlite 都不落明文
    if (v.source === 'env') {
      const id = String(v.id || '');
      return id ? String(process.env[id] || '') : '';
    }
    const name = String(v.id || v.name || v.key || '');
    if (!name) return '';
    const store = loadSecretStore();
    if (store.has(name)) return store.get(name);
    for (const [k, val] of store) {
      if (k.toLowerCase() === name.toLowerCase()) return val;
    }
    return '';
  }
  return String(v);
}

// store 里存的是 "secret://xxx" 引用串而不是真值时（例如 switcher 早期迁移把
// 引用本身当值写进去了），绝不能把它当 Bearer token 发出去 —— 那样必然 401。
function isSecretPointer(v) {
  return typeof v === 'string' && v.startsWith('secret://');
}

// Single-URL fast refresh for one provider. Used by doRefreshAllProviders to
// keep the loop bounded — doProbe's multi-URL fallback + 15s internal fetch
// timeout would make 5 providers take 5+ minutes if any one is unreachable.
// Trades breadth (no URL fallback) for speed: if the configured baseUrl is
// wrong, the provider reports failure; user can fix via the edit button.
async function refreshOneProviderFast(id, p, perAttemptMs = 8000, opts = {}) {
  // config 里存的可能是明文，也可能是 SecretRef 引用对象（openclaw secrets store）。
  // 请求用解析后的真 key；写回配置时仍用原始引用对象 —— 绝不把明文写回 openclaw.json。
  const rawKey = p.apiKey;
  if (!rawKey) return { provider: id, ok: false, error: 'no api key', skipped: true };
  const secretKey = resolveApiKey(rawKey);
  const danglingRef = isSecretPointer(secretKey);
  if ((!secretKey || danglingRef) && !opts.noAuth) {
    // 没有可用密钥（或密钥引用已失效）时，先试「不带 Authorization」——
    // 本地无鉴权服务（LM Studio）照样能通；真要鉴权的服务会返回 401，错误信息更准。
    const note = danglingRef
      ? '密钥引用失效（store 里存的是 secret:// 指针，不是真值）'
      : ((typeof rawKey === 'object' && rawKey.source === 'env')
          ? ('环境变量 ' + (rawKey.id || '?') + ' 未设置')
          : '未配置可用密钥');
    return refreshOneProviderFast(id, p, perAttemptMs, { noAuth: true, note });
  }
  const baseUrl = (p.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return { provider: id, ok: false, error: 'no baseUrl' };

  // baseUrl can be either the API root (https://api.deepseek.com) or include /v1
  // (http://localhost:12345/v1). Handle both without doubling up.
  const url = baseUrl.endsWith('/v1') ? baseUrl + '/models' : baseUrl + '/v1/models';
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      headers: opts.noAuth ? {} : { 'Authorization': 'Bearer ' + secretKey },
      signal: AbortSignal.timeout(perAttemptMs),
    });
    if (!resp.ok) return { provider: id, ok: false, error: `HTTP ${resp.status}${opts.note ? '（' + opts.note + '）' : ''}`, elapsedMs: Date.now() - t0 };
    const data = await resp.json();
    const raw = data.data || data;
    if (!Array.isArray(raw) || !raw.length) return { provider: id, ok: false, error: 'empty model list', elapsedMs: Date.now() - t0 };

    // 与「上次注册的模型」对比 —— 这就是「实际模型」的变更明细（新增 / 移除）
    const prevIds = new Set((p.models || []).map(m => (typeof m === 'string' ? m : m && m.id)).filter(Boolean));
    const nowIds = raw.map(m => m && m.id).filter(Boolean);
    const skippedPatterns = nowIds.filter(x => /[*?]/.test(x)).length;
    const usableIds = nowIds.filter(x => !/[*?]/.test(x));
    const nowSet = new Set(nowIds);
    const addedIds = usableIds.filter(x => !prevIds.has(x));
    const droppedIds = [...prevIds].filter(x => !nowSet.has(x));

    // Use the shared apply path so refresh-all and single-probe behave identically.
    // 写回原始引用对象（SecretRef），不落明文。
    const modelList = usableIds.map(id => ({ id }));
    const r = await applyProbeResult(id, modelList, p.baseUrl, rawKey);
    log(`Refresh ${id}: ${r.count} models (+${addedIds.length}/-${droppedIds.length}, pruned ${r.removed})`);
    return { provider: id, ok: true, count: r.count, removed: r.removed,
             fixedRefs: r.fixedRefs || 0, staleRemoved: r.staleRemoved || 0,
             added: addedIds.length, dropped: droppedIds.length, skippedPatterns,
             addedIds: addedIds.slice(0, 12), droppedIds: droppedIds.slice(0, 12),
             models: usableIds.slice(0, 60), totalModels: usableIds.length,
             elapsedMs: Date.now() - t0 };
  } catch (e) {
    return { provider: id, ok: false, error: e.message, elapsedMs: Date.now() - t0 };
  }
}

// Re-probe every configured provider to refresh its model list from the live API.
// Each provider is independent — failures don't block others. With 3s per-attempt
// timeout, 5 providers complete in ~15s worst case (vs 5+ min via doProbe).
// 并行执行所有 provider 的刷新（各自独立失败不阻塞其他），
// 并发上限 6，避免一次性打爆网络/限流。
async function doRefreshAllProviders({perAttemptMs = 8000} = {}) {
  const c = read();
  if (!c.models?.providers) return { ok: true, total: 0, succeeded: 0, failed: 0, results: [] };
  const providerIds = Object.keys(c.models.providers);
  const CONCURRENCY = 6;
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < providerIds.length) {
      const id = providerIds[cursor++];
      results.push(await refreshOneProviderFast(id, c.models.providers[id], perAttemptMs));
    }
  }
  await Promise.all(Array.from({length: Math.min(CONCURRENCY, providerIds.length)}, worker));
  const succeeded = results.filter(r => r.ok).length;
  const failed = results.length - succeeded;
  log(`Refresh-all: ${succeeded}/${results.length} ok (concurrency=${CONCURRENCY}, perAttemptMs=${perAttemptMs})`);
  return { ok: true, total: results.length, succeeded, failed, results };
}

// ---- HTTP server ----

// 启动时恢复上一次更新的日志（switcher 重启后仍能回看）
try { ocUpdateLoadPersisted(); } catch(e){}

// ---- HTTP server ----
const srv = http.createServer(async (req,res)=>{
  const {method}=req; const u=new URL(req.url,`http://localhost:${PORT}`);
  const p=u.pathname; const q=Object.fromEntries(u.searchParams);

  // CORS preflight
  if(method==='OPTIONS') {
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type',
      'Access-Control-Max-Age':'86400',
    });
    return res.end();
  }

  try {
    // GET
    if(method==='GET'&&p==='/api/status') return json(res,await getStatus());
    if(method==='GET'&&p==='/api/feishu/diagnostics') {
      if (cliMissing()) return json(res,{diagnostics:{},raw:'',error:'CLI not configured'},503);
      // Cache 15s: the frontend polls this on every refresh and `channels
      // status` can take seconds — a cache keeps page loads snappy.
      const nowTs = Date.now();
      // TTL 必须大于前端轮询间隔（30s），否则每轮都 spawn 一次 channels status
      if (diagCache && nowTs - diagCacheAt < 90000) return json(res, diagCache);
      // gateway 不在服务时不要 spawn CLI（会跟 gateway 启动抢 state 库）
      if (!await gatewayReachable()) {
        if (diagCache) return json(res, diagCache);
        return json(res,{diagnostics:{},error:'Gateway 未就绪'},503);
      }
      try{
        const sp=await runCli([CLI,'channels','status'],30000);
        const lines=(sp.out||'').split('\n').filter(l=>l.includes('Feishu'));
        const diag={};
        lines.forEach(l=>{
          // 格式：Feishu <key> (<display name>): <status>，display name 里可能有嵌套括号
          const colonIdx=l.lastIndexOf(':');
          if(colonIdx<0) return;
          const left=l.substring(0,colonIdx).trim();
          const status=l.substring(colonIdx+1).trim();
          const keyMatch=left.match(/^[- ]*Feishu\s+(\S+)/);
          if(!keyMatch) return;
          const key=keyMatch[1];
          const nameMatch=left.match(/\(([^)]*?)\)/);
          const displayName=nameMatch?nameMatch[1]:key;
          diag[key]={name:displayName,raw:l,status,connected:status.includes('running')&&status.includes('connected'),hasError:status.includes('error')||status.includes('not configured')||status.includes('stopped')};
        });
        diagCache = {diagnostics:diag,raw:sp.out}; diagCacheAt = nowTs;
        return json(res,diagCache);
      }catch(e){return json(res,{diagnostics:{},error:e.message});}
    }
    if(method==='GET'&&p==='/api/feishu') {
      const c=read();
      const feishu=c.channels?.feishu||{};
      const accounts=feishu.accounts||{};
      const masked={};
      Object.entries(accounts).forEach(([k,v])=>{
        masked[k]={
          appId:v.appId||'',
          appSecret:v.appSecret?maskSecret(v.appSecret):'',
          name:v.name||k,
          enabled:v.enabled!==false,
          hasSecret:!!v.appSecret,
          allowFrom:v.allowFrom||[],
          allowCount:(v.allowFrom||[]).length
        };
      });
      const bindings=(c.bindings||[]).filter(b=>b.match?.channel==='feishu');
      return json(res,{accounts:masked,allowFrom:feishu.allowFrom||[],bindings,enabled:feishu.enabled!==false,defaultAccount:feishu.defaultAccount||''});
    }
    if(method==='GET'&&p==='/api/agents') return json(res,getAgents());
    // openclaw 本体更新信息：当前安装版本 + npm 最新版 + 历史版本列表
    if(method==='GET'&&p==='/api/openclaw/update/info') {
      const cur=currentOpenclawVersion();
      const info=await queryOpenclawVersions(q.force==='1'||q.force==='true');
      return json(res,{
        ok:true,
        current:cur.version,
        packagePath:cur.path,
        latest:info.latest,
        hasUpdate: !!info.latest && info.latest !== cur.version,
        versions: info.versions,          // 全部历史版本（含 beta/rc），升序
        error: info.latestError||null,
      });
    }
    // 安装向导：环境状态检查（30s 缓存；?force=1 强制刷新）
    if(method==='GET'&&p==='/api/openclaw/install/status') return json(res,{ok:true,...(await getInstallStatus(q.force==='1'||q.force==='true'))});
    // 安装 openclaw：Body {prefix?, root?} — prefix=程序本体位置；root=数据根目录(生成 .openclaw/workspace)
    if(method==='POST'&&p==='/api/openclaw/install') {
      let b={}; try { b=await body(req); } catch(e) {}
      // #10: 与 update/install-node 互斥（进程内锁）
      if(installRunning) return json(res,{ok:false,error:'已有安装/更新任务在进行中，请稍候'},409);
      installRunning=true;
      try {
        const r=await doInstallOpenclaw(String(b.prefix||'').trim(), String(b.root||'').trim());
        log(`OpenClaw install ${r.ok?'OK':'FAIL'} (prefix=${String(b.prefix||'').trim()||'(default)'} root=${String(b.root||'').trim()||'(none)'})`);
        return json(res,r);
      } finally { installRunning=false; }
    }
    // 一键安装 Node.js LTS（前置环境；仅 Windows + winget 可用时有效）
    if(method==='POST'&&p==='/api/openclaw/install/node') {
      if(process.platform!=='win32') return json(res,{ok:false,error:'仅 Windows 支持 winget 一键安装 Node'},400);
      // #10: 互斥
      if(installRunning) return json(res,{ok:false,error:'已有安装/更新任务在进行中，请稍候'},409);
      installRunning=true;
      try {
        log('Node.js install start (winget)');
        const w=await new Promise((resolve)=>{
          try {
            const c = require('child_process').spawn('winget',['install','-e','--id','OpenJS.NodeJS.LTS','--accept-source-agreements','--accept-package-agreements','--silent'],{windowsHide:true,shell:false});
            let out='',err='',done=false;
            const timer=setTimeout(()=>{ if(!done){done=true;killTree(c.pid); resolve({out,err,timedOut:true});} },600000);
            c.stdout.on('data',d=>{if(!done){out+=d;}});
            c.stderr.on('data',d=>{if(!done)err+=d;});
            c.on('error',e=>{if(!done){done=true;clearTimeout(timer);resolve({out,err,error:e.message});}});
            c.on('close',(code)=>{if(!done){done=true;clearTimeout(timer);resolve({out,err,code});}});
          } catch(e){ resolve({error:e.message}); }
        });
        const ok=!w.error&&!w.timedOut&&w.code===0;
        log(`Node.js install ${ok?'OK':'FAIL'} (code=${w.code})`);
        return json(res,{ok, code:w.code, error:w.error||(w.timedOut?'winget 安装超时（10 分钟）':'安装后请重启终端/服务以刷新 PATH'), output:(w.out+w.err).slice(-6000)});
      } finally { installRunning=false; }
    }
    if(method==='POST'&&p==='/api/openclaw/update') {
      let b={}; try { b=await body(req); } catch(e) {}
      // #10: 互斥
      if(installRunning) return json(res,{ok:false,error:'已有安装/更新任务在进行中，请稍候'},409);
      installRunning=true;
      try {
        const want=String(b.version||'').trim();
        // 立刻进入 running 态：版本校验要跑 npm view（最慢 60~90s），
        // 不先 reset 的话前端这几十秒只能看到上一轮的旧日志，像卡死了一样
        ocUpdateReset(want||'latest');
        ocUpdatePush('$ npm install -g openclaw' + (want ? '@'+want : ''));
        if(want && !validVersion(want)) { ocUpdateFinish(false,'版本号格式非法'); return json(res,{ok:false,error:'版本号格式非法'},400); }
        if(want){
          // 必须存在于 npm 历史版本列表（防任意包/路径注入）
          ocUpdatePush('· 校验版本…（npm view openclaw versions，可能需要 1 分钟）');
          const info=await queryOpenclawVersions(true);
          if(!(info.versions||[]).includes(want) && want!==info.latest){ ocUpdateFinish(false,'版本不在 npm 历史版本列表中'); return json(res,{ok:false,error:`版本 ${want} 不在 npm 历史版本列表中`},400); }
        }
        // 先校验目标版本的 node 要求，不满足就提前拦（否则 npm 要跑 1~2 分钟才失败）
        const eng = await checkNodeEngineFor(want);
        if (!eng.ok) { ocUpdateFinish(false, eng.error); return json(res,{ok:false,error:eng.error},400); }
        if (eng.range) ocUpdatePush(`· Node 要求 ${eng.range}（当前 ${eng.current}，满足）`);
        const args=['install','-g', ...(await npmAllowScriptsArg()), want ? `${OPENCLAW_PKG}@${want}` : OPENCLAW_PKG];
        log(`OpenClaw update start: ${want||'latest'}`);
        const r=await runNpm(args, 240000, (chunk)=>ocUpdatePush(chunk));   // npm install -g 最多 4 分钟
        const ok = !r.error && !r.timedOut && r.code===0;
        const errMsg=r.error||(r.timedOut?'npm 超时':null);
        ocUpdateFinish(ok, errMsg);
        log(`OpenClaw update ${ok?'OK':'FAIL'} ${want||'latest'} (code=${r.code})`);
        return json(res,{ok, code:r.code, error:errMsg, output:(r.out+r.err).slice(-6000)});
      } catch(e){ ocUpdateFinish(false, e.message); throw e; }
      finally { installRunning=false; }
    }
    // 更新实时进度（前端轮询；npm 输出边跑边收）
    if(method==='GET'&&p==='/api/openclaw/update/progress') {
      const st=ocUpdateProgress;
      const elapsed = st.startedAt ? ((st.finishedAt || Date.now()) - st.startedAt) : 0;
      return json(res,{
        running:st.running, version:st.version, startedAt:st.startedAt, finishedAt:st.finishedAt,
        elapsedMs:elapsed, ok:st.ok, error:st.error,
        total:st.lines.length, lines:st.lines.slice(-250)
      });
    }
    // 新建 Agent 的模板列表：现存 Agent（真实 agent，来自 agents.list，而非
    // workspace 目录——那里混着 data/media/temp 等非 agent 文件夹）
    // + 推荐模板（switcher 自带 templates/ 目录）
    if(method==='GET'&&p==='/api/agent/templates') {
      const existing=[], recommended=[];
      try {
        let c; try { c=read(); } catch(e) { c={}; }
        const ids = new Set(entriesAsList(c).map(a=>a.id));
        if (ids.size) {
          for (const id of ids) existing.push(id);
        } else {
          // config 无 agents.list 时回退扫真实 agent 目录（AGENT_ROOT）
          for(const e of fs.readdirSync(AGENT_ROOT,{withFileTypes:true})) {
            if(e.isDirectory() && !e.name.startsWith('.')) existing.push(e.name);
          }
        }
      } catch{}
      const tplRoot=path.join(SCRIPT_DIR,'templates');
      try {
        for(const e of fs.readdirSync(tplRoot,{withFileTypes:true})) {
          if(!e.isDirectory() || e.name.startsWith('.')) continue;
          // 中文释义从各模板 IDENTITY.md 的 Name 行读取（如 "专业翻译"）
          let label='';
          try {
            const m=fs.readFileSync(path.join(tplRoot,e.name,'IDENTITY.md'),'utf8').match(/-\s*\*\*Name:\*\*\s*(.+)/);
            if(m) label=m[1].trim();
          } catch{}
          recommended.push({name:e.name,label:label||e.name});
        }
      } catch{}
      // #7: 自定义模板目录 OPENCLAW_WS/_templates/（README 承诺"自动出现"，
      //     后端 create/apply 本就支持该来源，仅列表漏了）
      for(const customRoot of [path.join(WS_ROOT,'_templates')]){
        try {
          for(const e of fs.readdirSync(customRoot,{withFileTypes:true})) {
            if(!e.isDirectory() || e.name.startsWith('.')) continue;
            if(recommended.some(t=>t.name===e.name)) continue;   // 去重（覆盖同名内置）
            let label='';
            try {
              const m=fs.readFileSync(path.join(customRoot,e.name,'IDENTITY.md'),'utf8').match(/-\s*\*\*Name:\*\*\s*(.+)/);
              if(m) label=m[1].trim();
            } catch{}
            recommended.push({name:e.name,label:label||e.name+'（自定义）'});
          }
        } catch{}
      }
      existing.sort((a,b)=>a.localeCompare(b));
      recommended.sort((a,b)=>a.label.localeCompare(b.label));
      return json(res,{existing,recommended});
    }
    // openclaw 官方支持的供应商目录（= gateway 配置界面同一数据源），
    // 实时从 CLI `capability model providers` 拉取；30s 缓存（目录本身稳定，
    // configured/selected 状态随配置变化由 30s 轮询 + 写入后失效兜底）。
    if(method==='GET'&&p==='/api/providers/available') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured',hint:'set OPENCLAW_CLI env var'},503);
      const nowTs=Date.now();
      // TTL 拉到 10 分钟：该 CLI 实测 94 秒（474 模型 × 10 个 agent 的能力矩阵），
      // TTL 太短会让前端 30s 轮询每轮都 spawn 一个 CLI —— 既堆积进程，
      // 又在 gateway 启动窗口抢 state 库导致 gateway 启动失败。
      if (provAvailCache && nowTs - provAvailCacheAt < 600000) return json(res, provAvailCache);
      // gateway 不在服务时不要 spawn CLI
      if (!await gatewayReachable()) {
        if (Array.isArray(provAvailCache)) return json(res, provAvailCache);
        return json(res,{ok:false,error:'Gateway 未就绪，暂不查询供应商能力'},503);
      }
      // in-flight 去重：同时只允许一个 CLI
      if (provAvailInFlight) {
        await provAvailInFlight;
        if (Array.isArray(provAvailCache)) return json(res, provAvailCache);
        return json(res,{ok:false,error:'查询中'},503);
      }
      provAvailInFlight = (async()=>{
        // 2026.9+ 多 agent 时该命令也要求 --agent
        let defaultAgent = 'main';
        try { defaultAgent = resolveDefaultAgentId(read()) || 'main'; } catch {}
        // 给足 150s（实测 94s）
        const cliRes=await runCli([CLI,'capability','model','providers','--json','--agent',defaultAgent], 150000);
        try {
          const arr=JSON.parse(cliRes.out);
          if (Array.isArray(arr)) {
            provAvailCache=arr.map(x=>({
              id:x.provider, count:x.count||0,
              defaults:x.defaults||[], available:x.available!==false,
              configured:!!x.configured, selected:!!x.selected,
              baseUrl:(CATALOG.find(c=>c.id===x.provider)||{}).baseUrl||''
            }));
            provAvailCacheAt=Date.now();
          }
        } catch(e){}
      })();
      try { await provAvailInFlight; } finally { provAvailInFlight=null; }
      if (Array.isArray(provAvailCache)) return json(res, provAvailCache);
      return json(res,{ok:false,error:'Failed to list providers'},500);
    }
    if(method==='GET'&&p==='/api/models') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured',hint:'set OPENCLAW_CLI env var',code:E.CLI_MISSING},503);
      return json(res,await getModels(q.q||''));
    }
    if(method==='GET'&&p==='/api/providers') return json(res,getProviders());
    if(method==='GET'&&p==='/api/providers/catalog') return json(res,getCatalogWithModels());
    // Gateway 状态探针：3s timeout。返回 up/down + pid。
    if(method==='GET'&&p==='/api/gateway/status') {
      return new Promise(resolve => {
        const http = require('http');
        // 防止双重响应:error/timeout/success 三个路径只能有一个真正写头。
        // 之前这里在 timeout 路径里 req.destroy() 会异步触发 'error',
        // 导致 json() 被调两次 → ERR_HTTP_HEADERS_SENT 持续刷屏。
        let responded = false;
        const reply = (data) => {
          if (responded) return;
          responded = true;
          try { resolve(json(res, data)); }
          catch (e) { try { res.end(); } catch {} }
        };
        const req = http.get('http://127.0.0.1:18888/health', { timeout: 3000 }, r => {
          let body = ''; r.on('data', d => body += d); r.on('end', () => {
            // pid 探测：gateway 启动时把状态写进 tmp/openclaw/gateway.state.lock（含 pid），
            // 直接读文件即可。原来的 spawnSync powershell 每个探针要 700~900ms，
            // 而这个接口是前端每 10 秒打一次。
            let pid = null;
            try {
              const lk = path.join(OPENCLAW_HOME, '.openclaw', 'tmp', 'openclaw', 'gateway.state.lock');
              const j = JSON.parse(fs.readFileSync(lk,'utf8'));
              const p = j && Number.isFinite(j.pid) ? j.pid : null;
              // process.kill(pid,0) 只探测存活、不发信号
              if (p) { try { process.kill(p, 0); pid = p; } catch(e){} }
            } catch (e) {}
            // 「up」= gateway 进程还活着；「responsive」= health 端点有没有应答。
            // 两者必须分开：gateway 启动/重建 agent 库时要忙好几分钟，
            // 那期间 /health 会超时，但进程好好地活着 —— 用 health 当 up 会误报成「已挂」。
            reply({
              up: pid !== null || r.statusCode === 200,
              responsive: r.statusCode === 200,
              pid, status: r.statusCode, body: body.slice(0, 80)
            });
          });
        });
        req.on('error', () => reply({ up: false, pid: null }));
        req.on('timeout', () => { req.destroy(); reply({ up: false, pid: null, error: 'timeout' }); });
        // 客户端断开,取消 gateway 请求,不再尝试写响应
        res.on('close', () => { req.destroy(); responded = true; });
      });
    }
    if(method==='GET'&&p==='/api/backups') return json(res,getBackups(q.all==='1'||q.all==='true'));
    if(method==='GET'&&p==='/api/scenes') {
      const r=readScenes();
      if(!r.ok) return json(res,{ok:false,error:r.error},500);
      return json(res,r.scenes);
    }
    if(method==='GET'&&p==='/api/log') return json(res,{lines:getLog(q.lines||80)});
      if(method==='GET'&&p==='/api/paths') return json(res,{backupDir:BACKUP_DIR,log:LOG,scenes:SCENES,openclawHome:OPENCLAW_HOME,userData:USER_DATA_DIR});
    const fm=p.match(/^\/api\/agent\/([^/]+)\/files$/);
    if(method==='GET'&&fm) {
      // 按目录浏览：?path=<相对子目录> 返回该层级的目录+文件（单层，不递归，
      // 避免超大项目目录（18GB+）把接口拖死）。
      const base=resolveAgentWorkspace(fm[1]);
      if(!fs.existsSync(base)) return json(res,{path:'',dirs:[],files:[]});
      const rel=String(q.path||'');
      const dir=resolveWithin(base, rel);
      if(!dir) return json(res,{error:'Path not allowed'},403);
      if(!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res,{path:rel,dirs:[],files:[]});
      const dirs=[], files=[];
      // 单层条目上限：超大目录（18GB+ 项目目录）只返回前 N 项，防止前端渲染卡死
      const MAX_ENTRIES = 400;
      let truncated = false;
      try {
        for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
          // 隐藏目录（.git/.openclaw 等）不进列表，避免噪音；隐藏文件保留（.env 有时要看）
          if(e.name.startsWith('.')) continue;
          if(dirs.length + files.length >= MAX_ENTRIES) { truncated = true; break; }
          const fp=path.join(dir,e.name);
          const rp=(rel?rel+'/':'')+e.name;
          if(e.isDirectory()) dirs.push(e.name);
          else if(e.isFile()) {
            try{
              const s=fs.statSync(fp);
              files.push({name:e.name,path:rp,size:s.size,modified:s.mtime.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})});
            }catch{}
          }
        }
      } catch(e){}
      dirs.sort((a,b)=>a.localeCompare(b));
      files.sort((a,b)=>a.name.localeCompare(b.name));
      return json(res,{path:rel,dirs,files,truncated});
    }
    const frm=p.match(/^\/api\/agent\/([^/]+)\/file$/);
    if(method==='GET'&&frm) {
      const fp=resolveWithin(resolveAgentWorkspace(frm[1]), q.path||'');
      if(!fp) return json(res,{error:'Path not allowed'},403);
      if(!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return json(res,{error:'Not found'},404);
      const stat=fs.statSync(fp);
      return json(res,{content:fs.readFileSync(fp,'utf8'),size:stat.size,modified:stat.mtime.toISOString()});
    }
    // GET prune is always dryRun (safe for browser)
    if(method==='GET'&&p==='/api/agents/defaults/models/prune') return json(res,await doPruneOrphans({dryRun:true}));

    // ============== 新增功能（CLI 转发层） ==============
    // 共用辅助：解析默认 agent id（多 agent 模式必须传 --agent）
    const _defaultAgentId = () => {
      try { return resolveDefaultAgentId(read()) || 'main'; } catch { return 'main'; }
    };

    // -------- 安全审计 --------
    if(method==='GET' && p==='/api/security/audit') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const r = await runCli([CLI,'security','audit','--json'], 45000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500),err:r.err.slice(0,300)}); }
    }
    // -------- 安全审计 (managed) — stop gateway → audit → start gateway --------
    // 原因: openclaw security audit --json 实际会 ensure schema 最新,需要写 sqlite,
    //       跟 gateway 持有的 state 锁冲突,直接调会报
    //       "OpenClaw refused shared state schema mutation … another Gateway owns that state directory"。
    //       managed 走 stop → audit → start 自动避开,完整流程 ~2 分钟(778 模型预热)。
    // Body: { waitMs?: 120000 } — gateway 启动超时(默认 120s, 上限 180s)
    if(method==='POST' && p==='/api/security/audit-managed') {
      const t0 = Date.now();
      const waitMs = Math.max(2000, Math.min(parseInt(b?.waitMs)||120000, 180000));
      try { log(`Security audit-managed: requested (waitMs=${waitMs})`); } catch (_) {}
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);

      // Step 0: 探测 gateway 当前是否在跑(1s timeout)
      let gatewayWasUp = false;
      try {
        const http = require('http');
        gatewayWasUp = await new Promise(res => {
          const req = http.get('http://127.0.0.1:18888/health', { timeout: 1000 }, r => { res(r.statusCode === 200); r.resume(); });
          req.on('error', () => res(false));
          req.on('timeout', () => { req.destroy(); res(false); });
        });
      } catch (_) {}

      // Step 1: 如果 gateway 在跑,杀掉 + 清 lock
      let killed = 0, locksCleaned = 0, killErr = '';
      if (gatewayWasUp) {
        try { log(`Security audit-managed: stopping gateway`); } catch (_) {}
        const findKill = await runPowerShell(`
          $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
          $gw = @($procs | Where-Object { $_.CommandLine -like '*openclaw*gateway*' })
          $ids = $gw | ForEach-Object { $_.ProcessId }
          $gw | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
          Start-Sleep -Seconds 2
          $r = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*openclaw*gateway*' })
          $r | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
          Start-Sleep -Seconds 1
          'killed=' + $ids.Count
        `);
        if (findKill?.timedOut) killErr = 'kill-script-timeout';
        else if (findKill?.error) killErr = `kill-err: ${findKill.error}`;
        const km = /killed=(\d+)/.exec(findKill?.out || ''); if (km) killed = parseInt(km[1]);
        const lockDir = path.join(OPENCLAW_HOME, '.openclaw', 'tmp', 'openclaw');
        try {
          for (const f of fs.readdirSync(lockDir)) {
            if (f.endsWith('.lock')) {
              try { spawnSync('cmd.exe', ['/d','/c','mavis-trash',path.join(lockDir,f)], { windowsHide: true, stdio:'ignore' });
                locksCleaned++;
              } catch (_) {}
            }
          }
        } catch (_) {}
        // 等 1s 让 lock / fd 释放
        await new Promise(r => setTimeout(r, 1000));
      }

      // Step 2: 跑 audit
      let auditRaw = null, auditErr = null, auditOk = false;
      try {
        const r = await runCli([CLI,'security','audit','--json'], 45000);
        auditRaw = r.out;
        auditErr = r.err;
        try { auditOk = !!JSON.parse(r.out); } catch (_) { auditOk = false; }
      } catch (e) { auditErr = e.message; }
      try { log(`Security audit-managed: audit done (ok=${auditOk})`); } catch (_) {}

      // Step 3: 如果之前 gateway 在跑,启回来
      let restarted = false, healthy = false, pid = null, startErr = '';
      if (gatewayWasUp) {
        try { log(`Security audit-managed: starting gateway`); } catch (_) {}
        const startRes = await runPowerShell(`
          Stop-ScheduledTask -TaskName 'OpenClaw Gateway' -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 1
          Start-ScheduledTask -TaskName 'OpenClaw Gateway' -ErrorAction SilentlyContinue
          if ($?) { 'started' } else { 'start-failed' }
        `);
        restarted = /started/.test(startRes?.out || '');
        if (!restarted) startErr = (startRes?.out || '') + (startRes?.err || '');
        if (restarted) {
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 1500));
            try {
              const p = spawnSync('powershell',['-NoProfile','-Command',
                "$g = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*openclaw*gateway*' } | Select-Object -First 1 -ExpandProperty ProcessId; if ($g) { 'pid=' + $g }"
              ], { windowsHide: true, encoding:'utf8' });
              const m = (p.stdout||'').match(/pid=(\d+)/);
              if (m) pid = parseInt(m[1]);
            } catch (_) {}
            try {
              const http = require('http');
              const ok = await new Promise(res => {
                const req = http.get('http://127.0.0.1:18888/health', { timeout: 2000 }, r => { res(r.statusCode === 200); r.resume(); });
                req.on('error', () => res(false));
                req.on('timeout', () => { req.destroy(); res(false); });
              });
              if (ok) { healthy = true; break; }
            } catch {}
          }
        }
      }

      const elapsedMs = Date.now() - t0;
      try { log(`Security audit-managed: gatewayWasUp=${gatewayWasUp} killed=${killed} restarted=${restarted} healthy=${healthy} pid=${pid} elapsedMs=${elapsedMs}`); } catch (_) {}

      let auditJson = null;
      try { auditJson = JSON.parse(auditRaw || 'null'); } catch (_) {}
      return json(res, {
        ok: auditOk,
        audit: auditJson,
        auditRawPreview: (auditRaw || '').slice(0, 500),
        auditErr: (auditErr || '').slice(0, 300),
        gatewayWasUp,
        killed, locksCleaned, killErr,
        restarted, healthy, pid, startErr,
        elapsedMs,
      }, auditOk ? 200 : 500);
    }

    // -------- Doctor --------
    if(method==='GET' && p==='/api/doctor') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const r = await runCli([CLI,'doctor','--json'], 300000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',timedOut:!!r.timedOut,raw:r.out.slice(0,500),err:r.err.slice(0,300)}); }
    }

    // -------- Cron 列表 --------
    if(method==='GET' && p==='/api/cron/list') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const r = await runCli([CLI,'cron','list','--json','--agent',_defaultAgentId()], 20000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
    }

    // -------- Plugins 列表 --------
    if(method==='GET' && p==='/api/plugins/list') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const r = await runCli([CLI,'plugins','list','--json'], 30000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
    }

    // -------- MCP 列表 --------
    if(method==='GET' && p==='/api/mcp/list') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const r = await runCli([CLI,'mcp','list','--json'], 15000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
    }

    // -------- Skills 列表（按 agent） --------
    if(method==='GET' && (p==='/api/skills/list' || p.startsWith('/api/skills/list?agent='))) {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const agentId = q.agent || _defaultAgentId();
      const r = await runCli([CLI,'skills','list','--json','--agent',agentId], 20000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
    }

    // -------- Hooks 列表（按 agent） --------
    if(method==='GET' && p.startsWith('/api/hooks/list')) {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const agentId = q.agent || _defaultAgentId();
      const r = await runCli([CLI,'hooks','list','--json','--agent',agentId], 15000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
    }

    // -------- Sessions 列表（all-agents） --------
    if(method==='GET' && p==='/api/sessions/list') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const r = await runCli([CLI,'sessions','list','--json','--all-agents'], 30000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
    }

    // -------- Memory 搜索（按 agent）— 文本输出，转成结构化 --------
    if(method==='GET' && p.startsWith('/api/memory/search')) {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const query = q.q || '';
      const agentId = q.agent || _defaultAgentId();
      const limit = Math.max(1, Math.min(parseInt(q.limit)||10, 50));
      if (!query) return json(res,{ok:false,error:'query required (use ?q=...)'},400);
      // CLI 用 --max-results 不是 --limit
      const r = await runCli([CLI,'memory','search',query,'--agent',agentId,'--max-results',String(limit)], 30000);
      // 解析文本输出为结构化结果
      // 格式示例： "0.442 memory/2026-08-09.md:78-97" + 缩进行
      const lines = (r.out || '').split(/\r?\n/);
      const hits = [];
      let cur = null;
      const flush = () => { if (cur) { cur.preview = cur.preview.trim(); hits.push(cur); cur = null; } };
      for (const line of lines) {
        const m = line.match(/^(\d+\.\d+)\s+(\S+?):(\d+)(?:-(\d+))?\s*$/);
        if (m) {
          flush();
          cur = { score: parseFloat(m[1]), file: m[2], startLine: parseInt(m[3]), endLine: m[4]?parseInt(m[4]):null, preview: line };
        } else if (cur && line.trim()) {
          cur.preview += '\n' + line;
        }
      }
      flush();
      return json(res, { ok: true, query, agentId, hits, raw: r.out.slice(0, 8000) });
    }

    // -------- Sandbox 列表 + explain --------
    if(method==='GET' && p==='/api/sandbox/list') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const r = await runCli([CLI,'sandbox','list','--json'], 15000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
    }
    if(method==='GET' && p==='/api/sandbox/explain') {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const r = await runCli([CLI,'sandbox','explain','--json','--agent',q.agent||_defaultAgentId()], 15000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
    }

    // -------- Config diff（当前 openclaw.json vs 备份） --------
    if(method==='GET' && p==='/api/config/diff') {
      const bakPath = q.path;
      if (!bakPath) return json(res,{ok:false,error:'path required (use ?path=...)'},400);
      // 校验 bakPath 必须在 BACKUP_DIR
      const resolved = path.resolve(bakPath);
      if (!resolved.startsWith(path.resolve(BACKUP_DIR)+path.sep)) {
        return json(res,{ok:false,error:'path must be inside backup dir'},403);
      }
      if (!fs.existsSync(resolved)) return json(res,{ok:false,error:'backup not found'},404);
      try {
        const cur = read();
        const old = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        const diff = computeJsonDiff(old, cur, '');
        return json(res, { ok: true, from: path.basename(resolved), to: 'current', changes: diff });
      } catch (e) {
        return json(res,{ok:false,error:e.message},500);
      }
    }

    // -------- Generic config get (读任意 path 的当前值) --------
    if(method==='GET' && p.startsWith('/api/config/get')) {
      if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
      const path = q.path;
      if (!path) return json(res,{ok:false,error:'path required (use ?path=...)'},400);
      if (typeof path !== 'string' || /[^a-zA-Z0-9._\[\]$\-]/.test(path)) {
        return json(res,{ok:false,error:'path must match [a-zA-Z0-9._[]$-]'},400);
      }
      // 先本地解析（毫秒级）。原来每次都 spawn 一次 `config get --json`，实测 4.6s。
      // 本地解析不到（路径含通配等）再回落 CLI，保证语义不丢。
      try {
        const local = resolveConfigPath(read(), path);
        if (local !== undefined) return json(res, local);
      } catch(e) {}
      const r = await runCli([CLI,'config','get','--json',path], 15000);
      try { return json(res, JSON.parse(r.out)); }
      catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500),err:r.err.slice(0,200)}); }
    }

    // -------- Secrets scan（找出 openclaw.json 里所有明文 secret） --------
    if(method==='GET' && p==='/api/secrets/scan') {
      const c = read();
      const findings = [];
      const refs = [];   // 已迁移到 secret:// 的引用（不算明文，但报告一下）
      const walk = (obj, p) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach((v,i) => walk(v, `${p}[${i}]`)); return; }
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          const lc = k.toLowerCase();
          if (typeof v === 'string' && v.length > 8 && (
            lc.includes('apikey') || lc.includes('api_key') ||
            lc === 'token' || lc.includes('secret') ||
            lc.includes('password') || lc.includes('appsecret')
          )) {
            if (v.startsWith('secret://')) {
              refs.push({ path: `${p}.${k}`, ref: v });
            } else {
              findings.push({ path: `${p}.${k}`, length: v.length, preview: v.slice(0,4)+'…'+v.slice(-4) });
            }
          } else if (typeof v === 'object') {
            walk(v, `${p}.${k}`);
          }
        }
      };
      walk(c, '');
      return json(res, { ok: true, plaintext: findings.length, refs: refs.length, findings, refList: refs });
    }

    // -------- 模型延迟/错误率（仅返回已配置 provider 的 ping 测速） --------
    if(method==='GET' && p==='/api/models/latency') {
      const c = read();
      const out = [];
      const providers = (c.models && c.models.providers) || {};
      for (const [id, p] of Object.entries(providers)) {
        if (!p.apiKey) { out.push({provider:id,status:'no-key'}); continue; }
        const base = (p.baseUrl||'').replace(/\/+$/,'');
        if (!base) { out.push({provider:id,status:'no-url'}); continue; }
        const key = resolveApiKey(p.apiKey);
        if (!key) { out.push({provider:id,status:'no-key'}); continue; }
        const t0 = Date.now();
        const latUrl = base.endsWith('/v1') ? base + '/models' : base + '/v1/models';
        try {
          // 直接用 node fetch：不再把 key 拼进 PowerShell 命令行（那会出现在进程列表里），
          // 也能直接用 SecretRef 解析出来的真 key。
          const resp = await fetch(latUrl, { headers:{ 'Authorization':'Bearer '+key }, signal: AbortSignal.timeout(8000) });
          const dt = Date.now() - t0;
          out.push({ provider:id, status: resp.ok ? 'ok' : ('http-'+resp.status), latencyMs: dt, code: 'HTTP ' + resp.status });
        } catch (e) {
          out.push({ provider:id, status:'err', latencyMs: Date.now()-t0, error: String(e.message||e).slice(0,200) });
        }
      }
      return json(res, { ok: true, results: out, at: Date.now() });
    }

    // POST
    if(method==='POST') {
      let b;
      try { b=await body(req); } catch(e) { b = {}; }

      if(p==='/api/switch') {
        const n=await doSwitch(b.changes||{});
        return json(res,{status:'ok',changed:n});
      }
      if(p==='/api/probe') return json(res,await doProbe(b.provider,b.apiKey,b.baseUrl||''));
      // POST prune: opt-in to dryRun via body.dryRun or ?dryRun=true. Empty body = real prune.
      if(p==='/api/agents/defaults/models/prune') {
        const dry = !!(b?.dryRun || q.dryRun==='true' || q.dryRun==='1');
        return json(res,await doPruneOrphans({dryRun: dry}));
      }
      if(p==='/api/providers/update') return json(res,await doUpdateProvider(b.id,b));
      if(p==='/api/providers/delete') return json(res,await doDeleteProvider(b.id,!!(b?.force||q.force==='true'||q.force==='1')));
      if(p==='/api/providers/refresh-all') return json(res,await doRefreshAllProviders());
      // 手动备份：立即把当前 openclaw.json 复制到备份目录（保留 30 份，与自动备份一致）
      if(p==='/api/backup') {
        try {
          if(!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR,{recursive:true});
          const bak=path.join(BACKUP_DIR,`openclaw-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
          fs.copyFileSync(CONFIG,bak);
          fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json')).sort().reverse().slice(100).forEach(f=>fs.unlinkSync(path.join(BACKUP_DIR,f)));
          log(`Manual backup: ${path.basename(bak)}`);
          return json(res,{ok:true,backup:path.basename(bak)});
        } catch(e) {
          return json(res,{ok:false,error:e.message},500);
        }
      }
      if(p==='/api/rollback') {
        const resolved=path.resolve(String(b.path||''));
        const bakRoot=path.resolve(BACKUP_DIR);
        if(!resolved.startsWith(bakRoot+path.sep)) return json(res,{error:'Backup path not allowed'},403);
        if(!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return json(res,{error:'Backup file not found'},400);
        // C7a: 回滚前先把当前配置存入备份区（误回滚可再滚回来）
        const preBak=path.join(BACKUP_DIR,`openclaw-pre-rollback-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
        try { fs.copyFileSync(CONFIG, preBak); log(`Rollback pre-backup: ${path.basename(preBak)}`); } catch(e){}
        const tmp=CONFIG+'.new';
        fs.copyFileSync(resolved,tmp); fs.renameSync(tmp,CONFIG);
        // C7b: 配置已替换 → 清空各缓存（与 write() 一致），避免旧数据残留最多 30s
        modelsCache = null; modelsCacheAt = 0;
        diagCache = null; diagCacheAt = 0;
        provAvailCache = null; provAvailCacheAt = 0;
        log(`Rollback: ${path.basename(resolved)}`); return json(res,{status:'ok',preBackup:path.basename(preBak)});
      }
      // 重启 gateway —— 不依赖 openclaw gateway stop（那个在普通 PowerShell 里
      // 会因 env 错配报 "non-default state dir"）。直接：杀进程 → 清 lock →
      // 触发计划任务 → 轮询 /health。
      // Body: { waitMs?: 15000, confirm?: "yes" }
      if(p==='/api/gateway/restart') {
        if (String(b?.confirm||'') !== 'yes') {
          return json(res, {ok:false, error:'Need confirm:"yes" in body to restart gateway', hint:'发送 {confirm:"yes", waitMs:20000}'}, 400);
        }
        // 上限 180s：gateway 启动含 778 个模型预热要 90~120s
        const waitMs = Math.max(2000, Math.min(parseInt(b?.waitMs)||90000, 180000));
        const t0 = Date.now();
        try { log(`Gateway restart: requested (waitMs=${waitMs})`); } catch (_) {}
        // Step 1: 杀 gateway 进程（用 Get-CimInstance 取 CommandLine，PS 5.1 的 Get-Process 没这属性）
        // 重要：runPowerShell 返回 {out,err,...} 对象，正则要解析 .out 字符串部分，不能用整个对象。
        let killed = 0;
        let killErr = '';
        const findKill = await runPowerShell(`
          $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
          $gw = @($procs | Where-Object { $_.CommandLine -like '*openclaw*gateway*' })
          $ids = $gw | ForEach-Object { $_.ProcessId }
          $gw | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
          Start-Sleep -Seconds 2
          $r = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*openclaw*gateway*' })
          $r | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
          Start-Sleep -Seconds 1
          'killed=' + $ids.Count
        `);
        if (findKill?.timedOut) killErr = 'kill-script-timeout';
        else if (findKill?.error) killErr = `kill-err: ${findKill.error}`;
        const km = /killed=(\d+)/.exec(findKill?.out || ''); if (km) killed = parseInt(km[1]);
        // Step 2: 清 lock 文件（用 cmd /c mavis-trash 走回收站，避免 shell 删除拦截）
        const lockDir = path.join(OPENCLAW_HOME, '.openclaw', 'tmp', 'openclaw');
        let locksCleaned = 0;
        try {
          for (const f of fs.readdirSync(lockDir)) {
            if (f.endsWith('.lock')) {
              try { spawnSync('cmd.exe', ['/d','/c','mavis-trash',path.join(lockDir,f)], { windowsHide: true, stdio:'ignore' });
                locksCleaned++;
              } catch (_) {}
            }
          }
        } catch (_) {}
        // Step 3: 触发计划任务
        const startRes = await runPowerShell(`
          Stop-ScheduledTask -TaskName 'OpenClaw Gateway' -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 1
          Start-ScheduledTask -TaskName 'OpenClaw Gateway' -ErrorAction SilentlyContinue
          if ($?) { 'started' } else { 'start-failed' }
        `);
        // Step 4: 轮询 /health
        const started = /started/.test(startRes?.out || '');
        let healthy = false;
        let pid = null;
        if (started) {
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 1500));
            try {
              const p = spawnSync('powershell',['-NoProfile','-Command',
                "$g = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*openclaw*gateway*' } | Select-Object -First 1 -ExpandProperty ProcessId; if ($g) { 'pid=' + $g }"
              ], { windowsHide: true, encoding:'utf8' });
              const m = (p.stdout||'').match(/pid=(\d+)/);
              if (m) pid = parseInt(m[1]);
            } catch (_) {}
            try {
              const http = require('http');
              const ok = await new Promise(res => {
                const req = http.get('http://127.0.0.1:18888/health', { timeout: 2000 }, r => { res(r.statusCode === 200); r.resume(); });
                req.on('error', () => res(false));
                req.on('timeout', () => { req.destroy(); res(false); });
              });
              if (ok) { healthy = true; break; }
            } catch {}
          }
        }
        const elapsedMs = Date.now() - t0;
        // 诊断：列出 startRes 内容（截前 200 字符）方便排查 ps 脚本为什么没正常返回
        const startOutPreview = (startRes?.out || '').replace(/\s+/g, ' ').slice(0, 200);
        const startErrPreview = (startRes?.err || '').replace(/\s+/g, ' ').slice(0, 200);
        try { log(`Gateway restart: killed=${killed} locksCleaned=${locksCleaned} started=${started} healthy=${healthy} pid=${pid} elapsedMs=${elapsedMs} startOut='${startOutPreview}' startErr='${startErrPreview}' killErr='${killErr}'`); } catch {}
        return json(res, {
          ok: healthy,
          killed, locksCleaned, started, healthy, pid,
          elapsedMs,
          killErr,
          startOut: startOutPreview,
          startErr: startErrPreview,
          ...(healthy ? {} : {error:`Gateway not healthy after ${elapsedMs}ms`})
        }, healthy ? 200 : 504);
      }
      // 启动 gateway —— 不杀进程，只清 lock + 触发计划任务 + 等 health。
      // 区别于 /api/gateway/restart：restart 是 kill+start（用于配置改动后热重载），
      // start 是无脑启动（gateway 死了/从没起来时用）。不需要 confirm 防误点。
      // Body: { waitMs?: 90000 }（默认 90s，上限 180s）
      if(p==='/api/gateway/start') {
        const waitMs = Math.max(2000, Math.min(parseInt(b?.waitMs)||90000, 180000));
        const t0 = Date.now();
        try { log(`Gateway start: requested (waitMs=${waitMs})`); } catch (_) {}
        // Step 1: 清 lock 文件
        const lockDir = path.join(OPENCLAW_HOME, '.openclaw', 'tmp', 'openclaw');
        let locksCleaned = 0;
        try {
          for (const f of fs.readdirSync(lockDir)) {
            if (f.endsWith('.lock')) {
              try { spawnSync('cmd.exe', ['/d','/c','mavis-trash',path.join(lockDir,f)], { windowsHide: true, stdio:'ignore' });
                locksCleaned++;
              } catch (_) {}
            }
          }
        } catch (_) {}
        // Step 2: 触发计划任务
        let started = false;
        const startRes = await runPowerShell(`
          Stop-ScheduledTask -TaskName 'OpenClaw Gateway' -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 1
          Start-ScheduledTask -TaskName 'OpenClaw Gateway' -ErrorAction SilentlyContinue
          if ($?) { 'started' } else { 'start-failed' }
        `);
        started = /started/.test(startRes?.out || '');
        // Step 3: 轮询 /health
        let healthy = false;
        let pid = null;
        if (started) {
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 1500));
            try {
              const p = spawnSync('powershell',['-NoProfile','-Command',
                "$g = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*openclaw*gateway*' } | Select-Object -First 1 -ExpandProperty ProcessId; if ($g) { 'pid=' + $g }"
              ], { windowsHide: true, encoding:'utf8' });
              const m = (p.stdout||'').match(/pid=(\d+)/);
              if (m) pid = parseInt(m[1]);
            } catch (_) {}
            try {
              const http = require('http');
              const ok = await new Promise(res => {
                const req = http.get('http://127.0.0.1:18888/health', { timeout: 2000 }, r => { res(r.statusCode === 200); r.resume(); });
                req.on('error', () => res(false));
                req.on('timeout', () => { req.destroy(); res(false); });
              });
              if (ok) { healthy = true; break; }
            } catch {}
          }
        }
        const elapsedMs = Date.now() - t0;
        const startOutPreview = (startRes?.out || '').replace(/\s+/g, ' ').slice(0, 200);
        const startErrPreview = (startRes?.err || '').replace(/\s+/g, ' ').slice(0, 200);
        try { log(`Gateway start: locksCleaned=${locksCleaned} started=${started} healthy=${healthy} pid=${pid} elapsedMs=${elapsedMs} startOut='${startOutPreview}' startErr='${startErrPreview}'`); } catch {}
        return json(res, {
          ok: healthy,
          locksCleaned, started, healthy, pid,
          elapsedMs,
          startOut: startOutPreview,
          startErr: startErrPreview,
          ...(healthy ? {} : {error:`Gateway not healthy after ${elapsedMs}ms`})
        }, healthy ? 200 : 504);
      }
      // 停止 gateway —— kill 所有 gateway 进程 + 清 lock。
      // 不需要 confirm：等价于关掉本地服务，不是数据破坏性操作。
      if(p==='/api/gateway/stop') {
        const t0 = Date.now();
        try { log(`Gateway stop: requested`); } catch (_) {}
        let killed = 0;
        let killErr = '';
        const findKill = await runPowerShell(`
          $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
          $gw = @($procs | Where-Object { $_.CommandLine -like '*openclaw*gateway*' })
          $ids = $gw | ForEach-Object { $_.ProcessId }
          $gw | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
          Start-Sleep -Seconds 2
          $r = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*openclaw*gateway*' })
          $r | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
          Start-Sleep -Seconds 1
          'killed=' + $ids.Count
        `);
        if (findKill?.timedOut) killErr = 'kill-script-timeout';
        else if (findKill?.error) killErr = `kill-err: ${findKill.error}`;
        const km = /killed=(\d+)/.exec(findKill?.out || ''); if (km) killed = parseInt(km[1]);
        // 清 lock（stop 后下次启动更干净）
        const lockDir = path.join(OPENCLAW_HOME, '.openclaw', 'tmp', 'openclaw');
        let locksCleaned = 0;
        try {
          for (const f of fs.readdirSync(lockDir)) {
            if (f.endsWith('.lock')) {
              try { spawnSync('cmd.exe', ['/d','/c','mavis-trash',path.join(lockDir,f)], { windowsHide: true, stdio:'ignore' });
                locksCleaned++;
              } catch (_) {}
            }
          }
        } catch (_) {}
        const elapsedMs = Date.now() - t0;
        try { log(`Gateway stop: killed=${killed} locksCleaned=${locksCleaned} elapsedMs=${elapsedMs} killErr='${killErr}'`); } catch {}
        return json(res, {
          ok: true,
          killed, locksCleaned,
          elapsedMs,
          killErr
        });
      }

      // ============== 新增功能（POST） ==============
      // 安全审计 fix：调用 openclaw security audit --fix，icacls 收紧文件权限
      // CLI 不支持 --non-interactive / --yes（fix 模式本身就是非交互）
      if(p==='/api/security/fix') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        try { log(`Security fix: requested`); } catch {}
        // 先 dry-run 看看会改什么
        const dry = await runCli([CLI,'security','audit','--fix','--json'], 120000);
        // 真跑
        const real = await runCli([CLI,'security','audit','--fix'], 120000);
        const out = (real.out || '') + (real.err || '');
        // 解析 "Applied N" / "Fixed N" / "Wrote N" 之类的文本
        const applied = /Applied\s+(\d+)/i.exec(out) || /Fixed\s+(\d+)/i.exec(out) || /Wrote\s+(\d+)/i.exec(out);
        const failed = /(\d+)\s+(?:error|failure|failed)/i.exec(out);
        try { log(`Security fix: applied=${applied?applied[1]:'?'} raw-len=${out.length}`); } catch {}
        return json(res, {
          ok: real.error ? false : true,
          applied: applied ? parseInt(applied[1]) : null,
          failed: failed ? parseInt(failed[1]) : 0,
          raw: out.slice(0, 1500),
          dryPreview: (dry.out + dry.err).slice(0, 500)
        });
      }

      // Cron 增/删/启停
      if(p==='/api/cron/add') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        const agentId = b.agent || _defaultAgentId();
        const name = (b.name||'manual').toString().replace(/[^\w\-_.]/g,'_');
        // CLI: openclaw cron add --agent X --name Y --every "1h"|--cron "* * * *"|--at "20m" --message|--command ...
        const args = [CLI,'cron','add','--json','--agent',agentId,'--name',name];
        if (b.every) args.push('--every', String(b.every));
        else if (b.cron) args.push('--cron', String(b.cron));
        else if (b.at) args.push('--at', String(b.at));
        else return json(res,{ok:false,error:'specify one of: every (e.g. "1h"/"30m"), cron (5-field expr), at (ISO or "20m")'},400);
        if (b.command) args.push('--command', String(b.command));
        else if (b.message) args.push('--message', String(b.message));
        else args.push('--message', 'manual cron from switcher');
        if (b.disabled) args.push('--disabled');
        if (b.displayName) args.push('--display-name', String(b.displayName));
        const r = await runCli(args, 20000);
        try { return json(res, JSON.parse(r.out)); }
        catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
      }
      if(p==='/api/cron/remove') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        if (!b.id) return json(res,{ok:false,error:'id required'},400);
        // CLI: openclaw cron remove <id> --json（无 --agent flag）
        const r = await runCli([CLI,'cron','remove','--json',b.id], 10000);
        try { return json(res, JSON.parse(r.out)); }
        catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
      }
      if(p==='/api/cron/toggle') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        if (!b.id) return json(res,{ok:false,error:'id required'},400);
        // CLI: openclaw cron enable <id> / disable <id> --json（无 --agent flag）
        const action = b.enabled===false ? 'disable' : 'enable';
        const r = await runCli([CLI,'cron',action,'--json',b.id], 10000);
        try { return json(res, JSON.parse(r.out)); }
        catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
      }

      // Session 删除
      if(p==='/api/sessions/delete') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        if (!b.sessionId) return json(res,{ok:false,error:'sessionId required'},400);
        // CLI: openclaw sessions delete <keys...> [--agent <id>] [--yes]
        // 'key' 是 sessions.list 里的 key 字段（"agent:manju:feishu:direct:..."）
        const key = b.key || `agent:${b.agent||'main'}:${b.sessionId}`;
        const args = [CLI,'sessions','delete','--json','--yes',key];
        if (b.agent) { args.push('--agent', b.agent); }
        const r = await runCli(args, 15000);
        try { return json(res, JSON.parse(r.out)); }
        catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
      }

      // ============== 通用 config patch / get ==============
      // Body: { patch: { key: value, ... } } —— 写到临时文件，openclaw config patch --file
      // 写完会触发 gateway 热重载（90~120s）
      // 注意：--json 仅在 --dry-run 下生效；真写无 JSON 输出，从文本 "Applied N" 确认
      if(p==='/api/config/patch') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        if (!b.patch || typeof b.patch !== 'object') return json(res,{ok:false,error:'patch object required'},400);
        // 拒绝明显危险路径
        const denyPaths = ['hooks.internal', 'gateway.auth.token', 'gateway.auth.password'];
        for (const deny of denyPaths) {
          if (JSON.stringify(b.patch).includes(deny)) return json(res,{ok:false,error:`patching "${deny}" is not allowed via this endpoint`},403);
        }
        const tmp = path.join(os.tmpdir(), `cfg-patch-${Date.now()}-${process.pid}.json5`);
        try {
          fs.writeFileSync(tmp, JSON.stringify(b.patch, null, 2), 'utf8');
          // 先 dry-run 校验（带 --json）
          const dry = await runCli([CLI,'config','patch','--file',tmp,'--dry-run','--json'], 30000);
          let dryOk = false, dryData = null;
          try { dryData = JSON.parse(dry.out); dryOk = !!dryData.ok; } catch {}
          if (!dryOk) {
            try { fs.unlinkSync(tmp); } catch {}
            return json(res, {ok:false, error:'dry-run-fail', dryData, raw: dry.out.slice(0,500), err: dry.err.slice(0,300)});
          }
          // 真写（不带 --json，文本输出）
          const real = await runCli([CLI,'config','patch','--file',tmp], 30000);
          try { fs.unlinkSync(tmp); } catch {}
          const applied = /Applied\s+(\d+)\s+config\s+update/i.exec(real.out + real.err);
          if (applied) {
            try { log(`Config patch: ${applied[1]} update(s)`); } catch {}
            return json(res, {ok:true, applied: parseInt(applied[1]), dryData, raw: (real.out+real.err).slice(0,300) });
          }
          return json(res, {ok:false,error:'apply-fail',raw:(real.out+real.err).slice(0,500)});
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch {}
          return json(res,{ok:false,error:e.message},500);
        }
      }

      // ============== 插件启停（patch plugins.entries.X.enabled） ==============
      // --json 仅在 dry-run 下生效；真写从 "Applied N" 文本确认
      if(p==='/api/plugin/toggle') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        if (!b.id) return json(res,{ok:false,error:'id required'},400);
        if (typeof b.enabled !== 'boolean') return json(res,{ok:false,error:'enabled (boolean) required'},400);
        const patch = { plugins: { entries: { [b.id]: { enabled: b.enabled } } } };
        const tmp = path.join(os.tmpdir(), `cfg-patch-${Date.now()}-${process.pid}.json5`);
        try {
          fs.writeFileSync(tmp, JSON.stringify(patch), 'utf8');
          const r = await runCli([CLI,'config','patch','--file',tmp], 30000);
          try { fs.unlinkSync(tmp); } catch {}
          const applied = /Applied\s+(\d+)\s+config\s+update/i.exec(r.out + r.err);
          if (applied) return json(res, {ok:true, plugin:b.id, enabled:b.enabled, applied:parseInt(applied[1])});
          return json(res, {ok:false,error:'apply-fail',raw:(r.out+r.err).slice(0,500)});
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch {}
          return json(res,{ok:false,error:e.message},500);
        }
      }

      // ============== Skills 启停（patch skills.entries.X.enabled） ==============
      if(p==='/api/skill/toggle') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        if (!b.name) return json(res,{ok:false,error:'name required'},400);
        if (typeof b.enabled !== 'boolean') return json(res,{ok:false,error:'enabled (boolean) required'},400);
        const patch = { skills: { entries: { [b.name]: { enabled: b.enabled } } } };
        const tmp = path.join(os.tmpdir(), `cfg-patch-${Date.now()}-${process.pid}.json5`);
        try {
          fs.writeFileSync(tmp, JSON.stringify(patch), 'utf8');
          const r = await runCli([CLI,'config','patch','--file',tmp], 30000);
          try { fs.unlinkSync(tmp); } catch {}
          const applied = /Applied\s+(\d+)\s+config\s+update/i.exec(r.out + r.err);
          if (applied) return json(res, {ok:true, skill:b.name, enabled:b.enabled, applied:parseInt(applied[1])});
          return json(res, {ok:false,error:'apply-fail',raw:(r.out+r.err).slice(0,500)});
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch {}
          return json(res,{ok:false,error:e.message},500);
        }
      }

      // ============== Sandbox 模式（patch agents.defaults.sandbox） ==============
      // Body: { mode: "off"|"non-main"|"all", scope?: "agent"|"session"|"shared",
      //         backend?: "docker"|"podman", workspaceAccess?: "none"|"ro"|"rw" }
      // 正确路径是 agents.defaults.sandbox，不是 tools.sandbox
      if(p==='/api/sandbox/mode') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        if (!b.mode) return json(res,{ok:false,error:'mode required (off|non-main|all)'},400);
        if (!['off','non-main','all'].includes(b.mode)) return json(res,{ok:false,error:'mode must be off|non-main|all'},400);
        const patch = { agents: { defaults: { sandbox: { mode: b.mode } } } };
        if (b.scope && ['session','agent','shared'].includes(b.scope)) patch.agents.defaults.sandbox.scope = b.scope;
        if (b.backend) patch.agents.defaults.sandbox.backend = b.backend;
        if (b.workspaceAccess && ['none','ro','rw'].includes(b.workspaceAccess)) patch.agents.defaults.sandbox.workspaceAccess = b.workspaceAccess;
        const tmp = path.join(os.tmpdir(), `cfg-patch-${Date.now()}-${process.pid}.json5`);
        try {
          fs.writeFileSync(tmp, JSON.stringify(patch), 'utf8');
          const r = await runCli([CLI,'config','patch','--file',tmp], 30000);
          try { fs.unlinkSync(tmp); } catch {}
          const applied = /Applied\s+(\d+)\s+config\s+update/i.exec(r.out + r.err);
          if (applied) return json(res, {ok:true, mode:b.mode, applied:parseInt(applied[1]), raw:(r.out+r.err).slice(0,200)});
          return json(res, {ok:false,error:'apply-fail',raw:(r.out+r.err).slice(0,500)});
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch {}
          return json(res,{ok:false,error:e.message},500);
        }
      }

      // 工具权限（agents.entries.X.tools.deny）—— 通过 config patch JSON5
      if(p==='/api/agent/tools/set') {
        if (!b.agent) return json(res,{ok:false,error:'agent required'},400);
        if (!Array.isArray(b.deny)) return json(res,{ok:false,error:'deny must be string[]'},400);
        return json(res, await mutate((c) => {
          const e = entriesAsList(c).find(x => x.id === b.agent);
          if (!e) return { ok:false, error:`agent ${b.agent} not found` };
          e.tools = e.tools || {};
          e.tools.deny = b.deny;
          setEntry(c, b.agent, e);
          return { ok:true, agent:b.agent, deny:b.deny };
        }));
      }

      // Sandbox 重新创建
      if(p==='/api/sandbox/recreate') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        const args = [CLI,'sandbox','recreate','--json'];
        if (b.all) args.push('--all');
        else if (b.agent) args.push('--agent', b.agent);
        const r = await runCli(args, 60000);
        try { return json(res, JSON.parse(r.out)); }
        catch { return json(res, {ok:false,error:'parse-fail',raw:r.out.slice(0,500)}); }
      }

      // Secrets 迁移：把 openclaw.json 里的明文 secret 移到 openclaw secrets 引用
      // 流程：
      //   1) 先调用 openclaw secrets set 把值存进 secret store（用 path 衍生 ref 名）
      //   2) 然后 config patch 把原值替换为 secret:// 引用
      // Body: { paths?: string[] } —— 默认扫描所有明文 secret 字段；可选只迁某些路径
      if(p==='/api/secrets/migrate') {
        if (cliMissing()) return json(res,{ok:false,error:'CLI not configured'},503);
        const c = read();
        const targetPaths = Array.isArray(b.paths) ? b.paths : null;
        const findings = [];
        const walk = (obj, p) => {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) { obj.forEach((v,i) => walk(v, `${p}[${i}]`)); return; }
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            const lc = k.toLowerCase();
            if (typeof v === 'string' && v.length > 8 && (
              lc.includes('apikey') || lc.includes('api_key') ||
              lc === 'token' || lc.includes('secret') ||
              lc.includes('password') || lc.includes('appsecret')
            )) {
              findings.push({ path: `${p}.${k}`, value: v });
            } else if (typeof v === 'object') {
              walk(v, `${p}.${k}`);
            }
          }
        };
        walk(c, '');
        const todo = targetPaths ? findings.filter(f => targetPaths.includes(f.path)) : findings;
        if (todo.length === 0) return json(res, {ok:true, migrated:0, message:'no plaintext secrets found'});
        const results = [];
        for (const f of todo) {
          // 衍生 ref 名：把 path 转成 secret:// 形式（替换 . 和 [ 为 _）
          const refName = f.path.replace(/[\.\[\]]/g, '_').replace(/^_+/, '').toLowerCase();
          const refUri = `secret://${refName}`;
          // 1) set
          const setRes = await runCli([CLI,'secrets','set',refName,f.value], 10000);
          if (setRes.error || /error|fail/i.test(setRes.out+setRes.err)) {
            results.push({ path:f.path, status:'set-fail', err: (setRes.out+setRes.err).slice(0,200) });
            continue;
          }
          // 2) patch openclaw.json：把原值换成 refUri
          const ok = mutateSync((cur) => {
            // 安全地按 path 走
            const parts = f.path.split('.').flatMap(s => s.match(/[^\[\]]+|\[\d+\]/g) || []);
            let obj = cur;
            for (let i = 0; i < parts.length-1; i++) {
              const p = parts[i];
              const idx = p.match(/^\[(\d+)\]$/);
              if (idx) { obj = obj[parseInt(idx[1])]; } else { obj = obj[p]; }
              if (!obj) return false;
            }
            const last = parts[parts.length-1];
            const idx = last.match(/^\[(\d+)\]$/);
            if (idx) obj[parseInt(idx[1])] = refUri;
            else obj[last] = refUri;
            return true;
          });
          if (!ok) {
            results.push({ path:f.path, status:'patch-fail', ref: refUri });
          } else {
            results.push({ path:f.path, status:'migrated', ref: refUri });
          }
        }
        const ok = results.filter(r => r.status==='migrated').length;
        return json(res, { ok: ok === results.length, migrated: ok, total: results.length, results });
      }

      if(p==='/api/agent/create') {
        const id=b.id;
        if(!id||!/^[a-zA-Z][a-zA-Z0-9_-]{1,30}$/.test(id)) return json(res,{ok:false,error:'Agent ID 必须英文字母开头，2-30 字符 (字母/数字/下划线/连字符)'},400);
        // 模板查找顺序：
        //   1) <SCRIPT_DIR>/templates/<tpl>   —— 推荐模板（随 switcher 分发）
        //   2) WS_ROOT/_templates/<tpl>       —— 旧推荐位置（兼容迁移前）
        //   3) 现存 Agent 配置里的 workspace    —— 真实 agent（可能不在 WS_ROOT/<id>）
        //   4) WS_ROOT/<tpl>                  —— 兜底
        // 模板名为空 = 空白创建（不复制任何文件），由用户在聊天中自行确认。
        const tplName = String(b.workspaceTemplate || '').trim();
        let tmpl = null;
        if (tplName) {
          // M6: reject traversal/absolute template names (sub-paths stay allowed)
          if (tplName.includes('..') || path.isAbsolute(tplName) || !/^[a-zA-Z0-9_./-]{1,60}$/.test(tplName)) {
            return json(res,{ok:false,error:'Invalid template name'},400);
          }
          let agentWs = null;
          try { agentWs = entryById(read(), tplName)?.workspace || null; } catch {}
          for (const cand of [
            path.join(SCRIPT_DIR, 'templates', tplName),
            path.join(WS_ROOT, '_templates', tplName),
            agentWs,
            path.join(WS_ROOT, tplName),
          ]) {
            if (!cand) continue;
            try { if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) { tmpl = cand; break; } } catch {}
          }
          if (!tmpl) {
            return json(res,{ok:false,error:`模板不存在: ${tplName}（可选: 现存 Agent 或推荐模板）`},400);
          }
        }
        const c0=read();
        // 重复创建保护：id 已存在于 agents.entries 时拒绝（防同名双 entry）
        if(c0.agents?.entries && Object.prototype.hasOwnProperty.call(c0.agents.entries, id))
          return json(res,{ok:false,error:`Agent id 已存在: ${id}`},400);
        // 工作区：显式提供则用之；留空 = openclaw 默认工作区（defaults.workspace/<id> 或 WS_ROOT/<id>）
        let ws=null, wsExplicit=false;
        if(b.workspace!==undefined && String(b.workspace).trim()!==''){
          const v=validateWorkspacePath(b.workspace);
          if(!v.ok) return json(res,{ok:false,error:v.error},400);
          ws=v.path; wsExplicit=true;
        } else {
          ws=resolveDefaultWorkspaceFor(c0,id);
        }
        if(fs.existsSync(ws)) return json(res,{ok:false,error:`Workspace ${ws} 已存在`},400);
        fs.mkdirSync(ws,{recursive:true});
        if (tmpl) {
          ['AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md','USER.md','HEARTBEAT.md','BOOTSTRAP.md'].forEach(f=>{
            const src=path.join(tmpl,f); if(fs.existsSync(src)) fs.copyFileSync(src,path.join(ws,f));
          });
        }
        // 记忆隔离：MEMORY.md 是模板 agent 的运行记忆（决策/路线记录），
        // 新 agent 必须从空白开始，不能继承。
        const memFile=path.join(ws,'MEMORY.md');
        fs.writeFileSync(memFile,'# Memory\n\n<!-- 新 agent 的记忆从这里开始记录 -->\n','utf8');
        const ad=path.join(AGENT_ROOT,id,'agent'); fs.mkdirSync(ad,{recursive:true});
        const c=read();
        if(!c.agents) c.agents={defaults:{}};
        if(!c.agents.defaults) c.agents.defaults={};
        ensureModelPolicy(c);
        setEntry(c, id, { name:id, agentDir:ad, ...(wsExplicit?{workspace:ws}:{}) });
        if(b.appId&&b.appSecret) {
          if(!c.channels) c.channels={feishu:{enabled:true,accounts:{}}};
          if(!c.channels.feishu) c.channels.feishu={enabled:true,accounts:{}};
          if(!c.channels.feishu.accounts) c.channels.feishu.accounts={};
          // 保留已有字段（重复创建时不清掉 allowFrom 等）
          const prevAcc=c.channels.feishu.accounts[`${id}_bot`]||{};
          c.channels.feishu.accounts[`${id}_bot`]={...prevAcc,appId:b.appId,appSecret:b.appSecret,enabled:true};
          if(!c.bindings) c.bindings=[];
          c.bindings.push({type:'route',agentId:id,match:{channel:'feishu',accountId:`${id}_bot`}});
        }
        write(c); log(`Create: ${id} (tpl=${b.workspaceTemplate||'(none)'}, feishu=${!!(b.appId&&b.appSecret)})`);
        return json(res,{ok:true});
      }
      if(p==='/api/agent/delete') {
        const id=b.id;
        // Same validation as create: '..' / absolute paths would make rmSync
        // delete arbitrary directories (path traversal -> data loss).
        if(!id || !validateAgentId(id)) return json(res,{ok:false,error:'Invalid agent id (must start with a letter, 2-30 chars)'},400);
        // #3: 配置修改全部走 mutate（串行化）；目录删除在配置写成功后执行——
        // 配置写失败则 agent 原样保留；目录删除失败只留磁盘垃圾，可重试。
        const rr=await mutate((c)=>{
          // C2: 默认 agent 保护——删除会改变路由/工作区根的解析语义
          const delDefaultId=resolveDefaultAgentId(c);
          if(id===delDefaultId) return {ok:false,error:`「${id}」是当前默认 agent，不可直接删除。请先在编辑中把默认标记移到其他 agent，或先创建替代 agent。`};
          const e=entryById(c, id);
          if(!e) return {ok:false,error:`Agent "${id}" not found`,code:E.NOT_FOUND};
          deleteEntry(c, id);
          if(c.channels?.feishu?.accounts){
            const botKey=`${id}_bot`;
            const removedAllow=(c.channels.feishu.accounts[botKey]?.allowFrom)||[];
            delete c.channels.feishu.accounts[botKey];
            pruneFeishuGlobalAllowFrom(c, removedAllow);
          }
          if(c.bindings) c.bindings=c.bindings.filter(x=>x.agentId!==id);
          return {ok:true};
        });
        if(!rr.ok) return json(res,rr, rr.code===E.NOT_FOUND?404:400);
        // 配置已删 → 清理场景死键（与 rename 的迁移对称；#6b 走 scenes 串行链）
        try {
          if(fs.existsSync(SCENES)){
            const sr=await mutateScenes((scenes)=>{
              let changed=false;
              for(const s of scenes){ if(s&&s.config&&s.config[id]!==undefined){ delete s.config[id]; changed=true; } }
              return {ok:true, changed};
            });
            if(sr.ok && sr.changed) log(`Scene cleanup after delete: ${id}`);
          }
        } catch{}
        // 目录删除（失败只留垃圾，不影响配置一致性）
        [path.join(WS_ROOT,id),path.join(AGENT_ROOT,id)].forEach(p=>{try{fs.rmSync(p,{recursive:true,force:true})}catch(e){}});
        log(`Delete: ${id}`);
        return json(res,{ok:true});
      }
      // 更新 Agent 基本信息：显示名 / 默认模型 / 默认 Agent 标记 / 工作区
      // Body: {id, name?, model?, default?, workspace?}（只更新传了的字段）
      //   workspace 传绝对路径 = 变更工作区（自动迁移目录）；
      //   workspace 传空字符串 = 恢复默认工作区（defaults.workspace/<id> 或 WS_ROOT/<id>，目录迁移回去）
      if(p==='/api/agent/update') {
        const {id, name, model, default: isDefault, workspace}=b;
        if(!id || !validateAgentId(id)) return json(res,{ok:false,error:'Invalid agent id'},400);
        // —— 工作区变更：校验在锁外（快速失败），迁移+写入在 mutate 锁内完成，
        //    失败回滚目录，保证「目录与配置要么都新要么都旧」（#4 原子性）。 ——
        let wsRequest = null;   // {current, wsTarget, rootWs, others} 锁外预检结果
        if(workspace!==undefined){
          const c0=read();
          const e0=entryById(c0, id);
          if(!e0) return json(res,{ok:false,error:`Agent "${id}" not found`,code:E.NOT_FOUND},404);
          const current=resolveAgentWorkspace(id);
          // 安全保护：当前工作区是「默认工作区根」时禁止自动迁移整个根目录
          //（main 的解析工作区就是根；先变更默认工作区或手动移动目录）
          const rootWs=String(c0.agents?.defaults?.workspace||'').trim()||WS_ROOT;
          if(path.resolve(current)===path.resolve(rootWs) && path.resolve(rootWs)!==path.resolve(WS_ROOT))
            return json(res,{ok:false,error:`「${id}」当前使用默认工作区根目录（${current}），不能自动迁移。请先在概览中变更 openclaw 默认工作区，或手动移动目录后再设置。`},400);
          if(path.resolve(current)===path.resolve(WS_ROOT) && !String(c0.agents?.defaults?.workspace||'').trim())
            return json(res,{ok:false,error:`「${id}」当前使用 openclaw 默认工作区根目录（${current}），不能自动迁移。请先变更默认工作区或手动移动目录。`},400);
          const raw=String(workspace||'').trim();
          let wsTarget;
          if(raw){
            const v=validateWorkspacePath(raw);
            if(!v.ok) return json(res,{ok:false,error:v.error},400);
            wsTarget=v.path;
          } else {
            // 恢复默认：删除 entry.workspace 后回落到的位置
            wsTarget=resolveDefaultWorkspaceFor(c0,id);
          }
          // 父目录保护：目标/当前工作区若是其他 agent 工作区的父目录（或相同路径），
          // 迁移会拖走/冲突别的 agent 的数据（如把 workspace 指向根目录会把所有 agent 目录卷走）。
          if(path.resolve(current)!==path.resolve(wsTarget)){
            const others=entriesAsList(c0).filter(a=>a.id!==id).map(a=>({id:a.id, ws:(()=>{try{return path.resolve(resolveAgentWorkspace(a.id, c0));}catch{return null;}})()})).filter(x=>x.ws);
            const t=path.resolve(wsTarget);
            const conflict=others.find(x=>x.ws===t);
            if(conflict)
              return json(res,{ok:false,error:`目标工作区 ${wsTarget} 与 agent「${conflict.id}」的工作区相同，拒绝迁移（两个 agent 不能共用同一工作区）。`},400);
            const parentOf=others.find(x=>x.ws.startsWith(t+path.sep));
            if(parentOf)
              return json(res,{ok:false,error:`目标工作区 ${wsTarget} 是 agent「${parentOf.id}」工作区的父目录，拒绝迁移（会拖走其他 agent 数据）。请选择更具体的目录。`},400);
            // 当前工作区是其他 agent 的父目录时也不允许迁移
            const cur=path.resolve(current);
            const childOf=others.find(x=>x.ws!==cur && x.ws.startsWith(cur+path.sep));
            if(childOf)
              return json(res,{ok:false,error:`当前工作区 ${current} 是 agent「${childOf.id}」工作区的父目录，迁移会拖走其他 agent 数据。请先手动整理目录结构。`},400);
            wsRequest={current, wsTarget};
          }
        }
        const rr = await mutate((c)=>{
          const e=entryById(c, id);
          if(!e) return {ok:false,error:`Agent "${id}" not found`,code:E.NOT_FOUND};
          // #4: 目录迁移在锁内、写配置前完成；任何后续失败都回滚目录（配置不变）
          let wsReport=[], wsChanged=false;
          if(wsRequest){
            const m=migrateWorkspaceDir(wsRequest.current, wsRequest.wsTarget);
            if(!m.ok) return {ok:false,error:m.error};
            wsReport=m.report; wsChanged=true;
          }
          // 后续校验失败 → 回滚已迁移的目录
          const rollbackWs = () => {
            if(wsChanged){
              try {
                if(fs.existsSync(wsRequest.wsTarget)) fs.renameSync(wsRequest.wsTarget, wsRequest.current);
                wsChanged=false;
              } catch {}
            }
          };
          if(name!==undefined){
            const n=String(name).trim();
            e.name = n ? n : id;   // 空名回退 id
          }
          if(model!==undefined){
            const m=String(model).trim();
            if(!m){ rollbackWs(); return {ok:false,error:'模型不能为空'}; }
            if(!e.model) e.model={};
            e.model.primary=m;
            // 同步 allow list（替代老的 agents.defaults.models registry）
            ensureModelPolicy(c);
            addModelToAllowList(c, m);
          }
          if(isDefault!==undefined){
            // C6: 默认标记变更会改变默认 agent 的解析（无显式 workspace 时默认 agent 解析到
            // defaults.workspace 根，其他 agent 解析到 defaults.workspace/<id>）。
            // 原默认 agent 若无显式 workspace，冻结其当前解析路径，防止解析跳变导致工作区"消失"。
            // 注意：必须在写入 e.default 之前读取原默认（否则 resolveDefaultAgentId 已返回新默认）。
            if(isDefault){
              const prevDefaultId=resolveDefaultAgentId(c);
              const prev=entryById(c, prevDefaultId);
              if(prev && prev.id!==id && !prev.workspace){
                const rootWs=path.resolve(String(c.agents?.defaults?.workspace||'').trim()||WS_ROOT);
                const childDir=path.join(rootWs, prev.id);
                let childIsDir=false;
                try { childIsDir = fs.existsSync(childDir) && fs.statSync(childDir).isDirectory(); } catch {}
                // 目录不在 base/<id> → 说明 prev 的数据就放在默认根（作为默认 agent 的语义）。
                // 失去默认后解析会跳变到 base/<id>（目录不存在）→ 冻结为当前解析（根），防止工作区"消失"。
                // 目录在 base/<id> → 失去默认后自动解析回该处，无需冻结。
                if(!childIsDir){
                  const frozen=resolveAgentWorkspace(prev.id);
                  prev.workspace=frozen;
                  setEntry(c, prev.id, prev);   // entryById 返回的是拷贝，要写回
                }
              }
            }
            if(isDefault) e.default=true;
            else { delete e.default; }
          }
          if(workspace!==undefined){
            if(String(workspace||'').trim()) e.workspace=wsRequest.wsTarget;
            else delete e.workspace;   // 恢复默认解析
          }
          // 把改动写回 entries（新结构）
          setEntry(c, id, e);
          return {ok:true,id, wsReport, wsChanged};
        });
        if (rr.ok) log(`Update agent ${id}${rr.wsChanged?' (workspace: '+rr.wsReport.join('; ')+')':''}`);
        if(rr.ok && rr.wsChanged) rr.report=rr.wsReport;
        return json(res, rr);
      }
      // 变更 openclaw 默认工作区（agents.defaults.workspace）。
      // Body: {workspace: string} — 绝对路径；空字符串 = 恢复 openclaw 内置默认（WS_ROOT）。
      // 注意：只改配置，不迁移任何目录；受影响的是「无显式 workspace 的 agent」，
      //       它们的解析路径会立即跟随新默认值（目录需用户自行处理/迁移）。
      if(p==='/api/agents/defaults/workspace') {
        const raw=String(b.workspace||'').trim();
        let target=null;
        if(raw){
          const v=validateWorkspacePath(raw);
          if(!v.ok) return json(res,{ok:false,error:v.error},400);
          target=v.path;
        }
        const rr=await mutate((c)=>{
          if(!c.agents) c.agents={defaults:{},list:[]};
          if(!c.agents.defaults) c.agents.defaults={};
          if(target) c.agents.defaults.workspace=target;
          else delete c.agents.defaults.workspace;
          // 受影响 agent：无显式 workspace 的（解析会跟随默认值）
          const affected=entriesAsList(c).filter(a=>!a.workspace).map(a=>a.id);
          return {ok:true, workspace:target||WS_ROOT, affected};
        });
        if(rr.ok) log(`Default workspace: ${target||'(openclaw default: '+WS_ROOT+')'}`);
        return json(res,rr);
      }
      // 重命名 Agent（完整迁移 id 的全部关联）：
      //   workspace 目录 / agents 目录(含会话) / 配置字段 / bindings /
      //   飞书账号键(旧id_bot→新id_bot) / scenes.json 键
      // 默认 agent（main）禁止重命名（openclaw 有 'main' 硬编码回退）。
      // #3/#4: 整体包进 mutate（串行化）；目录迁移在锁内完成，任一步失败
      //        回滚已迁移目录且不写配置（原子性）。
      if(p==='/api/agent/rename') {
        const {id, newId}=b;
        if(!id || !validateAgentId(id)) return json(res,{ok:false,error:'Invalid agent id'},400);
        if(!newId || !validateAgentId(newId)) return json(res,{ok:false,error:'Invalid new id'},400);
        if(newId===id) return json(res,{ok:false,error:'新旧 id 相同'},400);
        if(id==='main') return json(res,{ok:false,error:'默认 agent（main）不可重命名'},400);
        try {
          const rr = await mutate(async (c)=>{
            const entry=entryById(c, id);
            if(!entry) return {ok:false,error:`Agent "${id}" not found`,code:E.NOT_FOUND};
            const defs = entriesAsList(c).filter(a => a.default);
            const defaultAgentId = String((defs.length?defs[0]:entriesAsList(c)[0]||{}).id||'main').trim();
            if(id===defaultAgentId && !entry.default)
              return {ok:false,error:'当前默认 agent（无 default 标记的首个 agent）不可重命名，请先另设默认'};
            if(c.agents?.entries && Object.prototype.hasOwnProperty.call(c.agents.entries, newId))
              return {ok:false,error:`id 已存在: ${newId}`};
            // C1: 工作区迁移按「真实解析位置」计算，而非硬编码 WS_ROOT/<id>：
            //   - 无显式 workspace（走 defaults.workspace/<id>）→ 目标 = defaults.workspace/<newId>
            //   - 显式 workspace 且末段目录名 == id（如 D:\openclaw\workspace\mybot）→ 同级改名为 <newId>
            //   - 自定义路径与 id 无关（如 D:\projects\blog）→ 不迁移（显式路径优先，rename 不影响）
            const norm = p => String(p||'').replace(/[\\/]+$/,'');
            const curWs = resolveAgentWorkspace(id);
            let oldWs = null, newWs = null;
            if (entry.workspace) {
              const w = norm(entry.workspace);
              if (path.basename(w) === id) { oldWs = w; newWs = path.join(path.dirname(w), newId); }
            } else {
              oldWs = curWs;
              newWs = resolveDefaultWorkspaceFor(c, newId);
            }
            if(newWs && fs.existsSync(newWs)) return {ok:false,error:`目标工作区已存在: ${newWs}`};
            const oldAgentDir=path.join(AGENT_ROOT,id), newAgentDir=path.join(AGENT_ROOT,newId);
            if(fs.existsSync(newAgentDir)) return {ok:false,error:`目标 agent 目录已存在: ${newAgentDir}`};

            const report=[];
            const moved=[];   // 已迁移的目录（失败回滚用）
            try {
              // 1) workspace 目录改名（oldWs/newWs 可能为 null：自定义路径与 id 无关时不动）
              if(oldWs && newWs && fs.existsSync(oldWs) && path.resolve(oldWs)!==path.resolve(newWs)){
                fs.renameSync(oldWs,newWs); moved.push({from:oldWs,to:newWs}); report.push('workspace 目录');
              }
              // 2) agents 目录改名（含 agent/ 与 sessions/）
              if(fs.existsSync(oldAgentDir)){
                fs.renameSync(oldAgentDir,newAgentDir); moved.push({from:oldAgentDir,to:newAgentDir}); report.push('agent 目录(含会话)');
              }
            } catch(e) {
              // 回滚已迁移的目录
              for(const m of moved.reverse()){ try{ fs.renameSync(m.to,m.from); }catch{} }
              return {ok:false,error:'目录迁移失败（已回滚）: '+e.message};
            }
            // 3) 配置字段：写入新 key 并删旧 key
            if(entry){
              if(!entry.name || entry.name===id) entry.name=newId;
              if(entry.workspace && newWs && norm(entry.workspace)===oldWs) entry.workspace=newWs;
              if(entry.agentDir){
                const n=norm(entry.agentDir);
                // 兼容两种写法：.../agents/<id> 与 .../agents/<id>/agent
                if(n===oldAgentDir) entry.agentDir=newAgentDir;
                else if(n===path.join(AGENT_ROOT,id,'agent')) entry.agentDir=path.join(AGENT_ROOT,newId,'agent');
              }
              // 写新 entry（不含 id 字段，因为 id 是 key），删旧 key
              setEntry(c, newId, entry);
              deleteEntry(c, id);
            }
            // 4) bindings（agentId + 飞书账号 accountId）
            let bindingsChanged=0;
            if(c.bindings) for(const x of c.bindings){
              if(x.agentId===id){ x.agentId=newId; bindingsChanged++; }
              if(x.match?.accountId===`${id}_bot`){ x.match.accountId=`${newId}_bot`; bindingsChanged++; }
            }
            if(bindingsChanged) report.push('路由绑定');
            // 5) 飞书账号键 oldid_bot → newid_bot
            const oldKey=`${id}_bot`, newKey=`${newId}_bot`;
            if(c.channels?.feishu?.accounts && c.channels.feishu.accounts[oldKey]){
              c.channels.feishu.accounts[newKey]=c.channels.feishu.accounts[oldKey];
              delete c.channels.feishu.accounts[oldKey];
              report.push('飞书账号');
            }
            // 6) scenes.json 键迁移（switcher 自己的场景文件；坏文件不迁移、不覆盖）
            //    #6b: 走 scenes 串行链，防与 scenes/save|delete 并发覆盖
            try {
              if(fs.existsSync(SCENES)){
                const sr=await mutateScenes((scenes)=>{
                  let changed=false;
                  for(const s of scenes){ if(s&&s.config&&s.config[id]!==undefined){ s.config[newId]=s.config[id]; delete s.config[id]; changed=true; } }
                  return {ok:true, changed};
                });
                if(sr.ok && sr.changed) report.push('场景配置');
              }
            } catch{}
            return {ok:true, oldId:id, newId, report};
          });
          if(!rr.ok) return json(res,rr, rr.code===E.NOT_FOUND?404:400);
          log(`Rename agent: ${id} -> ${newId} (${rr.report.join(', ')||'配置'})`);
          return json(res,{ok:true,oldId:id,newId,report:rr.report});
        } catch(e){
          return json(res,{ok:false,error:'重命名失败: '+e.message},500);
        }
      }
      // 切换 Agent 模板（慎用）：用模板覆盖工作区文档文件并重置记忆。
      // Body: {id, template}  — template 为空 = 清空模板文件恢复空白
      if(p==='/api/agent/template/apply') {
        const {id, template}=b;
        if(!id || !validateAgentId(id)) return json(res,{ok:false,error:'Invalid agent id'},400);
        const ws=resolveAgentWorkspace(id);
        if(!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) return json(res,{ok:false,error:'Agent workspace not found'},400);
        const tplName=String(template||'').trim();
        let tmpl=null;
        if(tplName){
          if(tplName.includes('..')||path.isAbsolute(tplName)||!/^[a-zA-Z0-9_./-]{1,60}$/.test(tplName))
            return json(res,{ok:false,error:'Invalid template name'},400);
          let agentWs=null;
          try { agentWs=entryById(read(), tplName)?.workspace || null; } catch {}
          for(const cand of [
            path.join(SCRIPT_DIR,'templates',tplName),
            path.join(WS_ROOT,'_templates',tplName),
            agentWs,
            path.join(WS_ROOT,tplName),
          ]){
            if(!cand) continue;
            try { if(fs.existsSync(cand)&&fs.statSync(cand).isDirectory()){tmpl=cand;break;} } catch{}
          }
          if(!tmpl) return json(res,{ok:false,error:`模板不存在: ${tplName}`},400);
        }
        const DOCS=['AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md','USER.md','HEARTBEAT.md','BOOTSTRAP.md'];
        for(const f of DOCS){
          const fp=path.join(ws,f);
          if(tmpl){
            const src=path.join(tmpl,f);
            if(fs.existsSync(src)) fs.copyFileSync(src,fp);
          } else {
            try{ if(fs.existsSync(fp)) fs.unlinkSync(fp); }catch{}
          }
        }
        // 记忆重置：不继承任何旧记忆
        fs.writeFileSync(path.join(ws,'MEMORY.md'),'# Memory\n\n<!-- 新 agent 的记忆从这里开始记录 -->\n','utf8');
        log(`Apply template ${tplName||'(blank)'} -> ${id}`);
        return json(res,{ok:true,applied:tplName||'(blank)'});
      }
      // Toggle a tool in an agent's deny list (e.g. cron — which breaks LM
      // Studio requests because its schema pattern isn't ^...$-anchored).
      // Body: {id, tool, deny: true|false}
      if(p==='/api/agent/tools/toggle') {
        const {id, tool, deny}=b;
        if(!id || !validateAgentId(id)) return json(res,{ok:false,error:'Invalid agent id'},400);
        if(typeof tool!=='string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(tool))
          return json(res,{ok:false,error:'Invalid tool name'},400);
        const rr = await mutate((c)=>{
          const e=entryById(c, id);
          if(!e) return {ok:false,error:`Agent "${id}" not found`,code:E.NOT_FOUND};
          if(!e.tools) e.tools={};
          if(!Array.isArray(e.tools.deny)) e.tools.deny=[];
          const idx=e.tools.deny.indexOf(tool);
          if(deny && idx<0) e.tools.deny.push(tool);
          if(!deny && idx>=0) e.tools.deny.splice(idx,1);
          if(!e.tools.deny.length) delete e.tools.deny;
          if(Object.keys(e.tools).length===0) delete e.tools;
          setEntry(c, id, e);   // entryById 是拷贝，要写回
          return {ok:true,id,tool,denied:!!deny};
        });
        if (rr.ok) log(`Tools ${id}: ${tool} ${rr.denied?'denied':'allowed'}`);
        return json(res, rr);
      }
      const fwm=p.match(/^\/api\/agent\/([^/]+)\/file\/write$/);
      if(fwm) {
        const fp=resolveWithin(resolveAgentWorkspace(fwm[1]), b.path||'');
        if(!fp) return json(res,{error:'Path not allowed'},403);
        const dir=path.dirname(fp); if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(fp,String(b.content??''),'utf8'); log(`Write: ${fwm[1]}/${b.path}`);
        return json(res,{status:'ok'});
      }
      if(p==='/api/scenes/save') {
        // #6b: 走 scenes 串行链（读-改-写原子）
        const rr=await mutateScenes((scenes)=>{
          const idx=scenes.findIndex(x=>x.name===b.name);
          const entry={name:b.name,timestamp:ts(),config:b.config};
          if(idx>=0) scenes[idx]=entry; else scenes.push(entry);
          return {ok:true, changed:true};
        });
        if(!rr.ok) return json(res,{ok:false,error:rr.error},500);
        log(`Scene save: ${b.name}`);
        return json(res,{status:'ok'});
      }
      if(p==='/api/scenes/apply') {
        // 只读场景 → 不用 scenes 锁（避免与 rename 的 config 锁交叉死锁）
        const r=readScenes();
        if(!r.ok) return json(res,{ok:false,error:r.error},500);
        const s=r.scenes.find(x=>x.name===b.name);
        if(!s) return json(res,{error:'Scene not found'},404);
        const n=await doSwitch(s.config||{});   // await: response must not race the write
        return json(res,{status:'ok',changed:n});
      }
      if(p==='/api/scenes/delete') {
        const rr=await mutateScenes((scenes)=>{
          const before=scenes.length;
          for(let i=scenes.length-1;i>=0;i--){ if(scenes[i].name===b.name) scenes.splice(i,1); }
          return {ok:true, changed:scenes.length!==before};
        });
        if(!rr.ok) return json(res,{ok:false,error:rr.error},500);
        log(`Scene delete: ${b.name}`);
        return json(res,{status:'ok'});
      }

      // ---- 飞书 Bot 管理 ----
      // Feishu account keys must be safe identifiers: openclaw normalizes
      // illegal characters (observed: ':' → '-'), so a key like
      // 'v1:eyJhb_bot' never matches → "not configured, stopped" forever.
      // Keys are forced to [a-z0-9_-] and always end with _bot.
      if(p==='/api/feishu/bot/save') {
        const {botKey,appId,appSecret,name,enabled}=b;
        if(!botKey||!appId) return json(res,{ok:false,error:'需要 botKey 和 appId'},400);
        const normalized=normalizeBotKey(botKey, `bot_${appId.replace(/[^a-z0-9]/gi,'').slice(0,10)}`);
        const c=read();
        if(!c.channels) c.channels={};
        if(!c.channels.feishu) c.channels.feishu={enabled:true,accounts:{},allowFrom:[]};
        if(!c.channels.feishu.accounts) c.channels.feishu.accounts={};
        const existing=c.channels.feishu.accounts[normalized]||c.channels.feishu.accounts[botKey]||{};
        // 必须保留现有字段（allowFrom/dmPolicy/groupPolicy…）——之前整体重建
        // 导致"保存后白名单消失"（allowFrom 被丢弃）。
        c.channels.feishu.accounts[normalized]={
          ...existing,
          appId,
          appSecret:appSecret||existing.appSecret||'',
          name:name||normalized.replace(/_bot$/,''),
          enabled:enabled!==false
        };
        if(botKey!==normalized&&c.channels.feishu.accounts[botKey]) delete c.channels.feishu.accounts[botKey];
        write(c); log(`Feishu bot save: ${normalized}${botKey!==normalized?' (auto-normalized from '+botKey+')':''}`);
        return json(res,{ok:true,botKey:normalized,normalized:botKey!==normalized});
      }
      // 删 bot 时同步清理全局默认白名单里「它独占」的 open_id。
      // 全局列表是「注册过的所有 bot 的 owner 累计」（见 /api/feishu/regsave：
      // 注册时同时写全局和账号级），删 bot 不清就会留下孤儿条目，
      // 让全局白名单条数比 bot 数多（2026-08-24 删掉第 11 个 bot 后就多了一条）。
      // 注意：别的 bot 还在用的 open_id 必须保留，所以只删「独占」的。
      function pruneFeishuGlobalAllowFrom(cfg, removedAllowFrom){
        try{
          const list = cfg?.channels?.feishu?.allowFrom;
          if(!Array.isArray(list) || !removedAllowFrom || !removedAllowFrom.length) return 0;
          const stillUsed = new Set();
          for(const a of Object.values(cfg?.channels?.feishu?.accounts||{})){
            for(const x of (a.allowFrom||[])) stillUsed.add(String(x).trim());
          }
          const removed = new Set(removedAllowFrom.map(x=>String(x).trim()).filter(Boolean));
          const n0 = list.length;
          cfg.channels.feishu.allowFrom = list.filter(x=>{
            const v = String(x).trim();
            return !(removed.has(v) && !stillUsed.has(v));
          });
          return n0 - cfg.channels.feishu.allowFrom.length;
        }catch(e){ return 0; }
      }
      if(p==='/api/feishu/bot/delete') {
        const {botKey}=b;
        if(!botKey) return json(res,{ok:false,error:'需要 botKey'},400);
        const c=read();
        const removedAllow=(c.channels?.feishu?.accounts?.[botKey]?.allowFrom)||[];
        if(c.channels?.feishu?.accounts) delete c.channels.feishu.accounts[botKey];
        const pruned=pruneFeishuGlobalAllowFrom(c, removedAllow);
        // 同步删除相关 binding
        if(c.bindings) c.bindings=c.bindings.filter(x=>!(x.match?.channel==='feishu'&&x.match?.accountId===botKey));
        write(c); log(`Feishu bot delete: ${botKey}${pruned?` (pruned ${pruned} global allowFrom)`:''}`);
        return json(res,{ok:true,prunedGlobalAllowFrom:pruned});
      }
      if(p==='/api/feishu/binding/save') {
        const {botKey,agentId}=b;
        if(!botKey||!agentId) return json(res,{ok:false,error:'需要 botKey 和 agentId'},400);
        const c=read();
        if(!c.bindings) c.bindings=[];
        // 去重：同一 accountId 只保留一条
        c.bindings=c.bindings.filter(x=>!(x.match?.channel==='feishu'&&x.match?.accountId===botKey));
        c.bindings.push({type:'route',agentId,match:{channel:'feishu',accountId:botKey}});
        write(c); log(`Feishu binding: ${botKey} → ${agentId}`);
        return json(res,{ok:true});
      }
      if(p==='/api/feishu/binding/delete') {
        const {botKey}=b;
        if(!botKey) return json(res,{ok:false,error:'需要 botKey'},400);
        const c=read();
        if(c.bindings) c.bindings=c.bindings.filter(x=>!(x.match?.channel==='feishu'&&x.match?.accountId===botKey));
        write(c); log(`Feishu binding delete: ${botKey}`);
        return json(res,{ok:true});
      }
      if(p==='/api/feishu/allowfrom/add') {
        const {openId,botKey}=b;
        if(!openId) return json(res,{ok:false,error:'需要 openId'},400);
        const c=read();
        if(!c.channels) c.channels={};
        if(!c.channels.feishu) c.channels.feishu={enabled:true,accounts:{},allowFrom:[]};
        if(botKey){
          // 加到指定 bot 的 allowFrom
          if(!c.channels.feishu.accounts) c.channels.feishu.accounts={};
          if(!c.channels.feishu.accounts[botKey]) return json(res,{ok:false,error:'Bot 不存在'},400);
          if(!c.channels.feishu.accounts[botKey].allowFrom) c.channels.feishu.accounts[botKey].allowFrom=[];
          if(!c.channels.feishu.accounts[botKey].allowFrom.includes(openId)){
            c.channels.feishu.accounts[botKey].allowFrom.push(openId);
            write(c);
            log(`AllowFrom add: ${openId} → ${botKey}`);
            return json(res,{ok:true,scope:'bot',botKey});
          }
          return json(res,{ok:true,scope:'bot',botKey,alreadyExists:true});
        } else {
          // 加到全局默认白名单
          if(!c.channels.feishu.allowFrom) c.channels.feishu.allowFrom=[];
          if(!c.channels.feishu.allowFrom.includes(openId)){
            c.channels.feishu.allowFrom.push(openId);
            write(c);
            log(`AllowFrom add (global): ${openId}`);
          }
          return json(res,{ok:true,scope:'global'});
        }
      }
      if(p==='/api/feishu/allowfrom/remove') {
        const {openId,botKey}=b;
        if(!openId) return json(res,{ok:false,error:'需要 openId'},400);
        const c=read();
        if(botKey){
          // 从指定 bot 的 allowFrom 删
          if(c.channels?.feishu?.accounts?.[botKey]?.allowFrom){
            c.channels.feishu.accounts[botKey].allowFrom=c.channels.feishu.accounts[botKey].allowFrom.filter(x=>x!==openId);
          }
        } else {
          // 从全局删
          if(c.channels?.feishu?.allowFrom) c.channels.feishu.allowFrom=c.channels.feishu.allowFrom.filter(x=>x!==openId);
          // 同步从所有 bot 删
          if(c.channels?.feishu?.accounts){
            Object.keys(c.channels.feishu.accounts).forEach(k=>{
              if(c.channels.feishu.accounts[k].allowFrom){
                c.channels.feishu.accounts[k].allowFrom=c.channels.feishu.accounts[k].allowFrom.filter(x=>x!==openId);
              }
            });
          }
        }
        write(c); log(`AllowFrom remove: ${openId}${botKey?' ('+botKey+')':''}`);
        return json(res,{ok:true});
      }

      // ---- 飞书扫码一键创建 Bot (走 openclaw 内置 OAuth device-code) ----
      if(p==='/api/feishu/register/begin') {
        if (!FEISHU_REG_PATH || !fs.existsSync(FEISHU_REG_PATH)) {
          return json(res,{ok:false,error:'Feishu registration module not found',hint:'install OpenClaw with feishu integration, or set FEISHU_REG',code:E.FEISHU_MISSING},503);
        }
        // Drop expired sessions so the map can't grow unbounded
        const nowTs=Date.now();
        for (const [k,s] of regSessions) { if (nowTs - s.startedAt > (s.expireIn + 120) * 1000) regSessions.delete(k); }
        try {
          const reg=await import(pathToFileURL(FEISHU_REG_PATH).href);
          await reg.initAppRegistration('feishu');
          // 直接 post registration 拿原始响应（绕开 openclaw 的 launcher 包装）；
          // 用内置 fetch 而非 curl，跨平台零依赖。
          const base='https://accounts.feishu.cn';
          const resp=await fetch(`${base}/oauth/v1/app/registration`,{
            method:'POST',
            headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({action:'begin',archetype:'PersonalAgent',auth_method:'client_secret',request_user_info:'open_id'}),
            signal:AbortSignal.timeout(15000),
          });
          const raw=await resp.json();
          if(!raw.device_code) throw new Error('Feishu 未返回 device_code: '+JSON.stringify(raw).slice(0,200));
          const verificationUri='https://accounts.feishu.cn/oauth/v1/app/registration';
          // Prefer the API-supplied verification_uri_complete (already has
          // user_code embedded in the path). Fall back to manual construction
          // with ?session=USERCODE if Feishu doesn't return it.
          const domain=b.domain||'feishu';
          const baseUrl=domain==='lark'?'https://open.larksuite.com':'https://open.feishu.cn';
          const qrUrl = raw.verification_uri_complete
            || `${baseUrl}/page/launcher?from=oc_onboard&tp=ob_cli_app&session=${encodeURIComponent(raw.user_code||'')}`;
          regSessions.set(raw.device_code,{deviceCode:raw.device_code,interval:raw.interval||5,expireIn:raw.expire_in||600,startedAt:Date.now(),result:null});
          log(`Feishu register begin: device=${raw.device_code.slice(0,15)}...`);
          return json(res,{ok:true,sessionId:raw.device_code,qrUrl,userCode:raw.user_code,interval:raw.interval||5,expireIn:raw.expire_in||600,verificationUri});
        } catch(e) {
          log(`Feishu register begin FAIL: ${e.message}`);
          return json(res,{ok:false,error:e.message},500);
        }
      }
      if(p==='/api/feishu/register/poll') {
        const {sessionId}=b;
        const sess=regSessions.get(sessionId);
        if(!sess) return json(res,{ok:false,status:'unknown'});
        if(sess.result) return json(res,{ok:true,status:'done',result:sess.result});
        try {
          const reg=await import(pathToFileURL(FEISHU_REG_PATH).href);
          const status=await reg.pollAppRegistration({deviceCode:sessionId,interval:sess.interval,expireIn:Math.max(60,(sess.expireIn*1000-(Date.now()-sess.startedAt))/1000)});
          if(status.status==='success') {
            sess.result=status.result;
            log(`Feishu register success: appId=${status.result.appId.slice(0,10)}...`);
            return json(res,{ok:true,status:'done',result:status.result});
          }
          return json(res,{ok:true,status:status.status||'pending'});
        } catch(e) {
          return json(res,{ok:false,status:'error',error:e.message});
        }
      }
      if(p==='/api/feishu/register/save') {
        const {sessionId,botKey,agentId}=b;
        const sess=regSessions.get(sessionId);
        if(!sess||!sess.result) return json(res,{ok:false,error:'扫码未完成或已过期'},400);
        const {appId,appSecret,openId}=sess.result;
        const c=read();
        if(!c.channels) c.channels={};
        if(!c.channels.feishu) c.channels.feishu={enabled:true,accounts:{}};
        if(!c.channels.feishu.accounts) c.channels.feishu.accounts={};
        // 默认键：优先用 agent 名（coding → coding_bot），否则 appId 派生；
        // 规范化去掉冒号等非法字符（v1:eyJhb_bot 会让 openclaw 永远 not configured）。
        const accountId=normalizeBotKey(
          botKey,
          agentId ? `${agentId}_bot` : `${appId.replace(/[^a-z0-9]/gi,'').slice(0,12)}_bot`
        );
        // 保留已有字段（重复保存/重扫时不清掉 allowFrom 等）
        const prevAcc=c.channels.feishu.accounts[accountId]||{};
        c.channels.feishu.accounts[accountId]={...prevAcc,appId,appSecret,name:accountId.replace(/_bot$/,''),enabled:true};
        // 自动加 open_id 到白名单
        if(openId){
          if(!c.channels.feishu.allowFrom) c.channels.feishu.allowFrom=[];
          if(!c.channels.feishu.allowFrom.includes(openId)) c.channels.feishu.allowFrom.push(openId);
          if(!c.channels.feishu.accounts[accountId].allowFrom) c.channels.feishu.accounts[accountId].allowFrom=[];
          if(!c.channels.feishu.accounts[accountId].allowFrom.includes(openId)) c.channels.feishu.accounts[accountId].allowFrom.push(openId);
        }
        // 自动绑路由
        if(agentId){
          if(!c.bindings) c.bindings=[];
          c.bindings=c.bindings.filter(x=>!(x.match?.channel==='feishu'&&x.match?.accountId===accountId));
          c.bindings.push({type:'route',agentId,match:{channel:'feishu',accountId}});
        }
        write(c);
        regSessions.delete(sessionId);
        log(`Feishu register saved: ${accountId}${agentId?' → '+agentId:''}`);
        return json(res,{ok:true,accountId,appId,openId});
      }
    }

    // HTML root (only for /) — no-store: the frontend ships new JS frequently
    // and a heuristic-cached old page shows stale/broken buttons.
    if(p === '/' && fs.existsSync(HTML)) {
      const content=fs.readFileSync(HTML,'utf8');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});
      res.end(content);
      return;
    }
        if(method==='GET' && p==='/api/open-path'){
      const reqPath = String(q.path || '');
      if (!reqPath) return json(res, { error: 'missing path query param' }, 400);
      const norm = reqPath.replace(/\\/g, '/');
      // 动态加入默认工作区（可能是自定义路径，不在静态白名单内）
      // + 所有 agent 的解析工作区（C3: 自定义 workspace 也能用 📂 打开）
      let defWs = '';
      const agentWs = [];
      try {
        const cWs=read();
        defWs = String(cWs.agents?.defaults?.workspace || '').trim();
        for(const a of entriesAsList(cWs)){ try{ agentWs.push(resolveAgentWorkspace(a.id, cWs)); }catch{} }
      } catch {}
      const allowed = [
        BACKUP_DIR,
        path.dirname(BACKUP_DIR),
        path.dirname(LOG),
        path.dirname(SCENES),
        OPENCLAW_HOME,
        WS_ROOT,
        path.dirname(WS_ROOT),
        defWs || null,
        ...agentWs
      ].filter(Boolean).map(x => x.replace(/\\/g, '/'));
      const ok = allowed.some(a => {
        return norm === a || norm.startsWith(a + (a.endsWith('/') ? '' : '/'));
      });
      if (!ok) return json(res, { error: 'path not whitelisted: ' + reqPath }, 403);
      const { spawn } = require('child_process');
      try {
        if (process.platform === 'win32') {
          spawn('explorer.exe', [reqPath], { detached: true, stdio: 'ignore' });
        } else if (process.platform === 'darwin') {
          spawn('open', [reqPath], { detached: true, stdio: 'ignore' });
        } else {
          // Linux + others
          spawn('xdg-open', [reqPath], { detached: true, stdio: 'ignore' });
        }
        log('Open: ' + reqPath);
        return json(res, { status: 'ok', path: reqPath });
      } catch (e) {
        return json(res, { error: 'spawn failed: ' + e.message }, 500);
      }
    }
          // Static file serving — whitelist only the two frontend assets.
          // Everything else (switcher.cjs, scenes.example, tgz…) stays private.
      if(method==='GET' && p.startsWith('/') && !p.startsWith('/api/')){
        const rel = p.replace(/^\/+/,'');
        if (rel && !rel.includes('..') && !rel.includes('\\') && STATIC_ALLOW.has(rel)) {
          const fp = path.join(SCRIPT_DIR, rel);
          const ext = path.extname(fp).toLowerCase();
          const mime = ext === '.js' ? 'application/javascript; charset=utf-8'
                     : ext === '.html' ? 'text/html; charset=utf-8'
                     : 'application/octet-stream';
          const content = fs.readFileSync(fp);
          // C4: 禁止缓存——switcher 迭代频繁，max-age 曾导致部署后 UI 不更新（需强刷）
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
          res.end(content);
          return;
        }
      }

      // Fallback: every unmatched request gets a real 404 (previously the
      // connection hung forever with no response).
      return json(res, { error: 'Not found', code: E.NOT_FOUND }, 404);
    } catch(e) {
      // A second writeHead after headers are sent throws
      // ERR_HTTP_HEADERS_SENT inside the catch — unhandled, it would crash
      // the whole server (M2). Guard it.
      log('ERR: '+e.message);
      if (res.headersSent) { try { res.end(); } catch {} return; }
      json(res,{error:e.message},500);
    }
});

// ---- 端口冲突自动重试 ----
function tryListen(port, tries) {
  srv.listen(port,'0.0.0.0',()=>{
    PORT = port;
    log(`Server: http://localhost:${port} (pid=${process.pid})`);
  });
  srv.on('error',(e)=>{
    if(e.code==='EADDRINUSE' && tries < MAX_PORT_TRIES) {
      log(`Port ${port} in use, trying ${port+1}...`);
      srv.removeAllListeners('error');
      tryListen(port+1, tries+1);
    } else {
      log(`FATAL: Cannot bind port ${port} — ${e.message}`);
      process.exit(1);
    }
  });
}
tryListen(PORT, 0);
