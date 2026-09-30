import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Проверяем общую раскладку для локальной игры, сети и просмотра.
// Это не замена браузерной проверке CSS/касания.
const source = fs.readFileSync(new URL('../client/rendering.js', import.meta.url), 'utf8');
function fixture(n, mobile, width = 300, scale = 1) {
  const cards = Array.from({ length: n }, () => ({
    classList: { contains: c => c === 'card' },
    offsetWidth: 112 * scale,
    offsetHeight: 158 * scale,
    style: { setProperty(k, v) { this[k] = v; } },
  }));
  const container = { children: cards, clientWidth: width, style: {}, offsetHeight: 120 };
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: mobile }), addEventListener() {} },
  });
  vm.runInContext(source, context);
  return { cards, container, layout: () => context.layoutHandArc(container) };
}
test('mobile hand has constant height, readable overlap and no rotation', () => {
  for (const scale of [0.7, 1, 1.6]) {
    const small = fixture(6, true, 300, scale);
    const large = fixture(36, true, 300, scale);
    small.layout();
    large.layout();
    assert.equal(small.container.style.height, large.container.style.height);
    assert.ok(parseFloat(large.container.style.height) < large.cards[0].offsetHeight);
    large.cards.forEach((card, i) => {
      assert.equal(card.style['--tr'], '0deg');
      assert.equal(card.style['--ty'], '0px');
      if (i) {
        assert.ok(parseFloat(card.style['--tx']) -
          parseFloat(large.cards[i - 1].style['--tx']) >= 44);
      }
    });
    assert.ok(parseFloat(large.cards.at(-1).style['--tx']) > 300);
  }
});
test('a single mobile card is centered', () => {
  const f = fixture(1, true);
  f.layout();
  assert.equal(parseFloat(f.cards[0].style['--tx']), 94);
});
test('desktop retains its fan; empty hand clears explicit height', () => {
  const f = fixture(6, false, 900);
  f.layout();
  assert.ok(parseFloat(f.cards[0].style['--tr']) < 0);
  assert.ok(parseFloat(f.cards.at(-1).style['--tr']) > 0);
  f.container.children = [];
  f.layout();
  assert.equal(f.container.style.height, '');
});
