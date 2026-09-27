// Opt-in local fallback, NOT a solver for the rest of the game.
// Only reconstruct a duel with an empty talon and a publicly certain hand.
// A take declaration settles the local defensive outcome; we do not call it
// a game win and do not search a new round.
import { DurakGame } from '../game.js';
import { canSolve, positionFromState, sameEndgameAction } from './endgame.js';
import { cardPower } from './analysis.js';

export const DEFAULT_ROUND_OPTIONS = Object.freeze({
  maxNodes: 6000, maxMs: 40, maxDepth: 24, maxNodesPerAction: 500,
});
const now = () => globalThis.performance?.now?.() ?? Date.now();
const bound = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;

export function searchRound(state, tracker, meId, legalActions, options = {}) {
  const started = now();
  const limits = Object.fromEntries(Object.entries(DEFAULT_ROUND_OPTIONS)
    .map(([key, value]) => [key, bound(options[key], value)]));
  let nodes = 0;
  const candidates = [];
  const result = (status, action = null) => ({
    status, action, nodes, ms: now() - started, limits, candidates,
    scope: 'current-round', complete: candidates.length > 0 && candidates.every((c) => c.complete),
  });
  if (state.phase !== 'need-attack') return result('not-attacking');
  if (!canSolve(state, tracker, meId)) return result('uncertain-or-unsupported');
  try {
    const opponent = state.players.find((p) => !p.out && p.id !== meId);
    const hand = tracker.toCards(tracker.opponentKnownCards(opponent.id));
    const root = DurakGame.fromPosition(positionFromState(state, meId, hand));
    const legal = root.getLegalActions(meId);
    if (root.currentActorId() !== meId ||
        root.getState().maxAttacksNow !== state.maxAttacksNow ||
        legal.length !== legalActions.length ||
        !legal.every((a) => legalActions.some((b) => sameEndgameAction(a, b)))) {
      return result('mismatch');
    }
    const strength = (g) => g.players.find((p) => p.id === meId).hand
      .reduce((sum, c) => sum + cardPower(c, g.trumpSuit), 0);
    const initialStrength = strength(root);
    // Material only breaks ties between local outcomes. Prefer keeping costly
    // cards, including passing after a take, unless playing out ends the game.
    const evaluate = (g, kind) => {
      const value = kind === 'win' ? 1000 : kind === 'loss' ? -1000 :
        kind === 'opponent-takes' ? 100 : kind === 'self-takes' ? -100 : 0;
      return {
        score: value + Math.max(-0.99, Math.min(0.99, (strength(g) - initialStrength) / 10000)),
        forcedTake: kind === 'opponent-takes',
        defenderMayExit: kind === 'loss' || g.players.find((p) => p.id === opponent.id).out,
      };
    };
    let actionNodes = 0;
    function visit(g, depth) {
      if (nodes >= limits.maxNodes || actionNodes >= limits.maxNodesPerAction ||
          now() - started >= limits.maxMs || depth > limits.maxDepth) return null;
      nodes++;
      actionNodes++;
      if (g.phase === 'finished') {
        return evaluate(g, g.durak === meId ? 'loss' : g.durak === opponent.id ? 'win' : 'draw');
      }
      if (!g.table.length) return evaluate(g, 'closed');
      // For an already declared take, explore through closure (pass / last
      // card matter). Otherwise the declaration is the local search boundary.
      if (g.tookCards && !root.tookCards) {
        return evaluate(g, g.players[g.defenderIndex].id === meId ? 'self-takes' : 'opponent-takes');
      }
      const actor = g.currentActorId();
      const moves = g.getLegalActions(actor);
      if (!moves.length) return null;
      const outcomes = [];
      for (const move of moves) {
        const child = g.clone();
        child.applyLegalAction(actor, move);
        const outcome = visit(child, depth + 1);
        if (!outcome) return null; // incomplete branches are never proofs
        outcomes.push(outcome);
      }
      if (actor === meId) return outcomes.reduce((a, b) => b.score > a.score ? b : a);
      const worst = outcomes.reduce((a, b) => b.score < a.score ? b : a);
      return {
        ...worst,
        forcedTake: outcomes.every((o) => o.forcedTake),
        defenderMayExit: outcomes.some((o) => o.defenderMayExit),
      };
    }
    // Check cheap local certificates first, without a "highest trump" rule.
    // A separate per-action cap prevents one large subtree starving all peers.
    const ordered = legal.map((action) => {
      const child = root.clone();
      child.applyLegalAction(meId, action);
      return { action, child, replies: child.phase === 'finished' ? 0 :
        child.getLegalActions(child.currentActorId()).length };
    }).sort((a, b) => a.replies - b.replies);
    for (const { action, child } of ordered) {
      actionNodes = 0;
      const outcome = visit(child, 1);
      candidates.push({ action, complete: outcome !== null, nodes: actionNodes, ...(outcome || {}) });
    }
    const complete = candidates.filter((c) => c.complete);
    const allComplete = complete.length === legal.length;
    // Partial search may select ONLY a fully established forced take, never a
    // speculative score from an unfinished subtree. No global optimality claim.
    const safe = allComplete ? complete : complete.filter((c) => c.forcedTake && !c.defenderMayExit);
    if (!safe.length) return result('incomplete');
    const best = safe.reduce((a, b) => b.score > a.score ? b : a);
    const action = legalActions.find((a) => sameEndgameAction(a, best.action));
    return result(allComplete ? 'complete' : 'local-certificate', action);
  } catch {
    return result('failed');
  }
}
