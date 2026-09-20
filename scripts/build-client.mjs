#!/usr/bin/env node
/**
 * Сборка локального клиента.
 *
 *   client/template.html  (разметка, CSS и код интерфейса)
 * + src/**                (движок и боты — единственный источник правды)
 * ────────────────────────────────────────────────────────────────────────────
 *   → visual/index.html   (его отдаёт сервер по /visual)
 *   → docs/index.html     (GitHub Pages) — оба файла ГЕНЕРИРУЮТСЯ, руками не правятся
 *
 * Зачем: раньше движок и боты были скопированы прямо в HTML (почти 1900 строк), копии
 * расходились с src/ (например, простой бот в браузере и в тестах вёл себя по-разному).
 * Теперь код движка и ботов попадает в клиент только отсюда.
 *
 * Использование:
 *   npm run build-client              собрать и записать оба файла
 *   npm run build-client -- --check   ничего не писать; выйти с кодом 1, если файлы устарели
 *
 * Без зависимостей: модули склеиваются в один скрипт (import/export вырезаются), поэтому
 * страница по-прежнему открывается двойным щелчком, без сервера. Сборщик проверяет то, что
 * при склейке ломается тихо: одинаковые имена в разных модулях, импорт несуществующего
 * имени, циклы, Node-специфику, забытые import/export.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = 'client/template.html';
export const MARKER = '/* @@BUNDLE@@ */';
/** Что клиенту нужно из src/. Остальное подтягивается по импортам. */
export const ENTRIES = ['src/game.js', 'src/bots/index.js'];
export const OUTPUTS = ['visual/index.html', 'docs/index.html'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const posix = (p) => p.split(path.sep).join('/');

// ---------- разбор модулей ----------
const IMPORT_RE = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
const SIDE_EFFECT_IMPORT_RE = /^import\s+['"][^'"]+['"];?[ \t]*$/m;
const DECL_RE = /^(?:async\s+)?(?:function\*?\s+|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/gm;

function parseImports(rel, text) {
  if (SIDE_EFFECT_IMPORT_RE.test(text)) throw new Error(`${rel}: импорт «ради побочного эффекта» не поддерживается`);
  const imports = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const clause = m[1].trim();
    const spec = m[2];
    if (!spec.startsWith('.')) {
      throw new Error(`${rel}: импорт «${spec}» — не относительный. В клиент можно тянуть только модули src/ (никакого Node/npm).`);
    }
    if (!clause.startsWith('{')) throw new Error(`${rel}: поддерживаются только именованные импорты (import { … } from), а тут «${clause}»`);
    if (/\bas\b/.test(clause)) throw new Error(`${rel}: переименование при импорте («as») не поддерживается — имена в клиенте общие`);
    const names = clause.replace(/^\{|\}$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    imports.push({ from: posix(path.normalize(path.join(path.dirname(rel), spec))), names });
  }
  return imports;
}

function parseExports(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\};?[ \t]*$/gm)) {
    for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (/\bas\b/.test(n)) throw new Error(`«export { ${n} }»: переименование при экспорте не поддерживается`);
      names.add(n);
    }
  }
  return names;
}

