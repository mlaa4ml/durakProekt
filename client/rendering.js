/* ============ Визуализация ============ */

// Раскладывает карты руки дугой: центральная карта ниже и без наклона,
// к краям карты приподнимаются и разворачиваются. Работает по фактической
// ширине карты (--hand-card-w меняется через clamp()), поэтому пересчитывается
// при каждой отрисовке руки и при ресайзе окна.
function layoutHandArc(container){
  if(!container) return;
  const cards = Array.from(container.children).filter(el=>el.classList.contains('card'));
  const n = cards.length;
  if(n===0){ container.style.height=''; return; }
  // Отключаем transition на время замера/расстановки: getBoundingClientRect()
  // ниже форсирует синхронный reflow, а карты только что вставлены с ещё
  // не заданными --tx/--ty/--tr (т.е. дефолт 0,0,0) — без этого браузер
  // фиксирует два разных состояния стиля и на КАЖДОЙ перерисовке руки
  // проигрывает transition с нуля до дуги, из-за чего карты «мерцают».
  cards.forEach(el=>{ el.style.transition='none'; });
  // offsetWidth/Height не учитывают поворот предыдущего веера при ресайзе.
  const w = cards[0].offsetWidth || 60;
  const h = cards[0].offsetHeight || 84;
  const avail = container.clientWidth || w*n;
  if(window.matchMedia('(max-width:680px)').matches){
    // Не сжимаем индексы до нечитаемой полоски: большая рука прокручивается.
    // Высота не зависит от количества карт; нижняя часть скрыта лотком.
    const step = Math.max(44, w * 0.48);
    const total = w + step * (n - 1);
    const start = Math.max(4, (avail - total) / 2);
    cards.forEach((el,i)=>{
      el.style.setProperty('--tr', '0deg');
      el.style.setProperty('--tx', (start + i * step).toFixed(1)+'px');
      el.style.setProperty('--ty', '0px');
      el.style.marginLeft='0px';
      el.style.setProperty('--zi', String(i+1));
    });
    container.style.height = (h * 0.64 + 24) + 'px';
    void container.offsetHeight;
    cards.forEach(el=>{ el.style.transition=''; });
    return;
  }
  const stepDeg = n>1 ? Math.min(9, 56/(n-1)) : 0;
  const stepX = n>1 ? Math.max(w*0.22, Math.min(w*0.62, (avail - w) / (n-1))) : 0;
  const mid = (n-1)/2;
  // Форма дуги: центральная карта приподнята над базовой линией, к краям
  // подъём плавно сходит на нет — у самых крайних карт --ty=0 (они стоят
  // ровно на базовой линии контейнера). Так --ty никогда не становится
  // положительным, и карты физически не могут провалиться НИЖЕ контейнера
  // в панель действий/подсказку хода, даже при большой руке. Итоговый
  // подъём центра ограничен потолком в 85% высоты карты.
  let curveMag = h*0.055;
  const maxExtent = h*0.85;
  if(mid*mid*curveMag > maxExtent) curveMag = maxExtent / (mid*mid || 1);
  const extent = mid*mid*curveMag;
  cards.forEach((el,i)=>{
    const off = i - mid;
    el.style.setProperty('--tr', (off*stepDeg).toFixed(2)+'deg');
    el.style.setProperty('--tx', (off*stepX).toFixed(1)+'px');
    el.style.setProperty('--ty', (-(mid*mid - off*off)*curveMag).toFixed(1)+'px');
    el.style.marginLeft = (-w/2)+'px';
    // Возрастающий z-index слева направо: каждая следующая карта лежит
    // ПОВЕРХ предыдущей — обычный порядок веера. Раньше было наоборот
    // (выше всех — центральная), из-за чего у крайних карт перекрывался
    // не тот угол и веер выглядел «сломанным».
    el.style.setProperty('--zi', String(i+1));
  });
  container.style.height = (h + extent + 12) + 'px';
  // форсируем применение новой раскладки без анимации, затем возвращаем transition
  void container.offsetHeight;
  cards.forEach(el=>{ el.style.transition=''; });
}
window.addEventListener('resize', ()=>{
  clearTimeout(window.__handArcResize);
  window.__handArcResize = setTimeout(()=> layoutHandArc(document.getElementById('myHand')), 120);
});

