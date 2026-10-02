// ============================================================
// DBU Automation v1.8.14 DEV — Maneuvers Manager
// ============================================================
// DBU 0.9.2. Core modularizado: state/context/providers/registry/economy.
// Ações permanecem semanticamente idênticas; atualizações quentes são agrupadas.
// ============================================================

import { getTerrainLiftState } from "./maneuvers.js";
import { getEnergyChargeAllowedTypes } from "./energy-charge.js";
import { areAllies as areTeamAllies, areEnemies as areTeamEnemies } from "./combat-teams.js";
import {
  economyConditionActive,
  actorInActiveCombat,
  standardActionBudget,
  validateActionUse,
  recordStandardAction
} from "./standard-actions/economy.js";
import {
  MODULE_ID, SYS_ID, FAVORITES_SETTING, POWER_BUFF_MARKER, RECOVERY_BUFF_MARKER,
  MIRACLE_BUFF_PREFIX, STATE_FLAG, SOCKET, state,
  esc, num, clampInt, canControl, actorFromContext, tokenFromContext, combatantForActor,
  inActiveCombat, roundTrackingMeta, isActorsTurn, getCurrentRoundData, roundUses,
  powerUpUseCount, standardActionsSpent, baseTier, tier, capacity, currentGrapple,
  participantRef, participantFromGrapple, resolveParticipantToken, resolveParticipantActor,
  grappleActor, allText, registerStandardActionProvider, collectModifiers, createManeuverRegistry
} from "./standard-actions/core.js";

export { standardActionsSpent, registerStandardActionProvider };

function powerUpRules(actor) {
  let maxStacks = 2 + Math.max(0, Math.trunc(num(actor?.system?.aptitudes?.maxPowerStacksBonus, 0)));
  let gain = 1;
  const activeTransformations = (actor?.system?.transformations || []).filter(t => t?.active);
  const text = allText(activeTransformations).join("\n");

  // Charge Up [Passive] — DBU 0.9.2. No DBU-MRR-OLD 0.9.2 esse
  // efeito aparece como condicional textual e não é materializado no aptitude,
  // então somamos tanto o máximo quanto o ganho aqui.
  if (/increase your maximum amount of power stacks and the amount gained from the power up maneuver by 1/i.test(text)) {
    maxStacks += 1;
    gain += 1;
  }

  const ext = collectModifiers(actor, "powerUp");
  maxStacks += num(ext.maxStacksBonus, 0);
  gain += num(ext.gainBonus, 0);
  return {
    maxStacks: Math.max(1, Math.trunc(maxStacks)),
    gain: Math.max(1, Math.trunc(gain)),
    maxUses: Math.max(1, Math.trunc(num(ext.maxUses, 2)))
  };
}

function nextBuffId(buffs = []) {
  const ids = buffs.map(b => num(b?.id, 0)).filter(n => Number.isFinite(n));
  return (ids.length ? Math.max(...ids) : 0) + 1;
}

function syncGeneratedBuff(buffs, marker, { effect, flat = 0, bT = 0, T = 0, name }) {
  const list = foundry.utils.deepClone(buffs || []);
  const idx = list.findIndex(b => String(b?.notes || "").includes(marker));
  const hasValue = !!(flat || bT || T);
  if (!hasValue) {
    if (idx >= 0) list.splice(idx, 1);
    return list;
  }
  const row = {
    id: idx >= 0 ? list[idx].id : nextBuffId(list),
    name,
    active: true,
    effect,
    flat: Math.trunc(flat),
    bT: Math.trunc(bT),
    T: Math.trunc(T),
    notes: marker
  };
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  return list;
}

function appendGeneratedBuff(buffs, marker, { effect, flat = 0, bT = 0, T = 0, name }) {
  const list = foundry.utils.deepClone(buffs || []);
  list.push({
    id: nextBuffId(list),
    name,
    active: true,
    effect,
    flat: Math.trunc(flat),
    bT: Math.trunc(bT),
    T: Math.trunc(T),
    notes: marker
  });
  return list;
}

function removeGeneratedBuffByMarker(buffs, marker) {
  return foundry.utils.deepClone(buffs || []).filter(b => !String(b?.notes || "").includes(marker));
}

async function syncPowerBuff(actor, stacks) {
  const buffs = syncGeneratedBuff(actor.system?.customBuffs, POWER_BUFF_MARKER, {
    effect: "Combat Rolls",
    T: Math.max(0, Math.trunc(stacks)),
    name: "Power (DBU Automation)"
  });
  await actor.update({ "system.customBuffs": buffs });
}

function generatedBuffT(actor, marker) {
  const row = (actor?.system?.customBuffs || []).find(b => String(b?.notes || "").includes(marker));
  return row ? Math.trunc(num(row.T, 0)) : 0;
}

async function ensurePowerBuff(actor) {
  if (!actor) return false;
  const stacks = Math.max(0, Math.trunc(num(actor.system?.tracking?.powerStacks, 0)));
  if (generatedBuffT(actor, POWER_BUFF_MARKER) === stacks) return false;
  if (!game.user?.isGM && !actor.isOwner) return false;
  await syncPowerBuff(actor, stacks);
  return true;
}

function powerRows(cts) {
  const rows = [];
  for (const round of (cts.rounds || [])) {
    for (let i = 0; i < (round.actions || []).length; i++) {
      const a = round.actions[i];
      if (a?.type === "power-up") rows.push({ round, index: i, row: a });
    }
  }
  return rows;
}

function activePowerRows(cts) {
  const current = num(cts.currentRound, cts.rounds?.length || 1);
  return powerRows(cts).filter(x => num(x.round?.roundNumber, 0) >= current - 1);
}

function timedEffects(actor) {
  return foundry.utils.deepClone(actor?.getFlag?.(MODULE_ID, `${STATE_FLAG}.timedEffects`) || []);
}

async function writeTimedEffects(actor, timers, options = {}) {
  return gmOrOwnerSetFlag(actor, `${STATE_FLAG}.timedEffects`, timers || [], options);
}

async function powerUp(context = {}) {
  const actor = actorFromContext(context);
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Power Up: selecione seu personagem.");
  const { cts, round } = getCurrentRoundData(actor);
  const rules = powerUpRules(actor);
  const useRows = inActiveCombat(actor)
    ? (round.actions || []).filter(a => !a?.dbuOutsideCombat && (a?.dbuPowerUpUse === true || (a?.type === "power-up" && !a?.dbuExtraPowerStack)))
    : [];
  if (useRows.length >= rules.maxUses) return ui.notifications.warn(`${actor.name}: Power Up já usado ${rules.maxUses}/${rules.maxUses} neste Round.`);

  let activeRows = activePowerRows(cts);
  let stacks = Math.max(0, num(actor.system?.tracking?.powerStacks, activeRows.length));
  let timers = timedEffects(actor);
  const atMax = stacks >= rules.maxStacks;
  const canRefresh = stacks > 0;

  const result = await Dialog.wait({
    title: `${actor.name} — Power Up`,
    content: `<div class="dbua-system-dialog-content"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span><i class="fas fa-fire"></i> Power Up Maneuver</span><span>${inActiveCombat(actor) ? `${useRows.length}/${rules.maxUses} neste Round` : "Fora de Encounter · limite/Round livre"}</span></div><div class="combat-panel-body">
      <table class="status-table dbua-system-status-table"><tbody>
        <tr><td class="status-label">Power atual</td><td class="status-value"><b>${stacks}/${rules.maxStacks}</b></td></tr>
        <tr><td class="status-label">Ganho deste uso</td><td class="status-value"><b>+${rules.gain}</b> stack${rules.gain === 1 ? "" : "s"}</td></tr>
        <tr><td class="status-label">Por stack</td><td class="status-value">+¼ Max Capacity · +1(T) Combat Rolls</td></tr>
      </tbody></table>
      ${canRefresh ? `<label class="dbua-standard-check"><input id="dbua-power-refresh" type="checkbox" ${atMax ? "checked" : ""}> Remover 1 stack antes de aplicar o Power Up (renovar duração)</label>` : ""}
      ${atMax ? `<p class="notes"><b>Máximo atingido.</b> Para este uso produzir efeito, renove/remova uma stack antes de aplicar.</p>` : ""}
    </div></div></div>`,
    buttons: {
      use: { icon: '<i class="fas fa-fire"></i>', label: "Power Up", callback: html => ({ refresh: !!html.find("#dbua-power-refresh").prop("checked") }) },
      cancel: { label: "Cancelar", callback: () => null }
    },
    default: "use",
    close: () => null
  }, { width: 520, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
  if (!result) return null;

  if (result.refresh && activeRows.length) {
    // Remove a stack mais antiga; se estiver no Round atual, remove a row extra
    // preferencialmente para não apagar o custo da Maneuver por acidente.
    activeRows.sort((a, b) => num(a.round.roundNumber) - num(b.round.roundNumber) || a.index - b.index);
    const victim = activeRows[0];
    const victimStackId = String(victim.row?.dbuPowerStackId || "");
    // Preservamos a linha no tracker para não apagar o Action Cost histórico;
    // apenas essa stack deixa de ser contada como Power ativo.
    victim.row.type = "power-up-refreshed";
    victim.row.dbuPowerRemovedForRefresh = true;
    victim.row.dbuPowerRemovedAt = Date.now();
    victim.row.description = `${victim.row.description || "Power Up"} — stack renovada/removida`;
    if (victimStackId) timers = timers.filter(t => !(t?.kind === "powerStack" && t?.stackId === victimStackId));
    stacks = Math.max(0, stacks - 1);
  }

  const room = Math.max(0, rules.maxStacks - stacks);
  const gain = Math.min(rules.gain, room);
  if (gain <= 0) return ui.notifications.warn(`${actor.name}: nenhuma stack de Power pode ser adicionada; marque a opção de renovar uma stack.`);

  const useId = foundry.utils.randomID(10);
  for (let i = 0; i < gain; i++) {
    const stackId = foundry.utils.randomID(12);
    round.actions.push({
      type: "power-up",
      source: "",
      kiCost: 0,
      dkpCost: 0,
      kiWager: 0,
      description: `Power Up${i ? " — stack adicional" : ""}`,
      actionCost: i === 0 ? 1 : 0,
      dbuStandardKey: "powerUp",
      ...roundTrackingMeta(actor),
      dbuPowerUpUse: i === 0,
      dbuExtraPowerStack: i > 0,
      dbuPowerUpUseId: useId,
      dbuPowerStackId: stackId
    });
    timers.push({
      id: `power:${stackId}`,
      kind: "powerStack",
      stackId,
      awaitingNextTurn: true,
      activeTurn: false,
      createdAt: Date.now()
    });
  }
  const newStacks = Math.min(rules.maxStacks, stacks + gain);
  const powerBuffs = syncGeneratedBuff(actor.system?.customBuffs, POWER_BUFF_MARKER, {
    effect: "Combat Rolls",
    T: newStacks,
    name: "Power (DBU Automation)"
  });
  await actor.update({
    "system.combatTabState": cts,
    "system.tracking.powerStacks": newStacks,
    "system.customBuffs": powerBuffs,
    [`flags.${MODULE_ID}.${STATE_FLAG}.timedEffects`]: timers
  });
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll"><h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-fire"></i> ${esc(actor.name)} — Power Up</span></h3><div class="dbu-card-body"><div class="dbu-attack-meta"><span class="dbu-meta-chip">Standard · 1 Action</span><span class="dbu-meta-chip">${inActiveCombat(actor) ? `${useRows.length + 1}/${rules.maxUses} Round` : "Fora de Encounter"}</span></div><div class="dbu-defend-guide"><b>Power ${newStacks}/${rules.maxStacks}</b> · Max Capacity +${newStacks * 25}% · Combat Rolls +${newStacks}(T).${result.refresh ? " Uma stack foi renovada antes do ganho." : ""}</div></div></div>`
  });
  return { stacks: newStacks, gain, refreshed: !!result.refresh };
}

function recoveryState(actor) {
  return actor?.getFlag?.(MODULE_ID, STATE_FLAG)?.combatRecovery || null;
}

async function combatRecovery(context = {}) {
  const actor = actorFromContext(context);
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Combat Recovery: selecione seu personagem.");
  if (!actorInActiveCombat(actor)) return ui.notifications.warn(`${actor.name}: Combat Recovery só pode ser usado durante um Encounter ativo.`);
  if (roundUses(actor, "combatRecovery") > 0) return ui.notifications.warn(`${actor.name}: Combat Recovery já usado neste Round.`);

  const bt = baseTier(actor);
  const t = tier(actor);
  const modifiers = collectModifiers(actor, "combatRecovery");
  const minActions = Math.max(2, Math.trunc(num(modifiers.minActions, 2)));
  const budget = standardActionBudget(actor, { limitBonus: num(modifiers.actionLimitBonus, 0) });
  const configuredMaximum = Number.isFinite(Number(modifiers.maxActions))
    ? Math.max(minActions, Math.trunc(Number(modifiers.maxActions)))
    : null;
  const actionLimitAttr = configuredMaximum != null ? `max="${configuredMaximum}"` : "";

  const result = await Dialog.wait({
    title: `${actor.name} — Combat Recovery`,
    content: `<div class="dbua-system-dialog-content"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span><i class="fas fa-heart-pulse"></i> Combat Recovery</span><span>1/Round</span></div><div class="combat-panel-body">
      <div class="form-group"><label>Actions gastas</label><input id="dbua-recovery-actions" type="number" min="${minActions}" ${actionLimitAttr} step="1" value="${minActions}"></div>
      <p class="dbua-system-note">Por Action: recupera <b>1d10(bT)</b> LP e Ki e reduz Defense em <b>1(T)</b> até o início do próximo turno. O uso provoca <b>Exploit</b> para oponentes em até 8 Squares.</p>
      <p class="notes">Economia permissiva: o módulo mostra o custo padrão, mas não limita pelo contador base (${budget.spent}/${budget.limit} Actions registradas). Traits/Characteristics podem alterar o total ou remover custos.</p>
      <label class="dbua-standard-check"><input id="dbua-recovery-condition" type="checkbox"> Condition Recovery (não recuperar LP; o Steadfast Check e a remoção da Condition serão resolvidos quando a camada de Checks/Counter estiver integrada)</label>
    </div></div></div>`,
    buttons: {
      use: { icon: '<i class="fas fa-heart-pulse"></i>', label: "Recuperar", callback: html => {
        let actions = Math.max(minActions, Math.trunc(num(html.find("#dbua-recovery-actions").val(), minActions)));
        if (configuredMaximum != null) actions = Math.min(actions, configuredMaximum);
        return { actions, condition: !!html.find("#dbua-recovery-condition").prop("checked") };
      } },
      cancel: { label: "Cancelar", callback: () => null }
    },
    default: "use", close: () => null
  }, { width: 560, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
  if (!result) return null;

  const actions = result.actions;
  // DBU 0.9.2: 1d10(bT) usa o dado uma vez por Base Tier.
  // Para N Actions, portanto, a pool é N × bT dados d10.
  const recoveryFormula = `${actions * bt}d10`;
  const lpRoll = result.condition ? null : await (new Roll(recoveryFormula)).evaluate();
  const kiRoll = await (new Roll(recoveryFormula)).evaluate();
  const lpBefore = Math.max(0, num(actor.system?.lifePoints?.value, 0));
  const lpMax = Math.max(0, num(actor.system?.lifePoints?.max, lpBefore));
  const kiBefore = Math.max(0, num(actor.system?.kiPool?.value, 0));
  const kiMax = Math.max(0, num(actor.system?.kiPool?.max, kiBefore));
  const lpGain = lpRoll ? Math.max(0, num(lpRoll.total, 0)) : 0;
  const kiGain = Math.max(0, num(kiRoll.total, 0));
  const lpAfter = Math.min(lpMax, lpBefore + lpGain);
  const kiAfter = Math.min(kiMax, kiBefore + kiGain);
  const actualLp = lpAfter - lpBefore;
  const actualKi = kiAfter - kiBefore;
  const { cts, round } = getCurrentRoundData(actor);
  round.actions.push({
    type: "combat-recovery",
    dbuStandardKey: "combatRecovery",
    ...roundTrackingMeta(actor),
    actionCost: actions,
    kiCost: 0,
    description: `Combat Recovery — ${actions} Actions${result.condition ? " · Condition Recovery" : ""}`,
    dbuRecoveredLp: actualLp,
    dbuRecoveredKi: actualKi,
    dbuConditionRecovery: !!result.condition
  });

  const buffs = syncGeneratedBuff(actor.system?.customBuffs, RECOVERY_BUFF_MARKER, {
    effect: "Defense Value",
    T: -actions,
    name: "Combat Recovery (DBU Automation)"
  });
  const combat = game.combat;
  const combatant = combatantForActor(actor, combat);
  const sourceToken = tokenFromContext(context, actor);
  const exploitOpponents = [];
  const exploitSeen = new Set();
  for (const token of (canvas?.tokens?.placeables || [])) {
    if (!token?.actor || token.actor.id === actor.id) continue;
    if (!areTeamEnemies(sourceToken, token, combat)) continue;
    if (gridDistanceSquares(sourceToken, token) > 8.001) continue;
    if (exploitSeen.has(token.actor.id)) continue;
    exploitSeen.add(token.actor.id);
    exploitOpponents.push({
      actorId: token.actor.id,
      actorName: String(token.actor.name || token.name || "Oponente"),
      tokenId: token.id || token.document?.id || null
    });
  }
  const exploitOpponentIds = exploitOpponents.map(entry => entry.actorId);
  const exploitOpponentNames = exploitOpponents.map(entry => entry.actorName);
  const flag = {
    active: true,
    actions,
    recoveredLp: actualLp,
    recoveredKi: actualKi,
    conditionRecovery: !!result.condition,
    exploitPending: true,
    exploitOpponentIds,
    exploitOpponentNames,
    usedRound: num(combat?.round, 0),
    combatantId: combatant?.id || null,
    createdAt: Date.now()
  };

  await actor.update({
    "system.lifePoints.value": lpAfter,
    "system.kiPool.value": kiAfter,
    "system.customBuffs": buffs,
    "system.combatTabState": cts,
    [`flags.${MODULE_ID}.${STATE_FLAG}.combatRecovery`]: flag
  });
  for (const opponentId of exploitOpponentIds) {
    const opponentToken = (canvas?.tokens?.placeables || []).find(token => token?.actor?.id === opponentId) || null;
    if (!opponentToken?.actor) continue;
    await registerExploitPending(opponentToken.actor, {
      sourceActor: actor,
      sourceToken,
      recipientToken: opponentToken,
      reason: "Combat Recovery em até 8 Squares"
    });
  }

  try {
    if (lpRoll && game.dice3d) await game.dice3d.showForRoll(lpRoll, game.user, true);
    if (game.dice3d) await game.dice3d.showForRoll(kiRoll, game.user, true);
  } catch {}

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll"><h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-heart-pulse"></i> ${esc(actor.name)} — Combat Recovery</span></h3><div class="dbu-card-body"><div class="dbu-attack-meta"><span class="dbu-meta-chip">Standard · ${actions} Actions</span><span class="dbu-meta-chip">1/Round</span><span class="dbu-meta-chip">Defense −${actions}(T)</span></div><div class="dbu-defend-guide">${result.condition ? `<b>Condition Recovery declarado.</b> LP não foi recuperado. O Steadfast/remoção ficará como resolução assistida nesta etapa Standard.` : `LP <b>${lpBefore} → ${lpAfter}</b> (+${actualLp})`}<br>Ki <b>${kiBefore} → ${kiAfter}</b> (+${actualKi})<br><b>Exploit:</b> ${exploitOpponentIds.length ? `${exploitOpponentIds.length} oponente(s) em até 8 Squares foram registrados como elegíveis.<br><b>Quem pode usar Exploit:</b> ${exploitOpponentNames.map(name => esc(name)).join(", ")}` : `nenhum oponente elegível foi detectado em até 8 Squares`}. A resposta será automatizada na camada Counter.</div></div></div>`
  });
  return flag;
}

