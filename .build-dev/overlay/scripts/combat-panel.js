// ============================================================
// DBU Automation v1.8.6 TEST — Painel de Combate 2.2
// ============================================================
// Scouter UI + pendências sincronizadas com as cartas do chat.
// Defender pelo painel usa globalThis.DBU.defendFromPanel(), que chama o
// mesmo resolveDefense usado pela carta.
// ============================================================

import { eligibleInterveners, canReflect, startIntervene, startReflect } from "./intervene.js";
import { getTerrainLiftState, getSurgeUsage } from "./maneuvers.js";
import { getStandardPendingActions, respondExploitPending, respondGrappleEscape, respondSyntheticGrappleClash } from "./standard-actions.js";
import { conditionActive, standardActionBudget, actorInActiveCombat } from "./action-economy.js";

const PANEL_VERSION = "2.3";
const MODULE_VERSION = "1.9.6 DEV";
const OPEN = new Map();
const NOTIFIED = new Set();

// v1.8.12: caches/debounce do painel. As cartas de ataque só precisam ser
// reindexadas quando o chat/Encounter muda, não a cada seção/Actor renderizado.
let attackMessageRevision = 0;
let recentAttackCache = { revision: -1, combatId: null, messages: [] };
let refreshAllTimer = null;
const refreshActorTimers = new Map();

function invalidateAttackMessageCache() {
  attackMessageRevision += 1;
  recentAttackCache = { revision: -1, combatId: null, messages: [] };
}


