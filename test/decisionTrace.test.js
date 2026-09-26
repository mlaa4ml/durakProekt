import test from 'node:test';
import assert from 'node:assert/strict';
import { DurakGame } from '../src/game.js';
import { SmartBot } from '../src/bots/smartBot.js';
import { applyObservedAction } from '../src/bots/index.js';
import { simpleBotDecide } from '../src/bots/simpleBot.js';
import { canSolve } from '../src/bots/endgame.js';
import { playOneGame } from '../src/cli/matchCore.js';
import { replayArtifact } from '../src/diagnostics/replay.js';

function rng(seed = 17) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

// Real masked states and complete public observation history, no injected hands.
function walk(visit, seed = 17) {
  const game = new DurakGame([{ id: 'a' }, { id: 'b' }], {
    numPlayers: 2, deckSize: 24, allowPerevod: false,
  }, rng(seed));
  const bots = new Map(game.players.map(({ id }) => {
    const bot = new SmartBot({ explain: true, trace: true, solver: { maxNodes: 2000, maxMs: 1000 } });
    bot.reset(game.getState(id), id);
    return [id, bot];
  }));
  for (let n = 0; n < 1000 && game.phase !== 'finished'; n++) {
    const id = game.currentActorId();
    const state = game.getState(id), legal = game.getLegalActions(id);
    assert.equal(state.players.find((p) => p.id !== id).hand, undefined);
    if (visit(bots.get(id), state, id, legal)) return;
    applyObservedAction(game, bots, id, simpleBotDecide(state, id, legal));
  }
}

test('trace: every solver rejection, success, emergency; explanations do not change policy', () => {
  let checked = false;
  walk((bot, state, id, legal) => {
    if (!canSolve(state, bot.tracker, id)) return;
    checked = true;
    const original = bot._solveExact;
    const base = { solved: true, timedOut: false, value: 1, nodes: 7, ms: 2, action: legal[0], legal };
    const cases = [
      ['budget', { ...base, solved: false, timedOut: true }],
      ['legal-mismatch', { ...base, mismatch: true }],
      ['legal-mismatch', { ...base, legal: [] }],
      ['legal-mismatch', { ...base, action: { type: 'invalid' } }],
      ['unusable', null],
      ['unusable', { ...base, solved: false }],
      ['unusable', { ...base, action: null }],
      ['proven-loss', { ...base, value: -1 }],
      ['used', base],
      ['used', { ...base, value: 0 }],
    ];
    for (const [status, response] of cases) {
      bot._solveExact = () => response;
      const decision = bot.decide(state, id, legal);
      const trace = decision.decisionTrace;
      assert.equal(trace.solver.status, status);
      assert.equal(trace.handKnowledge, 'exact');
      assert.equal(trace.solver.applicable, true);
      assert.ok(trace.selectedRule);
      assert.ok(legal.includes(decision.action));
      assert.equal(trace.profile.version, 1);
      assert.equal(trace.actionId, null);
      if (status !== 'used') {
        assert.notEqual(trace.selectedRule, 'exact-solver');
        assert.match(decision.reason, /Эвристика:/);
        assert.doesNotMatch(decision.reason, /при любой его игре выигрываю|партия просчитана до конца/);
      }
      if (response) {
        assert.equal(trace.solver.nodes, 7);
        assert.equal(trace.solver.ms, 2);
      }
      for (const explain of [false, true]) for (const enabled of [false, true]) {
        bot.explain = explain; bot.trace = enabled;
        const other = bot.decide(state, id, legal);
        assert.deepEqual(other.action, decision.action);
        assert.equal(Object.hasOwn(other, 'reason'), explain);
        assert.equal(Object.hasOwn(other, 'decisionTrace'), enabled);
      }
      bot.explain = true; bot.trace = true;
      assert.doesNotMatch(JSON.stringify(trace), /"hand":|"cards":|"snapshot":|"suit":/);
    }
    bot._solveExact = original;
    bot.profile.exactEndgameSolver = false;
    assert.equal(bot.decide(state, id, legal).decisionTrace.solver.status, 'disabled');
    bot.profile.exactEndgameSolver = true;
    bot._choose = () => { throw new Error('private exception details'); };
    const emergency = bot.decide(state, id, legal);
    assert.equal(emergency.action, legal[0]);
    assert.equal(emergency.decisionTrace.emergencyFallback, true);
    assert.equal(emergency.decisionTrace.selectedRule, 'emergency-first-legal');
    assert.doesNotMatch(emergency.reason, /private exception/);
    return true;
  });
  assert.ok(checked);
});

test('real search and real public memory in attack and defense, including exhausted budget', () => {
  const solvedPhases = new Set(), budgetPhases = new Set();
  let used = false, unknown = false;
  for (const seed of [1, 7, 17, 42]) {
    walk((bot, state, id, legal) => {
      if (!canSolve(state, bot.tracker, id)) {
        const decision = bot.decide(state, id, legal);
        if (decision.decisionTrace.handKnowledge === 'unknown') {
          assert.equal(decision.decisionTrace.solver.status, 'unknown-hand');
          unknown = true;
        }
        return;
      }
      const saved = bot.solverOptions;
      bot.solverOptions = { ...saved, maxNodes: 0 };
      const limited = bot.decide(state, id, legal);
      assert.equal(limited.decisionTrace.solver.status, 'budget');
      assert.doesNotMatch(limited.reason, /при любой его игре выигрываю|партия просчитана до конца/);
      budgetPhases.add(state.phase);
      bot.solverOptions = saved;
      if (state.players.reduce((sum, p) => sum + p.handCount, 0) > 6) return;
      const full = bot.decide(state, id, legal);
      assert.ok(legal.includes(full.action));
      if (full.decisionTrace.solver.solved) solvedPhases.add(state.phase);
      if (full.decisionTrace.solver.status === 'used') {
        used = true;
        assert.equal(full.decisionTrace.selectedRule, 'exact-solver');
        assert.match(full.reason, /партия просчитана до конца/);
      }
    }, seed);
  }
  assert.ok(unknown);
  assert.ok(used);
  for (const phase of ['need-attack', 'defender-to-act']) {
    assert.ok(solvedPhases.has(phase), `full search: ${phase}`);
    assert.ok(budgetPhases.has(phase), `budget: ${phase}`);
  }
});

test('CLI trace links to replay IDs and replay remains valid without exposing hands in trace', () => {
  const result = playOneGame(['smart', 'simple'], 24, 2, true, {
    rng: rng(), recordDiagnostic: true,
    seatOptions: [{ solver: { maxNodes: 20, maxMs: 5 } }],
  });
  assert.equal(replayArtifact(result.diagnostic).actionCount, result.diagnostic.actions.length);
  let count = 0;
  for (const entry of result.diagnostic.actions) {
    if (entry.decision.actor.level !== 'smart') continue;
    count++;
    const trace = entry.decision.decisionTrace;
    assert.equal(trace.actionId, entry.id);
    assert.deepEqual(result.trace[entry.id - 1].decisionTrace, trace);
    assert.doesNotMatch(JSON.stringify(trace), /"hand":|"cards":|"snapshot":|"suit":/);
  }
  assert.ok(count);
});