/** Превращает ES-модуль в фрагмент общего скрипта: убирает import/export, остальное не трогает. */
function stripModule(rel, text) {
  let s = text;
  s = s.replace(IMPORT_RE, '');
  s = s.replace(/^export\s+default\s+\{[\s\S]*?^\};?[ \t]*$/gm, ''); // export default { … };
  s = s.replace(/^export\s+default\s+[A-Za-z_$][\w$]*;?[ \t]*$/gm, ''); // export default Имя;
  s = s.replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, ''); // export { … };
  s = s.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '');
  const left = s.match(/^(?:import|export)\b.*$/m);
  if (left) throw new Error(`${rel}: после вырезания остался «${left[0].slice(0, 60)}» — сборщик такую форму не понимает`);
  const nodeApi = s.match(/\b(?:process\.|require\(|__dirname|__filename|import\.meta)|node:[a-z]+|\bBuffer\b/);
  if (nodeApi) throw new Error(`${rel}: Node-специфика «${nodeApi[0]}» — в браузере не заработает`);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function topLevelNames(text) {
  return [...text.matchAll(DECL_RE)].map((m) => m[1]);
}

// ---------- порядок модулей ----------
function orderModules() {
  const modules = new Map(); // rel -> { text, imports, exports }
  const order = [];
  const state = new Map(); // rel -> 'visiting' | 'done'
  const visit = (rel, chain) => {
    if (state.get(rel) === 'done') return;
    if (state.get(rel) === 'visiting') throw new Error(`Циклический импорт: ${[...chain, rel].join(' → ')}`);
    state.set(rel, 'visiting');
    let text;
    try { text = read(rel); } catch { throw new Error(`Нет модуля ${rel} (импортирован из ${chain[chain.length - 1] || 'ENTRIES'})`); }
    const imports = parseImports(rel, text);
    modules.set(rel, { text, imports, exports: parseExports(text) });
    for (const imp of imports) visit(imp.from, [...chain, rel]);
    state.set(rel, 'done');
    order.push(rel);
  };
  for (const entry of ENTRIES) visit(entry, []);
  return { modules, order };
}

// ---------- сборка ----------
export function buildClient() {
  const template = read(TEMPLATE);
  if (template.split(MARKER).length !== 2) throw new Error(`В ${TEMPLATE} должно быть ровно одно вхождение «${MARKER}»`);

  const { modules, order } = orderModules();

  // импортируемые имена действительно экспортируются
  for (const rel of order) {
    for (const imp of modules.get(rel).imports) {
      const target = modules.get(imp.from);
      for (const name of imp.names) {
        if (!target.exports.has(name)) throw new Error(`${rel}: импортирует «${name}» из ${imp.from}, а он такого не экспортирует`);
      }
    }
  }

  const parts = [];
  const owner = new Map(); // имя -> где объявлено
  const claim = (name, where) => {
    if (owner.has(name)) throw new Error(`Имя «${name}» объявлено дважды: ${owner.get(name)} и ${where}. В общем скрипте функции затирают друг друга молча — переименуйте одно из них.`);
    owner.set(name, where);
  };
  for (const rel of order) {
    const body = stripModule(rel, modules.get(rel).text);
    for (const name of topLevelNames(body)) claim(name, rel);
    parts.push(`/* ---------- ${rel} ---------- */\n${body}`);
  }
  for (const name of topLevelNames(template)) claim(name, TEMPLATE);

  const bundle = [
    '/* ============ Движок и боты — СГЕНЕРИРОВАНО scripts/build-client.mjs из src/. Не править: правки пропадут при следующей сборке ============ */',
    '',
    parts.join('\n\n'),
    '',
  ].join('\n');

  let html = template.replace(MARKER, () => bundle);
  const banner = '<!-- СГЕНЕРИРОВАННЫЙ ФАЙЛ. Источники: client/template.html и src/**. Собирается командой `npm run build-client`, руками не править. -->\n';
  html = /^<!doctype html>\n/i.test(html) ? html.replace(/^(<!doctype html>\n)/i, (m) => m + banner) : banner + html;
  return { html, modules: order, names: [...owner.keys()] };
}

// ---------- CLI ----------
function main() {
  const check = process.argv.includes('--check');
  const { html, modules } = buildClient();
  const bytes = Buffer.byteLength(html);
  let stale = 0;
  for (const rel of OUTPUTS) {
    const file = path.join(ROOT, rel);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (check) {
      if (current === html) console.log(`OK: ${rel} актуален (${bytes} байт).`);
      else { stale++; console.error(`::error::${rel} не соответствует сборке из client/template.html и src/ — выполните: npm run build-client`); }
    } else if (current === html) {
      console.log(`Без изменений: ${rel}`);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html);
      console.log(`Собрано: ${rel} (${bytes} байт)`);
    }
  }
  if (!check) console.log(`Модули в порядке склейки: ${modules.join(', ')}`);
  if (stale) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`::error::${e.message}`); process.exit(1); }
}
