import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DurakGame } from '../src/game.js';
import { SmartBot } from '../src/bots/smartBot.js';
import { createBotBrain, applyObservedAction } from '../src/bots/index.js';
import { WorkerBotBrain, installBotWorker, assertBotMask } from '../src/bots/workerBrain.js';
import { solveEndgame } from '../src/bots/endgame.js';

function loopback() {
  const messages = [];
  const scope = { postMessage: data => queueMicrotask(() => worker.onmessage?.({ data })) };
  const worker = {
    messages, terminated: false,
    postMessage(data) {
      const copy = structuredClone(data);
      messages.push(copy);
      queueMicrotask(() => { if (!this.terminated) scope.onmessage({ data: copy }); });
    },
    terminate() { this.terminated = true; },
  };
  installBotWorker(scope);
  return worker;
}
function seeded(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test('worker FIFO preserves every public observation and synchronous decisions without hidden hands', async () => {
  const game = new DurakGame([{id:'a'}, {id:'b'}], {deckSize:24}, seeded(7));
  const options = { explain:true, trace:true, profile:{exactEndgameSolver:false} };
  const workers = new Map(), direct = new Map(), ports = [];
  for (const {id} of game.players) {
    const port = loopback();
    ports.push(port);
    const remote = new WorkerBotBrain(port, 'smart', options);
    const local = createBotBrain('smart', options);
    remote.reset(game.getState(id), id);
    local.reset(game.getState(id), id);
    workers.set(id, remote); direct.set(id, local);
  }
  let steps = 0;
  try {
    while (game.phase !== 'finished' && steps++ < 1000) {
      const id = game.currentActorId(), state = game.getState(id), legal = game.getLegalActions(id);
      const remote = await workers.get(id).decide(state, id, legal);
      const local = direct.get(id).decide(state, id, legal);
      assert.deepEqual(remote, local);
      assert.ok(legal.some(a => game._actionsEqual(a, remote.action)));
      const recipients = game.players.filter(p => !p.out).map(p => p.id);
      applyObservedAction(game, workers, id, remote.action);
      for (const p of recipients) direct.get(p).observe(game.getState(p), p, game.publicTransition);
    }
    assert.equal(game.phase, 'finished');
    for (const port of ports) {
      for (const [i, m] of port.messages.entries()) {
        assert.equal(m.seq, i + 1);
        assertBotMask(m.state, m.playerId);
        assert.equal(m.state.talon, undefined);
        if (m.event) assert.deepEqual(Object.keys(m.event).sort(),
          Object.keys(game.publicTransition).sort());
      }
      assert.ok(port.messages.filter(m => m.type === 'observe' && m.event).length > 5);
    }
  } finally { for (const brain of workers.values()) brain.dispose(); }
});

test('cancel, restart, stale replies and worker errors settle promises safely', async () => {
  const state = {players:[{id:'a',hand:[]},{id:'b',handCount:1}]};
  const port = {postMessage() {}, terminate() {this.terminated = true;}};
  const brain = new WorkerBotBrain(port, 'smart');
  brain.reset(state,'a');
  const oldHandler = port.onmessage;
  const pending = brain.decide(state,'a',[]);
  const rejected = assert.rejects(pending, /cancelled/);
  oldHandler({data:{seq:999,decision:{action:'stale'}}});
  assert.equal(brain.pending.size,1);
  brain.dispose(); brain.dispose();
  await rejected;
  oldHandler({data:{seq:2,decision:{action:'late'}}});
  assert.equal(brain.pending.size,0);
  assert.ok(port.terminated);
  const nextPort = loopback(), next = new WorkerBotBrain(nextPort,'simple');
  next.reset(state,'a');
  assert.deepEqual(await next.decide(state,'a',[]), {action:null});
  next.dispose();
  const badPort = {postMessage() {}, terminate() {}};
  const bad = new WorkerBotBrain(badPort,'smart');
  const failed = assert.rejects(bad.decide(state,'a',[]), /unavailable/);
  badPort.onerror();
  await failed;
});

test('both worker endpoints reject unmasked states and out-of-order observations', () => {
  const state = {players:[{id:'a',hand:[]},{id:'b',hand:[]}]};
  assert.throws(() => assertBotMask(state,'a'), /Unmasked/);
  const replies = [], scope = {postMessage: m => replies.push(m)};
  installBotWorker(scope);
  scope.onmessage({data:{seq:1,type:'reset',state,playerId:'a',level:'smart'}});
  scope.onmessage({data:{seq:3,type:'observe',state,playerId:'a'}});
  assert.deepEqual(replies, [
    {seq:1,error:'Bot worker failed'}, {seq:3,error:'Bot worker failed'},
  ]);
});

test('scratch transposition tables cannot cross rules, trumps or roots; small outcomes unchanged', () => {
  const before = JSON.parse(fs.readFileSync(new URL('../bench/issue71-before.json', import.meta.url)));
  const shared = new Map();
  for (const s of before.scenarios.filter(s => s.name.startsWith('small'))) {
    const baseline = before.rows.find(r => r.scenario === s.name);
    for (const trumpSuit of ['♠','♥']) for (const swap of [false,true]) {
      const position = structuredClone(s.position);
      position.trumpSuit = trumpSuit;
      if (swap) {
        position.attacker = 'p1'; position.defender = 'p0';
        position.defenderHandAtStart = position.players[0].hand.length;
      }
      const options = {maxNodes:400000,maxMs:2000};
      const fresh = solveEndgame(position, options);
      shared.set('poison', {score:1,flag:0});
      const reused = solveEndgame(position, {...options,table:shared});
      assert.equal(shared.has('poison'),false);
      assert.equal(fresh.solved,true);
      for (const key of ['value','action','nodes','player','timedOut']) assert.deepEqual(reused[key],fresh[key]);
      assert.ok(reused.legal.some(a => JSON.stringify(a) === JSON.stringify(reused.action)));
      if (!swap && trumpSuit === s.position.trumpSuit) {
        assert.equal(fresh.value,baseline.value);
        assert.deepEqual(fresh.action,baseline.action);
      }
    }
  }
});

test('decision memoization never outlives a decision, reset or exception', () => {
  const bot = new SmartBot();
  let calls = 0;
  bot._decide = () => {
    const compute = () => ++calls;
    assert.equal(bot._memoDecision('test',compute), calls);
    assert.equal(bot._memoDecision('test',compute), calls);
    return calls;
  };
  assert.equal(bot.decide(),1);
  assert.equal(bot._decisionCache,null);
  bot.reset();
  assert.equal(bot.decide(),2);
  bot._decide = () => { throw new Error('test'); };
  assert.throws(() => bot.decide(), /test/);
  assert.equal(bot._decisionCache,null);
});
