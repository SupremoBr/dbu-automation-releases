// ============================================================
// DBU Automation v1.8.12 DEV — Painel exclusivo do Mestre
// ============================================================
// O painel consulta apenas o estado atual do mundo. Não mantém snapshots nem
// histórico de ações. As ferramentas de manutenção removem somente estados
// temporários do DBU Automation e nunca reembolsam recursos gastos.
// ============================================================

import { getPendingActions, clearPendingNotificationCache } from "./combat-panel.js";
import { applyInstantRecovery, openProlongedRecoveryDialog } from "./recovery.js";
import { DEFAULT_COMBAT_TEAMS, getCombatantTeam, setCombatantTeam, teamLabel } from "./combat-teams.js";

const MODULE_ID = "dbu-automation";
const MODULE_VERSION = "1.8.12 DEV";
const PANEL_VERSION = "1.0";
const CHARGE_SCOPE = "world";
const CHARGE_FLAG = "dbuEnergyChargeState";
const TEMPORARY_ACTOR_FLAGS = [
  [MODULE_ID, "kiMultiplierEncounter092"],
  [MODULE_ID, "transformationEncounterEntries"]
];
const RUNTIME_LOCKS = [
  "DBU_DEFENSE_LOCKS",
  "DBU_PAY_LOCKS",
  "DBU_DUEL_WAGER_LOCKS",
  "DBU_UNITED_ATTACK_LOCKS",
  "DBU_COMBAT_REVEAL_LOCKS",
  "DBU_DUEL_VISUAL_RESOLVE_LOCKS"
];

