// Optional browser integration check, no production dependency:
// npm install --prefix /tmp/worker71 --no-save playwright@1.63.0
// /tmp/worker71/node_modules/.bin/playwright install chromium
// PLAYWRIGHT_MODULE=/tmp/worker71/node_modules/playwright/index.mjs node scripts/check-worker71.mjs
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { buildClient } from './build-client.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = buildClient().html.replace('buildGame();\nshowSetup();', `
window.check71 = {
  createLocalBotBrain, WorkerBotBrain, DurakGame, createBotBrain, applyObservedAction,
  cancelLocalBots, localDecision, localBrain, runFullGame,
  workers:localWorkers,
  generation:()=>localGeneration,
  // Extract exactly the generated bundle used by production workers.
  heavyWorker: (position) => {
    const factory = createLocalBotBrain.toString();
    const literal = factory.match(/new Blob\\(\\[(.*)\\], \\{type:/)[1];
    const bundle = JSON.parse(literal);
    const code = bundle + '\\nself.onmessage=()=>self.postMessage(solveEndgame('
      + JSON.stringify(position) + ', {maxNodes:400000,maxMs:2000}));';
    const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    const worker=new Worker(url); URL.revokeObjectURL(url); return worker;
  }
};
showSetup();`);
const server = http.createServer((req,res) => {res.setHeader('Content-Type','text/html');res.end(source);});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.check71);
  const scenario = JSON.parse(fs.readFileSync('bench/issue71-before.json')).scenarios.find(s => s.name === 'audit64-transfer-false');
  const result = await page.evaluate(async position => {
    const api = window.check71;
    // Real generated Blob worker: main-thread animation and timers while search runs.
    let frames=0, ticks=0, alive=true;
    const animate=()=>{if(alive){frames++;requestAnimationFrame(animate);}};
    requestAnimationFrame(animate);
    const timer=setInterval(()=>ticks++,10);
    const heavy=api.heavyWorker(position);
    const started=performance.now();
    const search=await new Promise((resolve,reject)=>{
      heavy.onmessage=e=>resolve(e.data); heavy.onerror=reject; heavy.postMessage({});
    });
    heavy.terminate(); alive=false; clearInterval(timer);
    const elapsed=performance.now()-started;
    // Real SmartBot worker, not the heavy-search test entrypoint.
    const game = new api.DurakGame([{id:'a'},{id:'b'}],{deckSize:24},()=>0.42);
    const id=game.currentActorId(), state=game.getState(id), legal=game.getLegalActions(id);
    const options={profile:{exactEndgameSolver:false},explain:true,trace:true};
    const brain=api.createLocalBotBrain('smart',options);
    const direct=api.createBotBrain('smart',options);
    brain.reset(state,id); direct.reset(state,id);
    const remote=await brain.decide(state,id,legal);
    const expected=direct.decide(state,id,legal);
    brain.dispose();
    // Cancelling a real in-flight decision must not apply an old action or fallback.
    const brains=new Map([[id,api.localBrain(game,id,'smart',options)]]);
    const pending=api.localDecision(game,brains,id,legal,api.generation());
    api.cancelLocalBots();
    const cancelled=await pending;
    const restarted=await api.runFullGame(2,24,'all', {level:'smart'});
    return {frames,ticks,elapsed,search,remote,expected,cancelled,
      restartedPhase:restarted.phase,remainingWorkers:api.workers.size};
  }, scenario.position);
  assert.ok(result.search.timedOut);
  assert.ok(result.elapsed >= 1500);
  assert.ok(result.frames > 10 && result.ticks > 20, 'UI blocked during search');
  assert.deepEqual(result.remote,result.expected);
  assert.equal(result.cancelled,null);
  assert.equal(result.restartedPhase,'finished');
  assert.equal(result.remainingWorkers,0);
  assert.deepEqual(errors,[]);
  const report={browser:await browser.version(),...result,errors};
  fs.writeFileSync('bench/issue71-browser.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await browser.close();
  await new Promise(r=>server.close(r));
}
