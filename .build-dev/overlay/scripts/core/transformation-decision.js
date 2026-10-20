import { MODULE_SOCKET } from "./module-id.js";
import { drainingForActor, upkeepTurnKey, applyTransformationTurnUpkeep } from "./transformation-upkeep.js";
import { revertAll } from "../transformations.js";

const FLAG = "dbuaTransformationDecision";
let runtime = null;

const escapeHtml = value => String(value ?? "").replace(/&/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function ownerFor(actor) {
  const users = game.users?.contents || Array.from(game.users || []);
  const owners = users.filter(user => user.active && !user.isGM &&
    (user.character?.id === actor.id || actor.testUserPermission?.(user, "OWNER")));
  owners.sort((a,b) => Number(b.character?.id === actor.id) - Number(a.character?.id === actor.id)
    || String(a.id).localeCompare(String(b.id)));
  return owners[0] || users.filter(u => u.active && u.isGM)
    .sort((a,b) => String(a.id).localeCompare(String(b.id)))[0] || null;
}

function getDecisionMessage(actor, cost, cap) {
  const name = escapeHtml(actor.name);
  const forms = (actor.system.transformations || []).filter(t => t?.active)
    .map(t => escapeHtml(t.name || "Transformação")).join(", ") || "Forma ativa";
  const ki = Number(actor.system.kiPool?.value || 0);
  return `<div class="dbu-attack-roll dbu-draining-card">
    <h3 class="dbu-attack-title">🔥 Draining — ${name}</h3>
    <div class="dbu-card-body">
      <p><b>${forms}</b></p>
      <p>Manutenção deste turno: <b>−${cost} Ki</b>. Ki atual: <b>${ki}</b>.
      Capacity restante: <b>${cap}</b> (não é consumida por Draining).</p>
      <p>Deseja manter sua transformação ou sair dela?</p>
      <div class="dbu-attack-actions">
        <button type="button" class="dbu-pay-btn" data-dbua-trans-choice="keep">Manter (−${cost} Ki)</button>
        <button type="button" class="dbu-pay-btn" data-dbua-trans-choice="exit">Sair da transformação</button>
      </div>
      <small>O GM confirma a decisão somente para este token. Sair pode ativar Exhausting.</small>
    </div>
  </div>`;
}

function findLiveDecision(message) {
  const flag = message?.getFlag?.("world", FLAG);
  if (!flag?.key || !flag.combatId || !flag.combatantId) return null;
  const combat = game.combats?.get?.(flag.combatId)
    || (game.combat?.id === flag.combatId ? game.combat : null);
  const combatant = combat?.combatants?.get?.(flag.combatantId)
    || Array.from(combat?.combatants || []).find(c => c.id === flag.combatantId);
  if (!combatant?.actor || upkeepTurnKey(combat, combatant) !== flag.key) return null;
  if (flag.tokenId && combatant.tokenId !== flag.tokenId) return null;
  return {flag, combat, combatant, actor:combatant.actor};
}

export async function requestTransformationDecision(combat, combatant) {
  const actor = combatant?.actor;
  if (!runtime?.isPrimaryGM?.() || !actor || !combat?.id) return false;
  const cost = drainingForActor(actor);
  if (!cost) return false;
  const key = upkeepTurnKey(combat, combatant);
  if (actor.getFlag?.("world", "dbuaDrainingTurn")?.key === key) return false;
  if (actor.getFlag?.("world", FLAG)?.key === key) return true;
  if (runtime.pending.has(key)) return true;

  runtime.pending.add(key);
  try {
    const recipient = ownerFor(actor);
    if (!recipient) {
      console.warn("DBU | Draining sem jogador ou GM conectado:", actor.name);
      return true;
    }
    if (combatant.tokenId && actor.token?.id && actor.token.id !== combatant.tokenId)
      throw new Error("Combatant e Synthetic Actor divergentes.");
    const capacity = Math.max(0, Number(actor.system.status?.maxCapacity || 0)
      - Number(actor.system.status?.capacitySpent || 0));
    const msg = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({actor, token:combatant.token?.object || combatant.token}),
      whisper:[recipient.id],
      content:getDecisionMessage(actor,cost,capacity),
      flags:{world:{[FLAG]:{
        key, combatId:combat.id, combatantId:combatant.id, tokenId:combatant.tokenId || null,
        ownerId:recipient.id, round:Number(combat.round || 0), status:"pending", cost
      }}}
    });
    await actor.setFlag("world", FLAG, {key,status:"pending",messageId:msg.id});
    return true;
  } finally {
    runtime.pending.delete(key);
  }
}

