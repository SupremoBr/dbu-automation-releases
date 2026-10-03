// DBU Automation — Signature Aura shared state/constants
export const MODULE_ID =
  (globalThis.game?.modules?.get?.("dbu-automation-dev")?.active ? "dbu-automation-dev" : null)
  || (globalThis.game?.modules?.get?.("dbu-automation")?.active ? "dbu-automation" : null)
  || "dbu-automation";

export const AURA_MAINTENANCE_FLAG = "auraMaintenanceKey";

export const auraRuntime = globalThis.DBU_SIGNATURE_AURA_RUNTIME || {
  pending: new Set()
};

auraRuntime.pending ??= new Set();
globalThis.DBU_SIGNATURE_AURA_RUNTIME = auraRuntime;