function gridDistanceSquares(a, b) {
  if (!a || !b) return Infinity;
  const grid = canvas?.grid?.size || canvas?.dimensions?.size || 100;
  const ac = a.center || { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = b.center || { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y)) / grid;
}

/**
 * Reusable gate for rules-driven movement. A participant in a Grapple must
 * resolve the DBU 0.9.2 Might Clash before Movement, Thrust/Knockback or a
 * future forced-movement handler changes token coordinates.
 */
export function validateGrappleMovement({ actor, token = null, kind = "movement", clashResolved = false } = {}) {
  const grapple = currentGrapple(actor);
  if (!grapple?.active) return { ok: true, requiresClash: false, kind };
  const ownRef = participantFromGrapple(grapple, grapple.role);
  const otherRole = grapple.role === "grappler" ? "grappled" : "grappler";
  const opponentRef = participantFromGrapple(grapple, otherRole);
  const actorToken = tokenDocumentOf(token || resolveParticipantToken(ownRef));
  const sceneId = actorToken?.parent?.id || actorToken?.scene?.id || canvas?.scene?.id || null;
  if (grapple.sceneId && sceneId && grapple.sceneId !== sceneId) {
    return { ok: false, requiresClash: false, kind, grapple, message: "O Grapple pertence a outra Scene; sincronize os tokens antes de mover." };
  }
  if (!clashResolved) {
    return {
      ok: false,
      requiresClash: true,
      kind,
      grapple,
      opponentActor: resolveParticipantActor(opponentRef),
      opponentToken: resolveParticipantToken(opponentRef),
      message: "Movement durante Grapple exige o Might Clash definido em DBU 0.9.2 antes de alterar a posição."
    };
  }
  return { ok: true, requiresClash: false, kind, grapple, linkedMovement: true };
}

function meleeSquares(actor) {
  const raw = actor?.system?.status?.meleeReach ?? actor?.system?.status?.meleeRange ?? 1;
  if (Number.isFinite(Number(raw))) return Math.max(1, Number(raw));
  const m = String(raw).match(/1\s*\+\s*(\d+)/);
  if (m) return 1 + Number(m[1]);
  const first = String(raw).match(/\d+/);
  return Math.max(1, Number(first?.[0] || 1));
}

function tokenDisposition(token) {
  return token?.document?.disposition ?? token?.disposition ?? null;
}

function isAllyToken(sourceToken, otherToken) {
  if (!sourceToken || !otherToken) return true;
  return areTeamAllies(sourceToken, otherToken, game.combat);
}

function candidateAllies(actor, sourceToken = null) {
  const sceneActors = new Map();
  for (const token of (canvas?.tokens?.placeables || [])) {
    if (!token?.actor || token.actor.id === actor.id) continue;
    if (token.actor.type !== "character") continue;
    if (!isAllyToken(sourceToken, token)) continue;
    sceneActors.set(token.actor.id, { actor: token.actor, token });
  }
  return [...sceneActors.values()];
}

function empowerRules(actor) {
  const activeTransformations = (actor?.system?.transformations || []).filter(t => t?.active);
  const text = allText(activeTransformations).join("\n");
  const ext = collectModifiers(actor, "empower");
  return {
    miracleFatigueFree: !!ext.miracleFatigueFree || /Miracle Empowerment without gaining (?:a stack of )?(?:the )?Fatigued/i.test(text),
    capacityMultiplier: Math.max(0, num(ext.capacityMultiplier, 1)),
    maxActions: Number.isFinite(Number(ext.maxActions)) ? Math.max(1, Math.trunc(Number(ext.maxActions))) : null,
    actionLimitBonus: num(ext.actionLimitBonus, 0)
  };
}

async function applyMiracleEmpowerment(source, target, { fatigueFree = false } = {}) {
  let fatigue = null;
  if (!fatigueFree) fatigue = await addConditionStacks(source, "fatigued", 1);
  const effectId = foundry.utils.randomID(12);
  const marker = `${MIRACLE_BUFF_PREFIX}${effectId}`;
  const buffs = appendGeneratedBuff(target.system?.customBuffs, marker, {
    effect: "ToP Extra Dice Cat.",
    flat: 1,
    name: `Miracle Empowerment — ${source.name}`
  });
  const timers = timedEffects(target);
  timers.push({
    id: `miracle:${effectId}`,
    kind: "miracleEmpowerment",
    marker,
    sourceActorId: source.id,
    awaitingNextTurn: true,
    activeTurn: false,
    createdAt: Date.now()
  });
  await gmOrOwnerUpdate(target, {
    "system.customBuffs": buffs,
    [`flags.${MODULE_ID}.${STATE_FLAG}.timedEffects`]: timers
  }, { authorityActor: source });
  return { marker, fatigue };
}

function primaryGM() {
  return (game.users?.contents || []).filter(u => u.active && u.isGM).sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
}

function isPrimaryGM() {
  const gm = primaryGM();
  return !!gm && gm.id === game.user.id;
}

function userOwnsActor(user, actor) {
  if (!user || !actor) return false;
  if (user.isGM) return true;
  try { return actor.testUserPermission?.(user, "OWNER") ?? false; } catch { return false; }
}

function allowedStandardUpdates(updates = {}) {
  const allowed = [
    "system.conditions",
    "system.customBuffs",
    "system.combatTabState",
    "system.kiPool.value",
    "system.status.capacitySpent",
    "system.tracking.powerStacks",
    `flags.${MODULE_ID}.${STATE_FLAG}`
  ];
  const keys = Object.keys(updates || {});
  return keys.length > 0 && keys.every(key => allowed.some(prefix => key === prefix || key.startsWith(`${prefix}.`)));
}

function requestGM(type, payload = {}) {
  const gm = primaryGM();
  if (!gm) return Promise.reject(new Error("Nenhum GM ativo para validar esta atualização."));
  const requestId = foundry.utils.randomID(16);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pendingRequests.delete(requestId);
      reject(new Error("O GM não confirmou a atualização dentro do tempo limite."));
    }, 12000);
    state.pendingRequests.set(requestId, { resolve, reject, timeout });
    game.socket.emit(SOCKET, { type, requestId, requesterId: game.user.id, ...payload });
  });
}

async function gmOrOwnerUpdate(actor, updates, { authorityActor = null } = {}) {
  if (!actor) return false;
  if (game.user.isGM || actor.isOwner) {
    await actor.update(updates);
    return true;
  }
  const result = await requestGM("dbuaStandardActorUpdateRequest", {
    actorRef: participantRef(actor),
    authorityRef: authorityActor ? participantRef(authorityActor) : null,
    updates
  });
  if (!result?.ok) throw new Error(result?.error || `O GM recusou a atualização de ${actor.name}.`);
  return true;
}

async function gmOrOwnerSetFlag(actor, path, value, { authorityActor = null } = {}) {
  if (!actor) return false;
  if (game.user.isGM || actor.isOwner) {
    await actor.setFlag(MODULE_ID, path, value);
    return true;
  }
  const result = await requestGM("dbuaStandardSetFlagRequest", {
    actorRef: participantRef(actor),
    authorityRef: authorityActor ? participantRef(authorityActor) : null,
    path,
    value
  });
  if (!result?.ok) throw new Error(result?.error || `O GM recusou a sincronização de ${actor.name}.`);
  return true;
}

async function registerExploitPending(recipient, {
  sourceActor,
  sourceToken = null,
  recipientToken = null,
  reason,
  combatId = game.combat?.id || null,
  round = num(game.combat?.round, 0)
} = {}) {
  if (!recipient || !sourceActor) return null;
  const id = foundry.utils.randomID(14);
  const all = foundry.utils.deepClone(recipient.getFlag(MODULE_ID, `${STATE_FLAG}.pendingActions`) || {});
  all[id] = {
    id,
    type: "exploit",
    status: "pending",
    reason: reason || "Exploit",
    source: participantRef(sourceActor, sourceToken),
    recipient: participantRef(recipient, recipientToken),
    combatId,
    round,
    createdAt: Date.now()
  };
  await gmOrOwnerSetFlag(recipient, `${STATE_FLAG}.pendingActions`, all, { authorityActor: sourceActor });
  return all[id];
}

export function getStandardPendingActions(actor) {
  const all = actor?.getFlag?.(MODULE_ID, `${STATE_FLAG}.pendingActions`) || {};
  return Object.values(all).filter(row => row?.status === "pending" && ["exploit", "grappleEscape", "grappleClash"].includes(row?.type));
}

async function setPendingActionStatus(actor, pendingId, status, extra = {}) {
  const all = foundry.utils.deepClone(actor?.getFlag?.(MODULE_ID, `${STATE_FLAG}.pendingActions`) || {});
  const current = all?.[pendingId];
  if (!current) return null;
  all[pendingId] = { ...current, ...extra, status, resolvedAt: status === "pending" ? null : Date.now() };
  await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.pendingActions`, all, { authorityActor: actor });
  return all[pendingId];
}

/**
 * Resolve um Exploit já criado por uma regra do módulo. Nesta etapa o gatilho
 * principal é Combat Recovery: o oponente pode ignorar ou usar o mesmo Attack
 * Core existente, limitado a Basic Attack/Attack References e travado no alvo
 * que provocou o Exploit. Counter Actions são registradas, nunca bloqueadas.
 */
export async function respondExploitPending(actor, pendingId, choice = "attack") {
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Exploit: selecione o personagem que recebeu a oportunidade.");
  const all = actor.getFlag?.(MODULE_ID, `${STATE_FLAG}.pendingActions`) || {};
  const pending = all?.[pendingId];
  if (!pending || pending.type !== "exploit" || pending.status !== "pending") {
    return ui.notifications.warn("DBU Exploit: essa oportunidade não está mais pendente.");
  }

  if (String(choice) === "ignore") {
    await setPendingActionStatus(actor, pendingId, "ignored", { ignoredAt: Date.now() });
    return { ignored: true, pendingId };
  }

  const sourceActor = resolveParticipantActor(pending.source);
  const sourceToken = resolveParticipantToken(pending.source)
    || (canvas?.tokens?.placeables || []).find(token => token?.actor?.id === sourceActor?.id)
    || null;
  const actorToken = resolveParticipantToken(pending.recipient)
    || tokenFromContext({}, actor);
  if (!sourceActor || !sourceToken) {
    return ui.notifications.warn("DBU Exploit: o personagem/token que provocou o Exploit não foi encontrado na cena.");
  }
  if (!actorToken?.actor) {
    return ui.notifications.warn(`DBU Exploit: o token de ${actor.name} não foi encontrado na cena.`);
  }
  if (typeof globalThis.DBUAutomation?.attack !== "function") {
    return ui.notifications.error("DBU Exploit: Attack Core não está disponível.");
  }

  await setPendingActionStatus(actor, pendingId, "resolving", { resolvingAt: Date.now() });

  // Economia permissiva: apenas registra a Counter Action padrão.
  const { cts, round } = getCurrentRoundData(actor);
  cts.roundCounterCount = Math.max(0, Math.trunc(num(cts.roundCounterCount, 0))) + 1;
  round.actions.push({
    type: "defend",
    source: "exploit",
    actionCost: 0,
    counterCost: 1,
    kiCost: 0,
    dkpCost: 0,
    kiWager: 0,
    description: `Exploit → ${sourceActor.name}`,
    dbuExploitPendingId: pendingId,
    dbuCounterInformativeOnly: true
  });
  await actor.update({ "system.combatTabState": cts });

  let result = null;
  try {
    result = await globalThis.DBUAutomation.attack({
      actor,
      token: actorToken,
      attackerToken: actorToken,
      target: sourceToken,
      targetToken: sourceToken,
      targets: [sourceToken],
      basicOnly: true,
      skipAreaTemplate: false,
      effectiveType: "out-of-sequence",
      timingOverride: true,
      __dbuaActionValidated: true,
      attackMode: "exploit",
      exploitSource: String(pending.reason || "Exploit"),
      exploitPendingId: pendingId,
      exploitRecoveryActorId: sourceActor.id,
      dialogTitle: `${actor.name} — Exploit contra ${sourceActor.name}`
    });
  } catch (error) {
    await setPendingActionStatus(actor, pendingId, "pending", { resolvingAt: null }).catch(() => {});
    throw error;
  }

  if (!result) {
    await setPendingActionStatus(actor, pendingId, "pending", { resolvingAt: null }).catch(() => {});
    return null;
  }

  await setPendingActionStatus(actor, pendingId, "used", { usedAt: Date.now(), attackMessageId: result?.messageId || null });
  return { used: true, pendingId, attack: result };
}

async function beginTurnGrappleEscape(combat, changes = {}) {
  if (!foundry.utils.hasProperty(changes, "turn") && !foundry.utils.hasProperty(changes, "round")) return null;
  const authority = primaryGM();
  const active = combat?.combatant;
  const grappled = active?.actor;
  if (!grappled || (authority ? !isPrimaryGM() : !grappled.isOwner)) return null;
  const grapple = currentGrapple(grappled);
  if (!grapple?.active || grapple.role !== "grappled") return null;
  const cursor = `${combat.id}:${num(combat.round, 0)}:${num(combat.turn, 0)}`;
  if (grapple.escapeAttemptCursor === cursor) return null;
  const grappler = grappleActor(grapple, "grappler");
  if (!grappler) {
    console.error("DBU Standard | Grappler não encontrado no escape automático", grapple);
    return null;
  }

  const challengerRoll = await evaluateGrappleCheck(grappled, await preparedStrike(grappled));
  const pendingId = foundry.utils.randomID(14);
  const all = foundry.utils.deepClone(grappler.getFlag(MODULE_ID, `${STATE_FLAG}.pendingActions`) || {});
  all[pendingId] = {
    id: pendingId,
    type: "grappleEscape",
    status: "pending",
    grappleId: grapple.grappleId || grapple.id,
    challenger: participantFromGrapple(grapple, "grappled"),
    responder: participantFromGrapple(grapple, "grappler"),
    challengerRoll,
    combatId: combat.id,
    round: num(combat.round, 0),
    turn: num(combat.turn, 0),
    createdAt: Date.now()
  };
  const updated = { ...grapple, escapeAttemptCursor: cursor };
  const grapplerState = currentGrapple(grappler);
  await gmOrOwnerSetFlag(grappled, `${STATE_FLAG}.grapple`, updated, { authorityActor: grappled });
  if (grapplerState) await gmOrOwnerSetFlag(grappler, `${STATE_FLAG}.grapple`, { ...grapplerState, escapeAttemptCursor: cursor }, { authorityActor: grappled });
  await gmOrOwnerSetFlag(grappler, `${STATE_FLAG}.pendingActions`, all, { authorityActor: grappled });
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: grappled }),
    content: `<div class="dbu-attack-roll"><h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-unlink"></i> ${esc(grappled.name)} — Escape do Grapple</span></h3><div class="dbu-card-body"><div class="dbu-defend-guide">No início do turno, ${esc(grappled.name)} fez o Grapple Check: <b>${challengerRoll.total}</b>.<br>${esc(grappler.name)} deve responder com Strike ou Dodge. Empates favorecem o Grappler.</div><div class="dbu-card-buttons"><button type="button" data-dbua-grapple-escape="${pendingId}" data-dbua-choice="strike"><i class="fas fa-fist-raised"></i> Strike</button><button type="button" data-dbua-grapple-escape="${pendingId}" data-dbua-choice="dodge"><i class="fas fa-running"></i> Dodge</button></div></div></div>`
  });
  globalThis.DBUAutomation?.renderCombatHud?.();
  return all[pendingId];
}

