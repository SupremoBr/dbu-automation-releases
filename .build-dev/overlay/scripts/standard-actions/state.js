// DBU Automation — Standard Actions shared state/constants
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

export const SYS_ID = "DBU-MRR-OLD";
export const FAVORITES_SETTING = "combatHudFavoriteActions";
export const POWER_BUFF_MARKER = "[DBU Automation] Power stacks";
export const RECOVERY_BUFF_MARKER = "[DBU Automation] Combat Recovery";
export const MIRACLE_BUFF_PREFIX = "[DBU Automation] Miracle Empowerment:";
export const STATE_FLAG = "standardManeuverState";
export const SOCKET = `module.${MODULE_ID}`;

export const state = globalThis.DBU_STANDARD_ACTIONS || {
  initialized: false,
  hooks: {},
  providers: [],
  socketHandler: null,
  renderTimers: new Map(),
  pendingRequests: new Map()
};
state.providers ??= [];
state.hooks ??= {};
state.renderTimers ??= new Map();
state.pendingRequests ??= new Map();
globalThis.DBU_STANDARD_ACTIONS = state;
