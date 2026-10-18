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

// Combat-card participant references. Token identity is authoritative: two
// unlinked copies share actor.id, but never their scene/token identity.
export function participantReference(actor, token = null) {
  const doc = tokenDocument(token) || tokenDocument(actor);
  const sceneId = doc ? tokenSceneId(doc) : null;
  const id = doc?.id || null;
  return {
    // Foundry interprets periods in object keys as update paths. Chat flags
    // therefore use a delimiter-safe participant key, not the token UUID.
    key: doc ? `tok_${sceneId || "unknown"}_${id}` : (actor?.id || null),
    actorId: actor?.id || doc?.actorId || null,
    tokenId: id,
    sceneId
  };
}

export function attackTargetKeys(attack = {}) {
  const refs = Array.isArray(attack?.targetRefs) ? attack.targetRefs : [];
  if (refs.length) return [...new Set(refs.map(ref => ref?.key).filter(Boolean))];
  return [...new Set((attack?.targetActorIds || []).filter(Boolean))];
}

// Resolve without guessing which clone is meant. A missing scene token must
// NOT silently fall back to the Actor in the sidebar.
export function resolveParticipant(key, attack = null) {
  const value = String(key || "");
  if (!value) return null;
  const refs = [
    ...(Array.isArray(attack?.targetRefs) ? attack.targetRefs : []),
    ...(attack?.attackerRef ? [attack.attackerRef] : [])
  ];
  const ref = refs.find(entry => entry?.key === value);
  if (ref?.tokenId) {
    const token = resolveSceneToken(ref.sceneId, ref.tokenId);
    return token?.actor || null;
  }
  const match = /^Scene\.([^.]+)\.Token\.([^.]+)$/.exec(value);
  if (match) return resolveSceneToken(match[1], match[2])?.actor || null;
  return game.actors?.get?.(ref?.actorId || value) || null;
}

export function participantKeyForAttack(actor, attack, token = null) {
  if (!actor) return null;
  const direct = participantReference(actor, token).key;
  const keys = attackTargetKeys(attack);
  if (direct && keys.includes(direct)) return direct;
  // Older 1.9.10 cards can contain legacy dotted token keys. Match only
  // by exact scene/token rather than treating the base Actor as unique.
  const doc = tokenDocument(token) || tokenDocument(actor);
  if (doc) {
    const legacy = tokenIdentity(doc);
    if (legacy && keys.includes(legacy)) return legacy;
  }
  // Never alias a known Synthetic Actor to another token with the same base.
  if (tokenDocument(token) || tokenDocument(actor)) return null;
  const refs = Array.isArray(attack?.targetRefs) ? attack.targetRefs : [];
  if (refs.length) {
    const matches = refs.filter(ref => ref?.actorId === actor.id);
    return matches.length === 1 ? matches[0].key : null;
  }
  return keys.includes(actor.id) ? actor.id : null;
}