export async function respondGrappleEscape(actor, pendingId, choice) {
  if (!actor || !canControl(actor)) return ui.notifications.warn("A resposta do Grapple exige controle do Grappler.");
  const all = foundry.utils.deepClone(actor.getFlag(MODULE_ID, `${STATE_FLAG}.pendingActions`) || {});
  const pending = all[pendingId];
  if (!pending || pending.type !== "grappleEscape" || pending.status !== "pending") return ui.notifications.warn("Esta tentativa de escape não está mais pendente.");
  const grapple = currentGrapple(actor);
  if (!grapple?.active || (grapple.grappleId || grapple.id) !== pending.grappleId) return ui.notifications.warn("O Grapple desta pendência não está mais ativo.");
  const prepared = choice === "dodge" ? await preparedDodge(actor) : await preparedStrike(actor);
  const responseRoll = await evaluateGrappleCheck(actor, prepared);
  const escaped = num(pending.challengerRoll?.total, 0) > responseRoll.total;
  pending.status = "resolved";
  pending.choice = choice === "dodge" ? "dodge" : "strike";
  pending.responseRoll = responseRoll;
  pending.escaped = escaped;
  pending.resolvedAt = Date.now();
  await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.pendingActions`, all, { authorityActor: actor });
  if (escaped) await endGrapple(grapple);
  const grappled = resolveParticipantActor(pending.challenger || {});
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>Escape do Grapple:</b> ${esc(grappled?.name || "Grappled")} ${num(pending.challengerRoll?.total, 0)} vs ${esc(actor.name)} ${responseRoll.total} (${esc(pending.choice)}). <b>${escaped ? "O Grappled escapou." : "O Grapple continua."}</b></div></div></div>`
  });
  globalThis.DBUAutomation?.renderCombatHud?.();
  return { escaped, challengerRoll: pending.challengerRoll, responseRoll };
}

async function completeSyntheticClashAsAuthority(responder, pendingId, choice, responseRoll) {
  const all = foundry.utils.deepClone(responder.getFlag(MODULE_ID, `${STATE_FLAG}.pendingActions`) || {});
  const pending = all[pendingId];
  if (!pending || pending.type !== "grappleClash" || pending.status !== "pending") throw new Error("Este Grapple Check não está mais pendente.");
  const initiator = resolveParticipantActor(pending.initiator || {});
  if (!initiator) throw new Error("Iniciador do Grapple Check não encontrado.");
  await resolvePendingClash(initiator, responder, pendingId, pending.initiatorRoll, responseRoll, {
    ...(pending.meta || {}),
    targetActorId: responder.id,
    target: pending.responder,
    initiator: pending.initiator
  });
  pending.status = "resolved";
  pending.choice = choice;
  pending.responseRoll = responseRoll;
  pending.resolvedAt = Date.now();
  await gmOrOwnerSetFlag(responder, `${STATE_FLAG}.pendingActions`, all, { authorityActor: responder });
  return { initiator, responder, initiatorRoll: pending.initiatorRoll, responseRoll };
}

export async function respondSyntheticGrappleClash(actor, pendingId, choice) {
  if (!actor || !canControl(actor)) return ui.notifications.warn("A resposta exige controle do personagem.");
  const pending = actor.getFlag(MODULE_ID, `${STATE_FLAG}.pendingActions.${pendingId}`);
  if (!pending || pending.type !== "grappleClash" || pending.status !== "pending") return ui.notifications.warn("Este Grapple Check não está mais pendente.");
  let prepared;
  if (pending.responderKind === "might") {
    const might = Math.max(0, num(actor.system?.status?.mightForClashes ?? actor.system?.status?.might, 0));
    prepared = { formula: `1d10+${might}`, ct: 10 };
    choice = "might";
  } else {
    prepared = choice === "dodge" ? await preparedDodge(actor) : await preparedStrike(actor);
    choice = choice === "dodge" ? "dodge" : "strike";
  }
  const responseRoll = await evaluateGrappleCheck(actor, prepared);
  if (!game.user.isGM && primaryGM()) {
    const response = await requestGM("dbuaStandardResolveSyntheticClashRequest", {
      responderRef: participantRef(actor),
      pendingId,
      choice,
      responseRoll
    });
    if (!response?.ok) throw new Error(response?.error || "O GM não confirmou o Grapple Check.");
  } else {
    await completeSyntheticClashAsAuthority(actor, pendingId, choice, responseRoll);
  }
  return { responseRoll };
}

async function applyEmpowerTransaction(source, target, {
  amount,
  capacityCost,
  actions,
  sourceKiBefore,
  sourceCapacityBefore,
  targetKiBefore,
  combatTabState
}) {
  const payload = {
    sourceRef: participantRef(source),
    targetRef: participantRef(target),
    amount,
    capacityCost,
    actions,
    sourceKiBefore,
    sourceCapacityBefore,
    targetKiBefore,
    combatTabState
  };
  if (!game.user.isGM && !target.isOwner) {
    const response = await requestGM("dbuaStandardEmpowerRequest", payload);
    if (!response?.ok) throw new Error(response?.error || "O GM não confirmou o Empower.");
    return true;
  }

  const targetAfter = targetKiBefore + amount;
  await target.update({ "system.kiPool.value": targetAfter });
  try {
    await source.update({
      "system.kiPool.value": sourceKiBefore - amount,
      "system.status.capacitySpent": sourceCapacityBefore + capacityCost,
      "system.combatTabState": combatTabState
    });
  } catch (error) {
    await target.update({ "system.kiPool.value": targetKiBefore }).catch(() => {});
    throw error;
  }
  return true;
}

async function empower(context = {}) {
  const actor = actorFromContext(context);
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Empower: selecione seu personagem.");
  if (roundUses(actor, "empower") > 0) return ui.notifications.warn(`${actor.name}: Empower já usado neste Round.`);
  const sourceToken = tokenFromContext(context, actor);
  const rules = empowerRules(actor);
  const budget = standardActionBudget(actor, { limitBonus: rules.actionLimitBonus });
  const explicitMaxActions = Number.isFinite(Number(rules.maxActions)) ? Math.max(1, Math.trunc(Number(rules.maxActions))) : null;
  const targets = Array.from(game.user?.targets || []).filter(t => t.actor && t.actor.id !== actor.id && t.actor.type === "character" && isAllyToken(sourceToken, t));
  const allies = candidateAllies(actor, sourceToken);
  const choices = targets.length ? targets.map(t => ({ actor: t.actor, token: t })) : allies;
  if (!choices.length) return ui.notifications.warn("DBU Empower: marque um aliado como Target ou tenha outro aliado na cena.");

  const options = choices.map(({ actor: a, token }) => `<option value="${esc(a.id)}">${esc(a.name)}${token ? ` · ${gridDistanceSquares(sourceToken, token).toFixed(1)} sq` : ""}</option>`).join("");
  const might = Math.max(0, num(actor.system?.status?.might, 0));
  const fatigued = (actor.system?.conditions || []).find(c => c?.id === "fatigued");
  const fatiguedStacks = fatigued?.active ? Math.max(0, Math.trunc(num(fatigued.stacks, 0))) : 0;
  const fatiguedMax = Math.max(1, Math.trunc(num(fatigued?.maxStacks, 2)));
  const miracleCanPay = rules.miracleFatigueFree || fatiguedStacks < fatiguedMax;
  const empowerActionLimitAttr = explicitMaxActions != null ? `max="${explicitMaxActions}"` : "";
  const result = await Dialog.wait({
    title: `${actor.name} — Empower`,
    content: `<div class="dbua-system-dialog-content"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span><i class="fas fa-hands-helping"></i> Empower</span><span>1/Round</span></div><div class="combat-panel-body">
      <div class="form-group"><label>Aliado</label><select id="dbua-empower-target">${options}</select></div>
      <div class="form-group"><label>Actions gastas</label><input id="dbua-empower-actions" type="number" min="1" ${empowerActionLimitAttr} step="1" value="1"></div>
      <p class="notes">Economia permissiva: Actions base registradas ${budget.spent}/${budget.limit}. O módulo não bloqueia usos extras concedidos por outros efeitos.</p>
      <div class="form-group"><label>Ki a transferir</label><input id="dbua-empower-ki" type="number" min="0" step="1" value="0"></div>
      <p class="notes">Por Action: até <b>2× Might</b> Ki; dentro do Melee Range, o limite dobra. Transferir Ki consome a mesma quantidade de Capacity.</p>
      <label class="dbua-standard-check ${miracleCanPay ? "" : "disabled"}"><input id="dbua-empower-miracle" type="checkbox" ${miracleCanPay ? "" : "disabled"}> <b>Miracle Empowerment</b> — o alvo aumenta ToP Extra Dice em +1 Dice Category até o fim do próximo turno e é tratado como estando em Melee para este Empower.${rules.miracleFatigueFree ? " <b>Seu efeito atual remove o custo de Fatigued.</b>" : " Você sofre +1 stack de Fatigued."}</label>
      ${!miracleCanPay ? `<p class="notes"><b>Miracle indisponível:</b> você já está no máximo de stacks de Fatigued.</p>` : ""}
    </div></div></div>`,
    buttons: {
      use: { icon: '<i class="fas fa-hands-helping"></i>', label: "Empower", callback: html => {
        let actions = Math.max(1, Math.trunc(num(html.find("#dbua-empower-actions").val(), 1)));
        if (explicitMaxActions != null) actions = Math.min(actions, explicitMaxActions);
        return { targetId: String(html.find("#dbua-empower-target").val() || ""), actions, amount: Math.max(0, Math.trunc(num(html.find("#dbua-empower-ki").val(), 0))), miracle: !!html.find("#dbua-empower-miracle").prop("checked") };
      } },
      cancel: { label: "Cancelar", callback: () => null }
    }, default: "use", close: () => null
  }, { width: 560, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
  if (!result) return null;
  if (result.miracle && !miracleCanPay) return ui.notifications.warn("Miracle Empowerment: não é possível sofrer outra stack de Fatigued.");

  const target = game.actors?.get?.(result.targetId);
  if (!target) return ui.notifications.warn("Aliado do Empower não encontrado.");
  if (!game.user.isGM && !target.isOwner && !primaryGM()) return ui.notifications.warn(`Empower em ${target.name}: é necessário um GM ativo para sincronizar a ficha de outro jogador.`);
  const targetToken = (canvas?.tokens?.placeables || []).find(t => t.actor?.id === target.id) || null;
  if (!isAllyToken(sourceToken, targetToken)) return ui.notifications.warn(`${target.name} não está identificado como Ally na cena.`);
  const dist = gridDistanceSquares(sourceToken, targetToken);
  const naturallyInMelee = dist <= meleeSquares(actor) + 0.001;
  const inMelee = naturallyInMelee || !!result.miracle;
  const perAction = 2 * might * (inMelee ? 2 : 1);
  const ruleMax = perAction * result.actions;
  const srcKi = Math.max(0, num(actor.system?.kiPool?.value, 0));
  const cap = capacity(actor);
  const capacityBudget = rules.capacityMultiplier > 0 ? Math.floor(cap.left / rules.capacityMultiplier) : Number.POSITIVE_INFINITY;
  const targetKi = Math.max(0, num(target.system?.kiPool?.value, 0));
  const targetMax = Math.max(0, num(target.system?.kiPool?.max, targetKi));
  const room = Math.max(0, targetMax - targetKi);
  const maxTransfer = Math.max(0, Math.min(ruleMax, srcKi, capacityBudget, room));
  const amount = Math.min(result.amount, maxTransfer);
  if (amount <= 0) return ui.notifications.warn(`Empower sem transferência. Máximo atual: ${maxTransfer} Ki.`);

  const capacityCost = Math.max(0, Math.ceil(amount * rules.capacityMultiplier));
  const { cts, round } = getCurrentRoundData(actor);
  round.actions.push({ type: "empower", dbuStandardKey: "empower", ...roundTrackingMeta(actor), actionCost: result.actions, kiCost: 0, description: `Empower → ${target.name}: ${amount} Ki${result.miracle ? " · Miracle" : ""}`, dbuEmpowerTargetId: target.id, dbuEmpowerAmount: amount, dbuMiracleEmpowerment: !!result.miracle });
  await applyEmpowerTransaction(actor, target, {
    amount,
    capacityCost,
    actions: result.actions,
    sourceKiBefore: srcKi,
    sourceCapacityBefore: cap.spent,
    targetKiBefore: targetKi,
    combatTabState: cts
  });
  let miracleResult = null;
  if (result.miracle) miracleResult = await applyMiracleEmpowerment(actor, target, { fatigueFree: rules.miracleFatigueFree });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll"><h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-hands-helping"></i> ${esc(actor.name)} — Empower</span></h3><div class="dbu-card-body"><div class="dbu-attack-meta"><span class="dbu-meta-chip">Standard · ${result.actions} Action${result.actions === 1 ? "" : "s"}</span><span class="dbu-meta-chip">${result.miracle ? "Miracle · tratado como Melee" : naturallyInMelee ? "Melee Range ×2" : `Distância ${Number.isFinite(dist) ? dist.toFixed(1) : "?"} sq`}</span></div><div class="dbu-defend-guide"><b>${esc(target.name)}</b> recebe <b>${amount} Ki</b>.<br>${esc(actor.name)}: −${amount} Ki · +${capacityCost} Capacity spent.<br>Limite deste uso: ${ruleMax} Ki; limite real antes da transferência: ${maxTransfer}.${result.miracle ? `<br><b>Miracle Empowerment:</b> ${esc(target.name)} recebe +1 Dice Category em ToP Extra Dice até o fim do próximo turno.${rules.miracleFatigueFree ? " Sem Fatigued por efeito atual." : ` ${esc(actor.name)} sofre +1 stack de Fatigued.`}` : ""}</div></div></div>`
  });
  return { target, amount, actions: result.actions, inMelee, miracle: !!result.miracle, miracleResult };
}

async function loadNativeClash() {
  try {
    return await import(`/systems/${game.system.id}/module/helpers/duel.mjs`);
  } catch (error) {
    console.error("DBU Standard | Não foi possível importar initiateClash nativo.", error);
    return null;
  }
}

async function preparedStrike(actor) {
  const sheet = actor?.sheet;
  if (!sheet) return { formula: "1d10", ct: 10 };
  try { await sheet.getData(); } catch {}
  return {
    formula: sheet._trackerDefend?.strikeFormula || "1d10",
    ct: sheet._calcCombatCTs?.(actor.system)?.strikeCT || 10
  };
}

async function preparedDodge(actor) {
  const sheet = actor?.sheet;
  if (!sheet) {
    const fallback = num(actor?.system?.aptitudes?.defenseValue, 0) + num(actor?.system?.aptitudes?.dodgeBuffTotal, 0);
    return { formula: `1d10${fallback >= 0 ? "+" : ""}${fallback}`, ct: 10 };
  }
  try { await sheet.getData(); } catch {}
  const fallback = num(actor?.system?.aptitudes?.defenseValue, 0) + num(actor?.system?.aptitudes?.dodgeBuffTotal, 0);
  return {
    formula: sheet._trackerDodge?.formula || `1d10${fallback >= 0 ? "+" : ""}${fallback}`,
    ct: sheet._trackerDodge?.ct || sheet._calcCombatCTs?.(actor.system)?.dodgeCT || 10
  };
}

async function evaluateGrappleCheck(actor, prepared) {
  const roll = await (new Roll(prepared.formula || "1d10")).evaluate();
  const natural = num(roll.dice?.[0]?.results?.[0]?.result, 0);
  const ct = num(prepared.ct, 10);
  const critical = natural >= ct;
  const botch = natural === 1;
  let criticalRoll = null;
  if (critical) {
    const formula = actor?.sheet?._critExtraFormula?.(tier(actor));
    if (formula) criticalRoll = await (new Roll(formula)).evaluate();
  }
  const total = num(roll.total, 0) + num(criticalRoll?.total, 0) - (botch ? 2 * baseTier(actor) : 0);
  try {
    if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
    if (criticalRoll && game.dice3d) await game.dice3d.showForRoll(criticalRoll, game.user, true);
  } catch {}
  return { formula: prepared.formula, natural, ct, critical, botch, criticalTotal: num(criticalRoll?.total, 0), total };
}

function targetOne(context, label) {
  const list = Array.from(game.user?.targets || []).filter(t => t?.actor);
  if (list.length !== 1) {
    ui.notifications.warn(`${label}: marque exatamente 1 alvo.`);
    return null;
  }
  return list[0];
}

function tailEligible(actor) {
  const text = JSON.stringify(actor?.system || {}).toLowerCase();
  return /tail attack|tail_attack/.test(text) || (/saiyan/.test(text) && /tail/.test(text));
}

function conditionActive(actor, id) {
  return economyConditionActive(actor, id);
}

function saiyanTailWeaknessApplies(actor) {
  if (String(actor?.system?.race || "").toLowerCase() !== "saiyan") return false;
  const heritageId = "41c68475bc754d8d";
  if (!(actor.system?.racialTraits || []).includes(heritageId)) return false;
  const sel = actor.system?.racialOptionSelections?.[heritageId];
  const tailed = String(sel?.["1"] ?? sel?.[1] ?? "").toLowerCase() === "tailed";
  if (!tailed) return false;
  const resistant = (actor.system?.talents || []).includes("saiyan_tail_resistance");
  return !resistant;
}

async function startNativeClash(actor, targetActor, opts, pendingMeta) {
  if (actor?.isToken || targetActor?.isToken) {
    const clashId = foundry.utils.randomID(12);
    const initiatorRoll = await evaluateGrappleCheck(actor, { formula: opts.formula, ct: opts.ct });
    const all = foundry.utils.deepClone(targetActor.getFlag(MODULE_ID, `${STATE_FLAG}.pendingActions`) || {});
    all[clashId] = {
      id: clashId,
      type: "grappleClash",
      status: "pending",
      label: opts.label,
      note: opts.note,
      responderKind: opts.responderKind || "strike-or-dodge",
      initiator: pendingMeta?.initiator || participantRef(actor),
      responder: pendingMeta?.target || participantRef(targetActor),
      initiatorRoll,
      meta: pendingMeta,
      createdAt: Date.now()
    };
    await gmOrOwnerSetFlag(targetActor, `${STATE_FLAG}.pendingActions`, all, { authorityActor: actor });
    const buttons = opts.responderKind === "might"
      ? `<button type="button" data-dbua-grapple-clash="${clashId}" data-dbua-choice="might"><i class="fas fa-dumbbell"></i> Might</button>`
      : `<button type="button" data-dbua-grapple-clash="${clashId}" data-dbua-choice="strike"><i class="fas fa-fist-raised"></i> Strike</button><button type="button" data-dbua-grapple-clash="${clashId}" data-dbua-choice="dodge"><i class="fas fa-running"></i> Dodge</button>`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="dbu-attack-roll"><h3 class="dbu-attack-title"><span class="dbu-card-title-text">${esc(opts.label)}</span></h3><div class="dbu-card-body"><div class="dbu-defend-guide">${esc(actor.name)}: <b>${initiatorRoll.total}</b><br>${esc(opts.note || "")}</div><div class="dbu-card-buttons">${buttons}</div></div></div>`
    });
    return clashId;
  }
  const native = await loadNativeClash();
  if (typeof native?.initiateClash !== "function") return ui.notifications.error("DBU: initiateClash nativo não encontrado.");
  const before = new Set(Object.keys(actor.getFlag(SYS_ID, "clashes") || {}));
  await native.initiateClash(actor, opts);
  const after = actor.getFlag(SYS_ID, "clashes") || {};
  const clashId = Object.keys(after).find(id => !before.has(id));
  if (!clashId) return null;
  const root = foundry.utils.deepClone(actor.getFlag(MODULE_ID, `${STATE_FLAG}.pendingClashes`) || {});
  root[clashId] = {
    ...pendingMeta,
    clashId,
    targetActorId: targetActor?.id || null,
    initiator: pendingMeta?.initiator || participantRef(actor),
    target: pendingMeta?.target || participantRef(targetActor),
    createdAt: Date.now(),
    resolved: false
  };
  await actor.setFlag(MODULE_ID, `${STATE_FLAG}.pendingClashes`, root);
  return clashId;
}

