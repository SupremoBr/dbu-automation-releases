// DBU Automation — resolve the package id that loaded this code.
export function detectModuleId() {
  try {
    const pathname = new URL(import.meta.url).pathname;
    const match = pathname.match(/\/modules\/([^/]+)\//);
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch {}

  if (globalThis.game?.modules?.get?.("dbu-automation-dev")?.active) return "dbu-automation-dev";
  if (globalThis.game?.modules?.get?.("dbu-automation")?.active) return "dbu-automation";
  return "dbu-automation";
}

export const MODULE_ID = detectModuleId();
export const MODULE_SOCKET = `module.${MODULE_ID}`;
