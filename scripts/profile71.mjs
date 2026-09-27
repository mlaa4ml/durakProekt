// Reproducible, bounded search microbenchmark; run before and after on the same host.
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { Session } from 'node:inspector';
import { solveEndgame } from '../src/bots/endgame.js';

const output = process.argv[2] || 'bench/issue71-before';
const repeats = Number(process.env.REPEATS || 12);
const budget = { maxNodes: 400000, maxMs: 2000 };
const card = (suit, rank) => ({ suit, rank });
const scenarios = [
  { name: 'small-win', trumpSuit: '♠', hands: [[card('♠', 14)], [card('♥', 6)]] },
  { name: 'small-defense', trumpSuit: '♠', hands: [[card('♥', 6), card('♣', 7)], [card('♥', 7), card('♠', 6)]] },
  { name: 'audit64', trumpSuit: '♠', hands: [
    [['♣',9],['♠',14],['♦',14],['♣',14],['♥',10],['♥',11],['♦',11],['♦',12],['♦',13],['♣',10],['♣',11],['♣',13]].map(([s,r])=>card(s,r)),
    [['♣',12],['♠',11],['♠',12],['♥',13]].map(([s,r])=>card(s,r)),
  ] },
].flatMap(s => [false, true].map(allowPerevod => ({
  name: `${s.name}-transfer-${allowPerevod}`,
  position: {
    rules: { numPlayers: 2, deckSize: 24, allowPerevod },
    trumpSuit: s.trumpSuit, players: s.hands.map((hand,i)=>({id:`p${i}`,hand})),
    attacker:'p0', defender:'p1', phase:'need-attack', allowAnyCardNow:true,
    attackCountThisRound:0, defenderHandAtStart:s.hands[1].length,
  },
})));
const session = new Session();
session.connect();
const post = (method, params = {}) => new Promise((resolve,reject) =>
  session.post(method, params, (err,result)=>err ? reject(err) : resolve(result)));
await post('Profiler.enable');
await post('HeapProfiler.enable');
// Warmup is identical, excluded from latency samples.
for (const s of scenarios) solveEndgame(s.position, {maxNodes:1000,maxMs:2000});
await post('Profiler.start');
await post('HeapProfiler.startSampling', {samplingInterval:32768});
const rows = [];
for (let i=0;i<repeats;i++) for (const s of scenarios) {
  const r=solveEndgame(s.position,budget);
  rows.push({scenario:s.name, iteration:i, ...r, nodesPerSecond:r.nodes*1000/r.ms});
}
const {profile:cpu}=await post('Profiler.stop');
const {profile:heap}=await post('HeapProfiler.stopSampling');
session.disconnect();
const percentile=(a,p)=>a.slice().sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
const summary=scenarios.map(s=>{
  const rs=rows.filter(r=>r.scenario===s.name), times=rs.map(r=>r.ms);
  return {scenario:s.name, p50:percentile(times,.5),p95:percentile(times,.95),p99:percentile(times,.99),
    timeoutFraction:rs.filter(r=>r.timedOut).length/rs.length,
    nodesPerSecond:rs.reduce((n,r)=>n+r.nodes,0)*1000/rs.reduce((n,r)=>n+r.ms,0)};
});
fs.mkdirSync('bench',{recursive:true});
fs.writeFileSync(`${output}.json`,JSON.stringify({
  revision:execSync('git rev-parse HEAD').toString().trim(),node:process.version,v8:process.versions.v8,
  platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,
  repeats,budget,scenarios,summary,rows,
},null,2)+'\n');
fs.writeFileSync(`${output}.cpuprofile`,JSON.stringify(cpu));
fs.writeFileSync(`${output}.heapprofile`,JSON.stringify(heap));
console.log(JSON.stringify(summary,null,2));