async function grapple(context = {}) {
  const actor = actorFromContext(context);
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Grapple: selecione seu personagem.");
  if (currentGrapple(actor)) return ui.notifications.warn(`${actor.name} já está em um Grapple.`);
  if (roundUses(actor, "grapple") > 0) return ui.notifications.warn(`${actor.name}: Grapple já usado neste Round.`);
  const targetToken = targetOne(context, "Grapple");
  if (!targetToken) return null;
  const target = targetToken.actor;
  const actorToken = tokenFromContext(context, actor);
  if (gridDistanceSquares(actorToken, targetToken) > meleeSquares(actor) + 0.001) return ui.notifications.warn(`${target.name} está fora do Melee Range.`);
  if (currentGrapple(target)) {
    await postRuleCard(actor, "Grappling a Grapple", "O alvo já está em um Grapple. Pela 0.9.2, primeiro é necessário um Might Clash contra o Grappler atual. A cadeia completa será habilitada quando o módulo de movimento/Instant estiver integrado; esta tentativa não foi executada.");
    return null;
  }

  const strike = await preparedStrike(actor);
  const canTail = tailEligible(target);
  const choice = await Dialog.wait({
    title: `${actor.name} — Grapple`,
    content: `<div class="dbua-system-dialog-content"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span><i class="fas fa-hand-rock"></i> Grapple Maneuver</span><span>1/Round · 1 Action</span></div><div class="combat-panel-body"><p>Alvo: <b>${esc(target.name)}</b> · Strike vs Strike/Dodge.</p>${canTail ? `<label class="dbua-standard-check"><input id="dbua-tail" type="checkbox"> Tail Restraint (−2(T) no Grapple Check; se vencer, bloqueia Tail Attack durante este Grapple)</label>` : ""}</div></div></div>`,
    buttons: { use: { label: "Grapple", callback: html => ({ tail: !!html.find("#dbua-tail").prop("checked") }) }, cancel: { label: "Cancelar", callback: () => null } }, default: "use", close: () => null
  }, { width: 520, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
  if (!choice) return null;

  const penalty = choice.tail ? 2 * tier(actor) : 0;
  const { cts, round } = getCurrentRoundData(actor);
  round.actions.push({ type: "grapple", dbuStandardKey: "grapple", ...roundTrackingMeta(actor), actionCost: 1, kiCost: 0, description: `Grapple → ${target.name}${choice.tail ? " · Tail Restraint" : ""}` });
  await actor.update({ "system.combatTabState": cts });
  return startNativeClash(actor, target, {
    type: "grapple",
    option: choice.tail ? "tail" : "init",
    label: `${choice.tail ? "Grapple — Tail Restraint" : "Grapple Check"} → ${target.name}`,
    formula: penalty ? `${strike.formula}-${penalty}` : strike.formula,
    ct: strike.ct,
    responderKind: "strike-or-dodge",
    note: `${target.name} deve responder. ${choice.tail ? `Tail Restraint: −${penalty} no Strike do Grappler.` : "Win: Grapple estabelecido; lose: Exploit para o alvo."}`
  }, { kind: "grapple-init", tail: !!choice.tail, initiator: participantRef(actor, actorToken), target: participantRef(target, targetToken) });
}

async function launch(context = {}) {
  const actor = actorFromContext(context);
  const gr = currentGrapple(actor);
  if (!actor || !gr || gr.role !== "grappler") return ui.notifications.warn("Launch só pode ser usado pelo Grappler.");
  if (roundUses(actor, "launch") > 0) return ui.notifications.warn(`${actor.name}: Launch já usado neste Round.`);
  const target = grappleActor(gr, "grappled");
  if (!target) return ui.notifications.warn("Grappled não encontrado.");
  const strike = await preparedStrike(actor);
  const { cts, round } = getCurrentRoundData(actor);
  round.actions.push({ type: "launch", dbuStandardKey: "launch", ...roundTrackingMeta(actor), actionCost: 1, kiCost: 0, description: `Launch → ${target.name}` });
  await actor.update({ "system.combatTabState": cts });
  return startNativeClash(actor, target, {
    type: "grapple", option: "launch", label: `Launch → ${target.name}`, formula: strike.formula, ct: strike.ct, responderKind: "strike-or-dodge",
    note: `Win: você PODE encerrar o Grapple para lançar ${target.name} até ${Math.max(0, num(actor.system?.status?.might, 0))} Squares. Lose: ${target.name} escapa.`
  }, { kind: "launch", initiator: participantFromGrapple(gr, "grappler"), target: participantFromGrapple(gr, "grappled") });
}

async function pin(context = {}) {
  const actor = actorFromContext(context);
  const gr = currentGrapple(actor);
  if (!actor || !gr || gr.role !== "grappler") return ui.notifications.warn("Pin só pode ser usado pelo Grappler.");
  if (roundUses(actor, "pin") > 0) return ui.notifications.warn(`${actor.name}: Pin já usado neste Round.`);
  const target = grappleActor(gr, "grappled");
  if (!target) return ui.notifications.warn("Grappled não encontrado.");
  const might = Math.max(0, num(actor.system?.status?.mightForClashes ?? actor.system?.status?.might, 0));
  const { cts, round } = getCurrentRoundData(actor);
  round.actions.push({ type: "pin", dbuStandardKey: "pin", ...roundTrackingMeta(actor), actionCost: 1, kiCost: 0, description: `Pin → ${target.name}` });
  await actor.update({ "system.combatTabState": cts });
  return startNativeClash(actor, target, {
    type: "grapple", option: "pin-dbua", label: `Pin → ${target.name}`, formula: `1d10+${might}`, ct: 10, responderKind: "might",
    note: "Might Clash. Win: Pinned enquanto durar este Grapple. Lose: o Grappled escapa."
  }, { kind: "pin", initiator: participantFromGrapple(gr, "grappler"), target: participantFromGrapple(gr, "grappled") });
}

async function completeLaunch(context = {}) {
  const actor = actorFromContext(context);
  const ready = actor?.getFlag?.(MODULE_ID, `${STATE_FLAG}.launchReady`);
  const gr = currentGrapple(actor);
  if (!actor || !ready?.active || !gr?.active || gr.role !== "grappler") return ui.notifications.warn("Nenhum Launch aguardando conclusão.");
  const target = grappleActor(gr, "grappled") || game.actors?.get?.(ready.targetId);
  const choice = await Dialog.wait({
    title: `${actor.name} — Concluir Launch`,
    content: `<div class="dbua-system-dialog-content"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span><i class="fas fa-rocket"></i> Launch venceu</span><span>continuação</span></div><div class="combat-panel-body"><p>Você venceu o Grapple Check contra <b>${esc(target?.name || "Grappled")}</b>.</p><p>Pela 0.9.2, você <b>pode</b> encerrar o Grapple para lançar o alvo até <b>${Math.max(0, num(ready.maxSquares, 0))} Squares</b>, ou manter o Grapple.</p></div></div></div>`,
    buttons: {
      throw: { icon: '<i class="fas fa-rocket"></i>', label: "Lançar e encerrar Grapple", callback: () => "throw" },
      keep: { icon: '<i class="fas fa-hand-rock"></i>', label: "Manter Grapple", callback: () => "keep" }
    },
    default: "throw", close: () => null
  }, { width: 520, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
  if (!choice) return null;
  await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.launchReady`, null);
  if (choice === "keep") {
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>Launch:</b> ${esc(actor.name)} venceu o Check, mas escolheu <b>manter o Grapple</b>.</div></div></div>` });
    return { launched: false, kept: true };
  }
  await endGrapple(gr);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>Launch:</b> ${esc(actor.name)} encerra o Grapple e lança ${esc(target?.name || "o alvo")} até <b>${Math.max(0, num(ready.maxSquares, 0))} Squares</b> em uma direção escolhida. <b>Posicione o token manualmente</b>; Walls e Collision continuam sob controle do mapa/ARC nesta versão de teste.</div></div></div>`
  });
  return { launched: true, maxSquares: Math.max(0, num(ready.maxSquares, 0)), target };
}

async function escapePin(context = {}) {
  const actor = actorFromContext(context);
  const gr = currentGrapple(actor);
  if (!actor || !gr?.active || gr.role !== "grappled" || !gr.pinned || !conditionActive(actor, "pinned")) return ui.notifications.warn("Escape Pinned só aparece enquanto você estiver Pinned neste Grapple.");
  const grappler = grappleActor(gr, "grappler");
  if (!grappler) return ui.notifications.warn("Grappler não encontrado.");
  if (roundUses(actor, "escapePin") > 0) return ui.notifications.warn(`${actor.name}: sua Action deste Round para escapar de Pinned já foi usada.`);
  const might = Math.max(0, num(actor.system?.status?.mightForClashes ?? actor.system?.status?.might, 0));
  const { cts, round } = getCurrentRoundData(actor);
  round.actions.push({ type: "escape-pin", dbuStandardKey: "escapePin", ...roundTrackingMeta(actor), actionCost: 1, kiCost: 0, description: `Escape Pinned → ${grappler.name}` });
  await actor.update({ "system.combatTabState": cts });
  return startNativeClash(actor, grappler, {
    type: "grapple", option: "escape-pin-dbua", label: `Escape Pinned → ${grappler.name}`, formula: `1d10+${might}`, ct: 10, responderKind: "might",
    note: "Pinned: gaste 1 Action e vença o Might Clash para remover Pinned. O Grapple continua."
  }, { kind: "escape-pin", initiator: participantFromGrapple(gr, "grappled"), target: participantFromGrapple(gr, "grappler") });
}

async function thrust(context = {}) {
  const actor = actorFromContext(context);
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Thrust: selecione seu personagem.");
  if (roundUses(actor, "thrust") > 0) return ui.notifications.warn(`${actor.name}: Thrust já usado neste Round.`);
  const targetToken = targetOne(context, "Thrust");
  if (!targetToken) return null;
  const actorToken = tokenFromContext(context, actor);
  if (gridDistanceSquares(actorToken, targetToken) > meleeSquares(actor) + 0.001) return ui.notifications.warn(`${targetToken.actor.name} está fora do Melee Range.`);
  const strike = await preparedStrike(actor);
  const { cts, round } = getCurrentRoundData(actor);
  round.actions.push({ type: "thrust", dbuStandardKey: "thrust", ...roundTrackingMeta(actor), actionCost: 1, kiCost: 0, description: `Thrust → ${targetToken.actor.name}` });
  await actor.update({ "system.combatTabState": cts });
  const native = await loadNativeClash();
  if (typeof native?.initiateClash !== "function") return ui.notifications.error("DBU: initiateClash nativo não encontrado.");
  return native.initiateClash(actor, {
    type: "thrust", option: "thrust", label: `Thrust → ${targetToken.actor.name}`, formula: strike.formula, ct: strike.ct, responderKind: "strike-or-dodge",
    note: "[1/Round] Win: escolha Push Back (½ Might, Collision ×2) ou Knock Prone (Might Clash)."
  });
}

function collisionDamage(hardness, bt) {
  const h = clampInt(hardness, 0, 4);
  return (1 + 2 * h) * Math.max(1, bt);
}

async function throwManeuver(context = {}) {
  let actor = actorFromContext(context);
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Throw: selecione seu personagem.");

  // Synthetic Actors podem guardar a flag do Terrain Lift no Token Actor.
  // Se o Token do contexto estiver carregando a Feature, ele passa a ser a fonte do Throw.
  const contextToken = tokenFromContext(context, actor);
  const tokenActor = contextToken?.actor || null;
  const actorTerrain = getTerrainLiftState(actor);
  const tokenTerrain = tokenActor ? getTerrainLiftState(tokenActor) : null;
  if (!actorTerrain && tokenTerrain) actor = tokenActor;

  if (roundUses(actor, "throw") > 0) return ui.notifications.warn(`${actor.name}: Throw já usado neste Round.`);
  const terrain = getTerrainLiftState(actor);
  if (!terrain) {
    return postRuleCard(actor, "Throw Maneuver", "Nenhuma Feature do Terrain Lift está sendo carregada. O Throw automático desta etapa usa a Feature carregada pelo Terrain Lift. Basic Items/Weapons permanecem como resolução assistida e serão conectados ao inventário depois.");
  }

  const sourceChoice = await Dialog.wait({
    title: `${actor.name} — Throw`,
    content: `<div class="dbua-system-dialog-content"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span><i class="fas fa-people-arrows-left-right"></i> Throw Maneuver</span><span>1/Round · 1 Action</span></div><div class="combat-panel-body"><p>Feature disponível para Throw:</p><div class="dbua-state-readonly active" style="margin:8px 0"><i class="fas fa-mountain"></i><span><small>Terrain Lift</small><b>${esc(terrain.label || "Feature")} · Hardness ${esc(terrain.hardness)} · Shield ${esc(terrain.shieldReduction ?? 5 * terrain.hardness)}</b></span></div><p class="dbua-system-note">Ao confirmar, esta Feature será usada no Attack Core. Se o ataque for declarado, ela deixa de ser carregada e o Terrain Shield termina conforme a resolução do Throw.</p></div></div></div>`,
    buttons: {
      terrain: { icon: '<i class="fas fa-mountain"></i>', label: "Arremessar Terrain Lift", callback: () => "terrain" },
      cancel: { label: "Cancelar", callback: () => null }
    },
    default: "terrain",
    close: () => null
  }, { width: 520, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
  if (sourceChoice !== "terrain") return null;

  const targetToken = targetOne({ ...context, actor }, "Throw");
  if (!targetToken) return null;
  const attackApi = globalThis.DBUAutomation?.attack;
  if (typeof attackApi !== "function") return ui.notifications.error("DBU Throw: Attack Core indisponível.");

  const actorToken = tokenFromContext(context, actor);
  const dist = gridDistanceSquares(actorToken, targetToken);
  const longRange = dist >= Math.max(1, num(actor.system?.status?.longRangeNumeric, 9));
  const refs = foundry.utils.deepClone(actor.system?.attackRefs || []);
  const syntheticId = Math.max(0, ...refs.map(r => num(r?.id, 0))) + 100000 + Math.floor(Math.random() * 1000);
  const marker = `DBUA_THROW_${foundry.utils.randomID(8)}`;
  refs.push({
    id: syntheticId,
    name: `Throw — ${terrain.label || "Feature"} H${terrain.hardness}`,
    foundation: "Physical",
    profile: "Simple",
    extraProfile: "",
    targetRange: Math.max(0, Math.ceil(dist)),
    inMelee: dist <= meleeSquares(actor),
    energyCharges: 0,
    kiWager: 0,
    powerShot: 0,
    miscStrike: "",
    miscWound: "",
    miscDodge: "",
    miscBonuses: "",
    weaponEquipped: "",
    weaponCheckbox: false,
    offHand: "",
    offHandCheckbox: false,
    description: marker
  });
  await actor.update({ "system.attackRefs": refs });
  const index = refs.length - 1;
  const h = clampInt(terrain.hardness, 1, 4);
  const bonus = collisionDamage(h, baseTier(actor));
  // O prep nativo classifica qualquer Physical sem Weapon como "Unarmed".
  // Throw usa Simple Profile, mas não deve herdar bônus específicos de Unarmed
  // apenas por a Feature não ser uma Weapon. Neutralizamos esses aptitudes aqui.
  const unarmedStrike = Math.trunc(num(actor.system?.aptitudes?.unarmedStrike, 0));
  const unarmedWound = Math.trunc(num(actor.system?.aptitudes?.unarmedWound, 0));
  const strikeParts = [];
  if (!longRange) strikeParts.push("-1(bT)");
  if (unarmedStrike) strikeParts.push(`${-unarmedStrike >= 0 ? "+" : ""}${-unarmedStrike}`);
  const woundDefault = unarmedWound ? `${-unarmedWound >= 0 ? "+" : ""}${-unarmedWound}` : "";
  let result = null;
  try {
    result = await attackApi({
      actor,
      token: actorToken,
      __dbuaActionValidated: true,
      effectiveType: context?.effectiveType || "standard",
      target: targetToken,
      sourceKey: `ref_${index}`,
      attackMode: "throw",
      standardActionKey: "throw",
      dialogTitle: `Throw — ${terrain.label || "Feature"} H${h}`,
      strikeExtraDefault: strikeParts.join(""),
      woundExtraDefault: woundDefault,
      wagerMaxOverride: Math.ceil(Math.max(0, num(actor.system?.kiPool?.value, 0)) / 4),
      flatDamageBonus: bonus,
      flatDamageLabel: `Collision H${h}`,
      throwHardness: h,
      throwFeatureLabel: terrain.label || "Feature",
      throwTerrainState: foundry.utils.deepClone(terrain)
    });
    if (result !== null && result !== undefined) {
      await actor.unsetFlag(MODULE_ID, "terrainLiftState").catch(() => {});
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>Throw — ${esc(terrain.label || "Feature")} H${h}:</b> a Feature deixou de ser carregada e o Terrain Shield foi encerrado. <b>Se acertar</b>, ela cai em uma Square adjacente ao alvo escolhida pelo arremessador. <b>Se errar</b>, continua além do alvo e o ARC escolhe a Square final. O posicionamento físico da Feature permanece manual nesta versão.</div></div></div>`
      });
    }
  } finally {
    // Remove somente a ref sintética, preservando qualquer alteração legítima feita
    // pelo jogador enquanto a janela estava aberta.
    const current = foundry.utils.deepClone(actor.system?.attackRefs || []);
    const filtered = current.filter(r => !(num(r?.id, -1) === syntheticId && String(r?.description || "").includes(marker)));
    if (filtered.length !== current.length) await actor.update({ "system.attackRefs": filtered });
  }
  return result;
}

