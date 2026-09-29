import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runPairedConfig, pairedShare, pairSeed, mulberry32, seatBelongsToA } from '../scripts/evalBots.js';
import { playOneGame } from '../src/cli/matchCore.js';
import { createBotBrain } from '../src/bots/index.js';

const solver = { maxNodes: 50, maxMs: Number.MAX_SAFE_INTEGER };

function trackedFactory(side, resets) {
  return (level, options) => {
    assert.equal(level, 'smart');
    assert.deepEqual(options.solver, solver);
    const brain = createBotBrain(level, options);
    const reset = brain.reset.bind(brain);
    brain.reset = (state, id) => {
      // Version injection must not bypass the masked contract.
      for (const p of state.players) {
        assert.equal(Array.isArray(p.hand), p.id === id);
      }
      resets.push({ side, id, hand: structuredClone(state.players.find(p => p.id === id).hand) });
      reset(state, id);
    };
    return brain;
  };
}

test('paired seeds, identical initial deals and distinct smart factories for 2/3/4 seats', () => {
  for (const players of [2, 3, 4]) {
    const resets = [];
    const row = runPairedConfig({
      players, deckSize: 24, pairs: 2, seed: 720072,
      factoryA: trackedFactory('A', resets), factoryB: trackedFactory('B', resets),
      brainA: { solver }, brainB: { solver },
    });
    assert.equal(row.errors, 0, JSON.stringify(row.records));
    assert.equal(row.illegal, 0);
    assert.equal(row.unfinished, 0);
    assert.equal(row.completed, 4);
    assert.equal(row.records.length, 4);
    assert.equal(resets.length, players * 4);
    for (let pair = 0; pair < 2; pair++) {
      const [a, b] = row.records.slice(pair * 2, pair * 2 + 2);
      assert.equal(a.seed, pairSeed(720072, players, 24, 'all', pair));
      assert.equal(a.seed, b.seed);
      assert.equal(a.dealHash, b.dealHash);
      assert.ok(a.dealHash);
      for (let seat = 0; seat < players; seat++) {
        const x = resets[pair * players * 2 + seat];
        const y = resets[pair * players * 2 + players + seat];
        assert.equal(x.id, y.id);
        assert.deepEqual(x.hand, y.hand);
        assert.notEqual(x.side, y.side);
        assert.equal(x.side, seat % 2 === 0 ? 'A' : 'B');
      }
    }
    // Identical versions yield identical winners per deal but opposite SIDE.
    for (let pair = 0; pair < 2; pair++) {
      const [a, b] = row.records.slice(pair * 2, pair * 2 + 2);
      assert.equal(a.durakSeat, b.durakSeat);
      if (a.status === 'decided') {
        assert.notEqual(a.loser, b.loser);
        for (const r of [a, b]) {
          assert.equal(r.loser, seatBelongsToA(r.durakSeat, r.direction) ? 'A' : 'B');
        }
      }
    }
    assert.equal(row.durakA, row.durakB);
    assert.equal(row.initialDeals.length, 2);
    assert.equal(row.initialDeals[0].deal.deck.length, 24 - 6 * players);
    assert.equal(row.initialDeals[0].deal.rules.numPlayers, players);
  }
});

test('deterministic outcomes reproduced independently of measured milliseconds', () => {
  const options = { players: 2, deckSize: 24, pairs: 2, seed: 88, brainA: { solver }, brainB: { solver } };
  const a = runPairedConfig(options);
  const b = runPairedConfig(options);
  assert.deepEqual(a.records, b.records);
  assert.deepEqual(a.initialDeals, b.initialDeals);
  assert.notEqual(pairSeed(1, 2, 24, 'all', 0), pairSeed(1, 2, 24, 'all', 1));
  assert.notEqual(pairSeed(1, 4, 36, 'all', 0), pairSeed(1, 4, 36, 'neighbors', 0));
});

test('unfinished and illegal outcomes retained with seeds, never counted as draws', () => {
  const unfinished = runPairedConfig({ players: 2, deckSize: 24, pairs: 1, seed: 4, maxSteps: 0 });
  assert.equal(unfinished.unfinished, 2);
  assert.equal(unfinished.draws, 0);
  assert.equal(unfinished.completed, 0);
  assert.equal(unfinished.decided, 0);
  const broken = () => ({ reset() {}, observe() {}, decide() { return { action: { type: 'invalid' } }; } });
  const illegal = runPairedConfig({
    players: 2, deckSize: 24, pairs: 1, seed: 4, factoryA: broken, factoryB: broken,
  });
  assert.equal(illegal.errors, 2);
  assert.equal(illegal.illegal, 2);
  assert.equal(illegal.draws, 0);
  assert.equal(illegal.unfinished, 0);
  assert.equal(illegal.records[0].seed, illegal.records[1].seed);
  assert.match(illegal.records[0].message, /outside legal list/);
  assert.equal(illegal.planned, illegal.errors);
});

test('early deadlock is unfinished; exact step-limit finish is not', () => {
  const idle = () => ({ reset() {}, observe() {}, decide() { return {}; } });
  assert.equal(playOneGame(['smart', 'smart'], 24, 2, false, {
    rng: mulberry32(22), seatFactories: [idle, idle],
  }).stuck, true);
  const play = maxSteps => playOneGame(['simple', 'simple'], 24, 2, false, {
    rng: mulberry32(22), maxSteps,
  });
  const complete = play(5000);
  assert.equal(complete.stuck, false);
  assert.equal(play(complete.steps).stuck, false);
  assert.equal(play(complete.steps - 1).stuck, true);
});

test('cluster CI uses independent PAIRS and all denominators', () => {
  const stats = pairedShare([{ lossesA: 2, decided: 2 }, { lossesA: 0, decided: 2 }]);
  assert.equal(stats.durakPct, 50);
  assert.equal(stats.se, 50); // not binomial SE=25 from treating 4 games as independent
  assert.deepEqual(stats.ci95, [0, 100]);
  assert.match(stats.ciWarning, /small sample/);
  assert.equal(pairedShare([{ lossesA: 1, decided: 2 }]).ci95, null);
  assert.equal(pairedShare([{ lossesA: 0, decided: 0 }]).durakPct, null);
  assert.equal(pairedShare([{ lossesA: 1, decided: 2 }, { lossesA: 1, decided: 2 }]).ci95, null);
});

test('CLI rejects invalid paired settings before any calibration', () => {
  for (const args of [
    ['--pairs=1.5'], ['--pairs=0'], ['--group=unknown'],
    ['--group=self', '--configs=5x24', '--json=/tmp/not-written72.json'],
  ]) {
    const res = spawnSync(process.execPath, ['scripts/evalBots.js', '--paired', ...args], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.equal(res.stdout, '');
  }
  const help = spawnSync(process.execPath, ['scripts/evalBots.js', '--paired', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /15 rows/);
});
