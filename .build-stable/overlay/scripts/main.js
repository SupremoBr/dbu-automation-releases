import { registerLocalizationSettings, initializeLocalization } from "./localization.js";
import { initializeDBUAutomation } from "./initializer.js";
import { attack as rawAttack } from "./attack.js";
import { energyCharge as rawEnergyCharge } from "./energy-charge.js";
import { surge as rawSurge, terrainLift as rawTerrainLift, getTerrainLiftState, getSurgeUsage } from "./maneuvers.js";
import {
  openStandardMenu as rawStandardMenu,
  runManeuverAction as rawRunManeuverAction,
  getStandardFavorites,
  setStandardFavorites,
  toggleStandardFavorite,
  getManeuverFavorites,
  setManeuverFavorites,
  toggleManeuverFavorite,
  listManeuverActions,
  getManeuverAction,
  resolveManeuverAction,
  registerManeuverAction,
  registerStandardActionProvider,
  StandardActions,
  registerStandardActionSettings,
  initializeStandardActionsAutomation,
  standardActionsSpent
} from "./standard-actions.js";
import { visualEnergyCharge } from "./visual-energy-charge.js";
import {
  signatureAura as rawSignatureAura,
  initializeSignatureAuraAutomation,
  getActiveSignatureAura
} from "./signature-aura.js";
import {
  transformation as rawTransformation,
  initializeTransformationAutomation,
  getActiveTransformations,
  payTransformationLp
} from "./transformations.js";
import {
  openCombatPanel as rawCombatPanel,
  initializeCombatPanelAutomation,
  getPendingActions,
  openCounterAction as rawCounterAction
} from "./combat-panel.js";
import {
  openCombatHud as rawOpenCombatHud,
  closeCombatHud,
  toggleCombatHud as rawToggleCombatHud,
  renderCombatHud,
  openCombatHudPreferences,
  registerCombatHudSettings,
  initializeCombatHudAutomation
} from "./combat-hud.js";
import {
  openGmPanel as rawGmPanel,
  initializeGmPanelAutomation,
  cleanupEncounter,
  GmPanel
} from "./gm-panel.js";
import {
  initializeInterveneAutomation,
  startIntervene,
  startReflect,
  eligibleInterveners,
  canReflect
} from "./intervene.js";
import { migrateLauncherMacros } from "./launcher-macros.js";
import {
  CombatTeams,
  DEFAULT_COMBAT_TEAMS,
  initializeCombatTeamsAutomation,
  assignDefaultCombatTeams,
  assignDefaultCombatantTeam,
  defaultTeamForCombatant,
  actorBelongsToPlayer,
  getCombatantTeam,
  getActorTeam,
  getTokenTeam,
  setCombatantTeam,
  tokenRelation,
  areAllies,
  areEnemies
} from "./combat-teams.js";
import { initializeBattleBornRouter, BattleBornRouter } from "./battle-born-router.js";
import { getAreaSpec, resolveAreaTargets, AreaAttack } from "./area-attack.js";
import {
  Recovery,
  applyInstantRecovery,
  applyProlongedRecovery,
  openProlongedRecoveryDialog,
  recoveryUnit
} from "./recovery.js";
import {
  openVisualConfigurator as rawVisualConfigurator,
  getVisualConfig,
  getAttackVisualSettings,
  getDefenseVisualSettings,
  getTransformationVisualSettings,
  getSignatureAuraVisualSettings,
  getEnergyChargeVisualSettings,
  getCombatVisualSettings
} from "./visual-config.js";

const MODULE_ID = "dbu-automation";
const VERSION = "1.9.1";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const api = globalThis.DBUAutomation || {};

if (!api.__readyPromise) {
  let resolveReady;
  let rejectReady;
  api.__readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  api.__resolveReady = resolveReady;
  api.__rejectReady = rejectReady;
}

