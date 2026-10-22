// Fix upstream openclaw-model-switcher 6.5.2 syntax error:
// Line 2665 has an extra `}` that prematurely closes the setup() function,
// causing "Unexpected identifier 'watch'" because watch()/onMounted()/return
// are then at top level of a regular <script> (not in a setup() scope).
//
// Fix: remove the extra `}` on line 2665, keeping the proper setup close at end.
const fs = require('fs');
const path = require('path');

const f = 'D:/nodejs/node_global/node_modules/openclaw-model-switcher/index.html';
let content = fs.readFileSync(f, 'utf8');
const lines = content.split('\n');

// Line 2665 (1-indexed) is the extra `}`. 0-indexed: lines[2664].
// Verify it's exactly "    }" (4 spaces + close brace, end of line).
const targetLine = 2665;
const idx = targetLine - 1;
const before = lines[idx];
if (before !== '    }' && before !== '\t}') {
  console.error(`Line ${targetLine} is not the expected extra brace. Got: ${JSON.stringify(before)}`);
  console.error('Refusing to edit — please check the upstream code manually.');
  process.exit(1);
}

// Remove that line
lines.splice(idx, 1);
const after = lines.join('\n');

// Backup
const bak = f + '.pre-fix-extra-brace-' + new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(f, bak);
console.log('[bak]  ' + bak);

// Write
fs.writeFileSync(f, after, 'utf8');
console.log('[done] removed extra `}` at line 2665');
console.log('[size] ' + after.length + ' bytes (was ' + content.length + ')');

// Sanity check: search for the watch call now
const watchMatch = after.match(/watch\(\(\) => kf\.value\.provider/);
console.log('[check] watch() at module top level:', watchMatch ? 'STILL THERE (expected)' : 'GONE (watch ref is wrong)');

const setupClose = (after.match(/^\s*\}\)\.mount\('#switcher-app'\);/m) || [])[0];
console.log('[check] mount() call present:', setupClose ? 'YES' : 'NO');
