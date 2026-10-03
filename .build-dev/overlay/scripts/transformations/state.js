// DBU Automation — Transformation shared state/constants
function moduleIdFromUrl() {
  try {
    const pathname = new URL(import.meta.url).pathname;
    const match = pathname.match(/\/modules\/([^/]+)\//);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export const MODULE_ID = moduleIdFromUrl()
  || (globalThis.game?.modules?.get?.("dbu-automation-dev")?.active ? "dbu-automation-dev" : null)
  || (globalThis.game?.modules?.get?.("dbu-automation")?.active ? "dbu-automation" : null)
  || "dbu-automation";

export const KI_MULT_ENCOUNTER_FLAG = "kiMultiplierEncounter092";
export const BASE_TOKEN_FLAG = "transformationBaseToken";
export const LAST_VISUAL_FLAG = "transformationLastVisual";
export const VISUAL_EFFECT_PREFIX = "DBU-Automation-Transformation";

export const transformationRuntime = globalThis.DBU_TRANSFORMATION_RUNTIME || {
  visualSyncSuppressions: new Map(),
  queuedVisualSync: new Set()
};

transformationRuntime.visualSyncSuppressions ??= new Map();
transformationRuntime.queuedVisualSync ??= new Set();
globalThis.DBU_TRANSFORMATION_RUNTIME = transformationRuntime;
