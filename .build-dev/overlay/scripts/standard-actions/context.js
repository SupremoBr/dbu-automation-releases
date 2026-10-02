// DBU Automation — Standard Actions context/helpers
import {
  actorInActiveCombat,
  activeCombatForActor,
  currentRoundData,
  standardActionCostOf,
  economyActionsSpent
} from "./economy.js";
import { MODULE_ID, STATE_FLAG } from "./state.js";

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
export function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(num(value, min))));
}
export function canControl(actor) {
  return !!actor && !!(game.user?.isGM || actor.isOwner);
}
export function actorFromContext(context = {}) {
  const direct = context?.actor;
  if (direct?.documentName === "Actor") return direct;
  if (direct?.actor?.documentName === "Actor") return direct.actor;
  const tok = tokenFromContext(context);
  if (tok?.actor) return tok.actor;
  if (context?.actorId) return game.actors?.get?.(context.actorId) || null;
  const controlled = (canvas?.tokens?.controlled || []).find(t => canControl(t?.actor));
  return controlled?.actor || game.user?.character || null;
}
export function tokenFromContext(context = {}, actor = null) {
  const direct = context?.token?.object ?? context?.token ?? null;
  if (direct?.actor) return direct;
  if (context?.tokenId) {
    const byId = canvas?.tokens?.get?.(context.tokenId);
    if (byId?.actor) return byId;
  }
  const actorId = actor?.id || context?.actorId || context?.actor?.id || null;
  if (!actorId) return null;
  return (canvas?.tokens?.controlled || []).find(t => t.actor?.id === actorId)
    || (canvas?.tokens?.placeables || []).find(t => t.actor?.id === actorId)
    || null;
}
export function combatantForActor(actor, combat = game.combat) {
  if (!actor || !combat) return null;
  return (combat.combatants?.contents || combat.combatants || []).find?.(c => c.actor?.id === actor.id) || null;
}
export function inActiveCombat(actor) {
  return actorInActiveCombat(actor);
}
export function roundTrackingMeta(actor) {
  return inActiveCombat(actor) ? {} : { dbuOutsideCombat: true };
}
export function isActorsTurn(actor) {
  const active = activeCombatForActor(actor);
  if (!active) return true;
  return active.combat?.combatant?.id === active.combatant?.id;
}
export function getCurrentRoundData(actor) {
  return currentRoundData(actor);
}
export function roundUses(actor, key) {
  if (!inActiveCombat(actor)) return 0;
  const { round } = getCurrentRoundData(actor);
  return round.actions.filter(a => !a?.dbuOutsideCombat && (a?.dbuStandardKey === key || a?.type === key)).length;
}
export function powerUpUseCount(actor) {
  if (!inActiveCombat(actor)) return 0;
  const { round } = getCurrentRoundData(actor);
  return (round.actions || []).filter(a => !a?.dbuOutsideCombat && (a?.dbuPowerUpUse === true || (a?.type === "power-up" && !a?.dbuExtraPowerStack))).length;
}
export function actionCostOf(row) {
  return standardActionCostOf(row);
}
export function standardActionsSpent(actor) {
  return economyActionsSpent(actor);
}
export function baseTier(actor) {
  return Math.max(1, num(actor?.system?.baseTier, Math.ceil(num(actor?.system?.tier, 1) / 2)));
}
export function tier(actor) {
  return Math.max(1, num(actor?.system?.tier, 1));
}
export function capacity(actor) {
  const max = Math.max(0, num(actor?.system?.status?.maxCapacity ?? actor?.system?.capacity?.max, 0));
  const spent = Math.max(0, num(actor?.system?.status?.capacitySpent, 0));
  return { max, spent, left: Math.max(0, max - spent) };
}
export function currentGrapple(actor) {
  const st = actor?.getFlag?.(MODULE_ID, STATE_FLAG) || {};
  return st?.grapple?.active ? st.grapple : null;
}
export function tokenDocumentOf(token) {
  return token?.document ?? token ?? null;
}
export function participantRef(actor, token = null) {
  const document = tokenDocumentOf(token || actor?.token);
  const sceneId = document?.parent?.id || document?.scene?.id || canvas?.scene?.id || null;
  return {
    actorId: actor?.id || null,
    actorUuid: actor?.uuid || document?.actor?.uuid || null,
    tokenId: document?.id || null,
    sceneId
  };
}
export function participantFromGrapple(grapple, role) {
  const stored = grapple?.[role] || {};
  return {
    actorId: stored.actorId || grapple?.[`${role}Id`] || null,
    actorUuid: stored.actorUuid || null,
    tokenId: stored.tokenId || grapple?.[`${role}TokenId`] || null,
    sceneId: stored.sceneId || grapple?.sceneId || null
  };
}
export function resolveParticipantToken(ref = {}) {
  if (ref.tokenId && canvas?.scene?.id === ref.sceneId) {
    const placeable = canvas?.tokens?.get?.(ref.tokenId);
    if (placeable) return placeable;
  }
  const scene = ref.sceneId ? game.scenes?.get?.(ref.sceneId) : canvas?.scene;
  return scene?.tokens?.get?.(ref.tokenId) || null;
}
export function resolveParticipantActor(ref = {}) {
  const token = resolveParticipantToken(ref);
  if (token?.actor) return token.actor;
  if (ref.actorUuid && typeof globalThis.fromUuidSync === "function") {
    const document = globalThis.fromUuidSync(ref.actorUuid);
    if (document?.documentName === "Actor") return document;
    if (document?.actor) return document.actor;
  }
  return ref.actorId ? game.actors?.get?.(ref.actorId) || null : null;
}
export function grappleActor(grapple, role) {
  return resolveParticipantActor(participantFromGrapple(grapple, role));
}
export function allText(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) allText(v, out);
    return out;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) allText(v, out);
  }
  return out;
}
