#!/usr/bin/env node
// Capture BEFORE policy edits; verify the same seeded games AFTER them.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { playOneGame } from '../src/cli/matchCore.js';
import { SMART_PROFILES } from '../src/bots/smartBot.js';

const file = 'bench/issue72-equivalence.json';
const configs = [
  ...[2, 3, 4].flatMap(n => [24, 36, 52].map(d => [n, d, 'all'])),
  ...[5, 6].flatMap(n => [36, 52].map(d => [n, d, 'all'])),
  [4, 36, 'neighbors'], [4, 36, 'attackerOnly'],
];
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Elapsed milliseconds are measurements, not deterministic diagnostics.
// All other fields, including solver nodes/status, prose and chosen rules, compare.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([k]) => k !== 'ms').map(([k, v]) => [k, stable(v)]));
  return value;
}
const games = [];
for (const [players, deckSize, throwInPolicy] of configs) {
  for (const seed of [7201, 7202]) {
    const result = playOneGame(Array(players).fill('smart'), deckSize, players, true, {
      rng: rng(seed), throwInPolicy,
      seatOptions: Array.from({ length: players }, () => ({
        solver: { maxNodes: 500, maxMs: Number.MAX_SAFE_INTEGER },
        roundSearch: { maxNodes: 100, maxMs: Infinity },
      })),
    });
    games.push({ players, deckSize, throwInPolicy, seed, result: stable(result) });
  }
}
const data = {
  schema: 1, profiles: SMART_PROFILES,
  budget: { solverNodes: 500, roundNodes: 100, wallClock: 'disabled (Infinity)' },
  games,
};
if (process.argv.includes('--capture')) {
  assert.ok(!fs.existsSync(file), 'Do not overwrite the pre-refactor reference');
  fs.writeFileSync(file, JSON.stringify({
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version, ...data,
  }, null, 2) + '\n');
  console.log(`Captured ${games.length} games in ${file}`);
} else {
  const { commit, node, ...expected } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(data, expected);
  console.log(`Equivalent: ${games.length} games, ${games.reduce((s, g) => s + g.result.trace.length, 0)} decisions; reference ${commit} (${node})`);
}