/* ============ HUD партии (issue #19) ============
   Раньше вверху стола была одна длинная строка
   «Атакует: X · Защищается: Y · козырь ♠»: на телефоне она переносилась,
   счётчики колоды и «бито» жили отдельно мелким текстом по краям стола, и
   ничто не связывало имя в строке с местом соперника за столом.
   Теперь тот же смысл выводится набором цветных чипов; цвета совпадают с
   бейджами ролей (.role-tag.attacker/.defender) и кольцами вокруг мест,
   поэтому «кто атакует / кто защищается» читается одним взглядом.
   Функция общая для всех трёх режимов (просмотр ботов / против ботов / сеть). */
function hudEsc(s){ return String(s==null?'':s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function moveWord(n){
  const m10=n%10, m100=n%100;
  if(m10===1 && m100!==11) return 'ход';
  if(m10>=2 && m10<=4 && (m100<12 || m100>14)) return 'хода';
  return 'ходов';
}
function hudSuitHtml(suit){
  return `<span class="suit${RED_SUITS.has(suit)?' red':''}">${hudEsc(suit)}</span>`;
}
function renderStatusHud(o){
  const box=document.getElementById('statusLine');
  if(!box) return;
  if(o.finished){
    box.innerHTML = '<span class="hud-chip finished">'+
      (o.durakName ? 'партия окончена — дурак: <b>'+hudEsc(o.durakName)+'</b>' : 'партия окончена — ничья')+
      '</span>';
    return;
  }
  const chips=[];
  if(o.trumpSuit) chips.push(`<span class="hud-chip trump">козырь ${hudSuitHtml(o.trumpSuit)}</span>`);
  chips.push(`<span class="hud-chip attacker"><span class="dot"></span>атакует <b>${hudEsc(o.attackerName||'?')}</b></span>`);
  chips.push(`<span class="hud-chip defender"><span class="dot"></span>защищается <b>${hudEsc(o.defenderName||'?')}</b></span>`);
  chips.push(`<span class="hud-chip">колода <b>${o.talonCount==null?'?':o.talonCount}</b></span>`);
  chips.push(`<span class="hud-chip">бито <b>${o.discardCount||0}</b></span>`);
  // Обратный отсчёт до ничьей «по застою» (см. rules.stallLimit): предупреждаем игроков заранее,
  // чтобы они понимали, почему партия вот-вот закончится вничью, а не потому что кто-то дурак.
  if(o.stall && o.stall.warning){
    chips.push(`<span class="hud-chip stall-warning">ничья через <b>${o.stall.remaining}</b> ${moveWord(o.stall.remaining)}, если не будет бито или выхода из игры</span>`);
  }
  box.innerHTML = chips.join('');
}
// Подсветка «сейчас ходите вы»: окантовка стола + контрастная подсказка +
// отдельный чип в HUD. Вызывается уже после того, как режим посчитал,
// действительно ли ход за игроком.
function markYourTurn(on){
  const table=document.getElementById('tableBoard');
  if(table) table.classList.toggle('your-turn', !!on);
  const hint=document.getElementById('turnHint');
  if(hint) hint.classList.toggle('my-turn', !!on);
  const box=document.getElementById('statusLine');
  if(box && on && !box.querySelector('.hud-chip.you')){
    const chip=document.createElement('span');
    chip.className='hud-chip you'; chip.innerHTML='<b>ваш ход</b>';
    box.appendChild(chip);
  }
}

function cardEl(card, faceUp=true){
  if(!faceUp){ const d=document.createElement('div'); d.className='card-back'; return d; }
  const d=document.createElement('div');
  const red = RED_SUITS.has(card.suit);
  d.className='card ' + (red?'brick':'ink');
  const idx = `<div class="r">${rankName(card.rank)}</div><div class="s">${card.suit}</div>`;
  d.innerHTML = `<div class="corner">${idx}</div><div class="corner br">${idx}</div>`;
  return d;
}

// Группировка руки по мастям (внутри масти — по возрастанию ранга).
// Козырная масть ставится в начало или в конец, по выбору игрока.
// Если игрок выключил группировку в настройках — карты остаются в исходном
// порядке (как пришли в руку), а строка «Козыри в руке» тогда не нужна.
const SUIT_ORDER_BASE = ['♠','♣','♥','♦'];
function trumpSidePref(){
  const el = document.getElementById('trumpSide');
  return el ? el.value : 'right';
}
function groupHandPref(){
  const el = document.getElementById('groupHandToggle');
  return el ? el.checked : true;
}
function updateTrumpSideRowVisibility(){
  document.getElementById('trumpSideRow').classList.toggle('hidden', !groupHandPref());
}
function sortHandForDisplay(hand, trumpSuit){
  if(!groupHandPref()) return hand.slice();
  const side = trumpSidePref();
  const others = SUIT_ORDER_BASE.filter(s=>s!==trumpSuit);
  const order = side==='left' ? [trumpSuit, ...others] : [...others, trumpSuit];
  return hand.slice().sort((a,b)=>{
    const oa=order.indexOf(a.suit), ob=order.indexOf(b.suit);
    if(oa!==ob) return oa-ob;
    return a.rank-b.rank;
  });
}
// Крайние (левое/правое) места при 4+ соперниках рисуем вертикальным веером —
// иначе при 5-6 игроках карты по бокам вылезают за стол по горизонтали.
function oppWrapClass(seatIdx, totalOpponents, out){
  const vertical = totalOpponents>=4 && (seatIdx===0 || seatIdx===totalOpponents-1);
  return 'opp' + (out?' out':'') + (vertical?' vertical':'');
}

// Строка роли ("атакует"/"защита"/"думает…") — рисуется в отдельном
// вынесенном из потока блоке (.role-row), чтобы её появление/исчезновение
// не меняло ширину карточки игрока и не двигало соседей по дуге.
function roleTagsHtml(isAttacker, isDefender, isThinking){
  return (isAttacker?'<span class="role-tag attacker">атакует</span>':'')+
    (isDefender?'<span class="role-tag defender">защита</span>':'')+
    (isThinking?'<span class="role-tag" style="background:#3a6b52;color:var(--cream);">думает…</span>':'');
}
function appendRoleRow(wrap, html){
  if(!html) return;
  const row=document.createElement('div'); row.className='role-row'; row.innerHTML=html;
  wrap.appendChild(row);
}

// Раньше при скрытых картах рисовался веер из N рубашек — его ширина росла
// вместе с числом карт в руке соперника, а т.к. в мобильной раскладке .opp
// стоят в одном flex-ряду, это "толкало" соседних игроков и сдвигало позиции
// на каждой раздаче/отбое. Теперь при скрытых картах рисуем один рубашечный
// значок фиксированного размера + бейдж с количеством — ширина .opp больше
// не зависит от числа карт, позиции игроков стабильны. Когда включено
// "показать все карты" (режим проверки правил), по-прежнему рисуем настоящий
// веер лицевых карт — там важно видеть реальную раскладку.
function renderOppHandArea(wrap, count, faceUp, hand, trumpSuit){
  if(faceUp && hand){
    const fan=document.createElement('div'); fan.className='fan';
    sortHandForDisplay(hand, trumpSuit).forEach(c=> fan.appendChild(cardEl(c, true)) );
    wrap.appendChild(fan);
  } else {
    const box=document.createElement('div'); box.className='hand-count';
    const back=document.createElement('div'); back.className='card-back-mini'; box.appendChild(back);
    const chip=document.createElement('div'); chip.className='count-chip'; chip.textContent=String(count); box.appendChild(chip);
    wrap.appendChild(box);
  }
}

