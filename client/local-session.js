// botOptions (issue #39): { level: 'simple'|'smart', explain: boolean }.
// По умолчанию — простой бот без объяснений, то есть ровно то, что было раньше.
// Партия просмотра проигрывается целиком в момент создания, поэтому и уровень, и
// объяснения фиксируются на её старте.
// A generation owns all workers, timers and in-flight answers of a local game.
let localGeneration=0;
const localWorkers=new Set();
function cancelLocalBots(){
  localGeneration++;
  stopBotTimer();
  for(const brain of localWorkers) brain.dispose();
  localWorkers.clear();
  interactiveBusy=false;
}
window.addEventListener('pagehide', cancelLocalBots);

function localBrain(game, playerId, level, options){
  let brain;
  try {
    brain=createLocalBotBrain(level, options);
    if(brain.dispose) localWorkers.add(brain);
    brain.reset(game.getState(playerId), playerId);
  } catch {
    if(brain?.dispose){ brain.dispose(); localWorkers.delete(brain); }
    // Explicit, visible failure fallback; never run SmartBot on the UI thread.
    game._log('⚠ Worker недоступен: используется простой бот.');
    brain=createBotBrain('simple', options);
    brain.reset(game.getState(playerId), playerId);
  }
  return brain;
}

function releaseBrains(brains){
  for(const brain of brains.values()){
    if(brain.dispose){ brain.dispose(); localWorkers.delete(brain); }
  }
}

async function localDecision(game, brains, playerId, legal, generation){
  const brain=brains.get(playerId);
  const state=game.getState(playerId);
  try {
    brain.observe(state, playerId);
    const decision=await brain.decide(state, playerId, legal) || {};
    if(generation!==localGeneration) return null;
    // Structured cloning loses object identity: validate against current legal actions.
    const action=legal.find(a=>game._actionsEqual(a, decision.action));
    if(!action) throw new Error('Invalid worker action');
    return {...decision, action};
  } catch {
    if(generation!==localGeneration) return null;
    if(brain.dispose){ brain.dispose(); localWorkers.delete(brain); }
    const fallback=createBotBrain('simple');
    fallback.reset(state, playerId);
    brains.set(playerId, fallback);
    game._log('⚠ Ошибка Worker: до конца партии используется простой бот.');
    return fallback.decide(state, playerId, legal);
  }
}

async function runFullGame(numPlayers, deckSize, throwInPolicy, botOptions={}, generation=localGeneration){
  const level=normalizeBotLevel(botOptions.level);
  const explain=botOptions.explain===true;
  const players=Array.from({length:numPlayers},(_,i)=>({id:`p${i+1}`, name:`Игрок ${i+1}`}));
  const game=new RecordingGame(players, {numPlayers, deckSize, throwInPolicy});
  const brains=new Map();
  try {
    for(const p of game.players){
      brains.set(p.id, localBrain(game, p.id, level, {explain, trace:explain}));
    }
    let safety=0;
    while(game.phase!=='finished' && safety++<8000){
      if(generation!==localGeneration) return null;
      const id=game.currentActorId();
      const legal=game.getLegalActions(id);
      if(!legal.length) break;
      const decision=await localDecision(game, brains, id, legal, generation);
      if(!decision || generation!==localGeneration) return null;
      if(explain) logBotExplanation(game, game.players.find(p=>p.id===id).name, decision);
      applyObservedAction(game, brains, id, decision.action);
      // Also yield in simple/fallback games; Promise microtasks alone don't paint.
      if(safety%20===0) await new Promise(resolve=>setTimeout(resolve,0));
    }
    return game;
  } finally { releaseBrains(brains); }
}

/* ============ Интерактивный режим: игрок против ботов ============ */

const HUMAN_ID = 'p1';
let igame = null;          // текущая партия в интерактивном режиме
let botTimer = null;       // таймер хода бота
let interactiveBusy = false;
// Карта, по которой игрок кликнул и для которой доступны сразу два действия —
// «отбиться» и «перевести» (issue #22: козырь того же ранга, что и карта на
// столе). Пока она выставлена, в панели действий показываем явный выбор.
let pendingChoiceCard = null;
// По «мозгу» на каждого бота (issue #38): мозг умного бота держит память о партии,
// поэтому он должен жить столько же, сколько партия, и сбрасываться на новой.
// Ключ — id игрока-бота, значение — объект из createBotBrain().
let botBrains = new Map();
// Настройки ботов, с которыми запущена ТЕКУЩАЯ партия (issue #39): { level, explain }.
// Уровень фиксируется на старте партии: смена селектора посреди игры её не трогает
// (у умного бота уже накоплена память), а применяется со следующей — по «Новая партия».
let activeBotSettings = null;

