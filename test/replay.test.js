import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DurakGame } from '../src/game.js';
import { GameRecorder, replayArtifact, BUILD_VERSION } from '../src/diagnostics/replay.js';
import { playOneGame } from '../src/cli/matchCore.js';
import { Room } from '../server/rooms.js';
import { saveMatchLog } from '../server/matchLog.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
function rng(seed = 1) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function assertMasked(state, playerId) {
  for (const player of state.players) {
    if (player.id === playerId) assert.ok(Array.isArray(player.hand));
    else assert.equal(Object.hasOwn(player, 'hand') && player.hand !== undefined, false);
  }
}
function recordedMatch(numPlayers = 2, deckSize = 24, throwInPolicy = 'all') {
  return playOneGame(Array(numPlayers).fill('simple'), deckSize, numPlayers, true, {
    rng: rng(17), throwInPolicy, recordDiagnostic: true,
  }).diagnostic;
}

for (const [players, deck, policy] of [[2, 24, 'all'], [4, 36, 'neighbors'], [6, 52, 'attackerOnly']]) {
  test(`record/replay full game ${players}/${deck}/${policy}`, () => {
    const artifact = recordedMatch(players, deck, policy);
    assert.equal(artifact.outcome.phase, 'finished');
    assert.equal(artifact.buildVersion, BUILD_VERSION);
    const { game, actionCount } = replayArtifact(clone(artifact));
    assert.equal(actionCount, artifact.actions.length);
    assert.deepEqual(game.finishedOrder, artifact.outcome.finishedOrder);
    assert.equal(game.durak, artifact.outcome.durak);
    assert.deepEqual(artifact.actions.map((e) => e.id), artifact.actions.map((_, i) => i + 1));
    for (const entry of artifact.actions) {
      assertMasked(entry.snapshot, entry.playerId);
      assert.equal(entry.decision.actor.level, 'simple');
      assert.equal(entry.decision.decisionTrace, null);
    }
    for (const snapshot of artifact.initialSnapshots) assertMasked(snapshot.state, snapshot.playerId);
    for (const snapshot of artifact.outcome.snapshots) assertMasked(snapshot.state, snapshot.playerId);
  });
}

test('explicit validation errors for versions, malformed data, IDs and tampering', () => {
  const original = recordedMatch();
  const cases = [
    [(a) => { a.format = 'other'; }, /unsupported format/],
    [(a) => { a.version++; }, /format version/],
    [(a) => { a.engineVersion++; }, /engine version/],
    [(a) => { a.buildVersion = 'old'; }, /build version mismatch/],
    [(a) => { delete a.initialDeck; }, /initial deck/],
    [(a) => { a.initialDeck[0] = a.initialDeck[1]; }, /начальная колода/],
    [(a) => { a.players[1].id = a.players[0].id; }, /invalid players/],
    [(a) => { a.actions[0].id = 2; }, /non-sequential/],
    [(a) => { a.actions[0].playerId = 'unknown'; }, /unknown player/],
    [(a) => { a.actions[0].snapshot.talonCount++; }, /snapshot mismatch/],
    [(a) => { a.actions[0].legalActions = []; }, /legal actions mismatch/],
    [(a) => { a.actions[0].action = { type: 'invalid' }; }, /illegal action/],
    [(a) => { a.actions.pop(); }, /outcome mismatch/],
    [(a) => { delete a.actions[0].decision; }, /missing decision/],
    [(a) => { a.rules.stallWarning++; }, /initial snapshots mismatch/],
  ];
  for (const [mutate, expected] of cases) {
    const artifact = clone(original);
    mutate(artifact);
    assert.throws(() => replayArtifact(artifact), expected);
  }
  assert.throws(() => replayArtifact(null), /Replay: unsupported format/);
});

test('partial archive is protected, isolated, replayable; rejected actions do not consume IDs', () => {
  const game = new DurakGame([{ id: 'a' }, { id: 'b' }], {}, rng());
  const recorder = new GameRecorder(game);
  assert.throws(() => recorder.exportArtifact(), /protected diagnostic storage/);
  assert.throws(() => game.applyAction('missing', { type: 'pass' }), /unknown player/);
  const actor = game.players.find((p) => game.getLegalActions(p.id).length);
  assert.throws(() => game.applyAction(actor.id, { type: 'invalid' }), /illegal action/);
  game.applyAction(actor.id, game.getLegalActions(actor.id)[0]);
  const artifact = recorder.exportArtifact({ protectedDiagnostic: true });
  assert.deepEqual(artifact.actions.map((e) => e.id), [1]);
  assert.equal(replayArtifact(artifact).actionCount, 1);
  artifact.actions[0].snapshot.players[0].handCount = -1;
  assert.notEqual(recorder.exportArtifact({ protectedDiagnostic: true }).actions[0].snapshot.players[0].handCount, -1);
  assert.equal(JSON.stringify(game.getState(actor.id)).includes('initialDeck'), false);
});

test('room records human actions without sending diagnostic data or opponent hands', () => {
  const sent = [];
  const socket = () => ({
    OPEN: 1, readyState: 1,
    send(text) { sent.push(JSON.parse(text)); },
  });
  const room = new Room('REPLAY', { numPlayers: 2 });
  try {
    room.addPlayer('A', socket());
    room.addPlayer('B', socket());
    const actor = room.game.players.find((p) => room.game.getLegalActions(p.id).length);
    room.applyAction(actor.id, room.game.getLegalActions(actor.id)[0]);
    const artifact = room.recorder.exportArtifact({ protectedDiagnostic: true });
    assert.equal(replayArtifact(artifact).actionCount, 1);
    assert.equal(artifact.actions[0].decision.actor.kind, 'human');
    for (const payload of sent.filter((p) => p.type === 'state')) {
      assertMasked(payload.state, payload.you);
      assert.equal(JSON.stringify(payload).includes('initialDeck'), false);
      assert.equal(Object.hasOwn(payload, 'diagnostic'), false);
      assert.ok(payload.log.every((line) => typeof line === 'string'));
    }
  } finally {
    room.destroy();
  }
});

test('postgame server archive is private on disk and accepted by replay CLI', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'durak-replay-'));
  const previous = process.env.DURAK_SAVE_LOGS;
  delete process.env.DURAK_SAVE_LOGS;
  try {
    const artifact = recordedMatch();
    const { game } = replayArtifact(artifact);
    const file = await saveMatchLog(game, { roomId: 'REPLAY', diagnostic: artifact }, dir);
    assert.ok(file);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(replayArtifact(stored.diagnostic).actionCount, artifact.actions.length);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    const cli = spawnSync(process.execPath, ['src/cli/replay.js', file], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const summary = JSON.parse(cli.stdout);
    assert.equal(summary.replay, 'ok');
    assert.equal(summary.actionCount, artifact.actions.length);
    assert.equal(cli.stdout.includes('hand'), false);
    const invalid = spawnSync(process.execPath, ['src/cli/replay.js'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage:/);
  } finally {
    if (previous === undefined) delete process.env.DURAK_SAVE_LOGS;
    else process.env.DURAK_SAVE_LOGS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