const OPEN = { dialog: null, root: null };
let refreshTimer = null;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pct(value, max) {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

function isGM() {
  return !!game.user?.isGM;
}

function isPrimaryGM() {
  const active = (game.users?.contents || [...(game.users || [])])
    .filter(user => user.active && user.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return active[0]?.id === game.user?.id;
}

function requireGM() {
  if (isGM()) return true;
  ui.notifications.warn("DBU Automation: o Painel do Mestre é exclusivo do GM.");
  return false;
}

function tokenForActor(actor) {
  if (!actor) return null;
  const combatant = game.combat?.combatants?.find?.(entry => entry.actor?.id === actor.id);
  const tokenId = combatant?.tokenId || combatant?.token?.id;
  return (tokenId ? canvas?.tokens?.get?.(tokenId) : null)
    || (canvas?.tokens?.placeables || []).find(token => token.actor?.id === actor.id)
    || null;
}

function uniqueCombatActors(combat = game.combat) {
  const actors = [];
  const seen = new Set();
  for (const combatant of combat?.combatants || []) {
    const actor = combatant.actor;
    if (!actor || seen.has(actor.id)) continue;
    seen.add(actor.id);
    actors.push(actor);
  }
  return actors;
}

function getCapacity(actor) {
  try {
    if (typeof globalThis.DBU?.getCapacity === "function") {
      return globalThis.DBU.getCapacity(actor);
    }
  } catch {}
  const max = number(actor?.system?.status?.maxCapacity, 0);
  const spent = number(actor?.system?.status?.capacitySpent, 0);
  return { max, spent, left: Math.max(0, max - spent) };
}

function activeTransformations(actor) {
  return (actor?.system?.transformations || [])
    .filter(entry => entry?.active && !/manifested power/i.test(String(entry?.name || "")))
    .map(entry => String(entry?.name || "Transformation"));
}

function activeAura(actor) {
  return (actor?.system?.signatureAuras || []).find(entry => entry?.active)?.name || "";
}

function activeConditions(actor) {
  return (actor?.system?.conditions || [])
    .filter(entry => entry?.active)
    .map(entry => String(entry?.name || entry?.label || entry?.id || "Condição"));
}

function actorState(actor) {
  const lp = {
    value: number(actor?.system?.lifePoints?.value, 0),
    max: number(actor?.system?.lifePoints?.max, 0)
  };
  const ki = {
    value: number(actor?.system?.kiPool?.value, 0),
    max: number(actor?.system?.kiPool?.max, 0)
  };
  const meta = actor?.system?.transformationMeta || {};
  const kiMultiplier = actor?.getFlag?.(MODULE_ID, "kiMultiplierEncounter092") || {};
  const charge = actor?.getFlag?.(CHARGE_SCOPE, CHARGE_FLAG) || null;
  const capacity = getCapacity(actor);
  const combatant = game.combat?.combatants?.find?.(entry => entry.actor?.id === actor.id) || null;

  return {
    actor,
    lp,
    ki,
    capacity,
    combatant,
    team: getCombatantTeam(combatant),
    turn: !!combatant && game.combat?.combatant?.id === combatant.id,
    transformations: activeTransformations(actor),
    aura: activeAura(actor),
    charge: charge?.active ? charge : null,
    conditions: activeConditions(actor),
    pending: getPendingActions(actor),
    legendRealized: Array.isArray(meta.legendRealizedUsed) ? meta.legendRealizedUsed : [],
    nlopEncounter: Array.isArray(meta.nlopActiveEncounter) ? meta.nlopActiveEncounter : [],
    nlopEver: Array.isArray(meta.newLevelOfPowerUsed) ? meta.newLevelOfPowerUsed : [],
    kiMultiplierTypes: kiMultiplier?.combatId === game.combat?.id
      ? Object.keys(kiMultiplier.types || {}).filter(key => kiMultiplier.types[key])
      : []
  };
}

function attackMessagesForCombat(combat = game.combat) {
  if (!combat?.id) return [];
  return (game.messages?.contents || [])
    .filter(message => message.getFlag?.("world", "dbuAttackData")?.combatId === combat.id)
    .sort((a, b) => number(b.timestamp || b._source?.timestamp, 0) - number(a.timestamp || a._source?.timestamp, 0));
}

function attackState(message) {
  const attack = message.getFlag("world", "dbuAttackData") || {};
  const states = message.getFlag("world", "dbuDefenseStates") || {};
  const targets = Array.isArray(attack.targetActorIds) ? attack.targetActorIds : [];
  let selected = 0;
  let resolved = 0;
  for (const targetId of targets) {
    const state = states[targetId] || {};
    if (state.resolved) resolved += 1;
    if (state.resolved || state.hiddenOutcome || state.selectedDefenseType || state.selectedDefenseName) selected += 1;
  }
  return {
    message,
    attack,
    targets: targets.length,
    selected,
    resolved,
    waiting: Math.max(0, targets.length - selected),
    revealed: !!message.getFlag("world", "dbuCombatRevealed"),
    revealLock: !!message.getFlag("world", "dbuCombatRevealInProgress"),
    unitedLock: !!message.getFlag("world", "dbuUnitedAttackLocked")
  };
}

function resourceMini(label, value, max, kind) {
  return `<div class="dbu-gm-resource"><span>${esc(label)} <b>${esc(value)}/${esc(max)}</b></span><i class="${esc(kind)}"><u style="width:${pct(value, max)}%"></u></i></div>`;
}

function chip(label, kind = "") {
  return `<span class="dbu-auto-chip ${esc(kind)}">${esc(label)}</span>`;
}

function actorStatusHTML(state) {
  const rows = [];
  if (state.transformations.length) rows.push(chip(`Forma: ${state.transformations.join(" + ")}`, "hot"));
  if (state.aura) rows.push(chip(`Aura: ${state.aura}`, "warn"));
  if (state.charge) rows.push(chip(`EC ${number(state.charge.gatheredCharges, 0)}`, "warn"));
  if (state.legendRealized.length) rows.push(chip(`Legend ${state.legendRealized.length}`, "good"));
  if (state.nlopEncounter.length) rows.push(chip(`NLoP ativo ${state.nlopEncounter.length}`, "good"));
  if (state.kiMultiplierTypes.length) rows.push(chip(`Ki Multiplier ${state.kiMultiplierTypes.length}`, "good"));
  if (state.conditions.length) rows.push(chip(`${state.conditions.length} condição(ões)`, "danger"));
  if (!rows.length) rows.push(chip("Sem efeitos temporários"));
  return rows.join("");
}

function actorRowHTML(state) {
  const actor = state.actor;
  const initiative = state.combatant?.initiative;
  const knownTeam = state.team && !DEFAULT_COMBAT_TEAMS.some(team => team.id === state.team)
    ? `<option value="${esc(state.team)}" selected>${esc(teamLabel(state.team))}</option>`
    : "";
  const teamOptions = `<option value="" ${state.team ? "" : "selected"}>Sem Time (fallback Disposition)</option>`
    + DEFAULT_COMBAT_TEAMS.map(team => `<option value="${esc(team.id)}" ${state.team === team.id ? "selected" : ""}>${esc(team.label)}</option>`).join("")
    + knownTeam;
  return `<div class="dbu-gm-actor-row ${state.turn ? "is-turn" : ""}" data-dbu-gm-actor-row="${esc(actor.id)}">
    <div class="dbu-gm-actor-main">
      <img src="${esc(actor.img || "icons/svg/mystery-man.svg")}" alt="${esc(actor.name)}">
      <div class="dbu-gm-actor-identity">
        <strong>${esc(actor.name)}</strong>
        <span>${state.turn ? "▶ TURNO ATUAL · " : ""}Iniciativa ${initiative == null ? "—" : esc(initiative)} · Tier ${esc(number(actor.system?.tier, 1))}</span>
        <label class="dbu-gm-team-control" title="Time deste combatente somente no Encounter atual"><i class="fas fa-users"></i><select data-dbu-gm-team data-combatant-id="${esc(state.combatant?.id || "")}" ${state.combatant ? "" : "disabled"}>${teamOptions}</select></label>
      </div>
    </div>
    <div class="dbu-gm-resources">
      ${resourceMini("LP", state.lp.value, state.lp.max, "lp")}
      ${resourceMini("Ki", state.ki.value, state.ki.max, "ki")}
      ${resourceMini("Cap", state.capacity.left, state.capacity.max, "capacity")}
    </div>
    <div class="dbu-auto-chip-row dbu-gm-status">${actorStatusHTML(state)}</div>
    <div class="dbu-gm-pending ${state.pending.length ? "has-pending" : ""}">
      <b>${state.pending.length}</b><span>Pendência(s)</span>
    </div>
    <div class="dbu-gm-row-actions">
      <button type="button" data-dbu-gm-action="focus" data-actor-id="${esc(actor.id)}" title="Localizar token"><i class="fas fa-crosshairs"></i></button>
      <button type="button" data-dbu-gm-action="sheet" data-actor-id="${esc(actor.id)}" title="Abrir ficha"><i class="fas fa-user"></i></button>
      <button type="button" data-dbu-gm-action="combat-panel" data-actor-id="${esc(actor.id)}" title="Abrir Painel de Combate"><i class="fas fa-dragon"></i></button>
      <button type="button" class="danger" data-dbu-gm-action="cleanup-actor" data-actor-id="${esc(actor.id)}" title="Limpar estados temporários deste encontro"><i class="fas fa-broom"></i></button>
    </div>
  </div>`;
}

function attackRowHTML(row) {
  const attack = row.attack;
  const lock = row.revealLock || row.unitedLock;
  const status = row.revealed
    ? chip("Revelado", "good")
    : row.waiting
      ? chip(`Aguardando ${row.waiting}`, "warn")
      : chip("Defesas escolhidas", "good");
  return `<div class="dbu-gm-attack-row ${lock ? "has-lock" : ""}">
    <div><strong>${esc(attack.attackerName || "Atacante")} — ${esc(attack.attackName || "Ataque")}</strong><span>${esc(attack.foundation || "")} / ${esc(attack.profile || "")} · ${row.selected}/${row.targets} defesa(s)</span></div>
    <div class="dbu-auto-chip-row">${status}${row.revealLock ? chip("Reveal lock", "danger") : ""}${row.unitedLock ? chip("United lock", "danger") : ""}</div>
    <button type="button" data-dbu-gm-action="unlock-message" data-message-id="${esc(row.message.id)}" ${lock ? "" : "disabled"}><i class="fas fa-unlock"></i> Destravar</button>
  </div>`;
}

function diagnosticsHTML() {
  const api = globalThis.DBUAutomation || {};
  const runtimeLocks = RUNTIME_LOCKS.reduce((total, name) => total + number(globalThis[name]?.size, 0), 0);
  const items = [
    ["Módulo", `v${api.version || MODULE_VERSION}`, api.mainLoaded],
    ["Core", globalThis.DBU?.version || api.readyState || "OFF", api.coreReady],
    ["Sistema", game.system?.id || "—", game.system?.id === "DBU-MRR-OLD"],
    ["Painel GM", `v${PANEL_VERSION}`, !!globalThis.DBU_GM_PANEL_AUTOMATION?.initialized],
    ["Socket", game.socket?.connected === false ? "Desconectado" : "Ativo", game.socket?.connected !== false],
    ["Travas em memória", String(runtimeLocks), runtimeLocks === 0]
  ];
  return `<div class="dbu-gm-diagnostic-grid">${items.map(([label, value, ok]) => `<div class="dbu-gm-diagnostic ${ok ? "ok" : "warn"}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</div>`;
}

function buildPanelContent() {
  const combat = game.combat;
  const states = uniqueCombatActors(combat).map(actorState);
  const attacks = attackMessagesForCombat(combat).map(attackState);
  const pending = states.reduce((sum, state) => sum + state.pending.length, 0);
  const charges = states.filter(state => state.charge).length;
  const locks = attacks.filter(row => row.revealLock || row.unitedLock).length
    + RUNTIME_LOCKS.reduce((sum, name) => sum + number(globalThis[name]?.size, 0), 0);
  const combatLabel = combat
    ? `Round ${number(combat.round, 0)} · Turno ${number(combat.turn, 0) + 1}`
    : "Nenhum combate ativo";

  return `<div class="dbu-auto-window dbu-gm-panel" data-dbu-gm-panel="1">
    <div class="dbu-gm-header">
      <div class="dbu-gm-scouter"><i class="fas fa-satellite-dish"></i></div>
      <div><div class="dbu-auto-name">Painel do Mestre</div><div class="dbu-auto-subline">${esc(combatLabel)} · DBU Automation ${MODULE_VERSION}</div></div>
      <button type="button" data-dbu-gm-action="refresh" title="Atualizar"><i class="fas fa-sync-alt"></i></button>
    </div>

    <div class="dbu-gm-summary">
      <div><span>Combatentes</span><b>${states.length}</b></div>
      <div><span>Pendências</span><b class="${pending ? "warn" : ""}">${pending}</b></div>
      <div><span>Energy Charge</span><b>${charges}</b></div>
      <div><span>Travas</span><b class="${locks ? "danger" : ""}">${locks}</b></div>
    </div>

    <div class="dbu-auto-section">
      <div class="dbu-auto-section-title"><span><i class="fas fa-users"></i> Combatentes / Times</span><span>${states.length}</span></div>
      <div class="dbu-auto-section-body">
        <div class="dbu-auto-empty" style="margin-bottom:8px;"><i class="fas fa-magic"></i> Entrada automática: combatentes com <b>OWNER de jogador → Time A</b>; demais combatentes → <b>Time B</b>. O GM pode trocar o Time individualmente abaixo.</div>
        <div class="dbu-gm-list">${states.length ? states.map(actorRowHTML).join("") : `<div class="dbu-auto-empty"><i class="fas fa-info-circle"></i> Inicie um combate para listar os participantes.</div>`}</div>
      </div>
    </div>

    <div class="dbu-auto-section">
      <div class="dbu-auto-section-title orange"><span><i class="fas fa-shield-alt"></i> Ataques e defesas</span><span>${attacks.length}</span></div>
      <div class="dbu-auto-section-body dbu-gm-list">${attacks.length ? attacks.slice(0, 12).map(attackRowHTML).join("") : `<div class="dbu-auto-empty"><i class="fas fa-check-circle"></i> Nenhum ataque registrado neste combate.</div>`}</div>
    </div>

    <div class="dbu-auto-section">
      <div class="dbu-auto-section-title green"><span><i class="fas fa-heartbeat"></i> Recovery</span><span>DBU 0.9.2</span></div>
      <div class="dbu-auto-section-body">
        <div class="dbu-gm-maintenance-actions">
          <button type="button" data-dbu-gm-action="prolonged-recovery" ${combat?.started ? "disabled" : ""}><i class="fas fa-hourglass-half"></i><span>Prolonged Recovery<small>Escolha os jogadores e as horas fora de Combat. Recupera 1/10 Max LP + Ki por hora.</small></span></button>
        </div>
        <div class="dbu-auto-empty" style="margin-top:8px;"><i class="fas fa-info-circle"></i> Instant Recovery é aplicada automaticamente aos personagens de jogadores quando você confirma <b>End Encounter</b> no Combat Tracker. Capacity não é recuperada.</div>
      </div>
    </div>

    <div class="dbu-auto-section">
      <div class="dbu-auto-section-title purple"><span><i class="fas fa-tools"></i> Manutenção</span><span>GM</span></div>
      <div class="dbu-auto-section-body">
        <div class="dbu-gm-maintenance-actions">
          <button type="button" data-dbu-gm-action="clear-locks"><i class="fas fa-unlock-alt"></i><span>Limpar travas<small>Libera operações interrompidas, sem desfazer recursos.</small></span></button>
          <button type="button" data-dbu-gm-action="prune-orphans"><i class="fas fa-broom"></i><span>Limpar órfãos<small>Remove estados ligados a cards que não existem mais.</small></span></button>
          <button type="button" data-dbu-gm-action="diagnostic"><i class="fas fa-stethoscope"></i><span>Executar diagnóstico<small>Mostra o estado técnico do módulo.</small></span></button>
          <button type="button" class="danger" data-dbu-gm-action="cleanup-encounter" ${combat ? "" : "disabled"}><i class="fas fa-power-off"></i><span>Encerrar temporários<small>Limpa estados do encontro atual. Não reembolsa Ki/Capacity.</small></span></button>
        </div>
      </div>
    </div>

    <div class="dbu-auto-section">
      <div class="dbu-auto-section-title green"><span><i class="fas fa-heartbeat"></i> Diagnóstico rápido</span></div>
      <div class="dbu-auto-section-body">${diagnosticsHTML()}</div>
    </div>

    <div class="dbu-gm-footnote"><i class="fas fa-memory"></i> Este painel não grava histórico nem snapshots. Ele lê somente o estado atual do Foundry.</div>
  </div>`;
}

async function confirmMaintenance(title, content) {
  return Dialog.confirm({
    title,
    content: `<div class="dbu-auto-window"><div class="dbu-auto-rule-block"><div class="dbu-auto-rule-title"><i class="fas fa-exclamation-triangle"></i> Confirmação do Mestre</div><p>${content}</p></div></div>`,
    yes: () => true,
    no: () => false,
    defaultYes: false
  });
}

function setCondition(conditions, id, active) {
  const existing = conditions.find(entry => entry?.id === id);
  if (existing) {
    existing.active = !!active;
    if (!active) existing.stacks = 0;
  }
  return conditions;
}

async function stopChargeVisual(actor, state) {
  const token = tokenForActor(actor);
  try {
    if (globalThis.Sequencer?.EffectManager) {
      await globalThis.Sequencer.EffectManager.endEffects({
        name: `DBU Energy Charge | ${actor.id}`,
        ...(token ? { object: token } : {})
      });
    }
  } catch (error) {
    console.warn("DBU Painel GM | limpeza visual do Energy Charge:", error);
  }

  const macroName = state?.visualKind === "macro" ? String(state.visualValue || "") : "";
  if (!macroName) return;
  try {
    const payload = {
      actor,
      token,
      attacker: actor,
      attackerToken: token,
      chargeAction: "energy-charge",
      mode: "off",
      phase: "deactivate",
      stage: state.visualStage || null,
      totalCharges: number(state.visualTotalCharges, 0),
      gatheredCharges: number(state.gatheredCharges, 0),
      state: foundry.utils.deepClone(state),
      effectName: `DBU Energy Charge | ${actor.id}`
    };
    if (macroName.trim().toLowerCase() === "visual energy charge" && typeof globalThis.DBUAutomation?.visualEnergyCharge === "function") {
      await globalThis.DBUAutomation.visualEnergyCharge(payload);
    } else {
      await game.macros?.getName?.(macroName)?.execute?.(payload);
    }
  } catch (error) {
    console.warn(`DBU Painel GM | macro visual ${macroName}:`, error);
  }
}

async function clearEnergyCharge(actor) {
  const state = actor?.getFlag?.(CHARGE_SCOPE, CHARGE_FLAG) || null;
  if (!state) return 0;
  await stopChargeVisual(actor, state);

  const updates = {};
  if (!state.guardDownWasActiveBefore && !state.powerOfMovement) {
    const conditions = foundry.utils.deepClone(actor.system?.conditions || []);
    setCondition(conditions, "guardDown", false);
    updates["system.conditions"] = conditions;
  }
  if (Object.keys(updates).length) await actor.update(updates);
  await actor.unsetFlag(CHARGE_SCOPE, CHARGE_FLAG).catch(() => {});
  return 1;
}

function messageBelongsToCombat(messageId, combatId) {
  const message = game.messages?.get?.(String(messageId));
  return message?.getFlag?.("world", "dbuAttackData")?.combatId === combatId;
}

async function removeMapEntries(actor, scope, key, predicate) {
  const current = actor.getFlag(scope, key);
  if (!current || typeof current !== "object" || Array.isArray(current)) return 0;
  const next = {};
  let removed = 0;
  for (const [entryKey, value] of Object.entries(current)) {
    if (predicate(entryKey, value)) removed += 1;
    else next[entryKey] = value;
  }
  if (!removed) return 0;
  if (Object.keys(next).length) await actor.setFlag(scope, key, next);
  else await actor.unsetFlag(scope, key).catch(() => {});
  return removed;
}

async function clearActorTemporaryStates(actor, { combatId = game.combat?.id || null } = {}) {
  if (!actor) return 0;
  let changed = 0;
  changed += await clearEnergyCharge(actor);
  if (typeof globalThis.DBUAutomation?.StandardActions?.cleanupActor === "function") {
    try { changed += Number(await globalThis.DBUAutomation.StandardActions.cleanupActor(actor)) || 0; }
    catch (error) { console.warn("DBU Painel GM | limpeza Standard Maneuvers:", error); }
  }

  const meta = actor.system?.transformationMeta || {};
  const updates = {};
  if ((meta.legendRealizedUsed || []).length) {
    updates["system.transformationMeta.legendRealizedUsed"] = [];
    changed += 1;
  }
  if ((meta.nlopActiveEncounter || []).length) {
    updates["system.transformationMeta.nlopActiveEncounter"] = [];
    changed += 1;
  }
  if (Object.keys(updates).length) await actor.update(updates);

  for (const [scope, key] of TEMPORARY_ACTOR_FLAGS) {
    const value = actor.getFlag(scope, key);
    if (value == null) continue;
    if (key === "kiMultiplierEncounter092" && combatId && value?.combatId && value.combatId !== combatId) continue;
    await actor.unsetFlag(scope, key).catch(() => {});
    changed += 1;
  }

  changed += await removeMapEntries(actor, "world", "dbuDefenseStates", messageId => {
    if (!combatId) return true;
    return !game.messages?.get?.(messageId) || messageBelongsToCombat(messageId, combatId);
  });
  changed += await removeMapEntries(actor, MODULE_ID, "reflectUsage", messageId => {
    if (!combatId) return true;
    return !game.messages?.get?.(messageId) || messageBelongsToCombat(messageId, combatId);
  });
  changed += await removeMapEntries(actor, "world", "dbuDuelContexts", (_duelId, value) => {
    const messageId = value?.originalAttackMessageId;
    if (!combatId) return !messageId || !game.messages?.get?.(messageId);
    return !messageId || !game.messages?.get?.(messageId) || messageBelongsToCombat(messageId, combatId);
  });

  return changed;
}

async function clearRuntimeLocks(messages = attackMessagesForCombat()) {
  let cleared = 0;
  for (const name of RUNTIME_LOCKS) {
    const set = globalThis[name];
    if (!set?.clear) continue;
    cleared += number(set.size, 0);
    set.clear();
  }
  clearPendingNotificationCache();

  for (const message of messages) {
    const updates = {};
    if (message.getFlag("world", "dbuCombatRevealInProgress")) {
      updates["flags.world.dbuCombatRevealInProgress"] = false;
      cleared += 1;
    }
    if (message.getFlag("world", "dbuUnitedAttackLocked")) {
      updates["flags.world.dbuUnitedAttackLocked"] = false;
      cleared += 1;
    }
    if (Object.keys(updates).length) await message.update(updates);
  }
  return cleared;
}

async function pruneOrphanStates() {
  let removed = 0;
  for (const actor of game.actors?.contents || []) {
    removed += await removeMapEntries(actor, "world", "dbuDefenseStates", messageId => !game.messages?.get?.(messageId));
    removed += await removeMapEntries(actor, MODULE_ID, "reflectUsage", messageId => !game.messages?.get?.(messageId));
    removed += await removeMapEntries(actor, "world", "dbuDuelContexts", (_duelId, value) => {
      const messageId = value?.originalAttackMessageId;
      return !!messageId && !game.messages?.get?.(messageId);
    });
  }
  return removed;
}

export async function cleanupEncounter({ combat = game.combat, automatic = false } = {}) {
  if (!requireGM() || !combat?.id) return { actors: 0, states: 0, locks: 0 };
  const actors = uniqueCombatActors(combat);
  let states = 0;
  for (const actor of actors) states += await clearActorTemporaryStates(actor, { combatId: combat.id });
  const messages = attackMessagesForCombat(combat);
  const locks = await clearRuntimeLocks(messages);

  if (!automatic) {
    ui.notifications.info(`DBU Painel GM: ${actors.length} Actor(s), ${states} estado(s) temporário(s) e ${locks} trava(s) tratados.`);
  }
  return { actors: actors.length, states, locks };
}

async function focusActor(actor) {
  const token = tokenForActor(actor);
  if (!token) return ui.notifications.warn(`${actor.name}: token não encontrado na cena atual.`);
  try {
    await canvas.animatePan({ x: token.center.x, y: token.center.y, scale: Math.max(number(canvas.stage?.scale?.x, 1), 0.75) });
    token.control?.({ releaseOthers: true });
  } catch (error) {
    console.error("DBU Painel GM | localizar token:", error);
  }
}

async function unlockMessage(message) {
  if (!message) return;
  const updates = {};
  if (message.getFlag("world", "dbuCombatRevealInProgress")) updates["flags.world.dbuCombatRevealInProgress"] = false;
  if (message.getFlag("world", "dbuUnitedAttackLocked")) updates["flags.world.dbuUnitedAttackLocked"] = false;
  globalThis.DBU_COMBAT_REVEAL_LOCKS?.delete?.(message.id);
  for (const setName of ["DBU_DEFENSE_LOCKS", "DBU_UNITED_ATTACK_LOCKS"]) {
    const set = globalThis[setName];
    if (!set?.size) continue;
    for (const key of [...set]) if (String(key).includes(message.id)) set.delete(key);
  }
  if (Object.keys(updates).length) await message.update(updates);
}

async function runAction(button) {
  if (!requireGM()) return;
  const action = button.dataset.dbuGmAction;
  const actor = button.dataset.actorId ? game.actors?.get?.(button.dataset.actorId) : null;
  const message = button.dataset.messageId ? game.messages?.get?.(button.dataset.messageId) : null;

  if (action === "refresh") return refreshOpenPanel();
  if (action === "sheet") return actor?.sheet?.render?.(true);
  if (action === "focus") return focusActor(actor);
  if (action === "combat-panel") {
    return globalThis.DBUAutomation?.panel?.({ actor, token: tokenForActor(actor) });
  }
  if (action === "diagnostic") {
    globalThis.DBUAutomation?.diagnostic?.();
    return refreshOpenPanel();
  }
  if (action === "prolonged-recovery") {
    await openProlongedRecoveryDialog();
    return refreshOpenPanel();
  }
  if (action === "unlock-message") {
    await unlockMessage(message);
    ui.notifications.info("DBU Painel GM: trava da carta removida.");
    return refreshOpenPanel();
  }
  if (action === "clear-locks") {
    const confirmed = await confirmMaintenance("Limpar travas do DBU?", "Libera operações que ficaram interrompidas. Recursos gastos e resultados já aplicados não serão alterados.");
    if (!confirmed) return;
    const count = await clearRuntimeLocks();
    ui.notifications.info(`DBU Painel GM: ${count} trava(s) removida(s).`);
    return refreshOpenPanel();
  }
  if (action === "prune-orphans") {
    const confirmed = await confirmMaintenance("Limpar estados órfãos?", "Serão removidos somente estados ligados a cards do chat que já não existem.");
    if (!confirmed) return;
    const count = await pruneOrphanStates();
    ui.notifications.info(`DBU Painel GM: ${count} estado(s) órfão(s) removido(s).`);
    return refreshOpenPanel();
  }
  if (action === "cleanup-actor") {
    if (!actor) return;
    const confirmed = await confirmMaintenance(`Limpar temporários de ${esc(actor.name)}?`, "Legend Realized do encontro, NLoP ativo no encontro, Ki Multiplier, Energy Charge e pendências deste combate serão limpos. New Level of Power já realizado na campanha não será apagado. Não haverá reembolso.");
    if (!confirmed) return;
    const count = await clearActorTemporaryStates(actor, { combatId: game.combat?.id || null });
    ui.notifications.info(`${actor.name}: ${count} estado(s) temporário(s) tratado(s).`);
    return refreshOpenPanel();
  }
  if (action === "cleanup-encounter") {
    const confirmed = await confirmMaintenance("Encerrar estados temporários do encontro?", "Todos os participantes do combate atual serão limpos. Transformations e Signature Auras ativas não serão desativadas, e nenhum Ki/Capacity será reembolsado.");
    if (!confirmed) return;
    await cleanupEncounter({ combat: game.combat, automatic: false });
    return refreshOpenPanel();
  }
}

function attachListeners(root) {
  for (const select of root.querySelectorAll("[data-dbu-gm-team]")) {
    select.addEventListener("change", async event => {
      event.preventDefault();
      const combatantId = select.dataset.combatantId;
      const combatant = game.combat?.combatants?.get?.(combatantId)
        || game.combat?.combatants?.find?.(entry => entry.id === combatantId)
        || null;
      if (!combatant) return ui.notifications.warn("DBU Times: combatente não encontrado no Encounter atual.");
      select.disabled = true;
      try {
        await setCombatantTeam(combatant, select.value);
        ui.notifications.info(`${combatant.name}: ${select.value ? teamLabel(select.value) : "sem Time; usando Disposition como fallback"}.`);
        await refreshOpenPanel();
      } catch (error) {
        console.error("DBU Times:", error);
        ui.notifications.error(error?.message || "Erro alterando o Time do combatente.");
      } finally {
        if (select.isConnected) select.disabled = false;
      }
    });
  }

  for (const button of root.querySelectorAll("[data-dbu-gm-action]")) {
    button.addEventListener("click", async event => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      try {
        await runAction(button);
      } catch (error) {
        console.error("DBU Painel GM:", error);
        ui.notifications.error(error?.message || "Erro no Painel do Mestre.");
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  }
}

export async function refreshOpenPanel() {
  if (!OPEN.dialog || !OPEN.root?.isConnected) return false;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = buildPanelContent();
  const next = wrapper.firstElementChild;
  if (!next) return false;
  OPEN.root.replaceWith(next);
  OPEN.root = next;
  attachListeners(next);
  return true;
}

function scheduleRefresh() {
  if (!OPEN.dialog) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshOpenPanel().catch(error => console.warn("DBU Painel GM | atualização:", error));
  }, 100);
}

export async function openGmPanel({ toggle = true } = {}) {
  if (!requireGM()) return null;
  if (OPEN.dialog?.rendered || OPEN.root?.isConnected) {
    if (toggle) {
      await OPEN.dialog.close?.();
      return null;
    }
    OPEN.dialog.bringToTop?.();
    await refreshOpenPanel();
    return OPEN.dialog;
  }

  let dialog = null;
  dialog = new Dialog({
    title: "DBU — Painel do Mestre",
    content: buildPanelContent(),
    buttons: {
      close: { icon: '<i class="fas fa-times"></i>', label: "Fechar" }
    },
    render: html => {
      const shell = html instanceof HTMLElement ? html : html?.[0] || null;
      const root = shell?.querySelector?.("[data-dbu-gm-panel]");
      if (!root) return;
      OPEN.dialog = dialog;
      OPEN.root = root;
      attachListeners(root);
    },
    close: () => {
      OPEN.dialog = null;
      OPEN.root = null;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }, {
    width: 980,
    height: "auto",
    resizable: true,
    classes: ["dbu-gm-panel-dialog", "dbu-auto-window-shell"]
  });
  dialog.render(true);
  return dialog;
}

function toolbarActions() {
  return [
    {
      name: "dbuGmPanel",
      title: "DBU — Painel do Mestre",
      icon: "fas fa-satellite-dish",
      run: () => openGmPanel({ toggle: true })
    },
    {
      name: "dbuCombatPanel",
      title: "DBU — Painel de Combate",
      icon: "fas fa-dragon",
      run: () => globalThis.DBUAutomation?.panel?.()
    },
    {
      name: "dbuDiagnostic",
      title: "DBU — Diagnóstico",
      icon: "fas fa-stethoscope",
      run: () => globalThis.DBUAutomation?.diagnostic?.()
    },
    {
      name: "dbuVisualConfig",
      title: "DBU — Configurar Visuais",
      icon: "fas fa-palette",
      run: () => globalThis.DBUAutomation?.visualConfig?.()
    }
  ];
}

function addSceneControl(controls) {
  if (!isGM()) return;
  const actions = toolbarActions();

  // Foundry v12 usa arrays e onClick.
  if (Array.isArray(controls)) {
    if (controls.some(control => control.name === "dbuAutomation")) return;
    controls.push({
      name: "dbuAutomation",
      title: "DBU Automation",
      layer: "tokens",
      icon: "fas fa-satellite-dish",
      visible: true,
      activeTool: "dbuGmPanel",
      tools: actions.map(action => ({
        name: action.name,
        title: action.title,
        icon: action.icon,
        visible: true,
        toggle: false,
        active: false,
        button: true,
        onClick: action.run
      }))
    });
    return;
  }

  // Foundry v13 usa records e onChange.
  if (!controls || typeof controls !== "object" || controls.dbuAutomation) return;
  const tools = {};
  actions.forEach((action, index) => {
    tools[action.name] = {
      name: action.name,
      title: action.title,
      icon: action.icon,
      order: index,
      button: true,
      visible: true,
      onChange: () => action.run()
    };
  });
  controls.dbuAutomation = {
    name: "dbuAutomation",
    title: "DBU Automation",
    icon: "fas fa-satellite-dish",
    order: Object.keys(controls).length,
    activeTool: "dbuGmPanel",
    visible: true,
    tools
  };
}

export function initializeGmPanelAutomation() {
  const previous = globalThis.DBU_GM_PANEL_AUTOMATION || {};
  for (const [hook, id] of Object.entries(previous.hooks || {})) {
    try { Hooks.off(hook, id); } catch {}
  }
  if (previous.sceneControlsHookId) {
    try { Hooks.off("getSceneControlButtons", previous.sceneControlsHookId); } catch {}
  }

  const sceneControlsHookId = Hooks.on("getSceneControlButtons", addSceneControl);
  const hooks = {
    createChatMessage: Hooks.on("createChatMessage", scheduleRefresh),
    updateChatMessage: Hooks.on("updateChatMessage", scheduleRefresh),
    deleteChatMessage: Hooks.on("deleteChatMessage", scheduleRefresh),
    updateActor: Hooks.on("updateActor", scheduleRefresh),
    updateCombat: Hooks.on("updateCombat", scheduleRefresh),
    updateCombatant: Hooks.on("updateCombatant", scheduleRefresh),
    createCombatant: Hooks.on("createCombatant", scheduleRefresh),
    deleteCombatant: Hooks.on("deleteCombatant", scheduleRefresh),
    canvasReady: Hooks.on("canvasReady", scheduleRefresh),
    deleteCombat: Hooks.on("deleteCombat", async combat => {
      if (!isPrimaryGM()) return;
      try {
        // Foundry End Encounter empties/deletes the Combat. Apply DBU 0.9.2
        // Instant Recovery before encounter-only temporary state is cleaned up.
        const recovery = await applyInstantRecovery(combat, { announce: true });
        const result = await cleanupEncounter({ combat, automatic: true });
        ui.notifications.info(`DBU Automation: encontro encerrado; Instant Recovery aplicada a ${recovery.recovered} personagem(ns) e ${result.states} estado(s) temporário(s) limpo(s).`);
      } catch (error) {
        console.error("DBU Painel GM | encerramento automático do encontro:", error);
        ui.notifications.warn("DBU Automation: não foi possível concluir toda a recuperação/limpeza automática do encontro.");
      }
      scheduleRefresh();
    })
  };

  const state = {
    initialized: true,
    version: PANEL_VERSION,
    moduleVersion: MODULE_VERSION,
    sceneControlsHookId,
    hooks,
    open: openGmPanel,
    refresh: refreshOpenPanel,
    cleanupEncounter
  };
  globalThis.DBU_GM_PANEL_AUTOMATION = state;
  console.log(`DBU Automation v${MODULE_VERSION} | Painel do Mestre ${PANEL_VERSION} registrado`);
  return state;
}

export const GmPanel = {
  open: openGmPanel,
  refresh: refreshOpenPanel,
  cleanupEncounter
};