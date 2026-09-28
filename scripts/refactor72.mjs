#!/usr/bin/env node
// One-shot mechanical relocation. Run only against the frozen pre-refactor source.
// Bodies are copied verbatim so rule ordering and prose cannot drift.
import fs from 'node:fs';
const path = 'src/bots/smartBot.js';
let source = fs.readFileSync(path, 'utf8');
if (source.includes('./profiles.js')) throw new Error('Already relocated');
const slice = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`Missing boundary: ${start}`);
  return source.slice(a, b);
};
const profiles = slice('/** Профиль эвристик.', '// Вес цены отдаваемой карты');
fs.writeFileSync('src/bots/profiles.js',
  '// Profile configuration and historical calibration notes; no policy execution.\n' + profiles);
source = source.replace(profiles,
  "import { SMART_PROFILE, SMART_PROFILES, pickProfile, pickProfileName } from './profiles.js';\nexport { SMART_PROFILE, SMART_PROFILES, pickProfile, pickProfileName };\n\n");

const context = slice('// Вес цены отдаваемой карты', '/**\n * Правила партии глазами бота.');
fs.writeFileSync('src/bots/policyContext.js',
  "import { cardToString } from '../deck.js';\n\n" +
  context.replace(/^(const|function) /gm, 'export $1 '));
source = source.replace(context, '');
const common = "import { cardToString } from '../deck.js';\n" +
  "import { PRESSURE_COST_WEIGHT, HIGH_RANK, BIG_TRUMP, list, myHandOf, handCountOf, alivePlayersCount } from './policyContext.js';\n";
function moveMethod(method, next, file, imports, exported, args) {
  const original = slice(`  ${method}(`, next);
  // The last closing brace with two spaces is the method end. Keep separator comments in facade.
  const end = original.lastIndexOf('\n  }') + '\n  }'.length;
  const body = original.slice(0, end);
  fs.writeFileSync(file, imports + '\n' +
    body.replace(`  ${method}(`, `export function ${exported}(`) + '\n');
  source = source.replace(body, `  ${method}(${args}) {\n    return ${exported}.call(this, ${args});\n  }`);
}
moveMethod('_decideAttack', '  _decideDefense(', 'src/bots/attackPolicy.js',
  common + "import { beats, cardPower } from './analysis.js';\n" +
  "import { bestAttackByPressure, voidSuitsOf, MAX_CARD_POWER } from './estimate.js';\n",
  'decideAttackPolicy', 'state, playerId, legalActions');
moveMethod('_decideDefense', '\n}\n\n/** Фабрика', 'src/bots/defensePolicy.js',
  common + "import { cardPower, planDefense, suitControl } from './analysis.js';\n" +
  "import { pDefenseSurvives, expectedThrowIn, voidSuitsOf } from './estimate.js';\n",
  'decideDefensePolicy', 'state, playerId, legalActions, { defends, transfers, take }');

// Collect presentation methods into a single module (call with the existing bot context).
const explanations = [];
for (const [method, next, name, args] of [
  ['_analysisText', '  decide(', 'analysisText', 'state, hand, trumpSuit, oppId'],
  ['_decisionReason', '  _choose(', 'decisionReason', 'picked, trace'],
  ['_solverReason', '  _decideAttack(', 'solverReason', 'action, value'],
]) {
  const original = slice(`  ${method}(`, next);
  const end = original.lastIndexOf('\n  }') + '\n  }'.length;
  const body = original.slice(0, end);
  explanations.push(body.replace(`  ${method}(`, `export function ${name}(`));
  source = source.replace(body,
    `  ${method}(${args}) {\n    return ${name}.call(this, ${args});\n  }`);
}
const label = "const PHASE_LABEL = { debut: 'начало партии', middle: 'середина партии', endgame: 'эндшпиль' };";
source = source.replace(label, '');
fs.writeFileSync('src/bots/explanations.js',
  common + "import { gamePhase, handStrength } from './analysis.js';\n\n" +
  label + '\n\n' + explanations.join('\n\n') + '\n');
const imports = slice("import { cardToString }", "import { SMART_PROFILE");
source = source.replace(imports,
  "import { searchRound, DEFAULT_ROUND_OPTIONS } from './roundSearch.js';\n" +
  "import { DEFAULT_RULES } from '../rules.js';\n" +
  "import { CardTracker } from './memory.js';\n" +
  "import { canSolve, solveFromState, sameEndgameAction, DEFAULT_SOLVER_OPTIONS } from './endgame.js';\n" +
  "import { beats, unbeatableCards } from './analysis.js';\n" +
  "import { myHandOf } from './policyContext.js';\n" +
  "import { decideAttackPolicy } from './attackPolicy.js';\n" +
  "import { decideDefensePolicy } from './defensePolicy.js';\n" +
  "import { analysisText, decisionReason, solverReason } from './explanations.js';\n");
fs.writeFileSync(path, source);
console.log('Relocated profiles, attack, defense, presentation; integration order unchanged.');
