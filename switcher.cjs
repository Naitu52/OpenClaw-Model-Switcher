'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
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
    'config.msi', '.cache', '.local', 'snap',
    'proc', 'sys', 'dev', 'run', 'lost+found',
    'var', 'private', 'tmp', 'etc',
]);

function quickParents() {
    const all = process.platform === 'win32' ? [
        'D:\\', 'C:\\',
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
            if (!e.isDirectory() || SKIP_DIRS.has(lower) || e.name.startsWith('.') || e.name.startsWith('$')) continue;
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
        const sp = spawnSync('npm', ['root', '-g'], {
            encoding: 'utf8', timeout: 5000,
            shell: process.platform === 'win32'
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
        const sp = spawnSync('npm', ['root', '-g'], {
            encoding: 'utf8', timeout: 5000,
            shell: process.platform === 'win32'
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
            if (trimmed && fs.existsSync(trimmed)) return trimmed;
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
        'D:\\openclaw\\.openclaw',
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
    return firstExisting(
        'D:\\openclaw\\workspace',
        'C:\\openclaw\\workspace',
        path.join(os.homedir(), 'workspace'),
        sibling
    );
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
        'D:\\nodejs\\node_global\\node_modules\\openclaw\\openclaw.mjs',
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
function write(cfg) {
  const tmp=CONFIG+'.new';
  fs.writeFileSync(tmp,JSON.stringify(cfg,null,2),'utf8');
  fs.renameSync(tmp,CONFIG);
  if(!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR,{recursive:true});
  const bak=path.join(BACKUP_DIR,`openclaw-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  try { fs.copyFileSync(CONFIG,bak); } catch(e) {}
  try { fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json')).sort().reverse().slice(30).forEach(f=>fs.unlinkSync(path.join(BACKUP_DIR,f))); } catch(e) {}
}

function json(res,data,code=200) {
  res.writeHead(code,{
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
  });
  res.end(JSON.stringify(data));
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

function getAgents() {
  let c; try { c=read(); } catch(e) { return []; }
  const dm = c.agents?.defaults?.model?.primary || 'minimax/MiniMax-M3';
  let list = c.agents?.list || [];
  if(!list.length && fs.existsSync(AGENT_ROOT)) {
    list = fs.readdirSync(AGENT_ROOT).filter(d=>{try{return fs.statSync(path.join(AGENT_ROOT,d)).isDirectory();}catch{return false;}}).map(id=>{
      const ws=path.join(WS_ROOT,id);
      return {id,name:id,workspace:fs.existsSync(ws)?ws:'',agentDir:path.join(AGENT_ROOT,id,'agent')};
    });
  }
  return list.map(a=>({
    id:a.id, name:a.name||a.id,
    model:a.model?.primary||dm, default:dm,
    workspace:a.workspace||'', agentDir:a.agentDir||'',
    status:'active'
  }));
}

function getModels(q) {
  let r;
  try {
    const sp = spawnSync('node',[CLI,'models','list','--all','--json'],{encoding:'utf8',timeout:30000});
    r = JSON.parse(sp.stdout);
  } catch(e) { return []; }
  let c; try { c=read(); } catch(e) { c={}; }
  const keyed=new Set();
  if(c.models?.providers) Object.keys(c.models.providers).forEach(k=>{ if(c.models.providers[k].apiKey) keyed.add(k); });
  const seen=new Set();
  return (r.models||[]).filter(m=>{
    if(seen.has(m.key)) return false; seen.add(m.key);
    if(!q) return true;
    const lq=q.toLowerCase();
    return m.key.toLowerCase().includes(lq)||(m.name||'').toLowerCase().includes(lq);
  }).map(m=>({
    key:m.key, name:m.name, provider:m.key.split('/')[0],
    available:m.available||keyed.has(m.key.split('/')[0]),
    hasKey:keyed.has(m.key.split('/')[0]),
    ctx:m.contextWindow, input:m.input
  }));
}

function getProviders() {
  let c; try { c=read(); } catch(e) { return []; }
  if(!c.models?.providers) return [];
  return Object.entries(c.models.providers).map(([k,v])=>({
    id:k, baseUrl:v.baseUrl||'',
    key:v.apiKey?`${v.apiKey.slice(0,4)}●●●${v.apiKey.slice(-4)}`:'',
    models:(v.models||[]).map(m=>`${k}/${m.id}`)
  }));
}

function getCatalogWithModels() {
  // 从 config 里获取已配 key 的供应商及其模型
  let c; try { c=read(); } catch(e) { c={}; }
  const configProviders = c.models?.providers || {};
  return CATALOG.map(cat => {
    const cp = configProviders[cat.id];
    const models = (cp?.models||[]).map(m=>({
      id:m.id, key:`${cat.id}/${m.id}`, name:m.name||m.id,
      ctx:m.contextWindow, input:m.input
    }));
    return {
      id:cat.id, name:cat.name, baseUrl:cat.baseUrl,
      hasKey:!!cp?.apiKey, modelCount:models.length,
      models
    };
  });
}

function getBackups() {
  if(!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json')).sort().reverse().slice(0,30).map(f=>{
    const fp=path.join(BACKUP_DIR,f);
    const s=fs.statSync(fp);
    return {name:f,time:s.mtime.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),path:fp,size:s.size};
  });
}

function getScenes() {
  try { return JSON.parse(fs.readFileSync(SCENES,'utf8')); } catch(e) { return []; }
}

function getLog() {
  try { return fs.readFileSync(LOG,'utf8').trim().split('\n').slice(-80); } catch(e) { return []; }
}

function getStatus() {
  let c; try { c=read(); } catch(e) { return {error:'Config read failed'}; }
  const agents = getAgents();
  const providers = getProviders();
  const models = getModels('');
  return {
    port:PORT,
    configPath:CONFIG,
    agents:agents.length,
    providers:providers.filter(p=>p.key).length,
    modelsTotal:models.length,
    modelsAvailable:models.filter(m=>m.available).length,
    backups:getBackups().length,
    scenes:getScenes().length,
    defaultModel:c.agents?.defaults?.model?.primary||'N/A',
    uptime:process.uptime(),
    nodeVersion:process.version,
    pid:process.pid,
  };
}

function doSwitch(changes) {
  const c=read(); const list=c.agents?.list||[];
  const log_entries=[];
  Object.entries(changes).forEach(([id,nm])=>{
    const e=list.find(a=>a.id===id); if(!e) return;
    const old = e.model?.primary || '(inherit)';
    if(!e.model) e.model={};
    e.model.primary=nm;
    if(!c.agents.defaults.models) c.agents.defaults.models={};
    if(!c.agents.defaults.models[nm]) c.agents.defaults.models[nm]={};
    log_entries.push(`${id}: ${old} → ${nm}`);
  });
  if(log_entries.length) { write(c); log(`Switch: ${log_entries.join(' | ')}`); }
  return log_entries.length;
}

async function doProbe(provider,apiKey,baseUrl) {
  if(!baseUrl) { const cat=CATALOG.find(x=>x.id===provider); baseUrl=cat?cat.baseUrl:`https://api.${provider}.com`; }
  // Try multiple URL patterns
  const urls = [];
  if(!baseUrl.includes('/v1')) urls.push(baseUrl+'/v1/models');
  urls.push(baseUrl.replace(/\/v1$/,'')+'/v1/models');
  urls.push(baseUrl.replace(/\/+$/,'')+'/models');

  for(const probeUrl of urls) {
    try {
      let resp = await fetch(probeUrl,{headers:{'Authorization':'Bearer '+apiKey},signal:AbortSignal.timeout(15000)});
      let data;
      if(!resp.ok) {
        // 尝试不带 Bearer 前缀（Anthropic 风格）
        resp = await fetch(probeUrl,{headers:{'Authorization':apiKey},signal:AbortSignal.timeout(8000)});
        if(!resp.ok) continue; // try next URL
        data = await resp.json();
      } else { data = await resp.json(); }
      const raw = data.data || data;
      if(!Array.isArray(raw)||!raw.length) continue;
      const models = raw.map(m=>({id:m.id,key:`${provider}/${m.id}`}));
      const c=read();
      if(!c.models) c.models={mode:'merge',providers:{}};
      if(!c.models.providers) c.models.providers={};
      c.models.providers[provider] = {
        baseUrl:baseUrl.replace(/\/v1\/models$/,'').replace(/\/models$/,''),
        apiKey, api:'openai-completions', authHeader:true,
        models:models.map(m=>({id:m.id,name:m.id,input:['text'],contextWindow:128000,maxTokens:8192}))
      };
      if(!c.agents.defaults.models) c.agents.defaults.models={};
      models.forEach(m=>{if(!c.agents.defaults.models[m.key])c.agents.defaults.models[m.key]={};});

      // ---- auto-prune orphans for this provider in agents.defaults.models ----
      // A key `${provider}/X` is an orphan if X is no longer in the freshly-probed
      // model list, AND no agent currently uses it as `model.primary`. This makes
      // probe() a real-time read: every successful probe reconciles.
      {
        const probedIds = new Set(models.map(m => m.id));
        const keepByAgent = new Set();
        if (c.agents.list) for (const a of c.agents.list) {
          const p = a?.model?.primary;
          if (p && p.startsWith(provider + '/')) keepByAgent.add(p);
        }
        const prefix = provider + '/';
        let removed = 0;
        for (const key of Object.keys(c.agents.defaults.models)) {
          if (!key.startsWith(prefix)) continue;
          if (keepByAgent.has(key)) continue;
          const id = key.slice(prefix.length);
          if (!probedIds.has(id)) {
            delete c.agents.defaults.models[key];
            removed++;
          }
        }
        if (removed) log(`Probe ${provider}: pruned ${removed} orphan(s) from agents.defaults.models`);
      }

      write(c); log(`Probe ${provider}: ${models.length} models via ${probeUrl}`);
      return {ok:true,count:models.length,models};
    } catch(e) { continue; }
  }
  return {ok:false,error:`All probe URLs failed for ${provider}`};
}

// ---- Orphan pruning (global, no API call needed) ----
// Removes keys from agents.defaults.models that are:
//   - NOT in use by any agent's model.primary
//   - AND NOT present in any models.providers[*].models[*].id
// In-use keys (e.g. minimax/MiniMax-M3) are kept even if no provider has them
// (handles remote-only models registered outside the switcher).
function doPruneOrphans({dryRun=false}={}) {
  const c = read();
  if (!c.agents?.defaults?.models) return { ok: true, removed: 0, removedKeys: [] };

  // Ground truth: any model id listed under any provider
  const known = new Set();
  if (c.models?.providers) {
    for (const [pid, p] of Object.entries(c.models.providers)) {
      for (const m of (p.models || [])) {
        if (m?.id) known.add(`${pid}/${m.id}`);
      }
    }
  }
  // In-use set: any agent's model.primary
  const inUse = new Set();
  if (c.agents?.list) for (const a of c.agents.list) {
    if (a?.model?.primary) inUse.add(a.model.primary);
  }

  const removedKeys = [];
  for (const key of Object.keys(c.agents.defaults.models)) {
    if (inUse.has(key)) continue;
    if (known.has(key)) continue;
    removedKeys.push(key);
  }
  if (!dryRun && removedKeys.length) {
    for (const k of removedKeys) delete c.agents.defaults.models[k];
    write(c);
    log(`Prune orphans: removed ${removedKeys.length} (${removedKeys.join(', ')})`);
  }
  return { ok: true, removed: removedKeys.length, removedKeys, dryRun, knownCount: known.size, inUseCount: inUse.size };
}

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
    if(method==='GET'&&p==='/api/status') return json(res,getStatus());
    if(method==='GET'&&p==='/api/feishu/diagnostics') {
      try{
        const sp=spawnSync('node',[CLI,'channels','status'],{encoding:'utf8',timeout:10000});
        const lines=sp.stdout.split('\n').filter(l=>l.includes('Feishu'));
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
        return json(res,{diagnostics:diag,raw:sp.stdout});
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
          appSecret:v.appSecret?(v.appSecret.slice(0,4)+'●●●'+v.appSecret.slice(-4)):'',
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
    if(method==='GET'&&p==='/api/models') return json(res,getModels(q.q||''));
    if(method==='GET'&&p==='/api/providers') return json(res,getProviders());
    if(method==='GET'&&p==='/api/providers/catalog') return json(res,getCatalogWithModels());
    if(method==='GET'&&p==='/api/backups') return json(res,getBackups());
    if(method==='GET'&&p==='/api/scenes') return json(res,getScenes());
    if(method==='GET'&&p==='/api/log') return json(res,{lines:getLog()});
      if(method==='GET'&&p==='/api/paths') return json(res,{backupDir:BACKUP_DIR,log:LOG,scenes:SCENES,openclawHome:OPENCLAW_HOME,userData:USER_DATA_DIR});
    const fm=p.match(/^\/api\/agent\/([^/]+)\/files$/);
    if(method==='GET'&&fm) {
      const ws=path.join(WS_ROOT,fm[1]); if(!fs.existsSync(ws)) return json(res,[]);
      const files=[];
      (function walk(dir,rel){
        try{fs.readdirSync(dir).forEach(f=>{
          const fp=path.join(dir,f);const s=fs.statSync(fp);
          if(s.isDirectory())walk(fp,path.join(rel,f));
          else files.push({name:f,path:(rel?rel+'/':'')+f,size:s.size,modified:s.mtime.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})});
        });}catch(e){}
      })(ws,'');
      return json(res,files);
    }
    const frm=p.match(/^\/api\/agent\/([^/]+)\/file$/);
    if(method==='GET'&&frm) {
      const fp=path.join(WS_ROOT,frm[1],q.path||'');
      if(!fs.existsSync(fp)) return json(res,{error:'Not found'},404);
      const stat=fs.statSync(fp);
      return json(res,{content:fs.readFileSync(fp,'utf8'),size:stat.size,modified:stat.mtime.toISOString()});
    }
    // GET prune is always dryRun (safe for browser)
    if(method==='GET'&&p==='/api/agents/defaults/models/prune') return json(res,doPruneOrphans({dryRun:true}));

    // POST
    if(method==='POST') {
      let b;
      try { b=await body(req); } catch(e) { b = {}; }

      if(p==='/api/switch') {
        const n=doSwitch(b.changes||{});
        return json(res,{status:'ok',changed:n});
      }
      if(p==='/api/probe') return json(res,await doProbe(b.provider,b.apiKey,b.baseUrl||''));
      // POST prune: opt-in to dryRun via body.dryRun or ?dryRun=true. Empty body = real prune.
      if(p==='/api/agents/defaults/models/prune') {
        const dry = !!(b?.dryRun || q.dryRun==='true' || q.dryRun==='1');
        return json(res,doPruneOrphans({dryRun: dry}));
      }
      if(p==='/api/rollback') {
        if(!b.path||!fs.existsSync(b.path)) return json(res,{error:'Backup file not found'},400);
        const tmp=CONFIG+'.new';
        fs.copyFileSync(b.path,tmp); fs.renameSync(tmp,CONFIG);
        log(`Rollback: ${path.basename(b.path)}`); return json(res,{status:'ok'});
      }
      if(p==='/api/agent/create') {
        const id=b.id;
        if(!id||!/^[a-zA-Z][a-zA-Z0-9_-]{1,30}$/.test(id)) return json(res,{ok:false,error:'Agent ID 必须英文字母开头，2-30 字符 (字母/数字/下划线/连字符)'},400);
        const ws=path.join(WS_ROOT,id);
        if(fs.existsSync(ws)) return json(res,{ok:false,error:`Workspace ${ws} 已存在`},400);
        fs.mkdirSync(ws,{recursive:true});
        const tmpl=path.join(WS_ROOT,b.workspaceTemplate||'comfyui');
        if(fs.existsSync(tmpl)) {
          ['AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md','USER.md','MEMORY.md','HEARTBEAT.md','BOOTSTRAP.md'].forEach(f=>{
            const src=path.join(tmpl,f); if(fs.existsSync(src)) fs.copyFileSync(src,path.join(ws,f));
          });
        }
        const ad=path.join(AGENT_ROOT,id,'agent'); fs.mkdirSync(ad,{recursive:true});
        const c=read();
        if(!c.agents) c.agents={defaults:{models:{}},list:[]};
        if(!c.agents.list) c.agents.list=[];
        if(!c.agents.defaults) c.agents.defaults={models:{}};
        if(!c.agents.defaults.models) c.agents.defaults.models={};
        c.agents.list.push({id,name:id,workspace:ws,agentDir:ad});
        if(b.appId&&b.appSecret) {
          if(!c.channels) c.channels={feishu:{enabled:true,accounts:{}}};
          if(!c.channels.feishu) c.channels.feishu={enabled:true,accounts:{}};
          if(!c.channels.feishu.accounts) c.channels.feishu.accounts={};
          c.channels.feishu.accounts[`${id}_bot`]={appId:b.appId,appSecret:b.appSecret,enabled:true};
          if(!c.bindings) c.bindings=[];
          c.bindings.push({type:'route',agentId:id,match:{channel:'feishu',accountId:`${id}_bot`}});
        }
        write(c); log(`Create: ${id} (tpl=${b.workspaceTemplate||'comfyui'}, feishu=${!!(b.appId&&b.appSecret)})`);
        return json(res,{ok:true});
      }
      if(p==='/api/agent/delete') {
        const id=b.id;
        if(!id) return json(res,{ok:false,error:'Missing id'},400);
        [path.join(WS_ROOT,id),path.join(AGENT_ROOT,id)].forEach(p=>{try{fs.rmSync(p,{recursive:true,force:true})}catch(e){}});
        const c=read();
        if(c.agents?.list) c.agents.list=c.agents.list.filter(x=>x.id!==id);
        if(c.channels?.feishu?.accounts) delete c.channels.feishu.accounts[`${id}_bot`];
        if(c.bindings) c.bindings=c.bindings.filter(x=>x.agentId!==id);
        write(c); log(`Delete: ${id}`);
        return json(res,{ok:true});
      }
      const fwm=p.match(/^\/api\/agent\/([^/]+)\/file\/write$/);
      if(fwm) {
        const fp=path.join(WS_ROOT,fwm[1],b.path);
        const dir=path.dirname(fp); if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(fp,b.content,'utf8'); log(`Write: ${fwm[1]}/${b.path}`);
        return json(res,{status:'ok'});
      }
      if(p==='/api/scenes/save') {
        const scenes=getScenes();
        // 如果同名场景存在则覆盖
        const idx=scenes.findIndex(x=>x.name===b.name);
        const entry={name:b.name,timestamp:ts(),config:b.config};
        if(idx>=0) scenes[idx]=entry; else scenes.push(entry);
        fs.writeFileSync(SCENES,JSON.stringify(scenes,null,2),'utf8'); log(`Scene save: ${b.name}`);
        return json(res,{status:'ok'});
      }
      if(p==='/api/scenes/apply') {
        const scenes=getScenes(); const s=scenes.find(x=>x.name===b.name);
        if(!s) return json(res,{error:'Scene not found'},404);
        doSwitch(s.config); return json(res,{status:'ok'});
      }
      if(p==='/api/scenes/delete') {
        const scenes=getScenes().filter(x=>x.name!==b.name);
        fs.writeFileSync(SCENES,JSON.stringify(scenes,null,2),'utf8'); log(`Scene delete: ${b.name}`);
        return json(res,{status:'ok'});
      }

      // ---- 飞书 Bot 管理 ----
      if(p==='/api/feishu/bot/save') {
        const {botKey,appId,appSecret,name,enabled}=b;
        if(!botKey||!appId) return json(res,{ok:false,error:'需要 botKey 和 appId'},400);
        // 自动规范化 botKey：去空格、补 _bot 后缀、全小写
        let normalized=String(botKey).trim().replace(/\s+/g,'_').toLowerCase();
        if(!/_bot$/.test(normalized)) normalized+='_bot';
        const c=read();
        if(!c.channels) c.channels={};
        if(!c.channels.feishu) c.channels.feishu={enabled:true,accounts:{},allowFrom:[]};
        if(!c.channels.feishu.accounts) c.channels.feishu.accounts={};
        const existing=c.channels.feishu.accounts[normalized]||c.channels.feishu.accounts[botKey]||{};
        c.channels.feishu.accounts[normalized]={
          appId,
          appSecret:appSecret||existing.appSecret||'',
          name:name||normalized.replace(/_bot$/,''),
          enabled:enabled!==false
        };
        if(botKey!==normalized&&c.channels.feishu.accounts[botKey]) delete c.channels.feishu.accounts[botKey];
        write(c); log(`Feishu bot save: ${normalized}${botKey!==normalized?' (auto-normalized from '+botKey+')':''}`);
        return json(res,{ok:true,botKey:normalized,normalized:botKey!==normalized});
      }
      if(p==='/api/feishu/bot/delete') {
        const {botKey}=b;
        if(!botKey) return json(res,{ok:false,error:'需要 botKey'},400);
        const c=read();
        if(c.channels?.feishu?.accounts) delete c.channels.feishu.accounts[botKey];
        // 同步删除相关 binding
        if(c.bindings) c.bindings=c.bindings.filter(x=>!(x.match?.channel==='feishu'&&x.match?.accountId===botKey));
        write(c); log(`Feishu bot delete: ${botKey}`);
        return json(res,{ok:true});
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
        try {
          const reg=await import(pathToFileURL(FEISHU_REG_PATH).href);
          await reg.initAppRegistration('feishu');
          // 直接 post registration 拿原始响应（绕开 openclaw 的 launcher 包装）
          const base='https://accounts.feishu.cn';
          const sp=spawnSync('curl',['-s','-X','POST',`${base}/oauth/v1/app/registration`,'-H','Content-Type: application/x-www-form-urlencoded','--data-urlencode','action=begin','--data-urlencode','archetype=PersonalAgent','--data-urlencode','auth_method=client_secret','--data-urlencode','request_user_info=open_id'],{encoding:'utf8',timeout:15000});
          const raw=JSON.parse(sp.stdout);
          if(!raw.device_code) throw new Error('Feishu 未返回 device_code: '+sp.stdout.slice(0,200));
          const verificationUri='https://accounts.feishu.cn/oauth/v1/app/registration';
          // 固定 QR 指向飞书 launcher 页（由用户手动输 user_code）
          const domain=b.domain||'feishu';
          const baseUrl=domain==='lark'?'https://open.larksuite.com':'https://open.feishu.cn';
          const qrUrl=`${baseUrl}/page/launcher?from=oc_onboard&tp=ob_cli_app`;
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
        const accountId=botKey||`${appId.slice(8)}_bot`;
        c.channels.feishu.accounts[accountId]={appId,appSecret,name:accountId.replace(/_bot$/,''),enabled:true};
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

    // HTML root (only for /)
    if(p === '/' && fs.existsSync(HTML)) {
      const content=fs.readFileSync(HTML,'utf8');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Access-Control-Allow-Origin':'*'});
      res.end(content);
      return;
    }
        if(method==='GET' && p==='/api/open-path'){
      const reqPath = String(q.path || '');
      if (!reqPath) return json(res, { error: 'missing path query param' }, 400);
      const norm = reqPath.replace(/\\/g, '/');
      const allowed = [
        BACKUP_DIR,
        path.dirname(BACKUP_DIR),
        path.dirname(LOG),
        path.dirname(SCENES),
        OPENCLAW_HOME
      ].filter(Boolean).map(x => x.replace(/\\/g, '/'));
      const ok = allowed.some(a => {
        return norm === a || norm.startsWith(a + (a.endsWith('/') ? '' : '/'));
      });
      if (!ok) return json(res, { error: 'path not whitelisted: ' + reqPath }, 403);
      const { spawn } = require('child_process');
      try {
        if (process.platform === 'win32') {
          spawn('explorer.exe', [reqPath], { detached: true, stdio: 'ignore' });
        } else {
          spawn('xdg-open', [reqPath], { detached: true, stdio: 'ignore' });
        }
        log('Open: ' + reqPath);
        return json(res, { status: 'ok', path: reqPath });
      } catch (e) {
        return json(res, { error: 'spawn failed: ' + e.message }, 500);
      }
    }
          // Static file serving
      if(method==='GET' && p.startsWith('/') && p !== '/api/status' && !p.startsWith('/api/')){
        // Try to serve as static file from SCRIPT_DIR
        const rel = p.replace(/^\/+|\.\./g, '');
        if(rel && !rel.includes('..')){
          const fp = path.join(SCRIPT_DIR, rel);
          if(fs.existsSync(fp) && fs.statSync(fp).isFile()){
            const ext = path.extname(fp).toLowerCase();
            const mime = ext === '.js' ? 'application/javascript; charset=utf-8'
                       : ext === '.css' ? 'text/css; charset=utf-8'
                       : ext === '.json' ? 'application/json; charset=utf-8'
                       : ext === '.png' ? 'image/png'
                       : ext === '.svg' ? 'image/svg+xml'
                       : 'application/octet-stream';
            const content = fs.readFileSync(fp);
            res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=3600' });
            res.end(content);
            return;
          }
        }
      }
    } catch(e) { log('ERR: '+e.message); json(res,{error:e.message},500); }
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
