#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { replayArtifact } from '../diagnostics/replay.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('Usage: node src/cli/replay.js <diagnostic-or-match-log.json>');
  const payload = JSON.parse(await readFile(args[0], 'utf8'));
  const { game, actionCount } = replayArtifact(payload.diagnostic ?? payload);
  // No hands in terminal output, even for partial protected archives.
  console.log(JSON.stringify({
    replay: 'ok', actionCount, phase: game.phase,
    durak: game.durak, drawReason: game.drawReason,
  }));
} catch (err) {
  console.error(`Replay failed: ${err.message}`);
  process.exitCode = 1;
}
