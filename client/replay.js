let game=null, cursor=0, playTimer=null;

function setReplayEnabled(enabled){
  for(const id of ['btnFirst','btnLast','btnPrev','btnNext','btnPlay','scrubber']){
    document.getElementById(id).disabled=!enabled;
  }
}

async function buildGame(){
  stop();
  cancelLocalBots();
  game=null;
  setReplayEnabled(false);
  const generation=localGeneration;
  const numPlayers=Number(document.getElementById('numPlayers').value);
  const deckSize=Number(document.getElementById('deckSize').value);
  const throwInPolicy=document.getElementById('throwInPolicy').value;
  const botOptions={ level: currentBotLevel(), explain: botExplainEnabled() };
  activeBotSettings={ ...botOptions };
  document.getElementById('eventDesc').textContent='Боты играют… Можно начать новую партию, чтобы отменить.';
  const completed=await runFullGame(numPlayers, deckSize, throwInPolicy, botOptions, generation);
  if(!completed || generation!==localGeneration) return;
  game=completed;
  updateBotSettingsHint();
  cursor=0;
  document.getElementById('scrubber').max=String(game.snapshots.length-1);
  document.getElementById('scrubber').value='0';
  renderFullLog();
  render();
}

function renderFullLog(){
  const box=document.getElementById('fullLog');
  box.innerHTML = game.log.map((line,i)=>`<span data-i="${i}">${i===cursor?'<span class="cur">'+line+'</span>':line}</span>`).join('\n');
}

function render(){
  if(!game || !game.snapshots.length) return;
  setReplayEnabled(true);
  const snap = game.snapshots[cursor].state;
  const desc = game.snapshots[cursor].description;
  const showAll = document.getElementById('showAll').checked;
  const viewerId = showAll ? null : snap.players[0].id;

  document.getElementById('eventDesc').textContent = desc;
  document.getElementById('stepCounter').textContent = `шаг ${cursor+1} / ${game.snapshots.length}`;
  document.getElementById('scrubber').value = String(cursor);

  const attackerName = snap.players[snap.attackerIndex]?.name;
  const defenderName = snap.players[snap.defenderIndex]?.name;
  renderStatusHud({
    finished: snap.finished,
    durakName: snap.durak ? snap.players.find(p=>p.id===snap.durak)?.name : null,
    attackerName, defenderName,
    trumpSuit: snap.trumpSuit,
    talonCount: snap.talonCount,
    discardCount: snap.discardCount,
    stall: snap.stall,
  });
  markYourTurn(false); // режим просмотра ботов — «вашего хода» здесь не бывает

  // opponents = все, кроме первого игрока (используем первого как "мою" позицию для примера)
  const oppBox=document.getElementById('opponents');
  oppBox.innerHTML='';
  oppBox.dataset.count = String(snap.players.length-1);
  snap.players.slice(1).forEach((p,i)=>{
    const realIdx=i+1;
    const wrap=document.createElement('div'); wrap.className=oppWrapClass(i, snap.players.length-1, p.out);
    const label=document.createElement('div'); label.className='label';
    label.textContent = p.name;
    wrap.appendChild(label);
    appendRoleRow(wrap, roleTagsHtml(realIdx===snap.attackerIndex, realIdx===snap.defenderIndex, false));
    const faceUp = showAll;
    renderOppHandArea(wrap, p.hand.length, faceUp, p.hand, snap.trumpSuit);
    if(p.out){ const b=document.createElement('div'); b.className='finish-badge'; b.textContent=`место ${p.finishRank}`; wrap.appendChild(b); }
    else { const cnt=document.createElement('div'); cnt.className='finish-badge'; cnt.textContent=`${p.hand.length} карт`; wrap.appendChild(cnt); }
    oppBox.appendChild(wrap);
  });

  // talon
  const talonStack=document.getElementById('talonStack');
  talonStack.innerHTML='';
  const stackDepth = Math.min(4, Math.ceil(snap.talonCount/6));
  for(let i=0;i<Math.max(stackDepth, snap.talonCount>0?1:0); i++){
    const b=document.createElement('div'); b.className='card-back';
    b.style.position='absolute'; b.style.left=(i*2)+'px'; b.style.top=(i*2)+'px';
    talonStack.appendChild(b);
  }
  if(snap.talonCount>0){
    const peek=document.createElement('div'); peek.className='trump-peek';
    peek.appendChild(cardEl(snap.trumpCard, true));
    talonStack.appendChild(peek);
  }
  document.getElementById('talonCount').textContent = snap.talonCount>0 ? `в колоде: ${snap.talonCount}` : 'колода пуста';

  // trick area
  const trickArea=document.getElementById('trickArea');
  trickArea.innerHTML='';
  trickArea.classList.toggle('taking-cards', snap.tableGoingToDefender===true);
  if(snap.tableGoingToDefender){
    const label=document.createElement('div'); label.className='taking-label';
    label.textContent=`→ забирает ${defenderName}`;
    trickArea.appendChild(label);
  }
  if(snap.table.length===0){
    trickArea.innerHTML += '<span style="font-family:var(--mono);font-size:11px;opacity:.5;">стол пуст</span>';
  }
  snap.table.forEach(t=>{
    const pair=document.createElement('div'); pair.className='trick-pair';
    const a=cardEl(t.attack,true); a.classList.add('attack-card'); a.style.transform='rotate(-6deg)';
    pair.appendChild(a);
    if(t.defense){ const d=cardEl(t.defense,true); d.classList.add('defense-card'); d.style.transform='rotate(8deg)'; pair.appendChild(d); }
    trickArea.appendChild(pair);
  });

  // discard
  document.getElementById('discardPile').textContent = snap.discardCount>0 ? `${snap.discardCount}` : '—';

  // my hand (viewer = player 1, if showAll off; if showAll on we still show p1 as "hand" for concreteness)
  const me = snap.players[0];
  document.getElementById('myHandLabel').textContent =
    `${me.name}${0===snap.attackerIndex?' — атакует':''}${0===snap.defenderIndex?' — защищается':''}`;
  const myHandBox=document.getElementById('myHand');
  myHandBox.innerHTML='';
  sortHandForDisplay(me.hand, snap.trumpSuit).forEach(c=> myHandBox.appendChild(cardEl(c,true)) );
  layoutHandArc(myHandBox);

  renderFullLog();

  document.getElementById('btnPrev').disabled = cursor<=0;
  document.getElementById('btnFirst').disabled = cursor<=0;
  document.getElementById('btnNext').disabled = cursor>=game.snapshots.length-1;
  document.getElementById('btnLast').disabled = cursor>=game.snapshots.length-1;
}

function stop(){ if(playTimer){ clearInterval(playTimer); playTimer=null; document.getElementById('btnPlay').textContent='▶'; } }

