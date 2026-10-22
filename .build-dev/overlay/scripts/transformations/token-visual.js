// Resolve the actual TokenDocument(s) whose appearance a Transformation changes.
// Synthetic/unlinked Actors must never fall back to another token sharing actor.id.
export function transformationTokenDocuments(actor, preferredToken = null) {
  if (!actor) return [];
  const result = [], seen = new Set();
  const add = value => {
    const doc = value?.document ?? value;
    if (!doc || typeof doc.update !== "function" || !doc.id) return;
    const key = transformationTokenKey(doc);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(doc);
  };
  const own = actor.token?.document ?? actor.token ?? null;
  if (actor.isToken || own) {
    if (own) add(own);
    else if (preferredToken?.actor === actor) add(preferredToken);
    return result;
  }
  if (preferredToken?.actor === actor) add(preferredToken);
  for (const token of actor.getActiveTokens?.() || []) {
    if (token?.actor === actor || (token?.actor?.uuid && token.actor.uuid === actor.uuid)) add(token);
  }
  return result;
}

export function transformationTokenKey(token) {
  const doc = token?.document ?? token;
  const sceneId = doc?.parent?.id ?? doc?.parent?.scene?.id ?? "unknown";
  return `Scene.${sceneId}.Token.${doc?.id || "unknown"}`;
}

export function transformationTokenSnapshot(token) {
  const doc = token?.document ?? token;
  return {
    src: String(doc?.texture?.src || ""),
    scaleX: Number(doc?.texture?.scaleX ?? 1),
    scaleY: Number(doc?.texture?.scaleY ?? 1),
    width: Number(doc?.width ?? 1),
    height: Number(doc?.height ?? 1)
  };
}

export function transformationTokenUpdate(config, base, { restoring = false } = {}) {
  const updates = {};
  if (restoring) {
    if (base?.src) updates["texture.src"] = base.src;
    if (base?.scaleX != null) updates["texture.scaleX"] = base.scaleX;
    if (base?.scaleY != null) updates["texture.scaleY"] = base.scaleY;
    if (base?.width != null) updates.width = base.width;
    if (base?.height != null) updates.height = base.height;
    return updates;
  }
  if (config?.token) updates["texture.src"] = config.token;
  if (Number(config?.tokenScale) > 0) {
    updates["texture.scaleX"] = Number(config.tokenScale);
    updates["texture.scaleY"] = Number(config.tokenScale);
  } else if (Number(config?.gridScale) > 0 && base) {
    updates["texture.scaleX"] = Number(base.scaleX ?? 1);
    updates["texture.scaleY"] = Number(base.scaleY ?? 1);
  }
  const gridScale = Math.max(0, Number(config?.gridScale || 0));
  const width = Number(config?.width) > 0 ? Number(config.width)
    : gridScale > 0 ? Math.max(0.5, Number(base?.width || 1) * gridScale) : null;
  const height = Number(config?.height) > 0 ? Number(config.height)
    : gridScale > 0 ? Math.max(0.5, Number(base?.height || 1) * gridScale) : null;
  if (width != null) updates.width = width;
  if (height != null) updates.height = height;
  return updates;
}
