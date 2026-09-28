// Режиму просмотра нужна «плёнка»: после каждой записи в лог — снимок стола, по которому
// партия листается вперёд-назад. Движку из src/ это не нужно (им же пользуется сервер),
// поэтому запись снимков живёт здесь, в наследнике.
class RecordingGame extends DurakGame {
  constructor(...args){
    super(...args);
    this.snapshots ||= [];
  }
  _captureState(){
    return {
      phase:this.phase,
      trumpSuit:this.trumpSuit, trumpCard:this.trumpCard,
      talonCount:this.talon.length, discardCount:this.discardCount,
      table:this.table.map(t=>({attack:t.attack, defense:t.defense})),
      tableGoingToDefender:this.tookCards===true,
      attackerIndex:this.attackerIndex, defenderIndex:this.defenderIndex,
      players:this.players.map(p=>({id:p.id,name:p.name,hand:p.hand.slice(),out:p.out,finishRank:p.finishRank})),
      durak:this.durak, finished:this.phase==='finished',
      stall:this.getStallInfo(),
    };
  }
  _log(msg){
    super._log(msg);
    (this.snapshots ||= []).push({description:msg, state:this._captureState()});
  }
}

