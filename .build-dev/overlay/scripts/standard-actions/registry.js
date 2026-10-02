// DBU Automation — generic Maneuver registry
export function createManeuverRegistry({ collectModifiers }) {
  const actions = new Map();
  function register(definition) {
    if (!definition?.key || !definition?.type) return false;
    actions.set(String(definition.key), { ...definition });
    return true;
  }
  function get(key) {
    return actions.get(String(key)) || null;
  }
  function has(key) {
    return actions.has(String(key));
  }
  function resolve(keyOrDefinition, actor = null, context = {}) {
    const definition = typeof keyOrDefinition === "string" ? get(keyOrDefinition) : keyOrDefinition;
    if (!definition) return null;
    const modifiers = actor ? collectModifiers(actor, definition.key, { ...context, type: definition.type }) : {};
    const availableTypes = new Set([String(definition.type || "standard")]);
    const resolvedTypes = typeof definition.resolveTypes === "function"
      ? definition.resolveTypes({ actor, context, definition, modifiers })
      : modifiers.availableTypes;
    for (const type of (Array.isArray(resolvedTypes) ? resolvedTypes : [])) availableTypes.add(String(type));
    const resolvedType = typeof definition.resolveType === "function"
      ? definition.resolveType({ actor, context, definition, modifiers })
      : (modifiers.effectiveType || modifiers.actionType);
    if (resolvedType) availableTypes.add(String(resolvedType));
    const requested = String(context?.effectiveType || context?.maneuverType || resolvedType || definition.type || "standard");
    const effectiveType = availableTypes.has(requested) ? requested : String(definition.type || "standard");
    return { ...definition, availableTypes: [...availableTypes], effectiveType, modifiers };
  }
  function list(type = "standard", actor = null, context = {}) {
    return [...actions.values()]
      .map(action => resolve(action, actor, context))
      .filter(action => action?.effectiveType === type && (!actor || typeof action.available !== "function" || action.available(actor)));
  }
  return Object.freeze({ register, get, has, resolve, list });
}
