#!/usr/bin/env node
// Mechanical extraction only: preserve execution order and every original byte.
// Shared lexical scope is intentional for the standalone file:// bundle.
import fs from 'node:fs';
import assert from 'node:assert/strict';
let template = fs.readFileSync('client/template.html', 'utf8');
const original = template;
function extract(name, start, end) {
  const a = template.indexOf(start);
  const b = template.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing boundary for ${name}`);
  const body = template.slice(a, b);
  fs.writeFileSync(`client/${name}.js`, body);
  template = template.slice(0, a) + `/* @@CLIENT:${name}@@ */\n` + template.slice(b);
}
extract('replay-recording', '// Режиму просмотра нужна', '// botOptions');
extract('local-session', '// botOptions', 'function renderInteractive(){');
extract('render-interactive', 'function renderInteractive(){', '/* ============ Сетевой режим');
extract('online', '/* ============ Сетевой режим', 'function renderNetwork(){');
extract('render-network', 'function renderNetwork(){', '/* ============ Переключение режимов');
extract('navigation', '/* ============ Переключение режимов', '/* ============ Визуализация');
extract('rendering', '/* ============ Визуализация', 'let game=null, cursor=0, playTimer=null;');
extract('replay', 'let game=null, cursor=0, playTimer=null;', "document.getElementById('newGameBtn')");
extract('bootstrap', "document.getElementById('newGameBtn')", '</script>');
const expanded = template.replace(/\/\* @@CLIENT:([a-z-]+)@@ \*\/\n/g,
  (_, name) => fs.readFileSync(`client/${name}.js`, 'utf8'));
assert.equal(expanded, original, 'Client extraction changed executable source');
fs.writeFileSync('client/template.html', template);
console.log('Client split: re-expanded source is byte-for-byte identical.');
