function renderInteractive(){
  if(!igame) return;
  const showAll=document.getElementById('showAll').checked;
  const finished=igame.phase==='finished';
  const turnIdx=currentTurnIndex(igame);
  const human=igame.players[0];
  const legalForHuman = finished ? [] : igame.getLegalActions(HUMAN_ID);

  // строка статуса
  const attackerName=igame.players[igame.attackerIndex]?.name;
  const defenderName=igame.players[igame.defenderIndex]?.name;
  renderStatusHud({
    finished,
    durakName: igame.durak ? igame.players.find(p=>p.id===igame.durak)?.name : null,
    attackerName, defenderName,
    trumpSuit: igame.trumpSuit,
    talonCount: igame.talon.length,
    discardCount: igame.discardCount,
    stall: igame.getStallInfo(),
  });
  document.getElementById('eventDesc').textContent = igame.log[igame.log.length-1] || '';
  document.getElementById('stepCounter').textContent = '';

  // соперники
  const oppBox=document.getElementById('opponents');
  oppBox.innerHTML='';
  oppBox.dataset.count = String(igame.players.length-1);
  igame.players.slice(1).forEach((p,i)=>{
    const realIdx=i+1;
    const wrap=document.createElement('div'); wrap.className=oppWrapClass(i, igame.players.length-1, p.out);
    const label=document.createElement('div'); label.className='label';
    label.textContent = p.name;
    wrap.appendChild(label);
    appendRoleRow(wrap, roleTagsHtml(realIdx===igame.attackerIndex, realIdx===igame.defenderIndex, realIdx===turnIdx));
    const faceUp = showAll;
    renderOppHandArea(wrap, p.hand.length, faceUp, p.hand, igame.trumpSuit);
    if(p.out){ const b=document.createElement('div'); b.className='finish-badge'; b.textContent=`место ${p.finishRank}`; wrap.appendChild(b); }
    else { const cnt=document.createElement('div'); cnt.className='finish-badge'; cnt.textContent=`${p.hand.length} карт`; wrap.appendChild(cnt); }
    oppBox.appendChild(wrap);
  });

  // прикуп
  const talonStack=document.getElementById('talonStack');
  talonStack.innerHTML='';
  const stackDepth=Math.min(4, Math.ceil(igame.talon.length/6));
  for(let i=0;i<Math.max(stackDepth, igame.talon.length>0?1:0); i++){
    const b=document.createElement('div'); b.className='card-back';
    b.style.position='absolute'; b.style.left=(i*2)+'px'; b.style.top=(i*2)+'px';
    talonStack.appendChild(b);
  }
  if(igame.talon.length>0){
    const peek=document.createElement('div'); peek.className='trump-peek';
    peek.appendChild(cardEl(igame.trumpCard, true));
    talonStack.appendChild(peek);
  }
  document.getElementById('talonCount').textContent = igame.talon.length>0 ? `в колоде: ${igame.talon.length}` : 'колода пуста';

  // стол
  const trickArea=document.getElementById('trickArea');
  trickArea.innerHTML='';
  trickArea.classList.toggle('taking-cards', igame.tookCards===true);
  if(igame.tookCards){
    const label=document.createElement('div'); label.className='taking-label';
    label.textContent=`→ забирает ${igame.players[igame.defenderIndex].name}`;
    trickArea.appendChild(label);
  }
  if(igame.table.length===0){
    trickArea.innerHTML+='<span style="font-family:var(--mono);font-size:11px;opacity:.5;">стол пуст</span>';
  }
  igame.table.forEach(t=>{
    const pair=document.createElement('div'); pair.className='trick-pair';
    const a=cardEl(t.attack,true); a.classList.add('attack-card'); a.style.transform='rotate(-6deg)';
    pair.appendChild(a);
    if(t.defense){ const d=cardEl(t.defense,true); d.classList.add('defense-card'); d.style.transform='rotate(8deg)'; pair.appendChild(d); }
    trickArea.appendChild(pair);
  });

  document.getElementById('discardPile').textContent = igame.discardCount>0 ? `${igame.discardCount}` : '—';

  // рука игрока
  document.getElementById('myHandLabel').textContent =
    `${human.name}${0===igame.attackerIndex?' — атакует':''}${0===igame.defenderIndex?' — защищается':''}`;
  const myHandBox=document.getElementById('myHand');
  myHandBox.innerHTML='';

  const attackActions=legalForHuman.filter(a=>a.type==='attack');
  const defendActions=legalForHuman.filter(a=>a.type==='defend');
  const transferActions=legalForHuman.filter(a=>a.type==='transfer');
  const singleTransferActions=transferActions.filter(a=>a.cards.length===1);
  const comboTransferAction=transferActions.find(a=>a.cards.length>1);
  const isHumanTurn = !finished && !interactiveBusy && turnIdx===0;

  // Карта, для которой сейчас ждём явного выбора "отбиться / перевести".
  // Если она больше не даёт обоих вариантов (стол изменился) — сбрасываем.
  if(pendingChoiceCard){
    const stillDual = defendActions.some(a=>sameCard(a.card,pendingChoiceCard))
      && singleTransferActions.some(a=>sameCard(a.cards[0],pendingChoiceCard));
    if(!isHumanTurn || !stillDual) pendingChoiceCard=null;
  }

  sortHandForDisplay(human.hand, igame.trumpSuit).forEach(c=>{
    const el=cardEl(c,true);
    let matchedAction=null, isTransfer=false, isDual=false;
    if(isHumanTurn){
      const defendA=defendActions.find(a=>sameCard(a.card,c));
      const transferA=singleTransferActions.find(a=>sameCard(a.cards[0],c));
      // Раньше defend всегда выигрывал у transfer, поэтому козырем того же
      // ранга нельзя было перевести — он просто "покрывал" карту (issue #22).
      // Теперь, если доступны оба действия, клик открывает явный выбор.
      if(defendA && transferA){
        isDual=true;
        matchedAction=null;
        el.classList.add('playable','dual-action');
        if(pendingChoiceCard && sameCard(pendingChoiceCard,c)) el.classList.add('choice-pending');
        el.title='Можно отбиться или перевести — нажмите, чтобы выбрать';
        el.addEventListener('click', ()=>{
          pendingChoiceCard = (pendingChoiceCard && sameCard(pendingChoiceCard,c)) ? null : {suit:c.suit, rank:c.rank};
          renderInteractive();
        });
      } else {
        matchedAction = attackActions.find(a=>sameCard(a.card,c)) || defendA || null;
        if(!matchedAction && transferA){ matchedAction=transferA; isTransfer=true; }
      }
    }
    if(matchedAction){
      el.classList.add('playable');
      if(isTransfer) el.classList.add('transferable');
      el.addEventListener('click', ()=> doHumanAction(matchedAction));
    } else if(!isDual && isHumanTurn && (attackActions.length>0 || defendActions.length>0 || singleTransferActions.length>0)){
      el.classList.add('unplayable');
    }
    myHandBox.appendChild(el);
  });
  layoutHandArc(myHandBox);

  // панель действий (выбор отбиться/перевести / пас / перевести оба сразу / взять карты)
  const actionBar=document.getElementById('actionBar');
  actionBar.innerHTML='';
  if(isHumanTurn){
    const passAction=legalForHuman.find(a=>a.type==='pass');
    const takeAction=legalForHuman.find(a=>a.type==='take');
    if(pendingChoiceCard){
      const defendA=defendActions.find(a=>sameCard(a.card,pendingChoiceCard));
      const transferA=singleTransferActions.find(a=>sameCard(a.cards[0],pendingChoiceCard));
      const lbl=document.createElement('span'); lbl.className='choice-label';
      lbl.textContent=`${cardToString(pendingChoiceCard)} —`;
      actionBar.appendChild(lbl);
      const dBtn=document.createElement('button'); dBtn.className='defend'; dBtn.textContent='Отбиться';
      dBtn.addEventListener('click', ()=>{ pendingChoiceCard=null; doHumanAction(defendA); });
      actionBar.appendChild(dBtn);
      const tBtn=document.createElement('button'); tBtn.className='transfer'; tBtn.textContent='Перевести';
      tBtn.addEventListener('click', ()=>{ pendingChoiceCard=null; doHumanAction(transferA); });
      actionBar.appendChild(tBtn);
      const cBtn=document.createElement('button'); cBtn.className='cancel'; cBtn.textContent='Отмена';
      cBtn.addEventListener('click', ()=>{ pendingChoiceCard=null; renderInteractive(); });
      actionBar.appendChild(cBtn);
    }
    if(comboTransferAction){
      const btn=document.createElement('button'); btn.className='transfer';
      btn.textContent=`Перевести оба (${comboTransferAction.cards.length})`;
      btn.addEventListener('click', ()=> doHumanAction(comboTransferAction));
      actionBar.appendChild(btn);
    }
    if(takeAction){
      const btn=document.createElement('button'); btn.className='take'; btn.textContent='Взять карты';
      btn.addEventListener('click', ()=> doHumanAction(takeAction));
      actionBar.appendChild(btn);
    }
    if(passAction){
      const btn=document.createElement('button'); btn.className='pass';
      btn.textContent = igame.phase==='need-attack' ? 'Пас (не подкидываю)' : 'Пас';
      btn.addEventListener('click', ()=> doHumanAction(passAction));
      actionBar.appendChild(btn);
    }
  }

  // подсказка, чей сейчас ход
  const hintBox=document.getElementById('turnHint');
  if(finished){
    hintBox.textContent='Партия завершена — нажмите «Новая партия», чтобы сыграть ещё раз.';
  } else if(isHumanTurn){
    hintBox.textContent = igame.phase==='defender-to-act'
      ? 'Ваш ход: отбейтесь картой, переведите или заберите карты.'
      : 'Ваш ход: подкиньте карту или пасуйте.';
  } else {
    hintBox.textContent = `Ходит ${igame.players[turnIdx]?.name || '...'}…`;
  }
  markYourTurn(isHumanTurn);

  renderInteractiveLog();
}

function renderInteractiveLog(){
  const box=document.getElementById('fullLog');
  const n=igame.log.length;
  box.innerHTML = igame.log.map((line,i)=>`<span data-i="${i}">${i===n-1?'<span class="cur">'+line+'</span>':line}</span>`).join('\n');
}