async function movement(context = {}) {
  const actor = actorFromContext(context);
  if (!actor) return ui.notifications.warn("DBU Movement: selecione seu personagem.");
  const normal = Math.max(0, num(actor?.system?.status?.normalSpeed ?? actor?.system?.speed?.normal, 0));
  const boosted = Math.max(normal, num(actor?.system?.status?.boostedSpeed ?? actor?.system?.speed?.boosted, normal));
  const grappleGate = validateGrappleMovement({ actor, token: tokenFromContext(context, actor), kind: "movement" });
  await recordStandardAction(actor, { type: "movement", dbuStandardKey: "movement", actionCost: 1, kiCost: 0, description: "Movement (assistido)" });
  return postRuleCard(actor, "Movement Maneuver", `Standard · 1 Action. Pode mover até <b>${boosted || "Boosted Speed"}</b> Squares. Cada Square além do Normal Speed (${normal || "—"}) custa <b>3 Ki</b>. Sair do Melee Range de um oponente provoca Exploit.${grappleGate.requiresClash ? `<br><br><b>Grapple:</b> ${esc(grappleGate.message)} O deslocamento não foi automatizado.` : ""}<br><br><b>v1.8.1:</b> o gasto foi registrado; o deslocamento permanece manual para respeitar Walls/Terrain.`);
}