async function processDecision({messageId, choice, userId}) {
  if (!runtime?.isPrimaryGM?.() || !["keep","exit"].includes(choice)) return;
  const message = game.messages?.get?.(messageId);
  const info = findLiveDecision(message);
  if (!info || info.flag.status !== "pending") return;
  const {flag,combat,combatant,actor} = info;
  const user = game.users?.get?.(userId);
  if (!user?.active || String(userId) !== String(flag.ownerId) ||
      (!user.isGM && !actor.testUserPermission?.(user, "OWNER"))) return;
  if (combat.combatant?.id !== combatant.id || Number(combat.round) !== flag.round) {
    ui.notifications.warn("DBU: a decisão pertence a um turno anterior.");
    return;
  }
  if (runtime.locks.has(flag.key)) return;
  runtime.locks.add(flag.key);
  try {
    let result = null;
    if (choice === "exit") {
      const ok = await revertAll(actor);
      if (!ok || drainingForActor(actor)>0) throw new Error(
        "Não foi possível sair das transformações com Draining. Verifique Compelled, Rampaging ou formas concedidas."
      );
    } else {
      result = await applyTransformationTurnUpkeep(combat,combatant,{announcement:false});
      if (!result && actor.getFlag?.("world", "dbuaDrainingTurn")?.key !== flag.key)
        throw new Error("Draining não foi pago; a transformação permanece pendente.");
    }
    await actor.setFlag("world", FLAG, {key:flag.key,status:choice,messageId});
    const feedback = choice === "exit" ? "Transformação encerrada, sem gasto de Ki."
      : drainingForActor(actor) <= 0
        ? `Draining pago: Ki ${result?.before ?? "?"} → ${result?.after ?? "?"}. A forma foi encerrada se o personagem ficou sem energia.`
        : `Transformação mantida. Ki ${result?.before ?? "?"} → ${result?.after ?? "?"}.`;
    await message.update({
      content:`<div class="dbu-attack-roll dbu-draining-card"><b>🔥 Draining — ${escapeHtml(actor.name)}</b><p>${feedback}</p></div>`,
      ["flags.world."+FLAG]:{...flag,status:choice}
    });
    if(choice === "keep") await runtime.onContinue?.(combat,combatant);
  } catch(error) {
    console.error("DBU | decisão de manutenção:",error);
    ui.notifications.error(error.message || "Falha na manutenção de transformação.");
  } finally {
    runtime.locks.delete(flag.key);
  }
}

export function initializeTransformationDecision({isPrimaryGM,onContinue}={}) {
  if (runtime) {
    try {game.socket.off(MODULE_SOCKET,runtime.socket)} catch {}
    try {document.removeEventListener("click",runtime.click,true)} catch {}
    try {Hooks.off("renderChatMessage",runtime.renderHookId)} catch {}
  }
  runtime={isPrimaryGM,onContinue,pending:new Set(),locks:new Set()};
  runtime.socket = data => {
    if(data?.type === "dbuaTransformationChoice") void processDecision(data);
  };
  runtime.click = event => {
    const button = event.target.closest?.("[data-dbua-trans-choice]");
    if(!button) return;
    const messageId = button.closest("[data-message-id]")?.dataset?.messageId;
    const msg = game.messages?.get?.(messageId), flag=msg?.getFlag?.("world",FLAG);
    if (!flag || flag.status !== "pending" || game.user?.id !== flag.ownerId) return;
    const choice=button.dataset.dbuaTransChoice;
    if(!["keep","exit"].includes(choice) || button.disabled) return;
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    button.disabled=true;
    const packet={type:"dbuaTransformationChoice",messageId,choice,userId:game.user.id};
    if(runtime.isPrimaryGM?.()) void processDecision(packet);
    else game.socket.emit(MODULE_SOCKET,packet);
  };
  runtime.renderHookId=Hooks.on("renderChatMessage",(msg,html)=>{
    const flag=msg.getFlag?.("world",FLAG);if(!flag)return;
    const root=html instanceof HTMLElement ? html : html?.[0];
    root?.querySelectorAll?.("[data-dbua-trans-choice]").forEach(btn=>{
      btn.disabled=flag.status!=="pending" || game.user?.id!==flag.ownerId;
    });
  });
  game.socket.on(MODULE_SOCKET,runtime.socket);
  document.addEventListener("click",runtime.click,true);
  return runtime;
}
