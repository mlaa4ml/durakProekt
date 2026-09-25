// Privileged, Node-only diagnostics. Never pass a recorder/artifact to a bot or socket.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DurakGame } from '../game.js';

export const REPLAY_FORMAT = 'durak-diagnostic';
export const REPLAY_VERSION = 1;
export const ENGINE_VERSION = 1;
const copy = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) => JSON.stringify(value, function (key, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
  }
  return v;
});
const equal = (a, b) => canonical(a) === canonical(b);
const fail = (message) => { throw new Error(`Replay: ${message}`); };

// Fingerprint the actual engine/policy sources, not a caller-supplied release label.
const sourceFiles = ['game.js', 'rules.js', 'deck.js',
  ...readdirSync(new URL('../bots/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `bots/${f}`),
].sort();
export const BUILD_VERSION = createHash('sha256').update(sourceFiles.map((file) =>
  `${file}\n${readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')}`
).join('\n')).digest('hex');

function outcome(game) {
  return {
    phase: game.phase, durak: game.durak, drawReason: game.drawReason,
    finishedOrder: game.finishedOrder,
    snapshots: game.players.map((p) => ({ playerId: p.id, state: game.getState(p.id) })),
  };
}

/**
 * Install immediately after construction, before any actions.
 * The private archive aggregates all seats' own hands: it is NOT a public log.
 * Rejected actions do not consume IDs. Clones/search games are not instrumented.
 */
export class GameRecorder {
  #game;
  #artifact;
  #apply;
  #pending = null;

  constructor(game, { participants = [] } = {}) {
    if (game.phase !== 'need-attack' || game.table.length || game.discardCount ||
        game.attackCountThisRound || game.stallActions) fail('recording must start at the initial deal');
    this.#game = game;
    this.#artifact = copy({
      format: REPLAY_FORMAT, version: REPLAY_VERSION, engineVersion: ENGINE_VERSION,
      buildVersion: BUILD_VERSION, participants,
      rules: game.rules,
      players: game.players.map(({ id, name }) => ({ id, name })),
      // _deal consumes contiguous hands, then the talon; last card is trump.
      initialDeck: [...game.players.flatMap((p) => p.hand), ...game.talon],
      initialSnapshots: game.players.map((p) => ({ playerId: p.id, state: game.getState(p.id) })),
      actions: [],
    });
    this.#apply = game.applyAction.bind(game);
    game.applyAction = (playerId, action) => this.applyAction(playerId, action);
  }

  // Decision metadata describes the actual actor (including human/bot takeover).
  // Stage 3 can fill decisionTrace without changing the envelope.
  applyAction(playerId, action, decision = null) {
    if (this.#pending) fail('recursive action');
    const game = this.#game;
    if (!game.players.some((p) => p.id === playerId)) fail('unknown player');
    const entry = copy({
      id: this.#artifact.actions.length + 1, playerId,
      snapshot: game.getState(playerId),
      legalActions: game.getLegalActions(playerId), action,
      decision: decision === null ? null : {
        actor: decision.actor ?? null,
        reason: decision.reason ?? null,
        decisionTrace: decision.decisionTrace ?? null,
      },
    });
    // Compare the full action, including defend.against.
    if (!entry.legalActions.some((a) => equal(a, entry.action))) fail(`illegal action ${entry.id}`);
    this.#pending = entry;
    try {
      const result = this.#apply(playerId, action);
      this.#artifact.actions.push(entry);
      return result;
    } finally {
      this.#pending = null;
    }
  }

  exportArtifact({ protectedDiagnostic = false } = {}) {
    if (this.#game.phase !== 'finished' && !protectedDiagnostic) {
      fail('unfinished game: export only to protected diagnostic storage');
    }
    return copy({ ...this.#artifact, outcome: outcome(this.#game) });
  }
}

/** Replays recorded choices, not bot decisions/time budgets, using the real engine. */
export function replayArtifact(artifact) {
  try {
    if (!artifact || artifact.format !== REPLAY_FORMAT) fail('unsupported format');
    if (artifact.version !== REPLAY_VERSION) fail(`unsupported format version ${artifact.version}`);
    if (artifact.engineVersion !== ENGINE_VERSION) fail(`unsupported engine version ${artifact.engineVersion}`);
    if (artifact.buildVersion !== BUILD_VERSION) fail('build version mismatch; use the recorded source revision');
    if (!Array.isArray(artifact.players) || !Array.isArray(artifact.actions) ||
        !Array.isArray(artifact.participants) || !artifact.rules || !artifact.outcome) fail('missing required fields');
    if (artifact.players.some((p) => !p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string') ||
        new Set(artifact.players.map((p) => p.id)).size !== artifact.players.length) fail('invalid players');
    if (!Array.isArray(artifact.initialDeck)) fail('missing initial deck');
    const game = new DurakGame(artifact.players, artifact.rules, Math.random, artifact.initialDeck);
    if (!equal(game.rules, artifact.rules)) fail('rules do not match resolved rules');
    const initial = game.players.map((p) => ({ playerId: p.id, state: game.getState(p.id) }));
    if (!equal(initial, artifact.initialSnapshots)) fail('initial snapshots mismatch');
    for (const [index, entry] of artifact.actions.entries()) {
      if (!entry || entry.id !== index + 1) fail(`non-sequential action id at ${index + 1}`);
      if (!game.players.some((p) => p.id === entry.playerId)) fail(`unknown player at action ${entry.id}`);
      if (!Object.hasOwn(entry, 'decision')) fail(`missing decision slot at action ${entry.id}`);
      if (!equal(game.getState(entry.playerId), entry.snapshot)) fail(`snapshot mismatch at action ${entry.id}`);
      const legal = game.getLegalActions(entry.playerId);
      if (!equal(legal, entry.legalActions)) fail(`legal actions mismatch at action ${entry.id}`);
      if (!legal.some((a) => equal(a, entry.action))) fail(`illegal action ${entry.id}`);
      game.applyAction(entry.playerId, entry.action);
    }
    if (!equal(outcome(game), artifact.outcome)) fail('outcome mismatch (possibly truncated history)');
    return { game, actionCount: artifact.actions.length };
  } catch (err) {
    if (err.message?.startsWith('Replay:')) throw err;
    fail(`invalid artifact: ${err.message}`);
  }
}
