// DBU Automation — identity of scene tokens and synthetic actors (DBU 0.9.2).
// An unlinked Token's actor.id is the base Actor ID; it is NOT a unique
// identifier for the individual creature. Never infer a specific Token by it.
export function tokenDocument(value) {
  if (!value) return null;
  if (value.document?.documentName === "Token") return value.document;
  if (value.documentName === "Token") return value;
  if (value.token?.documentName === "Token") return value.token;
  if (value.actor?.token?.documentName === "Token") return value.actor.token;
  return null;
}

export function tokenId(value) {
  return tokenDocument(value)?.id || value?.tokenId || null;
}

export function tokenSceneId(value) {
  const doc = tokenDocument(value);
  return doc?.parent?.id || doc?.parent?.scene?.id || value?.sceneId || null;
}

export function tokenIdentity(value) {
  const id = tokenId(value);
  if (!id) return null;
  const scene = tokenSceneId(value) || canvas?.scene?.id || "";
  return `Scene.${scene}.Token.${id}`;
}

export function actorIdentity(actor, token = null) {
  return tokenIdentity(token) || tokenIdentity(actor)
    || (actor?.uuid ? String(actor.uuid) : actor?.id ? `Actor.${actor.id}` : null);
}

export function resolveSceneToken(sceneId, id) {
  if (!id) return null;
  const scene = sceneId || canvas?.scene?.id;
  if (scene && canvas?.scene?.id === scene) {
    const placeable = canvas?.tokens?.get?.(id);
    if (placeable?.actor) return placeable;
  }
  return game.scenes?.get?.(scene)?.tokens?.get?.(id) || null;
}

export function actorToken(actor) {
  const doc = tokenDocument(actor);
  return doc ? resolveSceneToken(tokenSceneId(doc), doc.id) || doc : null;
}

export function sameToken(first, second) {
  const a = tokenIdentity(first);
  const b = tokenIdentity(second);
  return !!a && !!b && a === b;
}

// Actor-only callers remain supported. Do not pick an arbitrary copy
// if multiple tokens of the same base Actor are present.
export function tokenForActor(actor, { preferControlled = true } = {}) {
  if (!actor) return null;
  const direct = actorToken(actor);
  if (direct) return direct;
  const sceneTokens = Array.from(canvas?.tokens?.placeables || []);
  const matching = sceneTokens.filter(t => t?.actor?.id === actor.id);
  if (preferControlled) {
    const selected = matching.filter(t => t.controlled || canvas?.tokens?.controlled?.includes?.(t));
    if (selected.length === 1) return selected[0];
  }
  return matching.length === 1 ? matching[0] : null;
}

export function combatantForIdentity(actor, token = null, combat = game.combat) {
  if (!combat) return null;
  const list = Array.from(combat.combatants?.contents || combat.combatants || []);
  const doc = tokenDocument(token) || tokenDocument(actor);
  const id = doc?.id || tokenId(token);
  if (id) {
    const scene = tokenSceneId(doc || token);
    // An explicit Token MUST match by tokenId; falling back by actorId
    // would silently use another creature's turn or Team.
    return list.find(c => {
      const cid = c.tokenId || c.token?.id;
      const cscene = c.sceneId || c.scene?.id || combat.scene?.id || null;
      return cid === id && (!scene || !cscene || cscene === scene);
    }) || null;
  }
  if (!actor) return null;
  const matches = list.filter(c => c.actor?.id === actor.id);
  return matches.length === 1 ? matches[0] : null;
}
