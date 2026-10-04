// ============================================================
// DBU Automation v1.8.12 DEV — Times por Encounter
// ============================================================
// O Time fica salvo no Combatant, não no Actor.
// Padrão automático ao entrar no Encounter:
// - Actor com OWNER de jogador -> Time A
// - Actor sem OWNER de jogador -> Time B
// Mudanças manuais do GM nunca são sobrescritas pelo preenchimento automático.
// ============================================================

import { MODULE_ID } from "./core/module-id.js";
const TEAM_FLAG = "combatTeam";

export const DEFAULT_COMBAT_TEAMS = [
  { id: "team-a", label: "Time A" },
  { id: "team-b", label: "Time B" },
  { id: "team-c", label: "Time C" },
  { id: "team-d", label: "Time D" }
];

const teamState = globalThis.DBU_COMBAT_TEAMS_AUTOMATION || {
  initialized: false,
  hooks: {}
};
globalThis.DBU_COMBAT_TEAMS_AUTOMATION = teamState;

function disposition(token) {
  const raw = token?.document?.disposition ?? token?.disposition ?? null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function tokenActorId(token) {
  return token?.actor?.id || token?.document?.actorId || null;
}

function usersArray() {
  return Array.from(game.users?.contents || game.users || []);
}

export function actorBelongsToPlayer(actor) {
  if (!actor) return false;
  if (typeof actor.hasPlayerOwner === "boolean" && actor.hasPlayerOwner) return true;

  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownership = actor.ownership || actor._source?.ownership || {};
  return usersArray().some(user => {
    if (!user || user.isGM) return false;
    if (user.character?.id === actor.id) return true;
    const level = Number(ownership[user.id] ?? ownership.default ?? 0);
    return Number.isFinite(level) && level >= ownerLevel;
  });
}

export function combatantForToken(token, combat = game.combat) {
  if (!token || !combat) return null;
  const tokenId = token?.id || token?.document?.id || null;
  const actorId = tokenActorId(token);
  return combat.combatants?.find?.(combatant => {
    if (tokenId && (combatant.tokenId === tokenId || combatant.token?.id === tokenId)) return true;
    return !!actorId && combatant.actor?.id === actorId;
  }) || null;
}

export function combatantForActor(actor, combat = game.combat) {
  if (!actor || !combat) return null;
  return combat.combatants?.find?.(combatant => combatant.actor?.id === actor.id) || null;
}

export function getCombatantTeam(combatant) {
  return String(combatant?.getFlag?.(MODULE_ID, TEAM_FLAG) || "").trim();
}

export function getActorTeam(actor, combat = game.combat) {
  return getCombatantTeam(combatantForActor(actor, combat));
}

export function getTokenTeam(token, combat = game.combat) {
  return getCombatantTeam(combatantForToken(token, combat));
}

export function teamLabel(teamId) {
  const id = String(teamId || "").trim();
  if (!id) return "Sem Time";
  return DEFAULT_COMBAT_TEAMS.find(team => team.id === id)?.label || id;
}

export function defaultTeamForCombatant(combatant) {
  return actorBelongsToPlayer(combatant?.actor) ? "team-a" : "team-b";
}

export async function setCombatantTeam(combatant, teamId) {
  if (!combatant) return false;
  if (!game.user?.isGM) {
    ui.notifications.warn("DBU Automation: somente o GM pode alterar Times do Encounter.");
    return false;
  }
  const value = String(teamId || "").trim();
  if (value) await combatant.setFlag(MODULE_ID, TEAM_FLAG, value);
  else await combatant.unsetFlag(MODULE_ID, TEAM_FLAG).catch(() => {});
  return true;
}

/**
 * Preenche somente Combatants ainda sem Time. Nunca sobrescreve um Time que
 * já existe, inclusive Time A/B escolhido manualmente pelo GM.
 */
export async function assignDefaultCombatantTeam(combatant) {
  if (!combatant || !game.user?.isGM) return getCombatantTeam(combatant);
  const existing = getCombatantTeam(combatant);
  if (existing) return existing;
  const teamId = defaultTeamForCombatant(combatant);
  await combatant.setFlag(MODULE_ID, TEAM_FLAG, teamId);
  return teamId;
}

export async function assignDefaultCombatTeams(combat = game.combat) {
  if (!combat || !game.user?.isGM) return { assigned: 0, total: 0 };
  const combatants = Array.from(combat.combatants?.contents || combat.combatants || []);
  const updates = combatants
    .filter(combatant => !getCombatantTeam(combatant))
    .map(combatant => ({
      _id: combatant.id,
      [`flags.${MODULE_ID}.${TEAM_FLAG}`]: defaultTeamForCombatant(combatant)
    }));
  if (!updates.length) return { assigned: 0, total: combatants.length };

  // v1.8.12: uma única atualização embedded substitui um setFlag/await por
  // Combatant. Mantém a regra de nunca sobrescrever Times manuais existentes.
  if (typeof combat.updateEmbeddedDocuments === "function") {
    await combat.updateEmbeddedDocuments("Combatant", updates);
  } else {
    // Fallback para ambientes/Mocks sem updateEmbeddedDocuments.
    for (const update of updates) {
      const combatant = combatants.find(row => row.id === update._id);
      if (combatant) await combatant.setFlag(MODULE_ID, TEAM_FLAG, update[`flags.${MODULE_ID}.${TEAM_FLAG}`]);
    }
  }
  return { assigned: updates.length, total: combatants.length };
}

export function initializeCombatTeamsAutomation() {
  if (teamState.initialized) {
    if (game.user?.isGM) queueMicrotask(() => assignDefaultCombatTeams(game.combat).catch(error => console.warn("DBU Times | preenchimento inicial:", error)));
    return teamState;
  }
  teamState.initialized = true;

  teamState.hooks.createCombatant = Hooks.on("createCombatant", combatant => {
    if (!game.user?.isGM) return;
    queueMicrotask(() => assignDefaultCombatantTeam(combatant).catch(error => console.warn("DBU Times | novo combatente:", error)));
  });

  teamState.hooks.createCombat = Hooks.on("createCombat", combat => {
    if (!game.user?.isGM) return;
    queueMicrotask(() => assignDefaultCombatTeams(combat).catch(error => console.warn("DBU Times | novo Encounter:", error)));
  });

  teamState.hooks.updateCombat = Hooks.on("updateCombat", (combat, changes) => {
    if (!game.user?.isGM) return;
    // Ao iniciar o Encounter, garante que qualquer participante antigo também
    // recebeu o padrão Player=A / sem Player=B.
    if (Object.prototype.hasOwnProperty.call(changes || {}, "started") || Object.prototype.hasOwnProperty.call(changes || {}, "round")) {
      queueMicrotask(() => assignDefaultCombatTeams(combat).catch(error => console.warn("DBU Times | atualização do Encounter:", error)));
    }
  });

  if (game.user?.isGM) {
    queueMicrotask(() => assignDefaultCombatTeams(game.combat).catch(error => console.warn("DBU Times | Encounter atual:", error)));
  }

  console.log("DBU Automation | Times por Encounter ativos: Player OWNER=Time A, demais=Time B.");
  return teamState;
}

/**
 * Relação usada pelas automações.
 * 1) Se AMBOS os combatentes têm Time explícito no Encounter, o Time vence.
 * 2) Se algum deles ainda estiver sem Time (caso legado/temporário), usa a
 *    Disposition somente como fallback de segurança.
 */
export function tokenRelation(sourceToken, otherToken, combat = game.combat) {
  if (!sourceToken || !otherToken) return "unknown";
  if (tokenActorId(sourceToken) && tokenActorId(sourceToken) === tokenActorId(otherToken)) return "self";

  const sourceTeam = getTokenTeam(sourceToken, combat);
  const otherTeam = getTokenTeam(otherToken, combat);
  if (sourceTeam && otherTeam) return sourceTeam === otherTeam ? "ally" : "enemy";

  const a = disposition(sourceToken);
  const b = disposition(otherToken);
  if (a == null || b == null) return "unknown";
  return a === b ? "ally" : "enemy";
}

export function areAllies(sourceToken, otherToken, combat = game.combat) {
  const relation = tokenRelation(sourceToken, otherToken, combat);
  return relation === "self" || relation === "ally";
}

export function areEnemies(sourceToken, otherToken, combat = game.combat) {
  return tokenRelation(sourceToken, otherToken, combat) === "enemy";
}

export const CombatTeams = {
  defaults: DEFAULT_COMBAT_TEAMS,
  actorBelongsToPlayer,
  defaultTeamForCombatant,
  combatantForToken,
  combatantForActor,
  getCombatantTeam,
  getActorTeam,
  getTokenTeam,
  setCombatantTeam,
  assignDefaultCombatantTeam,
  assignDefaultCombatTeams,
  initializeCombatTeamsAutomation,
  teamLabel,
  tokenRelation,
  areAllies,
  areEnemies
};