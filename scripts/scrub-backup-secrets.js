#!/usr/bin/env node
/**
 * scrub-backup-secrets.js
 *
 * 扫描 / 脱敏 openclaw 配置的备份与快照文件里残留的明文密钥。
 *
 * 背景：openclaw 的 apiKey 支持三种来源 —— 明文字符串、env 引用、secret store 引用。
 *   运行期配置早已全部改成 store 引用，但历史备份/快照里仍是明文，备份一旦被拷贝
 *   或上传就等于泄露密钥。本脚本把备份里的明文替换成等价的 store 引用对象，
 *   保证「用备份回滚」这个用途不被破坏。
 *
 * 映射策略（按优先级）：
 *   1. 同路径：备份里的字段路径在 live config 里正好是 store 引用 -> 直接复用
 *   2. 推导 id：把路径大写化、非法字符转下划线（openclaw 的 store 命名约定）
 *   3. provider 兜底：models.providers.<id>.apiKey -> live config 里同 provider 的引用
 *   4. 都不中：写成 REDACTED_NO_STORE_REF（宁可丢回滚能力也不留明文）
 *
 * 用法：
 *   node scripts/scrub-backup-secrets.js --scan  [--live <运行期 openclaw.json>] <文件...>
 *   node scripts/scrub-backup-secrets.js --apply [--live <运行期 openclaw.json>] <文件...>
 *
 * --scan 只报告（默认），--apply 才真正改写。
 * 报告里只输出 长度 / sha256 前 12 位 / 首 6 字符，绝不回显密钥本身。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_HINT = /(^|[._-])(api[-_]?key|apikey|token|secret|password|passwd|pwd|credential)($|[._-])/i;

// 已经是引用对象的字段，不用管
function isRef(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    (v.source !== undefined || v.$secret !== undefined ||
     (v.id !== undefined && v.provider !== undefined));
}

// 只在「这个 key 看起来是凭据」且值是长字符串时才判定为明文密钥
function looksLikePlainSecret(v) {
  if (typeof v !== 'string') return false;
  if (v.length < 12) return false;
  if (v.startsWith('secret://')) return false;
  if (/^(sk-|gho_|ghp_|github_pat_|tp-|eyJ)/.test(v)) return true;
  if (/^[A-Za-z0-9_\-.]{20,}$/.test(v)) return true;
  return false;
}

function collect(node, pathStr, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collect(v, `${pathStr}[${i}]`, out));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    const p = pathStr ? `${pathStr}.${k}` : k;
    if (KEY_HINT.test(k) && looksLikePlainSecret(v)) {
      out.push({
        path: p,
        len: v.length,
        sha256: crypto.createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 12),
        head: v.slice(0, 6),
      });
    } else {
      collect(v, p, out);
    }
  }
}

// 遍历 live config，收集所有 store 引用：路径 -> 引用，以及 provider -> 引用
function buildStoreMap(liveConfigPath) {
  const byPath = new Map();
  const byProvider = new Map();
  const empty = { byPath, byProvider };
  if (!liveConfigPath || !fs.existsSync(liveConfigPath)) return empty;

  let live;
  try {
    live = JSON.parse(fs.readFileSync(liveConfigPath, 'utf8'));
  } catch {
    return empty;
  }

  const walk = (node, p) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${p}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      const np = p ? `${p}.${k}` : k;
      if (isRef(v)) {
        const id = v.id || v.$secret;
        if (id) {
          const ref = { id, provider: v.provider || 'team', source: v.source || 'store' };
          byPath.set(np, ref);
          const m = np.match(/providers\.([^.\[]+)/);
          if (m && !byProvider.has(m[1])) byProvider.set(m[1], ref);
        }
      }
      walk(v, np);
    }
  };
  walk(live, '');
  return { byPath, byProvider };
}

// openclaw 的 store 命名约定：路径大写 + 非字母数字转下划线
function deriveStoreId(pathStr) {
  return pathStr
    .split('.')
    .map((seg) => seg.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase())
    .join('_');
}

function resolveRef(pathStr, storeMap) {
  // 1) 同路径
  const direct = storeMap.byPath.get(pathStr);
  if (direct) return { ref: direct, how: '同路径' };
  // 2) 推导 id
  const derived = deriveStoreId(pathStr);
  for (const ref of storeMap.byPath.values()) {
    if (ref.id === derived) return { ref, how: '推导 id' };
  }
  // 3) provider 兜底
  const m = pathStr.match(/providers\.([^.\[]+)/);
  if (m) {
    const ref = storeMap.byProvider.get(m[1]);
    if (ref) return { ref, how: 'provider 兜底' };
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const scanOnly = argv.includes('--scan') || !apply;
  const liveIdx = argv.indexOf('--live');
  const livePath = liveIdx >= 0 ? argv[liveIdx + 1] : null;
  const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--live');

  if (!files.length) {
    console.error('用法: node scripts/scrub-backup-secrets.js [--scan|--apply] [--live <运行期 openclaw.json>] <文件...>');
    process.exit(2);
  }

  const storeMap = buildStoreMap(livePath);
  let totalFound = 0;
  let totalChanged = 0;
  let failed = 0;

  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.log(`--- ${f}: 不存在，跳过`);
      continue;
    }
    const raw = fs.readFileSync(f, 'utf8');
    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      console.log(`--- ${f}: JSON 解析失败 (${e.message})`);
      failed++;
      continue;
    }

    const hits = [];
    collect(json, '', hits);
    totalFound += hits.length;

    if (!hits.length) {
      console.log(`--- ${path.basename(f)}: 0 处明文密钥`);
      continue;
    }

    console.log(`--- ${path.basename(f)}: ${hits.length} 处明文密钥`);
    const plan = new Map(); // path -> {ref, how} | null
    for (const h of hits) {
      const r = resolveRef(h.path, storeMap);
      plan.set(h.path, r);
      console.log(
        `    ${h.path}  len=${h.len}  sha=${h.sha256}  head=${h.head}  ->  ` +
        (r ? `store:${r.ref.id} (${r.how})` : '无对应 store 引用 -> 将置为 REDACTED_NO_STORE_REF')
      );
    }

    if (!apply) continue;

    const rewrite = (node, pathStr) => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => rewrite(v, `${pathStr}[${i}]`));
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (const k of Object.keys(node)) {
        const v = node[k];
        const p = pathStr ? `${pathStr}.${k}` : k;
        if (KEY_HINT.test(k) && looksLikePlainSecret(v)) {
          const r = plan.get(p);
          node[k] = r
            ? { source: r.ref.source, provider: r.ref.provider, id: r.ref.id }
            : 'REDACTED_NO_STORE_REF';
          totalChanged++;
        } else {
          rewrite(v, p);
        }
      }
    };
    rewrite(json, '');

    let out;
    try {
      out = JSON.stringify(json, null, 2) + '\n';
      JSON.parse(out); // 写回前校验仍是合法 JSON
    } catch (e) {
      console.log(`    写回内容校验失败，未写入: ${e.message}`);
      failed++;
      continue;
    }
    fs.writeFileSync(f, out, 'utf8');
    console.log(`    已改写 ${hits.length} 处 -> ${f}`);
  }

  console.log('');
  console.log(scanOnly
    ? `扫描完成：共 ${totalFound} 处明文密钥（未改动，加 --apply 执行脱敏）`
    : `脱敏完成：处理 ${totalChanged} 处明文密钥，失败 ${failed} 个文件`);
  if (failed) process.exit(1);
}

main();