async function command(context = {}) {
  const actor = actorFromContext(context);
  if (!actor) return ui.notifications.warn("DBU Command: selecione seu personagem.");
  if (roundUses(actor, "command") > 0) return ui.notifications.warn(`${actor.name}: Command já usado neste Round.`);
  const commandBudget = standardActionBudget(actor);
  const actions = await Dialog.wait({
    title: `${actor.name} — Command`,
    content: `<div class="dbua-system-dialog-content"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span>Command Maneuver</span><span>1/Round</span></div><div class="combat-panel-body"><div class="form-group"><label>Actions gastas</label><input id="dbua-command-actions" type="number" min="1" step="1" value="1"></div><p class="notes">A atribuição das Actions aos Minions permanece assistida. Economia permissiva: contador base ${commandBudget.spent}/${commandBudget.limit}; o módulo não bloqueia Actions extras.</p></div></div></div>`,
    buttons: { use: { label: "Declarar", callback: html => Math.max(1, Math.trunc(num(html.find("#dbua-command-actions").val(), 1))) }, cancel: { label: "Cancelar", callback: () => null } },
    default: "use", close: () => null
  }, { width: 500, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
  if (!actions) return null;
  await recordStandardAction(actor, { type: "command", dbuStandardKey: "command", actionCost: actions, kiCost: 0, description: `Command — ${actions} Actions (assistido)` });
  return postRuleCard(actor, "Command Maneuver", `Standard · 1/Round · <b>${actions} Action${actions === 1 ? "" : "s"}</b>. Para cada Action gasta, escolha 1 de seus Minions: ele recebe 2 Actions para o próximo turno. Um Minion não pode possuir mais de 2 Actions e não pode ser alvo de Command novamente até o início do seu próximo turno. <br><br><b>v1.8.1:</b> gasto registrado; a atribuição aos Minions permanece assistida.`);
}

async function toss(context = {}) {
  const actor = actorFromContext(context);
  if (!actor) return ui.notifications.warn("DBU Toss: selecione seu personagem.");
  if (roundUses(actor, "toss") > 0) return ui.notifications.warn(`${actor.name}: Toss já usado neste Round.`);
  await recordStandardAction(actor, { type: "toss", dbuStandardKey: "toss", actionCost: 1, kiCost: 0, description: "Toss (assistido)" });
  return postRuleCard(actor, "Toss Maneuver", "Standard · 1/Round · 1 Action. Entregue/arremesse um Basic Item, Accessory, Weapon ou Apparel para outro personagem. O receptor faz Apprentice Perception; sucesso recebe o item, falha faz o item passar e ficar perdido. <br><br><b>v1.8.1:</b> gasto registrado; a transferência de inventário permanece assistida para não alterar itens sem confirmação.");
}

async function postRuleCard(actor, title, html) {
  if (!actor) return ui.notifications.warn(`DBU ${title}: selecione seu personagem.`);
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll"><h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-book-open"></i> ${esc(actor.name)} — ${esc(title)}</span></h3><div class="dbu-card-body"><div class="dbu-defend-guide">${html}</div></div></div>`
  });
}

const BASE_STANDARD_ACTIONS = [
  { key: "attack", type: "standard", actionCost: 1, attacking: true, icon: "fas fa-fist-raised", label: "Ataque", cost: "1 Action + KP/Wager", limit: "Profile / técnica", mode: "automated", available: a => !conditionActive(a, "pinned"), run: c => globalThis.DBUAutomation?.attack?.(c) },
  { key: "transform", type: "standard", actionCost: 1, icon: "fas fa-dragon", label: "Transformação", cost: "1 Action", limit: "—", mode: "automated", run: c => globalThis.DBUAutomation?.transform?.(c) },
  { key: "aura", type: "standard", actionCost: 1, icon: "fas fa-sun", label: "Aura", cost: "1 Action + KP da Aura", limit: "1/Round", mode: "automated", run: c => globalThis.DBUAutomation?.aura?.(c) },
  { key: "energyCharge", type: "standard", actionCost: 1, deferValidation: true, resolveTypes: ({ actor }) => getEnergyChargeAllowedTypes(actor), icon: "fas fa-bolt", label: "Energy Charge", cost: "1 Action + 2(bT) KP", limit: "—", mode: "automated", run: c => globalThis.DBUAutomation?.energyCharge?.(c) },
  { key: "powerUp", type: "standard", actionCost: 1, icon: "fas fa-fire", label: "Power Up", cost: "1 Action", limit: "2/Round", mode: "automated", run: powerUp },
  { key: "combatRecovery", type: "standard", actionCost: 2, icon: "fas fa-heart-pulse", label: "Combat Recovery", cost: "mín. 2 Actions", limit: "1/Round · somente Encounter", mode: "automated", available: a => actorInActiveCombat(a) && !conditionActive(a, "pinned"), run: combatRecovery },
  { key: "empower", type: "standard", actionCost: 1, icon: "fas fa-hands-helping", label: "Empower", cost: "Actions variáveis", limit: "1/Round", mode: "automated", run: empower },
  { key: "grapple", type: "standard", actionCost: 1, icon: "fas fa-hand-rock", label: "Grapple", cost: "1 Action", limit: "1/Round", mode: "automated", available: a => !currentGrapple(a), run: grapple },
  { key: "launch", type: "standard", actionCost: 1, icon: "fas fa-rocket", label: "Launch", cost: "1 Action", limit: "1/Round", mode: "contextual", available: a => currentGrapple(a)?.role === "grappler" && !a?.getFlag?.(MODULE_ID, `${STATE_FLAG}.launchReady`)?.active, run: launch },
  { key: "completeLaunch", type: "standard", actionCost: 0, icon: "fas fa-location-arrow", label: "Concluir Launch", cost: "sem custo extra", limit: "continuação", mode: "contextual", available: a => !!a?.getFlag?.(MODULE_ID, `${STATE_FLAG}.launchReady`)?.active, run: completeLaunch },
  { key: "pin", type: "standard", actionCost: 1, icon: "fas fa-thumbtack", label: "Pin", cost: "1 Action", limit: "1/Round", mode: "contextual", available: a => currentGrapple(a)?.role === "grappler", run: pin },
  { key: "escapePin", type: "standard", actionCost: 1, allowPinnedEscape: true, icon: "fas fa-unlock", label: "Escapar do Pin", cost: "1 Action", limit: "enquanto Pinned", mode: "contextual", available: a => currentGrapple(a)?.role === "grappled" && !!currentGrapple(a)?.pinned && conditionActive(a, "pinned"), run: escapePin },
  { key: "throw", type: "standard", actionCost: 1, attacking: true, icon: "fas fa-people-arrows-left-right", label: "Throw", cost: "1 Action", limit: "1/Round", mode: "automated", available: a => !conditionActive(a, "pinned"), detail: a => getTerrainLiftState(a) ? `Terrain Lift: H${getTerrainLiftState(a).hardness}` : "Feature/Item/Weapon", run: throwManeuver },
  { key: "thrust", type: "standard", actionCost: 1, icon: "fas fa-arrows-alt-h", label: "Thrust", cost: "1 Action", limit: "1/Round", mode: "automated", run: thrust },
  { key: "movement", type: "standard", actionCost: 1, movement: true, icon: "fas fa-running", label: "Movement", cost: "1 Action", limit: "—", mode: "assisted", available: a => !conditionActive(a, "pinned"), run: movement },
  { key: "command", type: "standard", actionCost: 1, icon: "fas fa-chess-king", label: "Command", cost: "Actions variáveis", limit: "1/Round", mode: "chat", run: command },
  { key: "toss", type: "standard", actionCost: 1, icon: "fas fa-box", label: "Toss", cost: "1 Action", limit: "1/Round", mode: "chat", run: toss }
];

const actionRegistry = createManeuverRegistry({ collectModifiers });
for (const action of BASE_STANDARD_ACTIONS) actionRegistry.register(action);

export function registerManeuverAction(definition) {
  return actionRegistry.register(definition);
}
export function getManeuverAction(key) {
  return actionRegistry.get(key);
}
export function resolveManeuverAction(keyOrDefinition, actor = null, context = {}) {
  return actionRegistry.resolve(keyOrDefinition, actor, context);
}
export function listManeuverActions(type = "standard", actor = null, context = {}) {
  return actionRegistry.list(type, actor, context);
}

export function getStandardFavorites() {
  let value = '["attack","transform"]';
  try { value = game.settings.get(MODULE_ID, FAVORITES_SETTING) || value; } catch {}
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(k => actionRegistry.has(k)).slice(0, 5);
  } catch {}
  return ["attack", "transform"];
}

export async function setStandardFavorites(keys = []) {
  const next = [...new Set(keys.map(String).filter(k => actionRegistry.has(k)))].slice(0, 5);
  await game.settings.set(MODULE_ID, FAVORITES_SETTING, JSON.stringify(next));
  globalThis.DBUAutomation?.renderCombatHud?.();
  return next;
}

export async function toggleStandardFavorite(key) {
  const favorites = getStandardFavorites();
  const idx = favorites.indexOf(key);
  if (idx >= 0) favorites.splice(idx, 1);
  else {
    if (favorites.length >= 5) return ui.notifications.warn("HUD DBU: máximo de 5 favoritos.");
    favorites.push(key);
  }
  return setStandardFavorites(favorites);
}

// Aliases genéricos: as próximas categorias reutilizam o mesmo armazenamento
// de favoritos sem migração de configuração do jogador.
export const getManeuverFavorites = getStandardFavorites;
export const setManeuverFavorites = setStandardFavorites;
export const toggleManeuverFavorite = toggleStandardFavorite;

export async function runManeuverAction(key, context = {}) {
  const actor = actorFromContext(context);
  const def = resolveManeuverAction(key, actor, context);
  if (!def) return ui.notifications.error(`DBU: Maneuver '${key}' não registrada.`);
  if (def.effectiveType === "standard" && !context?.timingOverride && !isActorsTurn(actor)) {
    ui.notifications.warn(`${def.label}: esta é normalmente uma Standard Maneuver usada no turno de ${actor?.name || "seu personagem"}. O módulo permitiu o uso fora do turno para respeitar Traits, Talents, Transformations e efeitos que mudam o timing para Instant/Out-of-Sequence.`);
  }
  if (typeof def.available === "function" && !def.available(actor)) return ui.notifications.warn(`${def.label} não está disponível neste estado.`);
  if (typeof def.run !== "function") return ui.notifications.warn(`${def.label}: sem automação registrada.`);
  const actionCost = typeof def.actionCost === "function" ? def.actionCost({ actor, context, definition: def }) : num(def.actionCost, 0);
  if (!def.deferValidation) {
    const validation = validateActionUse(actor, {
      label: def.label,
      actionCost,
      effectiveType: def.effectiveType,
      attacking: !!def.attacking,
      movement: !!def.movement,
      allowPinnedEscape: !!def.allowPinnedEscape,
      limitBonus: num(def.modifiers?.actionLimitBonus, 0)
    });
    if (!validation.ok) return null;
  }
  return def.run({ ...context, actor, __dbuaActionValidated: true, effectiveType: def.effectiveType });
}

function modeLabel(mode) {
  return { automated: "AUTOMÁTICA", contextual: "CONTEXTUAL", assisted: "ASSISTIDA", chat: "REGRA/CHAT" }[mode] || "AÇÃO";
}

export async function openStandardMenu(context = {}) {
  const actor = actorFromContext(context);
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Standard: selecione seu personagem.");
  const favorites = getStandardFavorites();
  const actions = listManeuverActions("standard", actor);
  const gr = currentGrapple(actor);
  const power = Math.max(0, num(actor.system?.tracking?.powerStacks, 0));
  const rules = powerUpRules(actor);
  const terrain = getTerrainLiftState(actor);

  const rows = actions.map(a => {
    const fav = favorites.includes(a.key);
    const detail = typeof a.detail === "function" ? a.detail(actor) : "";
    let stateText = detail || "";
    if (a.key === "powerUp") stateText = inActiveCombat(actor)
      ? `Power ${power}/${rules.maxStacks} · usos ${powerUpUseCount(actor)}/${rules.maxUses}`
      : `Power ${power}/${rules.maxStacks} · fora de Encounter`;
    if (a.key === "grapple" && gr) stateText = `Em Grapple: ${gr.role}`;
    if (a.key === "throw" && terrain) stateText = `${terrain.label || "Feature"} · H${terrain.hardness} · Shield ${terrain.shieldReduction ?? 5 * terrain.hardness}`;
    return `<div class="dbua-standard-row" data-key="${esc(a.key)}">
      <button type="button" class="dbua-standard-fav ${fav ? "active" : ""}" data-dbua-standard-fav="${esc(a.key)}" title="${fav ? "Remover dos favoritos" : "Adicionar aos favoritos"}"><i class="${fav ? "fas" : "far"} fa-star"></i></button>
      <span class="dbua-standard-icon"><i class="${esc(a.icon)}"></i></span>
      <span class="dbua-standard-copy"><b>${esc(a.label)}</b><small>${esc(a.cost)} · ${esc(a.limit)}${stateText ? ` · ${esc(stateText)}` : ""}</small></span>
      <span class="dbua-standard-mode ${esc(a.mode)}">${modeLabel(a.mode)}</span>
      <button type="button" class="dbua-standard-use" data-dbua-standard-use="${esc(a.key)}">USAR</button>
    </div>`;
  }).join("");

  return new Promise(resolve => {
    const dialog = new Dialog({
      title: `${actor.name} — Standard Maneuvers`,
      content: `<div class="dbua-system-dialog-content dbua-standard-menu"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span><i class="fas fa-circle"></i> Standard Maneuvers</span><span>DBU 0.9.2</span></div><div class="combat-panel-body"><p class="dbua-system-note">Standard Maneuvers normalmente são usadas no próprio turno e gastam Standard Actions. O módulo não bloqueia uso fora do turno, pois Traits, Talents, Transformations e outros efeitos podem mudar o timing para Instant/Out-of-Sequence. ★ salva até 5 atalhos pessoais na HUD.</p><div class="dbua-standard-list">${rows}</div></div></div></div>`,
      buttons: { close: { label: "Fechar", callback: () => resolve(null) } },
      close: () => resolve(null),
      render: html => {
        const root = html instanceof HTMLElement ? html : html?.[0];
        root?.querySelectorAll?.("[data-dbua-standard-fav]").forEach(btn => btn.addEventListener("click", async ev => {
          ev.preventDefault(); ev.stopPropagation();
          await toggleStandardFavorite(btn.dataset.dbuaStandardFav);
          dialog.close();
          setTimeout(() => openStandardMenu(context), 30);
        }));
        root?.querySelectorAll?.("[data-dbua-standard-use]").forEach(btn => btn.addEventListener("click", async ev => {
          ev.preventDefault(); ev.stopPropagation();
          const key = btn.dataset.dbuaStandardUse;
          dialog.close();
          try { resolve(await runManeuverAction(key, { ...context, actor })); }
          catch (error) { console.error("DBU Standard | action", error); ui.notifications.error(error?.message || "Erro na Standard Maneuver."); resolve(null); }
        }));
      }
    }, { width: 720, classes: ["dbu-old", "sheet", "dbua-system-dialog", "dbua-standard-dialog"] });
    dialog.render(true);
  });
}

export async function openManeuverCategoryPreview(type, context = {}) {
  const actor = actorFromContext(context);
  if (!actor || !canControl(actor)) return ui.notifications.warn("DBU Maneuvers: selecione seu personagem.");
  const normalized = String(type || "").toLowerCase();

  const row = ({ icon, label, detail, action = "", disabled = false, badge = "" }) => `
    <div class="dbua-standard-row ${disabled ? "disabled" : ""}">
      <span class="dbua-standard-icon"><i class="${esc(icon)}"></i></span>
      <span class="dbua-standard-copy"><b>${esc(label)}</b><small>${detail}</small></span>
      ${badge ? `<span class="dbua-standard-mode assisted">${esc(badge)}</span>` : ""}
      ${action ? `<button type="button" class="dbua-standard-use" data-dbua-category-action="${esc(action)}" ${disabled ? "disabled" : ""}>ABRIR</button>` : ""}
    </div>`;

  if (normalized === "instant") {
    const inEncounter = actorInActiveCombat(actor);
    const gr = currentGrapple(actor);
    const rows = [
      row({
        icon: "fas fa-heart-pulse",
        label: "Surge",
        detail: `${inEncounter ? "Disponível pelo handler nativo da ficha" : "Somente em Encounter ativo"} · o DBU nativo controla usos extras concedidos por outros efeitos.`,
        action: "surge",
        disabled: !inEncounter,
        badge: "REUSO"
      }),
      row({
        icon: "fas fa-mountain",
        label: "Terrain Lift",
        detail: "Reutiliza a automação existente de Hardness, Feature carregada e Terrain Shield.",
        action: "terrainLift",
        badge: "REUSO"
      }),
      row({
        icon: "fas fa-undo",
        label: "Revert",
        detail: "Continua dentro do macro de Transformation; este atalho apenas abre a automação já existente.",
        action: "transformation",
        badge: "VIA TRANSFORM"
      }),
      row({
        icon: "fas fa-hand-rock",
        label: "End Grapple / Pulled In",
        detail: gr?.active && gr.role === "grappler"
          ? "Contexto de Grapple detectado. Permanecem na automação de Grapple nesta etapa de teste."
          : "Só se aplicam quando você é o Grappler e o contexto permitir.",
        badge: "CONTEXTUAL"
      }),
      row({ icon: "fas fa-crosshairs", label: "Called Shot", detail: "Entrada preparada. Automação específica ainda não foi duplicada/criada nesta etapa.", badge: "PREPARADO" }),
      row({ icon: "fas fa-feather-alt", label: "No Effort", detail: "Entrada preparada para atalhos/chat. Cancel Energy Charge continua dentro de Energy Charge.", badge: "PREPARADO" }),
      row({ icon: "fas fa-clock", label: "Triggered", detail: "Entrada preparada para futura resolução semi-automática de gatilhos.", badge: "PREPARADO" }),
      row({ icon: "fas fa-hands-helping", label: "United Attack", detail: "Já existe no Attack Core e continua aparecendo na carta do ataque quando aplicável.", badge: "NO ATTACK CORE" })
    ].join("");

    return new Promise(resolve => {
      let dialog = null;
      dialog = new Dialog({
        title: `${actor.name} — Instant Maneuvers`,
        content: `<div class="dbua-system-dialog-content"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span><i class="fas fa-bolt"></i> Instant Maneuvers</span><span>DBU 0.9.2</span></div><div class="combat-panel-body"><p class="dbua-system-note">Esta tela reutiliza as automações já existentes. Não cria um segundo Surge, Revert, Terrain Lift ou United Attack.</p><div class="dbua-standard-list">${rows}</div></div></div></div>`,
        buttons: { close: { label: "Fechar", callback: () => resolve(null) } },
        close: () => resolve(null),
        render: html => {
          const root = html instanceof HTMLElement ? html : html?.[0];
          root?.querySelectorAll?.("[data-dbua-category-action]").forEach(btn => btn.addEventListener("click", async ev => {
            ev.preventDefault(); ev.stopPropagation();
            const action = btn.dataset.dbuaCategoryAction;
            dialog.close();
            try {
              const api = globalThis.DBUAutomation;
              if (action === "surge") return resolve(await api?.surge?.({ ...context, actor }));
              if (action === "terrainLift") return resolve(await api?.terrainLift?.({ ...context, actor }));
              if (action === "transformation") return resolve(await api?.transform?.({ ...context, actor }));
              resolve(null);
            } catch (error) {
              console.error("DBU Instant | action", error);
              ui.notifications.error(error?.message || "Erro na Instant Maneuver.");
              resolve(null);
            }
          }));
        }
      }, { width: 700, classes: ["dbu-old", "sheet", "dbua-system-dialog", "dbua-standard-dialog"] });
      dialog.render(true);
    });
  }

  if (normalized === "counter") {
    const pending = Array.isArray(context.pendingActions) ? context.pendingActions : [];
    const defenses = pending.filter(entry => entry?.type === "defense");
    const intervenes = pending.filter(entry => entry?.type === "intervene");
    const exploits = pending.filter(entry => entry?.type === "exploit");
    const reflects = pending.filter(entry => entry?.type === "reflect");
    const duelEligible = defenses.filter(entry => entry?.duelEligible);
    const available = [];
    if (defenses.length) available.push(row({ icon: "fas fa-shield-alt", label: "Defend", detail: `${defenses.length} defesa(s) pendente(s).`, action: "defend", badge: "PENDENTE" }));
    if (duelEligible.length) available.push(row({ icon: "fas fa-bolt", label: "Duel", detail: `${duelEligible.length} ataque(s) pendente(s) atendem aos requisitos do Duel.`, action: "duel", badge: "PENDENTE" }));
    if (intervenes.length) available.push(row({ icon: "fas fa-people-arrows", label: "Intervene", detail: `${intervenes.length} oportunidade(s) válida(s) de Intervene.`, action: "intervene", badge: "PENDENTE" }));
    if (exploits.length) available.push(row({ icon: "fas fa-fist-raised", label: "Exploit", detail: `${exploits.length} oportunidade(s) de Exploit.`, action: "exploit", badge: "PENDENTE" }));
    if (reflects.length) available.push(row({ icon: "fas fa-reply", label: "Reflect", detail: `${reflects.length} oportunidade(s) após Parry/Deflect bem-sucedido.`, action: "reflect", badge: "OUT-OF-SEQUENCE" }));

    const infoRows = [
      row({ icon: "fas fa-running", label: "Duel Escape", detail: "Permanece no card nativo do Duel e só pode ser selecionado quando alguém tenta iniciar Duel contra você.", badge: "CONTEXTUAL" }),
      row({ icon: "fas fa-ban", label: "Energy Cancel", detail: "Continua dentro do macro de Energy Charge; não foi duplicado no HUD.", badge: "VIA CHARGE" }),
      row({ icon: "fas fa-road-barrier", label: "Blockade", detail: "Entrada reservada para etapa futura; sem automação de movimento forçado nesta versão.", badge: "PREPARADO" })
    ].join("");

    const availableHtml = available.length
      ? available.join("")
      : `<div class="dbu-auto-empty"><i class="fas fa-check-circle"></i> Nenhum Counter contextual disponível agora.</div>`;

    return new Promise(resolve => {
      let dialog = null;
      dialog = new Dialog({
        title: `${actor.name} — Counter Maneuvers`,
        content: `<div class="dbua-system-dialog-content"><div class="combat-panel combat-conditions-panel"><div class="section-header"><span><i class="fas fa-shield-alt"></i> Counter Maneuvers</span><span>CONTEXTUAL</span></div><div class="combat-panel-body"><p class="dbua-system-note">Defend, Duel, Intervene e Exploit só ficam selecionáveis quando existe uma pendência válida. Reflect também aparece aqui quando houver oportunidade após Parry/Deflect, mas continua sendo registrado como <b>Out-of-Sequence</b>, não como Counter. O contador de Counter Actions é informativo e não bloqueia efeitos especiais que alterem a economia de Actions.</p><div class="dbua-standard-list">${availableHtml}${infoRows}</div></div></div></div>`,
        buttons: { close: { label: "Fechar", callback: () => resolve(null) } },
        close: () => resolve(null),
        render: html => {
          const root = html instanceof HTMLElement ? html : html?.[0];
          root?.querySelectorAll?.("[data-dbua-category-action]").forEach(btn => btn.addEventListener("click", async ev => {
            ev.preventDefault(); ev.stopPropagation();
            const action = btn.dataset.dbuaCategoryAction;
            dialog.close();
            try {
              const api = globalThis.DBUAutomation;
              if (typeof api?.counterAction !== "function") throw new Error("Resolver de Counter não foi inicializado.");
              resolve(await api.counterAction(action, { ...context, actor }));
            } catch (error) {
              console.error("DBU Counter | action", error);
              ui.notifications.error(error?.message || "Erro na Counter Maneuver.");
              resolve(null);
            }
          }));
        }
      }, { width: 700, classes: ["dbu-old", "sheet", "dbua-system-dialog", "dbua-standard-dialog"] });
      dialog.render(true);
    });
  }

  return ui.notifications.warn(`DBU Maneuvers: categoria '${type}' ainda não preparada.`);
}

async function setCondition(actor, id, active, { authorityActor = null } = {}) {
  const conditions = foundry.utils.deepClone(actor.system?.conditions || []);
  let row = conditions.find(c => c.id === id);
  if (!row) {
    const base = (CONFIG.DBU?.conditions || []).find(c => c.id === id) || { id, name: id, maxStacks: 1, effect: "" };
    row = { ...base, active: false, stacks: 0, roundApplied: null };
    conditions.push(row);
  }
  row.active = !!active;
  row.stacks = active ? Math.max(1, num(row.stacks, 0)) : 0;
  await gmOrOwnerUpdate(actor, { "system.conditions": conditions }, { authorityActor });
}

function grappleConditionSource(grappleId, id) {
  return `grapple:${grappleId}:${id}`;
}

async function setConditionSource(actor, id, sourceKey, active, { authorityActor = null } = {}) {
  const conditions = foundry.utils.deepClone(actor?.system?.conditions || []);
  let row = conditions.find(condition => condition?.id === id);
  const base = (CONFIG.DBU?.conditions || []).find(condition => condition.id === id) || { id, name: id, maxStacks: 1, effect: "" };
  if (!row) {
    row = { ...base, active: false, stacks: 0, roundApplied: null };
    conditions.push(row);
  }
  const sources = { ...(row.dbuAutomationSources || {}) };
  if (active) {
    if (!Object.keys(sources).length && row.dbuAutomationExternalActive == null) {
      row.dbuAutomationExternalActive = !!row.active;
    }
    sources[sourceKey] = { active: true, appliedAt: Date.now() };
    row.active = true;
    row.stacks = Math.max(1, num(row.stacks, 0));
  } else {
    delete sources[sourceKey];
    if (!Object.keys(sources).length) {
      const external = !!row.dbuAutomationExternalActive;
      row.active = external;
      row.stacks = external ? Math.max(1, num(row.stacks, 0)) : 0;
      delete row.dbuAutomationExternalActive;
    }
  }
  if (Object.keys(sources).length) row.dbuAutomationSources = sources;
  else delete row.dbuAutomationSources;
  await gmOrOwnerUpdate(actor, { "system.conditions": conditions }, { authorityActor });
  return row;
}

async function addConditionStacks(actor, id, amount = 1) {
  const conditions = foundry.utils.deepClone(actor?.system?.conditions || []);
  let row = conditions.find(c => c.id === id);
  const base = (CONFIG.DBU?.conditions || []).find(c => c.id === id) || { id, name: id, maxStacks: 1, effect: "" };
  if (!row) {
    row = { ...base, active: false, stacks: 0, roundApplied: null };
    conditions.push(row);
  }
  const maxStacks = Math.max(1, Math.trunc(num(row.maxStacks ?? base.maxStacks, 1)));
  const before = row.active ? Math.max(0, Math.trunc(num(row.stacks, 0))) : 0;
  const after = Math.min(maxStacks, before + Math.max(0, Math.trunc(num(amount, 0))));
  row.active = after > 0;
  row.stacks = after;
  await gmOrOwnerUpdate(actor, { "system.conditions": conditions });
  return { before, after, gained: after - before, maxStacks };
}

async function establishGrapple(grappler, grappled, pending) {
  const id = foundry.utils.randomID(12);
  const tailProneApplied = !!pending.tail && saiyanTailWeaknessApplies(grappled);
  const grapplerRef = pending?.initiator || participantRef(grappler);
  const grappledRef = pending?.target || participantRef(grappled);
  const sceneId = grapplerRef.sceneId || grappledRef.sceneId || canvas?.scene?.id || null;
  const conditionSources = {
    grapplerGuardDown: grappleConditionSource(id, "grappler-guardDown"),
    grappledGuardDown: grappleConditionSource(id, "grappled-guardDown"),
    pinned: grappleConditionSource(id, "pinned"),
    prone: grappleConditionSource(id, "prone")
  };
  const common = {
    active: true,
    id,
    grappleId: id,
    sceneId,
    grappler: grapplerRef,
    grappled: grappledRef,
    grapplerId: grappler.id,
    grappledId: grappled.id,
    grapplerTokenId: grapplerRef.tokenId,
    grappledTokenId: grappledRef.tokenId,
    tailRestrained: !!pending.tail,
    pinned: false,
    tailProneApplied,
    conditionSources,
    createdAt: Date.now()
  };
  await gmOrOwnerSetFlag(grappler, `${STATE_FLAG}.grapple`, { ...common, role: "grappler" }, { authorityActor: grappler });
  await gmOrOwnerSetFlag(grappled, `${STATE_FLAG}.grapple`, { ...common, role: "grappled" }, { authorityActor: grappler });
  await setConditionSource(grappler, "guardDown", conditionSources.grapplerGuardDown, true, { authorityActor: grappler });
  await setConditionSource(grappled, "guardDown", conditionSources.grappledGuardDown, true, { authorityActor: grappler });
  if (tailProneApplied) await setConditionSource(grappled, "prone", conditionSources.prone, true, { authorityActor: grappler });
  if (pending.tail) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: grappler }),
      content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>Tail Restraint:</b> ${esc(grappled.name)} não pode usar Tail Attack enquanto este Grapple durar.${tailProneApplied ? ` Pela Saiyan Heritage, ${esc(grappled.name)} também fica <b>Prone</b> até escapar do Grapple.` : ""}</div></div></div>`
    });
  }
}

