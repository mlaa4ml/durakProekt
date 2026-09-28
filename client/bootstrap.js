document.getElementById('newGameBtn').addEventListener('click', ()=>{
  if(mode==='view'){ stop(); buildGame(); } else { startInteractiveGame(); }
  showGame();
});
document.getElementById('showAll').addEventListener('change', ()=>{
  if(mode==='view') render(); else renderInteractive();
});
// Движок (тот же, что на сервере) не начнёт партию, если колоды не хватает на раздачу по
// handSize карт каждому: например, 5–6 игроков не садятся за колоду на 24 карты. Поэтому
// такие варианты в списке колод блокируем, а выбранный недопустимый — заменяем на ближайший.
function syncDeckWithPlayers(){
  const players=Number(document.getElementById('numPlayers').value);
  const deck=document.getElementById('deckSize');
  const need=players*DEFAULT_RULES.handSize;
  let firstOk=null;
  for(const opt of deck.options){
    const ok=Number(opt.value)>=need;
    opt.disabled=!ok;
    opt.title=ok?'':`Не хватит карт: ${players} игроков × ${DEFAULT_RULES.handSize} = ${need}`;
    if(ok && firstOk===null) firstOk=opt.value;
  }
  if(Number(deck.value)<need && firstOk!==null) deck.value=firstOk;
}
document.getElementById('numPlayers').addEventListener('change', syncDeckWithPlayers);
syncDeckWithPlayers();

// Уровень ботов и объяснения (issue #39): сами по себе игру не перезапускают — только
// показывают/прячут подсказку «применится со следующей партии».
document.getElementById('botLevel').addEventListener('change', updateBotSettingsHint);
document.getElementById('botExplain').addEventListener('change', updateBotSettingsHint);
document.getElementById('trumpSide').addEventListener('change', ()=>{
  if(mode==='view') render();
  else if(mode==='interactive') renderInteractive();
  else if(netGameStarted) renderNetwork();
});

// Раскладка карт на столе на мобильном (скролл вбок / перенос вниз).
// Применяется сразу же, без пересдачи — это просто настройка отображения.
(function initTableLayoutPref(){
  const sel = document.getElementById('tableLayoutMobile');
  const board = document.getElementById('tableBoard');
  const KEY = 'durak.tableLayoutMobile';
  const saved = localStorage.getItem(KEY);
  if(saved === 'scroll' || saved === 'wrap') sel.value = saved;
  function apply(){
    board.classList.remove('layout-scroll','layout-wrap');
    board.classList.add('layout-' + sel.value);
    localStorage.setItem(KEY, sel.value);
  }
  sel.addEventListener('change', apply);
  apply();
})();
document.getElementById('groupHandToggle').addEventListener('change', ()=>{
  updateTrumpSideRowVisibility();
  if(mode==='view') render();
  else if(mode==='interactive') renderInteractive();
  else if(netGameStarted) renderNetwork();
});
updateTrumpSideRowVisibility();
document.getElementById('modeViewBtn').addEventListener('click', ()=> setMode('view'));
document.getElementById('modeInteractiveBtn').addEventListener('click', ()=> setMode('interactive'));
document.getElementById('modeNetworkBtn').addEventListener('click', ()=> setMode('network'));

document.getElementById('netConnectBtn').addEventListener('click', netConnect);
document.getElementById('netRefreshRoomsBtn').addEventListener('click', ()=> netSend({type:'listRooms'}));
document.getElementById('netCreateRoomBtn').addEventListener('click', ()=>{
  netSend({
    type:'createRoom',
    label: document.getElementById('netCreateLabel').value,
    name: document.getElementById('netCreateName').value,
    numPlayers: Number(document.getElementById('netCreateNumPlayers').value),
    deckSize: Number(document.getElementById('netCreateDeckSize').value),
    throwInPolicy: document.getElementById('netCreateThrowIn').value,
  });
});
document.getElementById('netJoinRoomBtn').addEventListener('click', ()=>{
  netSend({type:'join', roomId: document.getElementById('netJoinRoomId').value.trim().toUpperCase(), name: document.getElementById('netJoinName').value});
});
document.getElementById('netLeaveBtn').addEventListener('click', ()=> netSend({type:'leave'}));
document.getElementById('netFillWithBotsBtn').addEventListener('click', ()=> netSend({type:'fillWithBots'}));
document.getElementById('netForgetBtn').addEventListener('click', netClearSession);
document.getElementById('netRejoinBtn').addEventListener('click', ()=>{
  const s=netLoadSession();
  if(!s) return;
  document.getElementById('netWsUrl').value=s.wsUrl;
  const doRejoin=()=> netSend({type:'rejoin', roomId:s.roomId, playerId:s.playerId});
  if(netWs && netWs.readyState===WebSocket.OPEN){ doRejoin(); return; }
  netConnect();
  const check=setInterval(()=>{
    if(netWs && netWs.readyState===WebSocket.OPEN){ clearInterval(check); doRejoin(); }
  }, 100);
  setTimeout(()=>clearInterval(check), 5000);
});
netUpdateSessionUI();
document.getElementById('btnFirst').addEventListener('click', ()=>{ stop(); cursor=0; render(); });
document.getElementById('btnLast').addEventListener('click', ()=>{ stop(); cursor=game.snapshots.length-1; render(); });
document.getElementById('btnPrev').addEventListener('click', ()=>{ stop(); cursor=Math.max(0,cursor-1); render(); });
document.getElementById('btnNext').addEventListener('click', ()=>{ stop(); cursor=Math.min(game.snapshots.length-1,cursor+1); render(); });
document.getElementById('scrubber').addEventListener('input', (e)=>{ stop(); cursor=Number(e.target.value); render(); });
document.getElementById('btnPlay').addEventListener('click', ()=>{
  if(playTimer){ stop(); return; }
  document.getElementById('btnPlay').textContent='⏸';
  playTimer=setInterval(()=>{
    if(cursor>=game.snapshots.length-1){ stop(); return; }
    cursor++; render();
  }, Number(document.getElementById('speed').value));
});

