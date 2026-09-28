/* ============ Сетевой режим: игра через WebSocket-сервер ============ */

const NET_SESSION_KEY = 'durak_visual_net_session';

let netWs = null;
let netPlayerId = null;
let netRoomId = null;
let netInRoom = false;
let netGameStarted = false; // true, когда партия реально началась (пришло первое 'state') — до этого сидим в лобби, ждём соперников
let netLastState = null;
let netLastLegal = [];
let netLastPlayers = [];
let netLastLog = [];
let netWaitingRoom = null; // последний roomUpdate — состав ещё не начавшейся комнаты
let netPendingChoiceCard = null; // карта, для которой ждём выбора «отбиться / перевести» (issue #22)

function netSend(obj){
  if(!netWs || netWs.readyState!==WebSocket.OPEN){ netSetLobbyStatus('нет соединения — сообщение не отправлено'); return; }
  netWs.send(JSON.stringify(obj));
}

function netSetLobbyStatus(text){
  const el=document.getElementById('netLobbyStatus');
  if(el) el.textContent=text;
}

function netUpdateStatusBar(){
  const connected = netWs && netWs.readyState===WebSocket.OPEN;
  document.getElementById('netStatusText').textContent = connected ? 'подключено' : 'не подключено';
  document.getElementById('netRoomText').textContent = netInRoom ? `· комната ${netRoomId}` : '';
  document.getElementById('netLeaveBtn').classList.toggle('hidden', !netInRoom || netGameStarted);
}

function netConnect(){
  const url=document.getElementById('netWsUrl').value.trim();
  if(!url) return;
  if(netWs && (netWs.readyState===WebSocket.OPEN || netWs.readyState===WebSocket.CONNECTING)) return;
  netSetLobbyStatus('подключаюсь…');
  netWs=new WebSocket(url);
  netWs.addEventListener('open', ()=>{ netSetLobbyStatus('подключено'); netUpdateStatusBar(); netSend({type:'listRooms'}); });
  netWs.addEventListener('close', ()=>{ netSetLobbyStatus('соединение закрыто'); netUpdateStatusBar(); });
  netWs.addEventListener('error', ()=>{ netSetLobbyStatus('ошибка соединения'); });
  netWs.addEventListener('message', (ev)=>{ netHandleMessage(JSON.parse(ev.data)); });
}

function netHandleMessage(msg){
  if(msg.type==='error'){ netSetLobbyStatus('Ошибка: '+msg.message); return; }

  if(msg.type==='rooms'){ netRenderRooms(msg.rooms); return; }

  if(msg.type==='joined'){
    netPlayerId=msg.playerId; netRoomId=msg.roomId; netInRoom=true; netGameStarted=false;
    netSaveSession(); netUpdateSessionUI(); netUpdateStatusBar(); netUpdatePanels();
    return;
  }

  if(msg.type==='left'){
    netPlayerId=null; netRoomId=null; netInRoom=false; netGameStarted=false; netLastState=null; netWaitingRoom=null;
    netClearSession(); netUpdateStatusBar(); netUpdatePanels();
    netSend({type:'listRooms'});
    showSetup();
    return;
  }

  if(msg.type==='roomUpdate'){
    netWaitingRoom=msg;
    renderNetWaitingRoom();
    return;
  }

  if(msg.type==='state'){
    netLastState=msg.state; netLastLegal=msg.legalActions||[]; netLastPlayers=msg.players||[]; netLastLog=msg.log||[];
    const wasStarted=netGameStarted;
    netGameStarted=true;
    if(!wasStarted) netUpdatePanels(); // первое состояние партии — переключаем лобби на игровое поле
    if(mode==='network'){ renderNetwork(); showGame(); }
    return;
  }
}

