// DBU Automation v1.8.5 TEST — Action economy informativa (DBU 0.9.2)

const MODULE_ID = "dbu-automation-dev";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function conditionState(actor, id) {
  return (actor?.system?.conditions || []).find(condition => condition?.id === id) || null;
}

export function conditionActive(actor, id) {
  return !!conditionState(actor, id)?.active;
}

/**
 * Returns the active Foundry Combat only when this Actor actually participates
 * in it. DBU limits expressed per Round / per Encounter are intentionally not
 * enforced outside an active Encounter (v1.8.1).
 */
export function activeCombatForActor(actor, combat = game.combat) {
  if (!actor || !combat) return null;
  const started = combat.started === true || (combat.round != null && Number(combat.round) > 0);
  if (!started) return null;
  const combatants = combat.combatants?.contents || combat.combatants || [];
  const combatant = Array.from(combatants).find(entry => {
    if (entry?.actor?.id === actor.id) return true;
    const tokenActorId = entry?.token?.actor?.id || entry?.token?.actorId || null;
    return tokenActorId === actor.id;
  });
  return combatant ? { combat, combatant } : null;
}

export function actorInActiveCombat(actor, combat = game.combat) {
  return !!activeCombatForActor(actor, combat);
}

export function currentRoundData(actor) {
  const cts = foundry.utils.deepClone(actor?.system?.combatTabState || {});
  cts.rounds ??= [];
  if (!cts.rounds.length) cts.rounds.push({ roundNumber: 1, actions: [] });
  const round = cts.rounds[cts.rounds.length - 1];
  round.roundNumber ??= cts.rounds.length;
  round.actions ??= [];
  cts.currentRound = round.roundNumber;
  cts.resourceUsage ??= { round: {}, encounter: {} };
  cts.resourceUsage.round ??= {};
  cts.resourceUsage.encounter ??= {};
  return { cts, round };
}

export function standardActionCostOf(row) {
  if (!row || row.dbuExtraPowerStack || row.dbuOutsideCombat) return 0;
  if (Number.isFinite(Number(row.actionCost))) return Math.max(0, Number(row.actionCost));
  if (row.dbuEnergyCharge && String(row.type || "standard") === "standard") return 1;
  const type = String(row.type || "");
  if (["attack", "transform", "power-up", "energy-charge", "charge", "grapple", "launch", "pin", "escape-pin", "thrust", "throw", "aura", "movement", "command", "toss"].includes(type)) return 1;
  return 0;
}

export function standardActionsSpent(actor) {
  if (!actorInActiveCombat(actor)) return 0;
  const { round } = currentRoundData(actor);
  return (round.actions || []).reduce((sum, row) => sum + standardActionCostOf(row), 0);
}

function brawlerPinnedBonus(actor) {
  const talents = actor?.system?.talents || [];
  return talents.some(entry => {
    const id = String(entry?.talentKey ?? entry?.id ?? entry?.key ?? entry ?? "").toLowerCase();
    const name = String(entry?.name || "").toLowerCase();
    return id === "brawler" || name === "brawler";
  }) ? 1 : 0;
}

/**
 * DBU 0.9.2 grants 3 Actions each Round. Pinned reduces that pool to 1
 * (Brawler adds one while Pinned) and Slowed removes one per stack.
 * Explicit modifiers are supplied by the Maneuver provider layer so unusual
 * character effects do not need to be guessed here.
 */
export function standardActionBudget(actor, { limitBonus = 0 } = {}) {
  const pinned = conditionActive(actor, "pinned");
  const slowed = conditionState(actor, "slowed");
  const slowedStacks = slowed?.active ? Math.max(0, Math.trunc(number(slowed.stacks, 0))) : 0;
  const inCombat = actorInActiveCombat(actor);
  const base = pinned ? 1 + brawlerPinnedBonus(actor) : 3;

  const limit = Math.max(0, Math.trunc(base + number(limitBonus, 0) - slowedStacks));

  // Fora de um Encounter ativo não existe um Round persistente para consumir.
  // Cada uso começa com o orçamento normal de Actions disponível, de modo que
  // custos como "2 Actions" continuam relevantes, mas usos anteriores fora de
  // Combat não bloqueiam a próxima Maneuver nem contaminam o próximo Encounter.
  if (!inCombat) {
    return { base, limit, spent: 0, remaining: limit, pinned, slowedStacks, inCombat: false };
  }

  const spent = standardActionsSpent(actor);
  return { base, limit, spent, remaining: Math.max(0, limit - spent), pinned, slowedStacks, inCombat: true };
}

export function validateActionUse(actor, {
  label = "Maneuver",
  actionCost = 1,
  effectiveType = "standard",
  attacking = false,
  movement = false,
  allowPinnedEscape = false,
  limitBonus = 0,
  notify = true
} = {}) {
  if (!actor) return { ok: false, reason: "actor", message: `${label}: personagem não encontrado.` };
  const budget = standardActionBudget(actor, { limitBonus });

  let message = "";
  if (budget.pinned && attacking) message = "Pinned impede Attacking Maneuvers.";
  else if (budget.pinned && movement) message = "Pinned impede Movement.";
  else if (budget.pinned && !allowPinnedEscape && budget.limit <= 0) message = "Pinned impede esta Maneuver neste Round.";

  // v1.8.5 TEST — a economia de Actions é deliberadamente permissiva.
  // DBU possui Characteristics, Traits, Transformations e efeitos que podem
  // conceder Actions extras ou remover/alterar custos. O módulo registra o
  // custo padrão, mas NÃO bloqueia uma Maneuver apenas porque o contador base
  // chegou a zero. Requisitos mecânicos de estado (Pinned, alvo, alcance etc.) continuam
  // sendo gates reais. Timing padrão de Standard é informativo/permissivo, pois
  // efeitos podem permitir uso como Instant ou Out-of-Sequence.
  const requestedCost = Math.max(0, Number(actionCost) || 0);
  const overBudget = effectiveType === "standard" && budget.inCombat && budget.remaining < requestedCost;

  if (message) {
    if (notify) ui.notifications.warn(message);
    return { ok: false, reason: "state", message, budget, overBudget };
  }

  if (overBudget && notify) {
    ui.notifications.info(`${actor.name}: custo padrão ${requestedCost} Action${requestedCost === 1 ? "" : "s"}; contador base restante ${budget.remaining}. O uso foi permitido para respeitar efeitos que alteram a economia de Actions.`);
  }

  return { ok: true, budget, effectiveType, overBudget };
}

export async function recordStandardAction(actor, row) {
  const { cts, round } = currentRoundData(actor);
  const outsideCombat = !actorInActiveCombat(actor);
  round.actions.push({
    ...row,
    actionCost: Math.max(0, Number(row?.actionCost) || 0),
    dbuOutsideCombat: outsideCombat || undefined
  });
  await actor.update({ "system.combatTabState": cts });
  return { cts, round, row: round.actions[round.actions.length - 1], outsideCombat };
}

export const ActionEconomy = {
  conditionActive,
  conditionState,
  activeCombatForActor,
  actorInActiveCombat,
  currentRoundData,
  standardActionCostOf,
  standardActionsSpent,
  standardActionBudget,
  validateActionUse,
  recordStandardAction,
  moduleId: MODULE_ID
};