function esc(value) {
  return String(value ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function number(value,fallback=0){const n=Number(value);return Number.isFinite(n)?n:fallback;}
function canControl(actor){return !!actor&&(game.user?.isGM||actor.isOwner);}
function tokenFromContext(context={}) {
  const direct=context?.token?.object??context?.token??null;if(direct?.actor)return direct;
  const byId=context?.tokenId?canvas?.tokens?.get?.(context.tokenId):null;if(byId?.actor)return byId;
  return (canvas?.tokens?.controlled||[])[0]||null;
}
function actorFromContext(context={}) {
  const direct=context?.actor;if(direct?.documentName==="Actor")return direct;if(direct?.actor?.documentName==="Actor")return direct.actor;
  const token=tokenFromContext(context);if(token?.actor)return token.actor;
  if(context?.actorId){const actor=game.actors?.get?.(context.actorId);if(actor)return actor;}
  return game.user?.character||null;
}
function tokenForActor(actor,context={}) {
  const direct=tokenFromContext(context);if(direct?.actor?.id===actor?.id)return direct;
  return (canvas?.tokens?.controlled||[]).find(t=>t.actor?.id===actor?.id)
    ||(canvas?.tokens?.placeables||[]).find(t=>t.actor?.id===actor?.id)||null;
}
function getCapacity(actor){
  try{if(globalThis.DBU?.getCapacity)return globalThis.DBU.getCapacity(actor);}catch{}
  const max=number(actor?.system?.status?.maxCapacity,0),spent=number(actor?.system?.status?.capacitySpent,0);
  return {max,spent,left:Math.max(0,max-spent)};
}
function activeTransformNames(actor){return (actor?.system?.transformations||[]).filter(t=>t?.active&&!/manifested power/i.test(String(t?.name||""))).map(t=>t?.name||"Transformation");}
function activeAuraName(actor){return (actor?.system?.signatureAuras||[]).find(a=>a?.active)?.name||"Nenhuma";}
function energyChargeState(actor){try{const s=actor?.getFlag?.("world","dbuEnergyChargeState")||null;return s?.active?s:null;}catch{return null;}}
function currentCombatLabel(actor){
  const c=game.combat;if(!c)return "Fora de combate";
  const cb=c.combatants?.find?.(x=>x.actor?.id===actor?.id);if(!cb)return `Round ${number(c.round,0)} · fora da iniciativa`;
  return `Round ${number(c.round,0)}${c.combatant?.id===cb.id?" · SEU TURNO":""}`;
}
function pct(v,m){return m>0?Math.max(0,Math.min(100,Math.round(v/m*100))):0;}
function resource(label,value,max,kind,extra="") {
  return `<div class="dbu-auto-resource"><div class="dbu-auto-resource-head"><span><b>${esc(label)}</b></span><span><b>${esc(value)}</b> / ${esc(max)}${extra?` · ${esc(extra)}`:""}</span></div><div class="dbu-auto-bar ${esc(kind)}"><span style="width:${pct(value,max)}%"></span></div></div>`;
}
function actionButton(action,icon,label,{disabled=false,title=""}={}){return `<button type="button" data-dbu-panel-action="${esc(action)}" ${disabled?"disabled":""} ${disabled&&title?`title="${esc(title)}"`:""}><i class="${esc(icon)}"></i> ${esc(label)}</button>`;}

function isRelevantCombatMessage(message) {
  if (!message) return false;
  try {
    return !!(
      message.getFlag?.("world", "dbuAttackData")
      || message.getFlag?.("world", "dbuDefenseStates")
      || message.getFlag?.("world", "dbuCombatRevealed")
      || message.getFlag?.("world", "dbuDeflectReflectOpportunity")
      || message.getFlag?.("world", "dbuReflectUses")
    );
  } catch {
    return false;
  }
}

function recentAttackMessages(){
  const currentCombatId=game.combat?.id||null;
  if(recentAttackCache.revision===attackMessageRevision && recentAttackCache.combatId===currentCombatId){
    return recentAttackCache.messages;
  }
  const maxAge=8*60*60*1000;
  const now=Date.now();
  const messages=(game.messages?.contents||[]).slice().reverse().filter(m=>{
    const attack=m.getFlag?.("world","dbuAttackData");
    if(!attack)return false;
    if(currentCombatId&&attack.combatId&&attack.combatId!==currentCombatId)return false;
    const created=number(attack.createdAt||m.timestamp||m._source?.timestamp,0);
    if(!attack.combatId&&created&&now-created>maxAge)return false;
    return true;
  });
  recentAttackCache={revision:attackMessageRevision,combatId:currentCombatId,messages};
  return messages;
}

function defenseStateFromMessage(message,actorId){
  const attack=message.getFlag("world","dbuAttackData")||{};
  if (!(attack.targetActorIds||[]).includes(actorId)) return null;
  const states=message.getFlag("world","dbuDefenseStates")||{};
  const state=states[actorId]||{};
  if(state.resolved)return null;
  return {message,attack,state};
}

function canDuelPending(actor,attack={}){
  const attacker=attack?.attackerId?game.actors?.get?.(attack.attackerId):null;
  const bt=Math.max(1,number(attack?.attackerBaseTier??attack?.baseTier??attacker?.system?.baseTier??attacker?.system?.tier,1));
  const signature=String(attack?.sourceGroup||"").toLowerCase().includes("sig");
  const charges=Math.max(number(attack?.energyCharges,0),number(attack?.energyChargeGathered,0));
  const wager=number(attack?.kiWager??attack?.wager,0);
  return signature||charges>=2||wager>=10*bt;
}

function pendingDefenses(actor,messages=recentAttackMessages()){
  const out=[];
  for(const message of messages){
    const row=defenseStateFromMessage(message,actor.id);if(!row)continue;
    out.push({type:"defense",message,attack:row.attack,targetId:actor.id,state:row.state,duelEligible:canDuelPending(actor,row.attack)});
    if(out.length>=5)break;
  }
  return out;
}

function pendingIntervenes(actor,messages=recentAttackMessages()){
  const out=[];
  for(const message of messages){
    if(!message.getFlag("world","dbuCombatRevealed"))continue;
    const attack=message.getFlag("world","dbuAttackData")||{};
    const states=message.getFlag("world","dbuDefenseStates")||{};
    for(const [targetId,state] of Object.entries(states)){
      if(!state?.damagePending||state?.damageResolved)continue;
      if((state?.intervention?.status||"pending")!=="pending")continue;
      const target=game.actors.get(targetId);if(!target)continue;
      const candidates=eligibleInterveners(message,target);
      if(candidates.some(x=>x.actor.id===actor.id)){
        out.push({type:"intervene",message,attack,targetId,target,state});
      }
    }
    if(out.length>=5)break;
  }
  return out;
}

function pendingReflects(actor,messages=recentAttackMessages()){
  const out=[];
  for(const message of messages){
    if(!message.getFlag("world","dbuCombatRevealed"))continue;
    const attack=message.getFlag("world","dbuAttackData")||{};
    if(!canReflect(attack))continue;
    const uses=message.getFlag("world","dbuReflectUses")||{};
    if(uses?.[actor.id]?.used)continue;
    const states=message.getFlag("world","dbuDefenseStates")||{};
    const st=states?.[actor.id];
    const parry=st?.hiddenOutcome?.defenseType==="parry"&&!!st.hiddenOutcome?.success;
    const deflect=message.getFlag("world","dbuDeflectReflectOpportunity")?.reflectorId===actor.id;
    if(parry||deflect)out.push({type:"reflect",message,attack,targetId:actor.id,source:parry?"Parry":"Deflect"});
    if(out.length>=5)break;
  }
  return out;
}

export function getPendingActions(actor){
  if(!actor)return[];
  const messages=recentAttackMessages();
  return [...pendingDefenses(actor,messages),...pendingIntervenes(actor,messages),...pendingReflects(actor,messages),...getStandardPendingActions(actor)];
}

function pendingHTML(actor,rows=getPendingActions(actor)){
  if(!rows.length)return `<div class="dbu-auto-empty"><i class="fas fa-check-circle"></i> Nenhuma ação pendente.</div>`;
  return `<div class="dbu-auto-pending-list">${rows.map(row=>{
    if(row.type==="defense")return `<div class="dbu-auto-pending-card"><div class="dbu-auto-pending-title">🛡 Defesa pendente</div><div class="dbu-auto-pending-main">${esc(row.attack.attackerName||"Atacante")} — ${esc(row.attack.attackName||"Ataque")}</div><div class="dbu-auto-pending-sub">A mesma defesa continua disponível no card do chat.</div><button type="button" data-dbu-pending-action="defense" data-message-id="${row.message.id}" data-target-id="${actor.id}"><i class="fas fa-shield-alt"></i> Defender</button></div>`;
    if(row.type==="intervene")return `<div class="dbu-auto-pending-card intervene"><div class="dbu-auto-pending-title">🤝 Intervene disponível</div><div class="dbu-auto-pending-main">${esc(row.target.name)} foi atingido por ${esc(row.attack.attackName||"um ataque")}</div><div class="dbu-auto-pending-sub">${esc(actor.name)} é elegível para intervir.</div><button type="button" data-dbu-pending-action="intervene" data-message-id="${row.message.id}" data-target-id="${row.targetId}"><i class="fas fa-people-arrows"></i> Intervene</button></div>`;
    if(row.type==="exploit")return `<div class="dbu-auto-pending-card"><div class="dbu-auto-pending-title">⚡ Exploit disponível</div><div class="dbu-auto-pending-main">${esc(row.reason||"Oportunidade de Exploit")}</div><div class="dbu-auto-pending-sub">Use um Basic Attack como Out-of-Sequence contra quem provocou o Exploit, ou ignore.</div><button type="button" data-dbu-pending-action="exploit" data-pending-id="${esc(row.id)}" data-choice="attack"><i class="fas fa-fist-raised"></i> Basic Attack</button><button type="button" data-dbu-pending-action="exploit" data-pending-id="${esc(row.id)}" data-choice="ignore"><i class="fas fa-times"></i> Ignorar</button></div>`;
    if(row.type==="grappleEscape")return `<div class="dbu-auto-pending-card"><div class="dbu-auto-pending-title">🔓 Escape do Grapple</div><div class="dbu-auto-pending-main">Grapple Check do alvo: ${number(row.challengerRoll?.total,0)}</div><div class="dbu-auto-pending-sub">Responda como Grappler; empate mantém o Grapple.</div><button type="button" data-dbu-pending-action="grappleEscape" data-pending-id="${esc(row.id)}" data-choice="strike"><i class="fas fa-fist-raised"></i> Strike</button><button type="button" data-dbu-pending-action="grappleEscape" data-pending-id="${esc(row.id)}" data-choice="dodge"><i class="fas fa-running"></i> Dodge</button></div>`;
    if(row.type==="grappleClash"){const buttons=row.responderKind==="might"?`<button type="button" data-dbu-pending-action="grappleClash" data-pending-id="${esc(row.id)}" data-choice="might"><i class="fas fa-dumbbell"></i> Might</button>`:`<button type="button" data-dbu-pending-action="grappleClash" data-pending-id="${esc(row.id)}" data-choice="strike"><i class="fas fa-fist-raised"></i> Strike</button><button type="button" data-dbu-pending-action="grappleClash" data-pending-id="${esc(row.id)}" data-choice="dodge"><i class="fas fa-running"></i> Dodge</button>`;return `<div class="dbu-auto-pending-card"><div class="dbu-auto-pending-title">🤼 Grapple Check</div><div class="dbu-auto-pending-main">${esc(row.label||"Grapple")} · ${number(row.initiatorRoll?.total,0)}</div><div class="dbu-auto-pending-sub">Resposta para Synthetic Actor/token.</div>${buttons}</div>`;}
    return `<div class="dbu-auto-pending-card reflect"><div class="dbu-auto-pending-title">↩ Reflect disponível</div><div class="dbu-auto-pending-main">${esc(row.attack.attackName||"Ataque")} — após ${esc(row.source)}</div><div class="dbu-auto-pending-sub">Energy/Magic sem AoE.</div><button type="button" data-dbu-pending-action="reflect" data-message-id="${row.message.id}" data-target-id="${actor.id}"><i class="fas fa-reply"></i> Reflect</button></div>`;
  }).join("")}</div>`;
}

async function buildPanelContent(actor){
  const lp={value:number(actor.system?.lifePoints?.value,0),max:number(actor.system?.lifePoints?.max,0)};
  const ki={value:number(actor.system?.kiPool?.value,0),max:number(actor.system?.kiPool?.max,0)};
  const cap=getCapacity(actor),charge=energyChargeState(actor),forms=activeTransformNames(actor),aura=activeAuraName(actor),cts=actor.system?.combatTabState||{};
  const terrain=getTerrainLiftState(actor),terrainShield=terrain?Math.max(0,number(terrain.shieldReduction,5*Math.max(1,number(terrain.hardness,1)))):0,surgeUsed=getSurgeUsage(actor);
  const tier=number(actor.system?.tier,1),baseTier=number(actor.system?.baseTier,tier),targets=game.user?.targets?.size||0;
  const combatLabel=currentCombatLabel(actor);
  const actionBudget=standardActionBudget(actor),pinned=conditionActive(actor,"pinned");
  const pending=getPendingActions(actor);
  return `<div class="dbu-auto-panel dbu-auto-window" data-dbu-panel-actor-id="${actor.id}">
    <div class="dbu-auto-panel-head">
      <div class="dbu-auto-portrait-wrap"><img class="dbu-auto-portrait" src="${esc(actor.img||"icons/svg/mystery-man.svg")}" alt="${esc(actor.name)}"><span class="dbu-auto-tier">T${tier}</span></div>
      <div><div class="dbu-auto-name">${esc(actor.name)}</div><div class="dbu-auto-subline">Base Tier ${baseTier} · <span class="${/SEU TURNO/.test(combatLabel)?"dbu-auto-turn":""}">${esc(combatLabel)}</span></div><div class="dbu-auto-subline">${esc(forms.length?forms.join(" + "):"Base")} · Aura: ${esc(aura)}</div></div>
    </div>
    <div class="dbu-auto-section"><div class="dbu-auto-section-title"><span>Recursos</span><span>Scouter Readout</span></div><div class="dbu-auto-section-body">
      ${resource("Life Points",lp.value,lp.max,"lp")}${resource("Ki Pool",ki.value,ki.max,"ki")}${resource("Capacity",cap.left,cap.max,"capacity",`${cap.spent} gasto`)}
    </div></div>
    <div class="dbu-auto-section"><div class="dbu-auto-section-title"><span>Status de Combate</span></div><div class="dbu-auto-section-body">
      <div class="dbu-auto-grid"><div class="dbu-auto-info"><div class="dbu-auto-info-label">Transformation</div><div class="dbu-auto-info-value">${esc(forms.length?forms.join(" + "):"Base")}</div></div><div class="dbu-auto-info"><div class="dbu-auto-info-label">Signature Aura</div><div class="dbu-auto-info-value">${esc(aura)}</div></div><div class="dbu-auto-info"><div class="dbu-auto-info-label">Energy Charge</div><div class="dbu-auto-info-value">${charge?`⚡ ${number(charge.gatheredCharges,0)} EC — ${esc(charge.attackName||charge.sourceKey||"Ataque")}`:"Nenhum"}</div></div><div class="dbu-auto-info"><div class="dbu-auto-info-label">Targets</div><div class="dbu-auto-info-value">${targets}</div></div></div>
      <div class="dbu-auto-chip-row" style="margin-top:7px"><span class="dbu-auto-chip">ATK ${number(cts.roundAttackCount,0)}</span><span class="dbu-auto-chip">DGE ${number(cts.roundDodgeCount,0)}</span><span class="dbu-auto-chip">CTR ${number(cts.roundCounterCount,0)}</span>${charge?`<span class="dbu-auto-chip warn">EC ${number(charge.gatheredCharges,0)}</span>`:""}</div>
    </div></div>
    <div class="dbu-auto-section"><div class="dbu-auto-section-title green"><span>⚠ Pendências</span><span>${pending.length}</span></div><div class="dbu-auto-section-body">${pendingHTML(actor,pending)}</div></div>
    <div class="dbu-auto-section"><div class="dbu-auto-section-title"><span>Combat</span><span>Actions registradas ${actionBudget.spent}/${actionBudget.limit}</span></div><div class="dbu-auto-section-body"><div class="dbu-auto-actions">${actionButton("attack","fas fa-fist-raised","Ataque",{disabled:pinned,title:pinned?"Pinned impede Attacking Maneuvers.":""})}${actionButton("energyCharge","fas fa-bolt","Energy Charge")}${actionButton("surge","fas fa-heartbeat",surgeUsed?`Surge · ${surgeUsed} uso${surgeUsed===1?"":"s"}`:"Surge",{disabled:!actorInActiveCombat(actor),title:actorInActiveCombat(actor)?"Usa o Surge nativo da ficha; usos extras continuam permitidos pelo próprio DBU.":"Surge só pode ser usado durante um Encounter ativo."})}${actionButton("terrainLift","fas fa-mountain",terrain?`Colocar Terreno (H${terrain.hardness} · Shield ${terrainShield})`:"Levantar Terreno")}${actionButton("aura","fas fa-sun","Signature Aura")}${actionButton("transform","fas fa-dragon","Transformação")}${actionButton("visualConfig","fas fa-palette","Visuais")}${actionButton("sheet","fas fa-user","Ficha")}${actionButton("refresh","fas fa-sync-alt","Atualizar")}</div><div class="dbu-auto-subline" style="margin-top:6px">Economia permissiva: o contador é informativo e não bloqueia Actions extras ou custos removidos por Traits/Characteristics.</div></div></div>
    <div class="dbu-auto-subline" style="text-align:center">DBU Automation ${MODULE_VERSION} · Painel ${PANEL_VERSION}</div>
  </div>`;
}

async function chooseDefense(message,actor){
  const attack=message.getFlag("world","dbuAttackData")||{};
  const buttons={
    dodge:{label:"Dodge",callback:()=>"dodge"},
    parry:{label:"Parry",callback:()=>"parry"},
    direct:{label:"Direct Hit",callback:()=>"directHit"},
    flare:{label:"Power Flare",callback:()=>"powerFlare"},
    counter:{label:"Cross Counter",callback:()=>"crossCounter"},
    guard:{label:"Guard",callback:()=>"guard"}
  };
  if(canDuelPending(actor,attack))buttons.duel={label:"Duel Clash",callback:()=>"duelClash"};
  buttons.cancel={label:"Cancelar",callback:()=>null};
  const result=await Dialog.wait({title:`${actor.name} — Defender`,content:`<div class="dbu-auto-window"><div class="dbu-auto-section"><div class="dbu-auto-section-title green"><span>🛡 Defesa</span></div><div class="dbu-auto-section-body"><div class="dbu-auto-chip-row" style="margin-bottom:8px"><span class="dbu-auto-chip">${esc(attack.attackerName||"Atacante")}</span><span class="dbu-auto-chip">${esc(attack.attackName||"Ataque")}</span><span class="dbu-auto-chip">${esc(attack.foundation||"")} / ${esc(attack.profile||"")}</span></div><p style="color:var(--dbua-muted);font-size:10px">Escolha a mesma defesa que aparece no card do chat. Duel só aparece quando o ataque atende aos requisitos da 0.9.2.</p></div></div></div>`,buttons,close:()=>null},{width:560,classes:["dbu-auto-defense-dialog"]});
  return result;
}

async function runPendingAction(button,actor){
  const type=button.dataset.dbuPendingAction,targetId=button.dataset.targetId;
  if(type==="grappleEscape")return respondGrappleEscape(actor,button.dataset.pendingId,button.dataset.choice);
  if(type==="grappleClash")return respondSyntheticGrappleClash(actor,button.dataset.pendingId,button.dataset.choice);
  if(type==="exploit")return respondExploitPending(actor,button.dataset.pendingId,button.dataset.choice||"attack");
  const message=game.messages.get(button.dataset.messageId);if(!message)return ui.notifications.warn("A carta do ataque não existe mais.");
  if(type==="defense"){
    const choice=await chooseDefense(message,actor);if(!choice)return;
    if(typeof globalThis.DBU?.defendFromPanel!=="function")return ui.notifications.error("DBU: defesa pelo painel não foi inicializada.");
    await globalThis.DBU.defendFromPanel(message.id,actor.id,choice);
  } else if(type==="intervene") await startIntervene(message,targetId);
  else if(type==="reflect") await startReflect(message,actor.id);
}

async function chooseCounterPendingRow(actor, rows, label) {
  if (!Array.isArray(rows) || !rows.length) return null;
  if (rows.length === 1) return rows[0];

  const options = rows.map((entry, index) => {
    let title = label;
    let detail = "";
    if (entry.type === "defense") {
      title = `${entry.attack?.attackerName || "Atacante"} — ${entry.attack?.attackName || "Ataque"}`;
      detail = `${entry.attack?.foundation || ""}${entry.attack?.profile ? ` / ${entry.attack.profile}` : ""}`;
    } else if (entry.type === "intervene") {
      title = `${entry.target?.name || "Ally"} — ${entry.attack?.attackName || "Ataque"}`;
      detail = `${entry.attack?.attackerName || "Atacante"}`;
    } else if (entry.type === "exploit") {
      title = entry.reason || "Exploit";
      detail = "Basic Attack como Out-of-Sequence";
    }
    return `<option value="${index}">${esc(title)}${detail ? ` · ${esc(detail)}` : ""}</option>`;
  }).join("");

  const choice = await Dialog.wait({
    title: `${actor.name} — ${label}`,
    content: `<div class="dbu-auto-window"><div class="dbu-auto-section"><div class="dbu-auto-section-title green"><span>${esc(label)}</span><span>${rows.length} pendências</span></div><div class="dbu-auto-section-body"><div class="form-group"><label>Escolha a oportunidade</label><select id="dbu-counter-pending-choice" style="width:100%">${options}</select></div></div></div></div>`,
    buttons: {
      use: { label: "Continuar", callback: html => Number(html.find("#dbu-counter-pending-choice").val()) },
      cancel: { label: "Cancelar", callback: () => null }
    },
    default: "use",
    close: () => null
  }, { width: 560, classes: ["dbu-auto-defense-dialog"] });

  return Number.isInteger(choice) ? rows[choice] || null : null;
}

/**
 * Entrada canônica do HUD COUNTER.
 * Reutiliza as automações existentes e só executa quando há pendência real.
 * O contador de Counter Actions é informativo/permissivo.
 */
export async function openCounterAction(kind, context = {}) {
  const actor = actorFromContext(context);
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Counter: selecione seu personagem.");
  const normalized = String(kind || "").trim().toLowerCase();
  const pending = getPendingActions(actor);

  if (normalized === "defend") {
    const row = await chooseCounterPendingRow(actor, pending.filter(entry => entry?.type === "defense"), "Defend");
    if (!row) return ui.notifications.warn(`${actor.name}: nenhuma defesa pendente.`);
    const choice = await chooseDefense(row.message, actor);
    if (!choice) return null;
    if (typeof globalThis.DBU?.defendFromPanel !== "function") return ui.notifications.error("DBU: defesa pelo painel não foi inicializada.");
    return globalThis.DBU.defendFromPanel(row.message.id, actor.id, choice);
  }

  if (normalized === "duel") {
    const rows = pending.filter(entry => entry?.type === "defense" && entry?.duelEligible);
    const row = await chooseCounterPendingRow(actor, rows, "Duel Maneuver");
    if (!row) return ui.notifications.warn(`${actor.name}: nenhum ataque pendente atende aos requisitos do Duel.`);
    if (typeof globalThis.DBU?.defendFromPanel !== "function") return ui.notifications.error("DBU: Duel pela defesa não foi inicializado.");
    return globalThis.DBU.defendFromPanel(row.message.id, actor.id, "duelClash");
  }

  if (normalized === "intervene") {
    const row = await chooseCounterPendingRow(actor, pending.filter(entry => entry?.type === "intervene"), "Intervene");
    if (!row) return ui.notifications.warn(`${actor.name}: nenhuma oportunidade válida de Intervene.`);
    return startIntervene(row.message, row.targetId);
  }


  if (normalized === "reflect") {
    const rows = pending.filter(entry => entry?.type === "reflect");
    const row = await chooseCounterPendingRow(actor, rows, "Reflect");
    if (!row) return ui.notifications.warn(`${actor.name}: nenhuma oportunidade válida de Reflect.`);
    return startReflect(row.message, actor.id);
  }

  if (normalized === "exploit") {
    const row = await chooseCounterPendingRow(actor, pending.filter(entry => entry?.type === "exploit"), "Exploit");
    if (!row) return ui.notifications.warn(`${actor.name}: nenhuma oportunidade de Exploit.`);
    const choice = await Dialog.wait({
      title: `${actor.name} — Exploit`,
      content: `<div class="dbu-auto-window"><div class="dbu-auto-section"><div class="dbu-auto-section-title green"><span>⚡ Exploit Maneuver</span><span>1 Counter</span></div><div class="dbu-auto-section-body"><p><b>${esc(row.reason || "Oportunidade de Exploit")}</b></p><p>Use um <b>Basic Attack</b> como Out-of-Sequence contra quem provocou o Exploit, ou ignore a oportunidade.</p></div></div></div>`,
      buttons: {
        attack: { icon: '<i class="fas fa-fist-raised"></i>', label: "Basic Attack", callback: () => "attack" },
        ignore: { icon: '<i class="fas fa-times"></i>', label: "Ignorar", callback: () => "ignore" },
        cancel: { label: "Cancelar", callback: () => null }
      },
      default: "attack",
      close: () => null
    }, { width: 520, classes: ["dbu-auto-defense-dialog"] });
    if (!choice) return null;
    return respondExploitPending(actor, row.id, choice);
  }

  if (normalized === "pending") return openCombatPanel({ ...context, actor });

  return ui.notifications.warn(`DBU Counter: ${kind || "ação"} ainda não possui entrada direta.`);
}

async function runPanelAction(action,actor,token,dialog,context){
  const api=globalThis.DBUAutomation;
  if(action==="sheet"){actor.sheet?.render?.(true);return;}
  if(action==="refresh"){await refreshOpenPanel(actor.id);return;}
  const method={attack:"attack",energyCharge:"energyCharge",surge:"surge",terrainLift:"terrainLift",aura:"aura",transform:"transform",visualConfig:"visualConfig"}[action];
  if(!method||typeof api?.[method]!=="function")return ui.notifications.error(`DBU Automation: ação ${action} não está disponível.`);
  try{dialog?.close?.();}catch{}
  await api[method]({actor,token});
}

async function attachPanelListeners(root,actor,token,dialog,context){
  for(const button of root.querySelectorAll("[data-dbu-panel-action]"))button.addEventListener("click",async e=>{e.preventDefault();try{await runPanelAction(button.dataset.dbuPanelAction,actor,token,dialog,context);}catch(err){console.error("DBU Painel:",err);ui.notifications.error(err?.message||"Erro no Painel.");}});
  for(const button of root.querySelectorAll("[data-dbu-pending-action]"))button.addEventListener("click",async e=>{e.preventDefault();button.disabled=true;try{await runPendingAction(button,actor);}catch(err){console.error("DBU Pendência:",err);ui.notifications.error(err?.message||"Erro na ação pendente.");}finally{button.disabled=false;await refreshOpenPanel(actor.id);}});
}

async function refreshOpenPanel(actorId){
  const entry=OPEN.get(actorId);if(!entry)return;
  const actor=entry.actor||game.actors.get(actorId);if(!actor)return;
  const root=entry.root?.querySelector?.("[data-dbu-panel-actor-id]")||entry.root;
  if(!root?.isConnected)return;
  const tmp=document.createElement("div");tmp.innerHTML=await buildPanelContent(actor);
  const next=tmp.firstElementChild;if(!next)return;
  root.replaceWith(next);entry.root=next;
  await attachPanelListeners(next,actor,tokenForActor(actor,entry.context),entry.dialog,entry.context);
}

export async function openCombatPanel(context={}){
  const actor=actorFromContext(context);if(!actor){ui.notifications.warn("DBU Painel: selecione um token ou configure um personagem para o usuário.");return null;}
  if(!canControl(actor)){ui.notifications.warn(`Você não controla ${actor.name}.`);return null;}
  const token=tokenForActor(actor,context),content=await buildPanelContent(actor);
  let dialog=null;
  dialog=new Dialog({title:`DBU Combat — ${actor.name}`,content,buttons:{close:{icon:'<i class="fas fa-times"></i>',label:"Fechar"}},render:html=>{const root=html instanceof HTMLElement?html:(html?.[0]||null);if(!root)return;const panel=root.querySelector("[data-dbu-panel-actor-id]")||root;OPEN.set(actor.id,{dialog,root:panel,actor,context:{...context,actor,token}});attachPanelListeners(panel,actor,token,dialog,context);},close:()=>OPEN.delete(actor.id)},{width:500,classes:["dbu-combat-panel-dialog","dbu-auto-window-shell"]});
  dialog.render(true);return dialog;
}

function controlledActorsForUser(){
  if(!game.user.isGM)return [...new Map([...(game.actors||[]),...(canvas?.tokens?.placeables||[]).map(t=>t.actor).filter(Boolean)].filter(a=>a.type==="character"&&a.isOwner).map(a=>[a.uuid||a.id,a])).values()];
  const ids=new Set([...OPEN.keys(),...(canvas?.tokens?.controlled||[]).map(t=>t.actor?.id).filter(Boolean)]);
  if(game.user.character?.id)ids.add(game.user.character.id);
  return [...ids].map(id=>OPEN.get(id)?.actor||game.actors.get(id)||(canvas?.tokens?.placeables||[]).find(t=>t.actor?.id===id)?.actor).filter(a=>a?.type==="character");
}
function notifyPendingChanges(){
  for(const actor of controlledActorsForUser())for(const row of getPendingActions(actor)){
    const key=`${row.type}:${row.message?.id||row.id}:${row.targetId||actor.id}`;if(NOTIFIED.has(key))continue;NOTIFIED.add(key);
    if(row.type==="defense")ui.notifications.warn(`🛡 ${actor.name}: defesa pendente contra ${row.attack.attackName||"ataque"}.`);
    else if(row.type==="intervene")ui.notifications.info(`🤝 ${actor.name} pode usar Intervene para proteger ${row.target.name}.`);
    else if(row.type==="reflect")ui.notifications.info(`↩ ${actor.name}: Reflect disponível após ${row.source}.`);
    else if(row.type==="grappleEscape")ui.notifications.warn(`🔓 ${actor.name}: responda ao escape do Grapple.`);
    else if(row.type==="grappleClash")ui.notifications.warn(`🤼 ${actor.name}: Grapple Check pendente.`);
    else if(row.type==="exploit")ui.notifications.info(`⚡ ${actor.name}: Exploit pendente (${row.reason||"oportunidade"}).`);
  }
}
function refreshAllOpen(){for(const actorId of OPEN.keys())refreshOpenPanel(actorId);notifyPendingChanges();}
function scheduleRefreshAll(delay=90,{invalidateMessages=false}={}){
  if(invalidateMessages)invalidateAttackMessageCache();
  if(refreshAllTimer)clearTimeout(refreshAllTimer);
  refreshAllTimer=setTimeout(()=>{refreshAllTimer=null;refreshAllOpen();},Math.max(0,number(delay,90)));
}
function scheduleRefreshActor(actorId,delay=70){
  if(!actorId)return;
  const old=refreshActorTimers.get(actorId);if(old)clearTimeout(old);
  const timer=setTimeout(()=>{refreshActorTimers.delete(actorId);if(OPEN.has(actorId))refreshOpenPanel(actorId);},Math.max(0,number(delay,70)));
  refreshActorTimers.set(actorId,timer);
}
function clearNotificationKeysForMessage(messageId){
  if(!messageId)return;
  for(const key of [...NOTIFIED])if(String(key).includes(`:${messageId}:`))NOTIFIED.delete(key);
}
export function clearPendingNotificationCache(){NOTIFIED.clear();return true;}

export function initializeCombatPanelAutomation(){
  const old=globalThis.DBU_COMBAT_PANEL_AUTOMATION||{};
  for(const [hook,id] of Object.entries(old.hooks||{}))try{Hooks.off(hook,id);}catch{}
  if(old.tokenHudHookId)try{Hooks.off("renderTokenHUD",old.tokenHudHookId);}catch{}
  const tokenHudHookId=Hooks.on("renderTokenHUD",(app,html,data)=>{try{const tokenId=data?._id||data?.id||app?.object?.id||app?.object?.document?.id;const token=tokenId?canvas?.tokens?.get?.(tokenId):app?.object;const actor=token?.actor;if(!actor||!canControl(actor))return;const root=html instanceof HTMLElement?html:(html?.[0]||null);if(!root||root.querySelector("[data-dbu-combat-panel-hud]"))return;const col=root.querySelector(".col.right")||root.querySelector(".right")||root;const c=document.createElement("div");c.className="control-icon";c.dataset.dbuCombatPanelHud="1";c.title="DBU — Painel de Combate 2.0";c.innerHTML='<i class="fas fa-dragon"></i>';c.addEventListener("click",async e=>{e.preventDefault();e.stopPropagation();await openCombatPanel({actor,token});});col.appendChild(c);}catch(err){console.error("DBU Token HUD:",err);}});
  const hooks={
    createChatMessage:Hooks.on("createChatMessage",message=>{
      if(isRelevantCombatMessage(message))scheduleRefreshAll(90,{invalidateMessages:true});
    }),
    updateChatMessage:Hooks.on("updateChatMessage",message=>{
      if(isRelevantCombatMessage(message))scheduleRefreshAll(90,{invalidateMessages:true});
    }),
    updateActor:Hooks.on("updateActor",actor=>{
      if(actor?.id&&OPEN.has(actor.id))scheduleRefreshActor(actor.id,70);
    }),
    updateCombat:Hooks.on("updateCombat",()=>scheduleRefreshAll(70,{invalidateMessages:true})),
    deleteChatMessage:Hooks.on("deleteChatMessage",message=>{
      if(!isRelevantCombatMessage(message))return;
      clearNotificationKeysForMessage(message?.id);
      scheduleRefreshAll(70,{invalidateMessages:true});
    }),
    deleteCombat:Hooks.on("deleteCombat",()=>{NOTIFIED.clear();scheduleRefreshAll(70,{invalidateMessages:true});})
  };
  const state={version:PANEL_VERSION,moduleVersion:MODULE_VERSION,initialized:true,tokenHudHookId,hooks};
  globalThis.DBU_COMBAT_PANEL_AUTOMATION=state;
  setTimeout(notifyPendingChanges,500);
  console.log(`DBU Automation | Painel de Combate ${PANEL_VERSION} pronto`,state);
  return state;
}