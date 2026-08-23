// Regenerate SHA256SUMS for every openclaw-model-switcher-*.tgz in the repo root.
// Usage: node scripts/write-shasums.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const tgzs = fs.readdirSync(root)
  .filter(f => /^openclaw-model-switcher-.*\.tgz$/.test(f))
  .sort();

if (!tgzs.length) {
  console.error('No .tgz found — run `npm pack` first.');
  process.exit(1);
}

const lines = [];
for (const t of tgzs) {
  const buf = fs.readFileSync(path.join(root, t));
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  lines.push(`${h}  ${t}`);
}
const out = lines.join('\n') + '\n';
fs.writeFileSync(path.join(root, 'SHA256SUMS'), out);
console.log('Wrote SHA256SUMS,', out.length, 'bytes');
console.log(out);
