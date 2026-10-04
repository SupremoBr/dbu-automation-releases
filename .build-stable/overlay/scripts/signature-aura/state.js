// DBU Automation — Signature Aura shared state/constants

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

export const AURA_MAINTENANCE_FLAG = "auraMaintenanceKey";

export const auraRuntime = globalThis.DBU_SIGNATURE_AURA_RUNTIME || {
  pending: new Set()
};

auraRuntime.pending ??= new Set();
globalThis.DBU_SIGNATURE_AURA_RUNTIME = auraRuntime;