async function endGrapple(grapple) {
  if (!grapple?.active) return;
  const grappler = grappleActor(grapple, "grappler");
  const grappled = grappleActor(grapple, "grappled");
  const grappledState = grappled ? currentGrapple(grappled) : null;
  const stateForSources = grappledState || grapple;
  const sources = stateForSources?.conditionSources || {};
  const authorityActor = [grappler, grappled].find(actor => actor?.isOwner) || grappler || grappled;
  for (const actor of [grappler, grappled].filter(Boolean)) {
    const own = currentGrapple(actor);
    await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.grapple`, null, { authorityActor });
    await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.launchReady`, null, { authorityActor }).catch(() => {});
    const guardSource = own?.role === "grappler" ? sources.grapplerGuardDown : sources.grappledGuardDown;
    if (guardSource) await setConditionSource(actor, "guardDown", guardSource, false, { authorityActor });
    else if (!own?.guardDownPreexisting) await setCondition(actor, "guardDown", false, { authorityActor });
  }
  if (grappled && sources.pinned) await setConditionSource(grappled, "pinned", sources.pinned, false, { authorityActor });
  else if (grappled && grappledState?.pinned && !grappledState?.pinnedPreexisting) await setCondition(grappled, "pinned", false, { authorityActor });
  if (grappled && sources.prone) await setConditionSource(grappled, "prone", sources.prone, false, { authorityActor });
  else if (grappled && grappledState?.tailProneApplied && !grappledState?.pronePreexisting) await setCondition(grappled, "prone", false, { authorityActor });
}

async function resolvePendingClash(initiator, responder, clashId, initSt, respSt, pending) {
  if (!pending || pending.resolved) return;
  if (pending.targetActorId && responder.id !== pending.targetActorId) {
    await ChatMessage.create({ content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>DBU Automation:</b> ${esc(responder.name)} respondeu ao Clash, mas o alvo esperado era ${esc(game.actors.get(pending.targetActorId)?.name || pending.targetActorId)}. Nenhum estado automático foi aplicado.</div></div></div>` });
    pending.resolved = true;
  } else {
    const win = num(initSt.total) > num(respSt.total); // ties defender wins
    if (pending.kind === "grapple-init") {
      if (win) await establishGrapple(initiator, responder, pending);
      else await registerExploitPending(responder, {
        sourceActor: initiator,
        reason: "Falha ao iniciar Grapple"
      });
    } else if (pending.kind === "launch") {
      const gr = currentGrapple(initiator);
      if (win) {
        await gmOrOwnerSetFlag(initiator, `${STATE_FLAG}.launchReady`, { active: true, grappleId: gr?.id, targetId: responder.id, maxSquares: Math.max(0, num(initiator.system?.status?.might, 0)), createdAt: Date.now() });
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: initiator }), content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>Launch venceu.</b> ${esc(initiator.name)} pode encerrar o Grapple e lançar ${esc(responder.name)} até <b>${Math.max(0, num(initiator.system?.status?.might, 0))} Squares</b>. A posição final continua manual nesta etapa Standard para respeitar Walls/Collision.</div></div></div>` });
      } else if (gr) await endGrapple(gr);
    } else if (pending.kind === "pin") {
      const gr = currentGrapple(initiator);
      if (win) {
        const responderGr = currentGrapple(responder) || gr;
        const source = responderGr?.conditionSources?.pinned || grappleConditionSource(gr?.grappleId || gr?.id, "pinned");
        await setConditionSource(responder, "pinned", source, true, { authorityActor: initiator });
        if (gr) {
          const conditionSources = { ...(gr.conditionSources || {}), pinned: source };
          const patchA = { ...gr, pinned: true, conditionSources };
          await gmOrOwnerSetFlag(initiator, `${STATE_FLAG}.grapple`, patchA, { authorityActor: initiator });
          await gmOrOwnerSetFlag(responder, `${STATE_FLAG}.grapple`, { ...responderGr, pinned: true, conditionSources }, { authorityActor: initiator });
        }
      } else if (gr) await endGrapple(gr);
    } else if (pending.kind === "escape-pin") {
      const gr = currentGrapple(initiator);
      if (win && gr?.active) {
        const grappler = grappleActor(gr, "grappler");
        const grapplerGr = grappler ? currentGrapple(grappler) : null;
        const source = gr.conditionSources?.pinned;
        if (source) await setConditionSource(initiator, "pinned", source, false, { authorityActor: initiator });
        else if (!gr.pinnedPreexisting) await setCondition(initiator, "pinned", false, { authorityActor: initiator });
        await gmOrOwnerSetFlag(initiator, `${STATE_FLAG}.grapple`, { ...gr, pinned: false }, { authorityActor: initiator });
        if (grappler && grapplerGr) await gmOrOwnerSetFlag(grappler, `${STATE_FLAG}.grapple`, { ...grapplerGr, pinned: false }, { authorityActor: initiator });
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: initiator }), content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>Escape Pinned:</b> ${esc(initiator.name)} venceu o Might Clash e remove o <b>Pinned</b>. O Grapple continua.</div></div></div>` });
      }
    }
    pending.resolved = true;
  }
  const all = foundry.utils.deepClone(initiator.getFlag(MODULE_ID, `${STATE_FLAG}.pendingClashes`) || {});
  if (all[clashId]) all[clashId].resolved = true;
  await gmOrOwnerSetFlag(initiator, `${STATE_FLAG}.pendingClashes`, all);
  globalThis.DBUAutomation?.renderCombatHud?.();
}

async function ensureGrappleConditions(actor) {
  const gr = currentGrapple(actor);
  if (!gr?.active) return false;
  const missingGuard = !conditionActive(actor, "guardDown");
  const missingPinned = gr.role === "grappled" && gr.pinned && !conditionActive(actor, "pinned");
  const missingProne = gr.role === "grappled" && gr.tailProneApplied && !conditionActive(actor, "prone");
  if (!missingGuard && !missingPinned && !missingProne) return false;
  const sources = gr.conditionSources || {};
  const guardSource = gr.role === "grappler" ? sources.grapplerGuardDown : sources.grappledGuardDown;
  if (missingGuard && guardSource) await setConditionSource(actor, "guardDown", guardSource, true, { authorityActor: actor });
  if (missingPinned && sources.pinned) await setConditionSource(actor, "pinned", sources.pinned, true, { authorityActor: actor });
  if (missingProne && sources.prone) await setConditionSource(actor, "prone", sources.prone, true, { authorityActor: actor });
  return true;
}

export async function cleanupStandardActor(actor) {
  if (!actor) return 0;
  let changed = 0;
  const gr = currentGrapple(actor);
  if (gr?.active) {
    await endGrapple(gr);
    changed += 1;
  }
  const rec = recoveryState(actor);
  if (rec) {
    const buffs = syncGeneratedBuff(actor.system?.customBuffs, RECOVERY_BUFF_MARKER, { effect: "Defense Value", T: 0, name: "Combat Recovery (DBU Automation)" });
    await gmOrOwnerUpdate(actor, { "system.customBuffs": buffs });
    await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.combatRecovery`, null);
    changed += 1;
  }
  const timers = timedEffects(actor);
  const miracles = timers.filter(t => t?.kind === "miracleEmpowerment");
  if (miracles.length) {
    let buffs = foundry.utils.deepClone(actor.system?.customBuffs || []);
    for (const timer of miracles) buffs = removeGeneratedBuffByMarker(buffs, String(timer.marker || ""));
    await gmOrOwnerUpdate(actor, { "system.customBuffs": buffs });
    await writeTimedEffects(actor, timers.filter(t => t?.kind !== "miracleEmpowerment"));
    changed += miracles.length;
  }
  // Remove pendências auxiliares da camada Standard sem tocar nos Power Ups
  // registrados no Round Tracker.
  await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.pendingClashes`, null).catch(() => {});
  await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.exploitPending`, null).catch(() => {});
  await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.pendingActions`, null).catch(() => {});
  await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.launchReady`, null).catch(() => {});
  return changed;
}

async function inspectResolvedClashes(changedActor) {
  if (!isPrimaryGM() && primaryGM()) return;
  const responderClashes = changedActor?.getFlag?.(SYS_ID, "clashes") || {};
  for (const [clashId, respSt] of Object.entries(responderClashes)) {
    if (respSt?.role !== "responder") continue;
    const candidates = [
      ...(game.actors?.contents || []),
      ...(canvas?.tokens?.placeables || []).map(token => token.actor).filter(Boolean)
    ];
    const initiator = candidates.find(a => {
      const p = a.getFlag(MODULE_ID, `${STATE_FLAG}.pendingClashes.${clashId}`);
      return !!p;
    });
    if (!initiator) continue;
    const pending = initiator.getFlag(MODULE_ID, `${STATE_FLAG}.pendingClashes.${clashId}`);
    if (!pending || pending.resolved) continue;
    const initSt = initiator.getFlag(SYS_ID, `clashes.${clashId}`);
    if (!initSt) continue;
    await resolvePendingClash(initiator, changedActor, clashId, initSt, respSt, pending);
  }
}