function sameCard(a,b){ return !!a && !!b && a.suit===b.suit && a.rank===b.rank; }

// Уровень ботов, выбранный в настройках СЕЙЧАС — для следующей партии.
// Уже идущая партия берёт уровень из activeBotSettings и от селектора не зависит.
function currentBotLevel(){
  const sel=document.getElementById('botLevel');
  return normalizeBotLevel(sel ? sel.value : DEFAULT_BOT_LEVEL);
}

// Галочка «боты объясняют свои ходы в логе». По умолчанию выключена (решение заказчика, #29).
function botExplainEnabled(){
  const cb=document.getElementById('botExplain');
  return !!(cb && cb.checked);
}

// Подсказка «изменение применится со следующей партии» — показывается, пока настройки
// в панели расходятся с теми, с которыми идёт текущая партия.
function updateBotSettingsHint(){
  const hint=document.getElementById('botSettingsHint');
  if(!hint) return;
  let show=false;
  if(activeBotSettings && (mode==='view' || mode==='interactive')){
    const levelChanged=currentBotLevel()!==activeBotSettings.level;
    // В игре против ботов галочку можно включить посреди партии — она действует сразу.
    // А партия режима просмотра проигрывается целиком при создании, там ждёт новой.
    const explainChanged=mode==='view' && botExplainEnabled()!==activeBotSettings.explain;
    show=levelChanged || explainChanged;
  }
  hint.classList.toggle('hidden', !show);
}

// Первая буква с маленькой: «Подкидываю …» -> «подкидываю …» (в логе после «Бот 2:»).
// Аббревиатуры («ИИ …») не трогаем.
function lowerFirst(text){
  if(!text || /^[A-ZА-ЯЁ]{2}/.test(text)) return text;
  return text.charAt(0).toLowerCase()+text.slice(1);
}

// Текст записи лога с объяснением хода бота (issue #39):
//   🤖 Бот 2: подкидываю 9♦ — у соперника 1 карта, и 9♦ он по моим подсчётам не бьёт
//      └ расклад: эндшпиль, колода пуста, соперник держит K♠, 9♦
// reason/analysis приходят из «мозга» как есть — в них уже только то, что бот знает.
function formatBotExplanation(botName, decision){
  const reason=decision && typeof decision.reason==='string' ? decision.reason.trim().replace(/[.\s]+$/,'') : '';
  if(!reason) return null;
  let text=`🤖 ${botName}: ${lowerFirst(reason)}`;
  const analysis=decision.analysis && typeof decision.analysis==='string' ? decision.analysis.trim() : '';
  if(analysis) text+=`\n   └ расклад: ${analysis}`;
  // Local diagnostics only: trace contains metadata, never hands/search positions.
  const trace=decision.decisionTrace;
  if(trace) text+=`\n   └ диагностика: ${JSON.stringify(trace)}`;
  return text;
}

// Дописывает объяснение в лог партии. Идёт через game._log, как и события движка, поэтому
// строка попадает и в game.log (его рисуют renderFullLog / renderInteractiveLog), и в
// snapshots — индексы лога и шагов просмотра остаются согласованы.
function logBotExplanation(game, botName, decision){
  // Same accepted-action sequence as the engine's public observations; human
  // actions count too. Explanations are logged immediately before this action.
  if(decision.decisionTrace) decision.decisionTrace.actionId=(game.publicTransition?.actionNumber || 0)+1;
  const text=formatBotExplanation(botName, decision);
  if(text) game._log(text);
}

// Мозг бота на текущую партию. explain:true — мозг всегда УМЕЕТ объяснять, а писать ли
// это в лог, решает галочка botExplain в момент хода (см. scheduleBotStep). Так галочку
// можно включить и посреди партии, не пересоздавая мозг и не теряя его память.
function makeBotBrain(game, playerId){
  const level=activeBotSettings ? activeBotSettings.level : currentBotLevel();
return localBrain(game, playerId, level, { explain:true, trace:true });
}

