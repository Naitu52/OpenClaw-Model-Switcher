const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tgzs = ['openclaw-model-switcher-6.4.8.tgz', 'openclaw-model-switcher-6.4.9.tgz'];
const lines = [];
for (const t of tgzs) {
  const full = path.join(__dirname, '..', t);
  const buf = fs.readFileSync(full);
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  lines.push(`${h}  ${t}`);
}
const out = lines.join('\n') + '\n';
fs.writeFileSync(path.join(__dirname, '..', 'SHA256SUMS'), out);
console.log('Wrote SHA256SUMS,', out.length, 'bytes');
console.log(out);
