// DBU Automation — Standard Actions modifier providers
import { state } from "./state.js";

export function registerStandardActionProvider(provider) {
  if (typeof provider !== "function") return false;
  if (!state.providers.includes(provider)) state.providers.push(provider);
  return true;
}
export function collectModifiers(actor, actionKey, context = {}) {
  const result = {};
  for (const provider of state.providers) {
    try {
      const patch = provider({ actor, actionKey, type: context.type || "standard", context });
      if (patch && typeof patch === "object") {
        foundry.utils.mergeObject(result, patch, { inplace: true, insertKeys: true, overwrite: true });
      }
    } catch (error) {
      console.warn("DBU Standard | provider", error);
    }
  }
  return result;
}