if (window.matchMedia('(max-width: 680px)').matches) {
  const sp = document.getElementById('settingsPanel');
  if (sp) sp.open = false;
}

/* ============ Тема (светлая/тёмная/системная) ============ */
function applyTheme(pref){
  if(pref==='light' || pref==='dark') document.documentElement.setAttribute('data-theme', pref);
  else document.documentElement.removeAttribute('data-theme');
}
(function initTheme(){
  const saved = localStorage.getItem('durak-theme') || 'system';
  const sel = document.getElementById('themeSelect');
  if(sel) sel.value = saved;
  applyTheme(saved);
  sel?.addEventListener('change', e=>{
    localStorage.setItem('durak-theme', e.target.value);
    applyTheme(e.target.value);
  });
})();

/* ============ Показ полного лога на экране стола ============ */
function applyLogVisible(on){
  document.getElementById('logBlock').classList.toggle('hidden', !on);
}
(function initLogToggle(){
  const cb = document.getElementById('showLogToggle');
  const saved = localStorage.getItem('durak-show-log');
  // на телефоне по умолчанию прячем лог (занимает много места ниже стола),
  // на десктопе — показываем; если пользователь уже выбирал сам, берём его выбор
  const on = saved!==null ? saved==='1' : !window.matchMedia('(max-width: 680px)').matches;
  cb.checked = on;
  applyLogVisible(on);
  cb.addEventListener('change', e=>{
    localStorage.setItem('durak-show-log', e.target.checked ? '1' : '0');
    applyLogVisible(e.target.checked);
  });
})();

/* ============ Размер карт игрока внизу (подбирается прямо во время игры) ============ */
(function initHandSize(){
  const range = document.getElementById('handSizeRange');
  const valueLabel = document.getElementById('handSizeValue');
  const KEY = 'durak.handScale';
  function apply(scale, persist){
    document.documentElement.style.setProperty('--hand-scale', String(scale));
    valueLabel.textContent = Math.round(scale * 100) + '%';
    // ширина/высота карт меняются мгновенно через CSS-переменную, но веер
    // руки (--tx/--ty/--tr) расставлен в px по факту замера карты, поэтому
    // пересчитываем раскладку руки сразу же, без пересдачи и без ререндера
    // остального стола.
    layoutHandArc(document.getElementById('myHand'));
    if(persist) localStorage.setItem(KEY, String(scale));
  }
  const saved = parseFloat(localStorage.getItem(KEY));
  const initial = Number.isFinite(saved) && saved >= parseFloat(range.min) && saved <= parseFloat(range.max) ? saved : 1;
  range.value = String(initial);
  apply(initial, false);
  range.addEventListener('input', ()=> apply(parseFloat(range.value), true));
})();

// ?botLevel=smart в адресе выставляет селектор при загрузке — удобно для ручной проверки
// (так уровень задавался на этапе 4, до появления селектора).
(function initBotLevelFromUrl(){
  try{
    const q=new URLSearchParams(location.search);
    const fromUrl=q.get('botLevel')||q.get('bot');
    if(fromUrl) document.getElementById('botLevel').value=normalizeBotLevel(fromUrl);
  }catch(e){ /* location недоступен — остаётся уровень по умолчанию */ }
})();

buildGame();
showSetup();
