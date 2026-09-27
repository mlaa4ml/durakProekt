import { createBotBrain } from './index.js';

// Both ends enforce the masked contract. Never accept a game/RecordingGame,
// talon contents, snapshots or an unmasked opponent hand.
export function assertBotMask(state, playerId) {
  if (!state || !Array.isArray(state.players) || !state.players.some(p => p.id === playerId))
    throw new Error('Invalid bot state');
  if (state.players.some(p => p.id !== playerId && p.hand !== undefined)
      || state.talon !== undefined || state.snapshots !== undefined)
    throw new Error('Unmasked bot state');
}

// One worker = one brain = one player in one game. MessagePort FIFO preserves
// every public transition, including those between two turns of this player.
export function installBotWorker(scope) {
  let brain = null, player = null, sequence = 0;
  scope.onmessage = ({ data: m }) => {
    try {
      if (m.seq !== sequence + 1) throw new Error('Observation sequence mismatch');
      sequence = m.seq;
      assertBotMask(m.state, m.playerId);
      if (m.type === 'reset') {
        player = m.playerId;
        brain = createBotBrain(m.level, m.options);
        brain.reset(m.state, player);
      } else {
        if (!brain || m.playerId !== player) throw new Error('Brain not initialized');
        if (m.type === 'observe') brain.observe(m.state, player, m.event);
        else if (m.type === 'decide') {
          const decision = brain.decide(m.state, player, m.legal);
          scope.postMessage({ seq: m.seq, decision });
        } else throw new Error('Unknown bot request');
      }
    } catch {
      // Do not echo state, inferred hands or exception contents.
      scope.postMessage({ seq: m.seq, error: 'Bot worker failed' });
    }
  };
}

export class WorkerBotBrain {
  constructor(worker, level, options = {}) {
    this.worker = worker;
    this.level = level;
    this.options = options;
    this.sequence = 0;
    this.pending = new Map();
    this.error = null;
    this.playerId = null;
    worker.onmessage = ({ data: m }) => {
      if (this.error) return;
      if (m.error) { this.dispose(new Error(m.error)); return; }
      const request = this.pending.get(m.seq);
      if (!request) return; // cancelled/duplicate/stale response
      this.pending.delete(m.seq);
      clearTimeout(request.timer);
      request.resolve(m.decision);
    };
    worker.onerror = () => this.dispose(new Error('Bot worker unavailable'));
    worker.onmessageerror = () => this.dispose(new Error('Invalid bot worker response'));
  }

  _send(type, state, playerId, extra = {}) {
    if (this.error) throw this.error;
    assertBotMask(state, playerId);
    if (this.playerId && this.playerId !== playerId) throw new Error('Wrong bot player');
    this.playerId = playerId;
    const seq = ++this.sequence;
    this.worker.postMessage({ type, seq, state, playerId, ...extra });
    return seq;
  }

  reset(state, playerId) {
    this._send('reset', state, playerId, { level: this.level, options: this.options });
  }

  observe(state, playerId, event = null) {
    // A failed worker must not prevent delivery to the other observers.
    if (!this.error) this._send('observe', state, playerId, { event });
  }

  decide(state, playerId, legal) {
    return new Promise((resolve, reject) => {
      try {
        const seq = this._send('decide', state, playerId, { legal });
        const timer = setTimeout(() => this.dispose(new Error('Bot worker watchdog')), 15000);
        this.pending.set(seq, { resolve, reject, timer });
      } catch (e) { reject(e); }
    });
  }

  dispose(error = new Error('Bot decision cancelled')) {
    if (this.error) return;
    this.error = error;
    this.worker.terminate();
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