// Создать мозги ботам на новую партию. Человек (индекс 0) мозга не получает.
function resetBotBrains(game){
  botBrains = new Map();
  activeBotSettings = { level: currentBotLevel(), explain: botExplainEnabled() };
  updateBotSettingsHint();
  if(!game) return;
  game.players.forEach((p,i)=>{
    if(i===0) return;
    botBrains.set(p.id, makeBotBrain(game, p.id));
  });
}

// Мозг конкретного бота; если его почему-то нет (партия из старого состояния) — создаём на лету.
function brainFor(game, playerId){
  let brain=botBrains.get(playerId);
  if(!brain){
    brain=makeBotBrain(game, playerId);
    botBrains.set(playerId, brain);
  }
  return brain;
}

function startInteractiveGame(){
  cancelLocalBots();
  pendingChoiceCard = null;
  const numPlayers=Number(document.getElementById('numPlayers').value);
  const deckSize=Number(document.getElementById('deckSize').value);
  const throwInPolicy=document.getElementById('throwInPolicy').value;
  const players=Array.from({length:numPlayers},(_,i)=>({id:`p${i+1}`, name: i===0 ? 'Вы' : `Бот ${i+1}`}));
  igame=new RecordingGame(players, {numPlayers, deckSize, throwInPolicy});
  resetBotBrains(igame);
  renderInteractive();
  scheduleBotStep();
}

function stopBotTimer(){
  if(botTimer){ clearTimeout(botTimer); botTimer=null; }
}

// Чей сейчас ход (индекс игрока), по текущей фазе движка.
function currentTurnIndex(game){
  if(game.phase==='finished') return -1;
  if(game.phase==='defender-to-act') return game.defenderIndex;
  if(game.phase==='need-attack'){
    if(game.throwInQueue.length===0) return -1;
    return game.throwInQueue[game.throwInQueuePos];
  }
  return -1;
}

function scheduleBotStep(){
  stopBotTimer();
  if(!igame || igame.phase==='finished') {
    interactiveBusy=false;
    releaseBrains(botBrains);
    renderInteractive(); return;
  }
  const turnIdx=currentTurnIndex(igame);
  if(turnIdx===-1){ renderInteractive(); return; }
  const turnPlayer=igame.players[turnIdx];
  if(turnIdx===0 || turnPlayer.out){
    interactiveBusy=false;
    renderInteractive();
    return;
  }
  interactiveBusy=true;
  renderInteractive();
  const generation=localGeneration;
  const currentGame=igame;
  const brains=botBrains;
  botTimer=setTimeout(async ()=>{
    botTimer=null;
    if(generation!==localGeneration || currentGame!==igame) return;
    const legal=currentGame.getLegalActions(turnPlayer.id);
    if(legal.length===0){ interactiveBusy=false; scheduleBotStep(); return; }
    brainFor(currentGame, turnPlayer.id);
    const decision=await localDecision(currentGame, brains, turnPlayer.id, legal, generation);
    if(!decision || generation!==localGeneration || currentGame!==igame) return;
    if(botExplainEnabled()) logBotExplanation(currentGame, turnPlayer.name, decision);
    applyObservedAction(currentGame, brains, turnPlayer.id, decision.action);
    interactiveBusy=false;
    scheduleBotStep();
  }, 550);
}

function doHumanAction(action){
  if(!igame || interactiveBusy) return;
  if(!action) return;
  pendingChoiceCard=null;
  const legal=igame.getLegalActions(HUMAN_ID);
  // Раньше для transfer/take/pass сравнение падало в "return true" и брало
  // первое попавшееся действие нужного типа из списка — из-за этого клик по
  // любой карте для перевода фактически переводил не ту карту (часто козырь),
  // т.к. порядок legal-действий не совпадает с порядком карт на экране.
  // _actionsEqual уже умеет корректно сравнивать действия по картам (в т.ч.
  // transfer по полному набору карт) — используем ту же проверку, что и applyAction.
  const match=legal.find(a=>igame._actionsEqual(a,action));
  if(!match) return;
  applyObservedAction(igame, botBrains, HUMAN_ID, match);
  scheduleBotStep();
}

