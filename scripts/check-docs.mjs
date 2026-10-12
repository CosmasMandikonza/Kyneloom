#!/usr/bin/env node
/**
 * Kyneloom's zero-dependency documentation integrity check.
 * Validates local Markdown links, referenced local image assets,
 * and fenced-code balance. No network requests are made.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build']);
const errors = [];
let checked = 0;

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(next));
    else if (entry.isFile() && next.endsWith('.md')) files.push(next);
  }
  return files;
}
function checkLink(source, href) {
  if (/^(https?:|mailto:|tel:|data:|#)/i.test(href)) return;
  const pathname = href.split('#')[0].split('?')[0];
  if (!pathname) return;
  let target;
  try { target = path.resolve(path.dirname(source), decodeURIComponent(pathname)); }
  catch { errors.push(source + ': invalid URI ' + href); return; }
  if (!target.startsWith(root + path.sep) && target !== root) {
    errors.push(source + ': link escapes repository: ' + href);
  } else if (!fs.existsSync(target)) {
    errors.push(path.relative(root, source) + ': missing ' + href);
  }
}
for (const file of walk(root)) {
  checked += 1;
  const md = fs.readFileSync(file, 'utf8');
  const fences = (md.match(/^ *`{3,}/gm) ?? []).length;
  if (fences % 2 !== 0) errors.push(path.relative(root, file) + ': unbalanced fenced code block');
  for (const match of md.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) checkLink(file, match[1]);
  for (const match of md.matchAll(/<(?:img|source)\b[^>]*?\b(?:src|srcset)="([^"]+)"/g)) checkLink(file, match[1]);
}
if (errors.length) {
  console.error('Documentation check failed:\n' + errors.map(e => '  - ' + e).join('\n'));
  process.exitCode = 1;
} else console.log('Documentation integrity OK: ' + checked + ' Markdown files checked.');