function netRenderRooms(rooms){
  const tbody=document.querySelector('#netRoomsTable tbody');
  tbody.innerHTML='';
  rooms.forEach(r=>{
    const tr=document.createElement('tr');
    const statusText = r.finished ? 'завершена' : r.started ? 'идёт' : 'ждёт игроков';
    tr.innerHTML = `<td>${r.roomId}</td><td>${r.label||'—'}</td><td>${r.seatsFilled}/${r.numPlayers}</td>`+
      `<td>${r.deckSize} карт, ${r.throwInPolicy}, ${statusText}</td><td></td>`;
    if(!r.started){
      const btn=document.createElement('button'); btn.type='button'; btn.textContent='Войти';
      btn.addEventListener('click', ()=>{
        const name=document.getElementById('netJoinName').value.trim() || prompt('Ваше имя?','Игрок') || 'Игрок';
        netSend({type:'join', roomId:r.roomId, name});
      });
      tr.lastElementChild.appendChild(btn);
    }
    tbody.appendChild(tr);
  });
  if(rooms.length===0) tbody.innerHTML='<tr><td colspan="5" class="muted">комнат пока нет</td></tr>';
}

function netSaveSession(){
  if(netRoomId && netPlayerId){
    localStorage.setItem(NET_SESSION_KEY, JSON.stringify({wsUrl:document.getElementById('netWsUrl').value.trim(), roomId:netRoomId, playerId:netPlayerId}));
  }
  netUpdateSessionUI();
}
function netClearSession(){ localStorage.removeItem(NET_SESSION_KEY); netUpdateSessionUI(); }
function netLoadSession(){ try{ return JSON.parse(localStorage.getItem(NET_SESSION_KEY)||'null'); } catch { return null; } }
function netUpdateSessionUI(){
  const s=netLoadSession();
  const box=document.getElementById('netSessionBox');
  if(s){ box.style.display='block'; document.getElementById('netSessionInfo').textContent=`комната ${s.roomId}, сервер ${s.wsUrl}`; }
  else{ box.style.display='none'; }
}

// Показываем либо лобби, либо игровое поле — в зависимости от того, сидим
// ли мы уже в комнате. Сам показ экрана (лобби внутри #setupScreen vs стол
// внутри #gameScreen) уже решают showSetup()/showGame() — здесь только лобби.
function netUpdatePanels(){
  const inNetwork = mode==='network';
  document.getElementById('networkLobby').classList.toggle('hidden', !inNetwork || netGameStarted);
  // Пока сидим в ещё не начавшейся комнате — не нужны список всех комнат и
  // формы создания/входа, вместо них показываем состав своей комнаты.
  document.getElementById('netWaitingRoomBox').classList.toggle('hidden', !netInRoom);
  document.getElementById('netRoomsBox').classList.toggle('hidden', netInRoom);
  document.getElementById('netCreateBox').classList.toggle('hidden', netInRoom);
  document.getElementById('netJoinBox').classList.toggle('hidden', netInRoom);
  if(netInRoom) renderNetWaitingRoom();
  netUpdateStatusBar();
}

function renderNetWaitingRoom(){
  const box=document.getElementById('netWaitingRoomBox');
  if(!netInRoom || !netWaitingRoom){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  document.getElementById('netWaitingRoomTitle').textContent =
    `· код ${netWaitingRoom.roomId}${netWaitingRoom.label?' · '+netWaitingRoom.label:''} · ${netWaitingRoom.seats.length}/${netWaitingRoom.numPlayers}`;
  const tbody=document.querySelector('#netWaitingSeatsTable tbody');
  tbody.innerHTML='';
  netWaitingRoom.seats.forEach((s,i)=>{
    const tr=document.createElement('tr');
    const statusText = s.botControlled ? 'бот' : (s.connected ? 'в сети' : 'подключается…');
    const nameText = s.name + (s.id===netPlayerId ? ' (вы)' : '') + (s.id===netWaitingRoom.hostPlayerId ? ' · создатель' : '');
    tr.innerHTML = `<td>${i+1}</td><td>${nameText}</td><td>${statusText}</td>`;
    tbody.appendChild(tr);
  });
  const free = netWaitingRoom.numPlayers - netWaitingRoom.seats.length;
  const isHost = netPlayerId===netWaitingRoom.hostPlayerId;
  const fillBtn=document.getElementById('netFillWithBotsBtn');
  fillBtn.classList.toggle('hidden', !isHost || free<=0);
  document.getElementById('netWaitingHint').textContent = free<=0
    ? 'все места заняты — партия вот-вот начнётся'
    : isHost
      ? `свободно мест: ${free} — нажмите кнопку, чтобы отдать их ботам и начать сразу`
      : `ждём ещё игроков (свободно: ${free}) — заполнить ботами может только создатель комнаты`;
}