function combatCursor(combat) {
  return {
    round: num(combat?.round, -1),
    turn: num(combat?.turn, -1),
    actorId: combat?.combatant?.actor?.id || null
  };
}

function cursorChanged(a, b) {
  if (!a || !b) return true;
  return a.round !== b.round || a.turn !== b.turn || a.actorId !== b.actorId;
}

async function expirePowerStack(actor, timer) {
  if (actor?.system?.aptitudes?.cannotLosePowerStacks) return { expired: false, defer: true };
  const cts = foundry.utils.deepClone(actor?.system?.combatTabState || {});
  let found = false;
  for (const round of (cts.rounds || [])) {
    for (const row of (round.actions || [])) {
      if (row?.type === "power-up" && String(row?.dbuPowerStackId || "") === String(timer?.stackId || "")) {
        row.type = "power-up-expired";
        row.dbuPowerExpired = true;
        row.dbuPowerExpiredAt = Date.now();
        row.description = `${row.description || "Power Up"} — expirado`;
        found = true;
      }
    }
  }
  const current = Math.max(0, Math.trunc(num(actor?.system?.tracking?.powerStacks, 0)));
  const next = found ? Math.max(0, current - 1) : current;
  const buffs = syncGeneratedBuff(actor.system?.customBuffs, POWER_BUFF_MARKER, {
    effect: "Combat Rolls",
    T: next,
    name: "Power (DBU Automation)"
  });
  await gmOrOwnerUpdate(actor, {
    "system.combatTabState": cts,
    "system.tracking.powerStacks": next,
    "system.customBuffs": buffs
  });
  if (found) globalThis.DBUAutomation?.renderCombatHud?.();
  return { expired: true, found };
}

async function expireMiracleEmpowerment(actor, timer) {
  const marker = String(timer?.marker || "");
  if (!marker) return { expired: true };
  const buffs = removeGeneratedBuffByMarker(actor.system?.customBuffs, marker);
  await gmOrOwnerUpdate(actor, { "system.customBuffs": buffs });
  return { expired: true };
}

async function expireTimedEffect(actor, timer) {
  if (timer?.kind === "powerStack") return expirePowerStack(actor, timer);
  if (timer?.kind === "miracleEmpowerment") return expireMiracleEmpowerment(actor, timer);
  return { expired: true };
}

function combatActorById(combat, actorId) {
  if (!actorId) return null;
  return (combat?.combatants?.contents || combat?.combatants || []).find?.(combatant => combatant?.actor?.id === actorId)?.actor
    || game.actors?.get?.(actorId)
    || null;
}

function timedEffectActorsForTransition(combat, prev, next) {
  const ids = new Set([prev?.actorId, next?.actorId].filter(Boolean));
  return [...ids].map(actorId => combatActorById(combat, actorId)).filter(Boolean);
}

async function processTimedEffectsAtTurnChange(combat, changes) {
  if (!foundry.utils.hasProperty(changes || {}, "turn") && !foundry.utils.hasProperty(changes || {}, "round")) return;
  const next = combatCursor(combat);
  const prev = state.lastCombatCursor || null;
  if (!prev) {
    state.lastCombatCursor = next;
    return;
  }
  if (!cursorChanged(prev, next)) return;

  const gm = primaryGM();
  // v1.8.12: somente o Actor que saiu do turno e o Actor que entrou podem
  // alterar timers de "próximo turno". Evita percorrer game.actors inteiro.
  for (const actor of timedEffectActorsForTransition(combat, prev, next)) {
    // Um único cliente é autoridade quando há GM. Sem GM, cada owner cuida do próprio Actor.
    if (gm ? game.user.id !== gm.id : !actor.isOwner) continue;
    const timers = timedEffects(actor);
    if (!timers.length) continue;
    let changed = false;
    const kept = [];
    for (const original of timers) {
      const timer = { ...original };
      // Primeiro encerramos o "próximo turno" que estava ativo.
      if (timer.activeTurn && prev.actorId === actor.id) {
        const res = await expireTimedEffect(actor, timer);
        if (res?.defer) {
          timer.activeTurn = false;
          timer.awaitingNextTurn = true;
          timer.deferredByCannotLosePower = true;
          kept.push(timer);
        }
        changed = true;
        continue;
      }
      // Depois marcamos a entrada no próximo turno daquele Actor.
      if (timer.awaitingNextTurn && next.actorId === actor.id) {
        timer.awaitingNextTurn = false;
        timer.activeTurn = true;
        timer.startedRound = next.round;
        timer.startedTurn = next.turn;
        timer.deferredByCannotLosePower = false;
        kept.push(timer);
        changed = true;
        continue;
      }
      kept.push(timer);
    }
    if (changed) await writeTimedEffects(actor, kept);
  }
  state.lastCombatCursor = next;
}

async function expireRecoveryAtTurnStart(combat, changes) {
  if (!foundry.utils.hasProperty(changes || {}, "turn") && !foundry.utils.hasProperty(changes || {}, "round")) return;
  const active = combat?.combatant;
  const actor = active?.actor;
  if (!actor) return;
  const rec = recoveryState(actor);
  if (!rec?.active) return;
  const nowRound = num(combat.round, 0);
  if (nowRound <= num(rec.usedRound, 0)) return;
  const buffs = syncGeneratedBuff(actor.system?.customBuffs, RECOVERY_BUFF_MARKER, { effect: "Defense Value", T: 0, name: "Combat Recovery (DBU Automation)" });
  await gmOrOwnerUpdate(actor, { "system.customBuffs": buffs });
  await gmOrOwnerSetFlag(actor, `${STATE_FLAG}.combatRecovery`, { ...rec, active: false, expiredAt: Date.now() });
}

async function standardSocketHandler(data) {
  if (!data) return;
  if (data.type === "dbuaStandardResponse" && data.requesterId === game.user.id) {
    const pending = state.pendingRequests.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    state.pendingRequests.delete(data.requestId);
    pending.resolve({ ok: !!data.ok, error: data.error || null, result: data.result });
    return;
  }
  if (!isPrimaryGM() || !String(data.type || "").endsWith("Request")) return;

  const respond = (ok, error = null, result = null) => game.socket.emit(SOCKET, {
    type: "dbuaStandardResponse",
    requestId: data.requestId,
    requesterId: data.requesterId,
    ok,
    error,
    result
  });

  try {
    const requester = game.users?.get?.(data.requesterId);
    if (!requester?.active) throw new Error("Solicitante inválido ou desconectado.");
    if (data.type === "dbuaStandardResolveSyntheticClashRequest") {
      const responder = resolveParticipantActor(data.responderRef || {});
      if (!responder || !userOwnsActor(requester, responder)) throw new Error("O solicitante não controla o respondente do Grapple Check.");
      await completeSyntheticClashAsAuthority(responder, String(data.pendingId || ""), String(data.choice || "strike"), data.responseRoll || {});
      respond(true);
      return;
    }
    if (data.type === "dbuaStandardEmpowerRequest") {
      const source = resolveParticipantActor(data.sourceRef || {});
      const target = resolveParticipantActor(data.targetRef || {});
      if (!source || !target) throw new Error("Actor de origem ou alvo do Empower não foi encontrado.");
      if (!userOwnsActor(requester, source)) throw new Error("O solicitante não controla a origem do Empower.");
      const amount = Math.max(0, Math.trunc(num(data.amount, 0)));
      const capacityCost = Math.max(0, Math.trunc(num(data.capacityCost, 0)));
      const actions = Math.max(1, Math.trunc(num(data.actions, 1)));
      const sourceKi = Math.max(0, num(source.system?.kiPool?.value, 0));
      const sourceCapacity = Math.max(0, num(source.system?.status?.capacitySpent, 0));
      const targetKi = Math.max(0, num(target.system?.kiPool?.value, 0));
      const targetMax = Math.max(0, num(target.system?.kiPool?.max, targetKi));
      const capState = capacity(source);
      if (roundUses(source, "empower") > 0) throw new Error("Empower já foi usado neste Round.");
      const actionCheck = validateActionUse(source, { label: "Empower", actionCost: actions, notify: false });
      if (!actionCheck.ok) throw new Error(actionCheck.message);
      if (amount < 1 || sourceKi !== num(data.sourceKiBefore, -1) || sourceCapacity !== num(data.sourceCapacityBefore, -1) || targetKi !== num(data.targetKiBefore, -1)) {
        throw new Error("Os recursos mudaram antes da confirmação; reabra o Empower.");
      }
      if (sourceKi < amount || capState.left < capacityCost || targetKi + amount > targetMax) {
        throw new Error("Recursos insuficientes ou Ki do alvo excederia o máximo.");
      }
      await target.update({ "system.kiPool.value": targetKi + amount });
      try {
        await source.update({
          "system.kiPool.value": sourceKi - amount,
          "system.status.capacitySpent": sourceCapacity + capacityCost,
          "system.combatTabState": data.combatTabState
        });
      } catch (error) {
        await target.update({ "system.kiPool.value": targetKi }).catch(() => {});
        throw error;
      }
      respond(true);
      return;
    }
    const actor = resolveParticipantActor(data.actorRef || {});
    const authority = resolveParticipantActor(data.authorityRef || {});
    if (!actor) throw new Error("Actor de destino não encontrado pelo GM.");
    if (!userOwnsActor(requester, actor) && !userOwnsActor(requester, authority)) {
      throw new Error("O solicitante não controla o Actor que autorizou a operação.");
    }

    if (data.type === "dbuaStandardActorUpdateRequest") {
      if (!allowedStandardUpdates(data.updates)) throw new Error("Campos de atualização não permitidos.");
      await actor.update(data.updates);
    } else if (data.type === "dbuaStandardSetFlagRequest") {
      const path = String(data.path || "");
      if (!(path === STATE_FLAG || path.startsWith(`${STATE_FLAG}.`))) throw new Error("Flag fora do namespace Standard.");
      await actor.setFlag(MODULE_ID, path, data.value);
    } else {
      throw new Error("Operação Standard desconhecida.");
    }
    respond(true);
  } catch (error) {
    console.error("DBU Standard | socket transaction", error);
    respond(false, error?.message || "Falha na atualização validada pelo GM.");
  }
}

let standardSettingsPrepared = false;
function registerStandardSettingsNow() {
  if (!globalThis.game?.settings) return;
  const key = `${MODULE_ID}.${FAVORITES_SETTING}`;
  if (game.settings?.settings?.has?.(key)) return;
  game.settings.register(MODULE_ID, FAVORITES_SETTING, {
    name: "DBU HUD — Standard favoritos",
    scope: "client",
    config: false,
    type: String,
    default: '["attack","transform"]'
  });
}

export function registerStandardActionSettings() {
  if (standardSettingsPrepared) return;
  standardSettingsPrepared = true;
  if (globalThis.game?.ready) registerStandardSettingsNow();
  else Hooks.once("init", registerStandardSettingsNow);
}

export function initializeStandardActionsAutomation() {
  if (state.initialized) return state;
  state.initialized = true;
  if (state.socketHandler) try { game.socket.off(SOCKET, state.socketHandler); } catch {}
  state.socketHandler = standardSocketHandler;
  game.socket.on(SOCKET, state.socketHandler);
  state.hooks.updateActor = Hooks.on("updateActor", (actor, changes) => {
    const keys = Object.keys(changes || {}).join(" ");
    if (foundry.utils.hasProperty(changes || {}, "system.tracking.powerStacks")) {
      setTimeout(() => ensurePowerBuff(actor).catch(error => console.error("DBU Standard | power sync", error)), 30);
    }
    if (foundry.utils.hasProperty(changes || {}, "system.conditions")) {
      setTimeout(() => ensureGrappleConditions(actor).catch(error => console.error("DBU Standard | grapple condition lock", error)), 35);
    }
    if (keys.includes("clashes") || foundry.utils.hasProperty(changes || {}, `flags.${SYS_ID}.clashes`)) {
      setTimeout(() => inspectResolvedClashes(actor).catch(error => console.error("DBU Standard | clash resolve", error)), 40);
    }
  });
  state.hooks.updateCombat = Hooks.on("updateCombat", (combat, changes) => {
    const turnChanged = foundry.utils.hasProperty(changes || {}, "round") || foundry.utils.hasProperty(changes || {}, "turn");
    const previousActorId = state.lastCombatCursor?.actorId || null;
    const nextActorId = combat?.combatant?.actor?.id || null;
    processTimedEffectsAtTurnChange(combat, changes).catch(error => console.error("DBU Standard | timed effects", error));
    expireRecoveryAtTurnStart(combat, changes).catch(error => console.error("DBU Standard | recovery expiry", error));
    beginTurnGrappleEscape(combat, changes).catch(error => console.error("DBU Standard | grapple escape", error));
    if (turnChanged) {
      // v1.8.12: updateActor já mantém Power Buff sincronizado. Na troca de turno
      // revisamos apenas os dois Actors afetados, em vez de todos os Actors do mundo.
      const ids = new Set([previousActorId, nextActorId].filter(Boolean));
      setTimeout(() => {
        for (const actorId of ids) {
          const actor = combatActorById(combat, actorId);
          if (actor && (game.user?.isGM || actor.isOwner)) ensurePowerBuff(actor).catch(() => {});
        }
      }, 120);
    }
  });
  state.hooks.renderChatMessage = Hooks.on("renderChatMessage", (_message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    root?.querySelectorAll?.("[data-dbua-grapple-escape]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault();
      const pendingId = button.dataset.dbuaGrappleEscape;
      const actors = [
        ...(game.actors?.contents || []),
        ...(canvas?.tokens?.placeables || []).map(token => token.actor).filter(Boolean)
      ];
      const actor = actors.find(candidate => candidate?.getFlag?.(MODULE_ID, `${STATE_FLAG}.pendingActions.${pendingId}`));
      if (!actor) return ui.notifications.warn("A pendência de escape não foi encontrada.");
      button.disabled = true;
      try { await respondGrappleEscape(actor, pendingId, button.dataset.dbuaChoice); }
      catch (error) { console.error("DBU Standard | grapple escape response", error); ui.notifications.error(error?.message || "Falha ao responder ao escape."); }
      finally { button.disabled = false; }
    }));
    root?.querySelectorAll?.("[data-dbua-grapple-clash]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault();
      const pendingId = button.dataset.dbuaGrappleClash;
      const actors = [
        ...(game.actors?.contents || []),
        ...(canvas?.tokens?.placeables || []).map(token => token.actor).filter(Boolean)
      ];
      const actor = actors.find(candidate => candidate?.getFlag?.(MODULE_ID, `${STATE_FLAG}.pendingActions.${pendingId}`));
      if (!actor) return ui.notifications.warn("O Grapple Check pendente não foi encontrado.");
      button.disabled = true;
      try { await respondSyntheticGrappleClash(actor, pendingId, button.dataset.dbuaChoice); }
      catch (error) { console.error("DBU Standard | synthetic grapple response", error); ui.notifications.error(error?.message || "Falha ao responder ao Grapple Check."); }
      finally { button.disabled = false; }
    }));
  });
  state.lastCombatCursor = game.combat ? combatCursor(game.combat) : null;
  setTimeout(() => {
    for (const actor of (game.actors?.contents || [])) {
      if (game.user?.isGM || actor.isOwner) ensurePowerBuff(actor).catch(() => {});
    }
  }, 250);
  return state;
}

export const StandardActions = {
  registerManeuverAction,
  registerStandardActionProvider,
  listManeuverActions,
  getManeuverAction,
  open: openStandardMenu,
  openCategoryPreview: openManeuverCategoryPreview,
  run: runManeuverAction,
  favorites: getStandardFavorites,
  getManeuverFavorites,
  setFavorites: setStandardFavorites,
  setManeuverFavorites,
  toggleFavorite: toggleStandardFavorite,
  toggleManeuverFavorite,
  getGrappleState: currentGrapple,
  validateGrappleMovement,
  getPendingActions: getStandardPendingActions,
  respondExploitPending,
  respondGrappleEscape,
  respondSyntheticGrappleClash,
  powerUpRules,
  collisionDamage,
  cleanupActor: cleanupStandardActor
};
