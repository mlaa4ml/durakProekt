import { cardToString } from '../deck.js';

// Вес цены отдаваемой карты в оценке атаки: 1 п.п. давления стоит примерно 1 % шкалы cardPower.
// Значение не «на глаз»: cost нормирован на козырного туза (MAX_CARD_POWER), поэтому 0.35 означает
// «отдать козырного туза вместо шестёрки оправдано, только если это даёт >35 п.п. давления».
export const PRESSURE_COST_WEIGHT = 0.35;

// Порога «шанс отбиться ниже X — беру» здесь СОЗНАТЕЛЬНО нет (раздел 1.5 roadmap: такое правило
// дало чистый шум). Решение принимается только сравнением двух ожидаемых цен в шкале cardPower.

export const HIGH_RANK = 12;  // дама и старше
export const BIG_TRUMP = 13;  // козырные король и туз

export const list = (cards) => cards.map(cardToString).join(', ');

export function myHandOf(state, playerId) {
  const me = (state.players || []).find((p) => p.id === playerId);
  return me && Array.isArray(me.hand) ? me.hand : [];
}

export function handCountOf(state, id) {
  const p = (state.players || []).find((x) => x.id === id);
  return p ? p.handCount || 0 : 0;
}

/**
 * Сколько игроков ещё в партии. Вероятностные правила этапа 4 (issue #49) включаются
 * только в дуэли: оценка `pOpponentBeats` считает ОДНОГО соперника, а за столом на 3–4
 * человека карту может побить любой другой игрок, и оценка систематически завышает
 * давление. На фаззинге (`test/botLegality.test.js`, 36×4 и 52×3) это выливалось в
 * бесконечно тянущиеся партии: боты перестают закрывать раунды и упираются в лимит шагов.
 */
export function alivePlayersCount(state) {
  return (state.players || []).filter((p) => !p.out).length;
}

