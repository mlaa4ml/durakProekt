// Сборка клиента (scripts/build-client.mjs): visual/index.html и docs/index.html — производные
// файлы; движок и боты попадают в них только из src/. Тест ловит забытую пересборку и
// поломки склейки (лишние import/export, синтаксис) до CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { buildClient, ENTRIES, OUTPUTS, ROOT } from '../scripts/build-client.mjs';

const built = buildClient();
const readOut = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('клиенты актуальны: visual/index.html и docs/index.html == сборка из client/template.html и src/', () => {
  for (const rel of OUTPUTS) {
    assert.equal(readOut(rel), built.html, `${rel} устарел — выполните: npm run build-client`);
  }
});

test('в сборку вошли все модули движка и ботов, в порядке зависимостей', () => {
  const idx = (m) => built.modules.indexOf(m);
  for (const m of ['src/deck.js', 'src/rules.js', 'src/game.js', 'src/bots/simpleBot.js', 'src/bots/memory.js', 'src/bots/analysis.js', 'src/bots/smartBot.js', 'src/bots/index.js']) {
    assert.ok(idx(m) >= 0, `нет модуля ${m}`);
  }
  assert.ok(idx('src/deck.js') < idx('src/game.js'), 'deck.js должен идти раньше game.js');
  assert.ok(idx('src/bots/memory.js') < idx('src/bots/smartBot.js'), 'memory.js должен идти раньше smartBot.js');
  for (const e of ENTRIES) assert.ok(built.modules.includes(e));
});

test('скрипт клиента — валидный JS без import/export', () => {
  const m = built.html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'не найден <script type="module">');
  assert.doesNotMatch(m[1], /^(?:import|export)\b/m, 'в скрипте остались import/export');
  assert.doesNotThrow(() => new vm.Script(`(async () => {\n${m[1]}\n})`), 'скрипт клиента не парсится');
});
