const fs = require('fs');
const path = 'D:/tmp-check649/package/index.html';
const html = fs.readFileSync(path, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
try { new Function(m[1]); console.log('JS OK', m[1].length, 'chars'); }
catch (e) { console.log('ERR', e.message); }
const checks = {
  'DEBUG banner': html.includes('DEBUG OVERLAY'),
  'TEST MODAL text': html.includes('TEST MODAL'),
  '__dbg global': html.includes('__dbg'),
  'class-based modal': html.includes('modal modal-open'),
  'data-modal=create': html.includes('data-modal="create"'),
  'openCreate (clean)': /function openCreate\(\) \{[^}]*newAgent\.value[^}]*showCreate\.value/m.test(html),
};
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✔' : '✘'} ${k}`);
