function renderNetwork(){
  if(!netLastState) return;
  const st=netLastState;
  const you=st.players.find(p=>p.id===netPlayerId);
  const finished=st.finished;
  const attacker=netLastPlayers.find(p=>p.id===st.attacker);
  const defender=netLastPlayers.find(p=>p.id===st.defender);

  renderStatusHud({
    finished,
    durakName: st.durak ? ((netLastPlayers.find(p=>p.id===st.durak)||{}).name || st.durak) : null,
    attackerName: attacker?.name, defenderName: defender?.name,
    trumpSuit: st.trumpSuit,
    talonCount: st.talonCount,
    discardCount: st.discardCount,
    stall: st.stall,
  });
  document.getElementById('eventDesc').textContent='';
  document.getElementById('stepCounter').textContent='';

  const oppBox=document.getElementById('opponents');
  oppBox.innerHTML='';
  oppBox.dataset.count = String(st.players.length-1);
  st.players.filter(p=>p.id!==netPlayerId).forEach((p,seatIdx)=>{
    const rosterInfo=netLastPlayers.find(rp=>rp.id===p.id) || {};
    const wrap=document.createElement('div'); wrap.className=oppWrapClass(seatIdx, st.players.length-1, p.out);
    const label=document.createElement('div'); label.className='label';
    label.innerHTML = `${p.name}`+
      (rosterInfo.connected===false?' <span class="net-roster-flag offline">офлайн</span>':'')+
      (rosterInfo.botControlled?' <span class="net-roster-flag bot">бот вместо игрока</span>':'');
    wrap.appendChild(label);
    appendRoleRow(wrap, roleTagsHtml(p.id===st.attacker, p.id===st.defender, false));
    // Сервер намеренно не присылает чужие карты — всегда рисуем компактный
    // счётчик, настоящих карт здесь в принципе нет.
    renderOppHandArea(wrap, p.handCount, false, null, null);
    if(p.out){ const b=document.createElement('div'); b.className='finish-badge'; b.textContent=`место ${p.finishRank}`; wrap.appendChild(b); }
    else { const cnt=document.createElement('div'); cnt.className='finish-badge'; cnt.textContent=`${p.handCount} карт`; wrap.appendChild(cnt); }
    oppBox.appendChild(wrap);
  });

  const talonStack=document.getElementById('talonStack');
  talonStack.innerHTML='';
  const stackDepth=Math.min(4, Math.ceil(st.talonCount/6));
  for(let i=0;i<Math.max(stackDepth, st.talonCount>0?1:0); i++){
    const b=document.createElement('div'); b.className='card-back';
    b.style.position='absolute'; b.style.left=(i*2)+'px'; b.style.top=(i*2)+'px';
    talonStack.appendChild(b);
  }
  if(st.talonCount>0 && st.trumpCard){
    const peek=document.createElement('div'); peek.className='trump-peek';
    peek.appendChild(cardEl(st.trumpCard, true));
    talonStack.appendChild(peek);
  }
  document.getElementById('talonCount').textContent = st.talonCount>0 ? `в колоде: ${st.talonCount}` : 'колода пуста';

  const trickArea=document.getElementById('trickArea');
  trickArea.innerHTML='';
  trickArea.classList.toggle('taking-cards', st.tableGoingToDefender===true);
  if(st.tableGoingToDefender){
    const label=document.createElement('div'); label.className='taking-label';
    label.textContent=`→ забирает ${defender?.name||'?'}`;
    trickArea.appendChild(label);
  }
  if(st.table.length===0){
    trickArea.innerHTML+='<span style="font-family:var(--mono);font-size:11px;opacity:.5;">стол пуст</span>';
  }
  st.table.forEach(t=>{
    const pair=document.createElement('div'); pair.className='trick-pair';
    const a=cardEl(t.attack,true); a.classList.add('attack-card'); a.style.transform='rotate(-6deg)';
    pair.appendChild(a);
    if(t.defense){ const d=cardEl(t.defense,true); d.classList.add('defense-card'); d.style.transform='rotate(8deg)'; pair.appendChild(d); }
    trickArea.appendChild(pair);
  });

  document.getElementById('discardPile').textContent = st.discardCount>0 ? `${st.discardCount}` : '—';

  document.getElementById('myHandLabel').textContent =
    `${you?.name||'Вы'}${netPlayerId===st.attacker?' — атакует':''}${netPlayerId===st.defender?' — защищается':''}`;
  const myHandBox=document.getElementById('myHand');
  myHandBox.innerHTML='';
  const isMyTurn = !finished && netLastLegal.length>0;
  const netSingleTransfers=netLastLegal.filter(a=>a.type==='transfer' && a.cards.length===1);
  const netComboTransfer=netLastLegal.find(a=>a.type==='transfer' && a.cards.length>1);
  const netDefends=netLastLegal.filter(a=>a.type==='defend');
  // Тот же выбор «отбиться / перевести», что и в игре против ботов (issue #22).
  if(netPendingChoiceCard){
    const stillDual = netDefends.some(a=>sameCard(a.card,netPendingChoiceCard))
      && netSingleTransfers.some(a=>sameCard(a.cards[0],netPendingChoiceCard));
    if(!isMyTurn || !stillDual) netPendingChoiceCard=null;
  }
  (sortHandForDisplay(you?.hand||[], st.trumpSuit)).forEach(c=>{
    const el=cardEl(c,true);
    let matched=null, isTransfer=false, isDual=false;
    if(isMyTurn){
      const defendA=netDefends.find(a=>sameCard(a.card,c));
      const transferA=netSingleTransfers.find(a=>sameCard(a.cards[0],c));
      if(defendA && transferA){
        isDual=true;
        el.classList.add('playable','dual-action');
        if(sameCard(netPendingChoiceCard,c)) el.classList.add('choice-pending');
        el.title='Можно отбиться или перевести — нажмите, чтобы выбрать';
        el.addEventListener('click', ()=>{
          netPendingChoiceCard = sameCard(netPendingChoiceCard,c) ? null : {suit:c.suit, rank:c.rank};
          renderNetwork();
        });
      } else {
        matched = netLastLegal.find(a=>a.type==='attack' && sameCard(a.card,c)) || defendA || null;
        if(!matched && transferA){ matched=transferA; isTransfer=true; }
      }
    }
    if(matched){
      el.classList.add('playable');
      if(isTransfer) el.classList.add('transferable');
      el.addEventListener('click', ()=> netSend({type:'action', action:matched}));
    } else if(!isDual && isMyTurn){
      el.classList.add('unplayable');
    }
    myHandBox.appendChild(el);
  });
  layoutHandArc(myHandBox);

  const actionBar=document.getElementById('actionBar');
  actionBar.innerHTML='';
  if(isMyTurn){
    const takeAction=netLastLegal.find(a=>a.type==='take');
    const passAction=netLastLegal.find(a=>a.type==='pass');
    if(netPendingChoiceCard){
      const defendA=netDefends.find(a=>sameCard(a.card,netPendingChoiceCard));
      const transferA=netSingleTransfers.find(a=>sameCard(a.cards[0],netPendingChoiceCard));
      const lbl=document.createElement('span'); lbl.className='choice-label';
      lbl.textContent=`${cardToString(netPendingChoiceCard)} —`;
      actionBar.appendChild(lbl);
      const dBtn=document.createElement('button'); dBtn.className='defend'; dBtn.textContent='Отбиться';
      dBtn.addEventListener('click', ()=>{ netPendingChoiceCard=null; netSend({type:'action',action:defendA}); });
      actionBar.appendChild(dBtn);
      const tBtn=document.createElement('button'); tBtn.className='transfer'; tBtn.textContent='Перевести';
      tBtn.addEventListener('click', ()=>{ netPendingChoiceCard=null; netSend({type:'action',action:transferA}); });
      actionBar.appendChild(tBtn);
      const cBtn=document.createElement('button'); cBtn.className='cancel'; cBtn.textContent='Отмена';
      cBtn.addEventListener('click', ()=>{ netPendingChoiceCard=null; renderNetwork(); });
      actionBar.appendChild(cBtn);
    }
    if(netComboTransfer){ const btn=document.createElement('button'); btn.className='transfer'; btn.textContent=`Перевести оба (${netComboTransfer.cards.length})`; btn.addEventListener('click',()=>netSend({type:'action',action:netComboTransfer})); actionBar.appendChild(btn); }
    if(takeAction){ const btn=document.createElement('button'); btn.className='take'; btn.textContent='Взять карты'; btn.addEventListener('click',()=>netSend({type:'action',action:takeAction})); actionBar.appendChild(btn); }
    if(passAction){ const btn=document.createElement('button'); btn.className='pass'; btn.textContent = st.phase==='need-attack' ? 'Пас (не подкидываю)' : 'Пас'; btn.addEventListener('click',()=>netSend({type:'action',action:passAction})); actionBar.appendChild(btn); }
  }

  const hintBox=document.getElementById('turnHint');
  if(finished){
    hintBox.textContent='Партия завершена. Можно выйти в лобби и сыграть ещё раз.';
  } else if(isMyTurn){
    hintBox.textContent = st.phase==='defender-to-act' ? 'Ваш ход: отбейтесь картой, переведите или заберите карты.' : 'Ваш ход: подкиньте карту или пасуйте.';
  } else {
    hintBox.textContent = 'Ждём ход соперника…';
  }
  markYourTurn(isMyTurn);

  const logBox=document.getElementById('fullLog');
  logBox.textContent = netLastLog.join('\n'); // сервер шлёт только хвост лога (последние 20 строк)
}

