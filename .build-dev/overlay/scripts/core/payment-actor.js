// Resolve payment recipients without treating a base Actor ID as a token ID.
// Only an explicitly identified scene Token (or an unambiguous legacy case)
// can pay resources for an unlinked creature.
import { resolveSceneToken, tokenForActor } from "./token-identity.js";

export function resolvePaymentActor(message, {
  actorId = null,
  payType = "",
  tokenId = null,
  sceneId = null
} = {}) {
  const expectedId = String(actorId || "");
  const attack = message?.getFlag?.("world", "dbuAttackData") || null;
  const storedRef = message?.getFlag?.("world", "dbuAttackPaymentRef") || null;
  const attackerRef = payType === "combined" ? attack?.attackerRef : null;
  const speaker = message?.speaker || {};

  const refs = [
    tokenId ? { tokenId, sceneId } : null,
    payType === "combined" ? storedRef : null,
    attackerRef,
    speaker.token ? { tokenId: speaker.token, sceneId: speaker.scene } : null
  ].filter(Boolean);

  for (const ref of refs) {
    if (!ref.tokenId) continue;
    const token = resolveSceneToken(ref.sceneId, ref.tokenId);
    const actor = token?.actor;
    if (!actor) continue;
    if (expectedId && actor.id !== expectedId) continue;
    return actor;
  }

  // Legacy cards that carry only a base Actor ID: resolve a unique active
  // synthetic token, but never choose arbitrarily between multiple copies.
  const base = expectedId ? game.actors?.get?.(expectedId) : null;
  if (!base) return null;
  const token = tokenForActor(base, { preferControlled: false });
  if (token?.actor && !token.document?.actorLink && !token.actorLink) {
    return token.actor;
  }
  const copies = Array.from(canvas?.tokens?.placeables || [])
    .filter(t => t?.actor?.id === expectedId && !(t.document?.actorLink ?? t.actorLink));
  if (copies.length) return null;
  return base;
}
