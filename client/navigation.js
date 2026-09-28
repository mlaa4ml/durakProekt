/* ============ Переключение режимов ============ */

let mode='view'; // 'view' | 'interactive' | 'network'

/* ============ Переключение «настройки» / «стол» ============ */
const MODE_LABELS = {view:'просмотр ботов', interactive:'игра против ботов', network:'игра по сети'};
function hasActiveGame(){
  if(mode==='view') return !!game;
  if(mode==='interactive') return !!igame;
  if(mode==='network') return netGameStarted;
  return false;
}
function updateResumeButton(){
  document.getElementById('resumeGameBtn').classList.toggle('hidden', !hasActiveGame());
}
function showSetup(){
  updateResumeButton(); // состояние партии могло измениться, пока экран настроек был скрыт (боты продолжают ходить)
  document.getElementById('setupScreen').classList.remove('hidden');
  document.getElementById('gameScreen').classList.add('hidden');
}
function showGame(){
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('gameScreen').classList.remove('hidden');
  document.getElementById('gameModeLabel').textContent = MODE_LABELS[mode] || '';
  // пока экран был скрыт (display:none), замеры карт возвращали 0 — пересчитываем дугу заново
  layoutHandArc(document.getElementById('myHand'));
}
document.getElementById('backToSetupBtn').addEventListener('click', showSetup);
document.getElementById('resumeGameBtn').addEventListener('click', ()=>{ if(hasActiveGame()) showGame(); });

function setMode(newMode){
  if(mode===newMode) return;
  mode=newMode;
  stop(); // остановить автопроигрывание режима просмотра, если шло
  cancelLocalBots();
  document.getElementById('modeViewBtn').classList.toggle('active', mode==='view');
  document.getElementById('modeInteractiveBtn').classList.toggle('active', mode==='interactive');
  document.getElementById('modeNetworkBtn').classList.toggle('active', mode==='network');
  document.getElementById('viewTransport').classList.toggle('hidden', mode!=='view');
  document.getElementById('scrubber').classList.toggle('hidden', mode!=='view');
  document.getElementById('localControls').classList.toggle('hidden', mode==='network');
  document.getElementById('localControlsBtn').classList.toggle('hidden', mode==='network');
  document.getElementById('networkStatusBar').classList.toggle('hidden', mode!=='network');
  netUpdatePanels(); // прячет/показывает блок «Подключение к серверу» — актуально при ЛЮБОМ переключении режима, не только при входе в сетевой
  document.getElementById('footerNote').textContent = mode==='view'
    ? 'Ходят боты друг против друга — это инструмент проверки правил, не финальный интерфейс.'
    : mode==='interactive'
    ? 'Вы играете за «Вы» (первый игрок), остальные — боты. Переключатель «показать все карты» оставляет карты ботов открытыми — удобно для поиска багов в правилах.'
    : 'Партия идёт на отдельном сервере — карты соперников вам не видны, только их количество.';
  if(mode==='view'){ buildGame(); showGame(); }
  else if(mode==='interactive'){ startInteractiveGame(); showGame(); }
  else { if(netGameStarted){ renderNetwork(); showGame(); } else showSetup(); }
}