async function waitReady(timeoutMs = 15000) {
  if (api.coreReady) return api;
  let timer;
  try {
    return await Promise.race([
      api.__readyPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          "DBU Automation não terminou de iniciar em 15 segundos."
        )), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function attack(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawAttack(context);
}

async function energyCharge(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawEnergyCharge(context);
}

async function surge(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawSurge(context);
}

async function terrainLift(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawTerrainLift(context);
}

async function standardMenu(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawStandardMenu(context);
}

async function maneuver(key, context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawRunManeuverAction(key, context);
}

async function signatureAura(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawSignatureAura(context);
}

async function transformation(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawTransformation(context);
}

async function combatPanel(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawCombatPanel(context);
}

async function counterAction(kind, context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawCounterAction(kind, context);
}

async function openCombatHud(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawOpenCombatHud(context);
}

async function combatHud(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawToggleCombatHud(context);
}

async function gmPanel(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawGmPanel(context);
}

async function visualConfigurator(context = {}, internal = {}) {
  if (!internal?.__skipReadyWait && !api.coreReady) await waitReady();
  return rawVisualConfigurator(context);
}

function status() {
  const moduleEntry = game.modules.get(MODULE_ID);
  const info = {
    module: MODULE_ID,
    version: VERSION,
    installedVersion: moduleEntry?.version || moduleEntry?.data?.version || null,
    active: !!moduleEntry?.active,
    system: game.system?.id,
    bootstrapLoaded: !!api.bootstrapLoaded,
    mainLoaded: !!api.mainLoaded,
    readyState: api.readyState,
    coreReady: !!api.coreReady,
    coreVersion: globalThis.DBU?.version || null,
    attack: typeof api.attack === "function",
    energyCharge: typeof api.energyCharge === "function",
    surge: typeof api.surge === "function",
    terrainLift: typeof api.terrainLift === "function",
    standardManeuvers: typeof api.standard === "function",
    visualEnergyCharge: typeof api.visualEnergyCharge === "function",
    signatureAura: typeof api.aura === "function",
    transformation: typeof api.transform === "function",
    combatPanel: typeof api.panel === "function",
    combatHud: typeof api.hud === "function",
    gmPanel: typeof api.gmPanel === "function",
    visualConfigurator: typeof api.visualConfig === "function",
    pendingActions: typeof api.getPendingActions === "function",
    areaAttack: typeof api.resolveAreaTargets === "function",
    intervene: !!globalThis.DBU_INTERVENE_AUTOMATION?.initialized,
    reflect: typeof api.reflect === "function",
    auraMaintenanceHook: globalThis.DBU_AURA_AUTOMATION?.combatHookId || null,
    tokenHudHook: globalThis.DBU_COMBAT_PANEL_AUTOMATION?.tokenHudHookId || null,
    gmSceneControlsHook: globalThis.DBU_GM_PANEL_AUTOMATION?.sceneControlsHookId || null,
    sequencer: !!globalThis.Sequencer,
    oldAutoStartActive: !!game.modules.get("dbu-auto-start")?.active
  };

  console.log("DBU Automation | Status", info);
  ui.notifications.info(
    `DBU Automation v${VERSION} | Main ${info.mainLoaded ? "OK" : "OFF"} | ` +
    `Core ${info.coreReady ? (info.coreVersion || "OK") : info.readyState} | ` +
    `Aura ${info.signatureAura ? "OK" : "OFF"} | Transform ${info.transformation ? "OK" : "OFF"} | ` +
    `Painel ${info.combatPanel ? "OK" : "OFF"} | HUD ${info.combatHud ? "OK" : "OFF"} | Painel GM ${info.gmPanel ? "OK" : "OFF"} | Área ${info.areaAttack ? "OK" : "OFF"} | ` +
    `Visuais ${info.visualConfigurator ? "OK" : "OFF"} | Intervene ${info.intervene ? "OK" : "OFF"}`,
    { permanent: true }
  );
  return info;
}

Object.assign(api, {
  moduleId: MODULE_ID,
  version: VERSION,
  mainLoaded: true,
  readyState: "main-loaded",
  attack,
  energyCharge,
  surge,
  terrainLift,
  getTerrainLiftState,
  getSurgeUsage,
  standard: standardMenu,
  standardMenu,
  openStandardMenu: standardMenu,
  maneuver,
  runManeuverAction: maneuver,
  getStandardFavorites,
  setStandardFavorites,
  toggleStandardFavorite,
  getManeuverFavorites,
  setManeuverFavorites,
  toggleManeuverFavorite,
  listManeuverActions,
  getManeuverAction,
  resolveManeuverAction,
  registerManeuverAction,
  registerStandardActionProvider,
  standardActionsSpent,
  StandardActions,
  visualEnergyCharge,
  aura: signatureAura,
  signatureAura,
  transform: transformation,
  transformation,
  panel: combatPanel,
  combatPanel,
  openCombatPanel: combatPanel,
  hud: combatHud,
  combatHud,
  openCombatHud,
  closeCombatHud,
  toggleCombatHud: combatHud,
  renderCombatHud,
  combatHudPreferences: openCombatHudPreferences,
  gmPanel,
  openGmPanel: gmPanel,
  GmPanel,
  cleanupEncounter,
  Recovery,
  applyInstantRecovery,
  applyProlongedRecovery,
  prolongedRecovery: openProlongedRecoveryDialog,
  openProlongedRecoveryDialog,
  recoveryUnit,
  visualConfig: visualConfigurator,
  visualConfigurator,
  configureVisuals: visualConfigurator,
  getVisualConfig,
  getAttackVisualSettings,
  getDefenseVisualSettings,
  getTransformationVisualSettings,
  getSignatureAuraVisualSettings,
  getEnergyChargeVisualSettings,
  getCombatVisualSettings,
  getAreaSpec,
  resolveAreaTargets,
  areaAttack: AreaAttack,
  AreaAttack,
  getPendingActions,
  counterAction,
  openCounterAction: counterAction,
  getActiveSignatureAura,
  getActiveTransformations,
  payTransformationLp,
  migrateLauncherMacros,
  status,
  waitReady,
  initialize: initializeDBUAutomation,
  initializeAura: initializeSignatureAuraAutomation,
  initializeTransformations: initializeTransformationAutomation,
  initializeCombatPanel: initializeCombatPanelAutomation,
  initializeCombatHud: initializeCombatHudAutomation,
  initializeGmPanel: initializeGmPanelAutomation,
  initializeIntervene: initializeInterveneAutomation,
  initializeStandardActions: initializeStandardActionsAutomation,
  intervene: startIntervene,
  reflect: startReflect,
  eligibleInterveners,
  canReflect,
  CombatTeams,
  combatTeams: CombatTeams,
  DEFAULT_COMBAT_TEAMS,
  initializeCombatTeams: initializeCombatTeamsAutomation,
  assignDefaultCombatTeams,
  assignDefaultCombatantTeam,
  defaultTeamForCombatant,
  actorBelongsToPlayer,
  getCombatantTeam,
  getActorTeam,
  getTokenTeam,
  setCombatantTeam,
  tokenRelation,
  areAllies,
  areEnemies,
  BattleBornRouter
});

globalThis.DBUAutomation = api;
console.log(`DBU Automation v${VERSION} | main ES module carregado`);

// O hook da barra de ferramentas precisa existir antes da inicialização dos
// Scene Controls. Os demais componentes continuam sendo iniciados no ready.
initializeGmPanelAutomation();
registerCombatHudSettings();
registerStandardActionSettings();
registerLocalizationSettings();

async function boot() {
  if (api.__booting || api.coreReady) return;
  api.__booting = true;
  api.readyState = "initializing-core";

  try {
    const oldAutoStartActive = !!game.modules.get("dbu-auto-start")?.active;

    if (oldAutoStartActive) {
      if (game.user.isGM) {
        ui.notifications.warn(
          "DBU Automation: dbu-auto-start ainda está ativo. Desative o módulo antigo para evitar inicialização duplicada."
        );
      }
      await sleep(1700);
    }

    await initializeDBUAutomation();
    initializeLocalization();
    initializeSignatureAuraAutomation();
    initializeTransformationAutomation();
    initializeCombatPanelAutomation();
    initializeInterveneAutomation();
    initializeStandardActionsAutomation();
    initializeCombatHudAutomation();
    initializeBattleBornRouter();
    initializeCombatTeamsAutomation();

    api.coreReady = true;
    api.readyState = "ready";
    api.__resolveReady?.(api);

    console.log(`DBU Automation v${VERSION} | ready`, {
      core: globalThis.DBU?.version,
      system: game.system?.id,
      auraHook: globalThis.DBU_AURA_AUTOMATION?.combatHookId,
      transformations: !!globalThis.DBU_TRANSFORMATION_AUTOMATION?.initialized,
      combatPanel: !!globalThis.DBU_COMBAT_PANEL_AUTOMATION?.initialized,
      combatHud: !!globalThis.DBU_COMBAT_HUD_AUTOMATION?.initialized,
      gmPanel: !!globalThis.DBU_GM_PANEL_AUTOMATION?.initialized,
      intervene: !!globalThis.DBU_INTERVENE_AUTOMATION?.initialized,
      standardManeuvers: !!globalThis.DBU_STANDARD_ACTIONS?.initialized,
      visualConfigurator: typeof api.visualConfig === "function",
      areaAttack: typeof api.resolveAreaTargets === "function",
      pendingActions: typeof api.getPendingActions === "function"
    });
  } catch (error) {
    api.coreReady = false;
    api.readyState = "error";
    api.lastError = String(error?.stack || error?.message || error);
    console.error("DBU Automation | Erro durante inicialização:", error);
    api.__rejectReady?.(error);
    ui.notifications.error(
      `DBU Automation: erro iniciando o core. ${error?.message || error}`,
      { permanent: true }
    );
  } finally {
    api.__booting = false;
  }
}

if (globalThis.game?.ready) {
  queueMicrotask(boot);
} else {
  Hooks.once("ready", boot);
}