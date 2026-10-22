// 检查所有 agent sqlite 的 schema_version
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const root = process.env.OPENCLAW_AGENTS_DIR || path.join(OPENCLAW_HOME, '.openclaw', 'agents');
const agents = fs.readdirSync(root, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

for (const name of agents) {
  const dbPath = path.join(root, name, 'agent', 'openclaw-agent.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.log(`  ${name.padEnd(12)} (no sqlite)`);
    continue;
  }
  const size = fs.statSync(dbPath).size;
  let ver = '?';
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    ver = row ? row.value : '(no schema_meta)';
    db.close();
  } catch (e) {
    ver = 'ERR: ' + e.message.split('\n')[0];
  }
  console.log(`  ${name.padEnd(12)} schema=${String(ver).padEnd(6)} ${(size/1024).toFixed(0)}KB`);
}