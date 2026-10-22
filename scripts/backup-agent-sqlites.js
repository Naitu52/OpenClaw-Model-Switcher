// 备份所有 agent 的 openclaw-agent.sqlite 到 workspace 内的 backups/
// (workspace 外写会被 safety policy 挡,所以走 node fs.copyFileSync)
const fs = require('fs');
const path = require('path');

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const SRC_ROOT = process.env.OPENCLAW_AGENTS_DIR || path.join(OPENCLAW_HOME, '.openclaw', 'agents');
const DST_ROOT = path.join(__dirname, '..', 'backups', `agent-sqlite-pre-fix-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}`);
fs.mkdirSync(DST_ROOT, { recursive: true });

const agents = fs.readdirSync(SRC_ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name);

let totalBytes = 0;
for (const name of agents) {
  const src = path.join(SRC_ROOT, name, 'agent', 'openclaw-agent.sqlite');
  if (!fs.existsSync(src)) continue;
  // sqlite 是 3 文件组(sqlite + shm + wal),全部拷
  for (const suffix of ['', '-shm', '-wal']) {
    const s = src + suffix;
    if (!fs.existsSync(s)) continue;
    const dst = path.join(DST_ROOT, name + '-openclaw-agent.sqlite' + suffix);
    fs.copyFileSync(s, dst);
    totalBytes += fs.statSync(dst).size;
  }
  console.log(`  ${name.padEnd(10)} backed up`);
}
console.log(`done: backup at ${DST_ROOT}  total=${(totalBytes/1024).toFixed(0)}KB`);