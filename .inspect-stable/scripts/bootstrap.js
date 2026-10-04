// DBU Automation v1.8.12 DEV — bootstrap clássico
// Garante a API global antes do carregamento do módulo ES.

(() => {
  const MODULE_ID = "dbu-automation-dev";
  const VERSION = "1.8.12 DEV";

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

  Object.assign(api, {
    moduleId: MODULE_ID,
    version: VERSION,
    bootstrapLoaded: true,
    mainLoaded: !!api.mainLoaded,
    coreReady: !!api.coreReady,
    readyState: api.readyState || "bootstrap",

    async waitReady(timeoutMs = 15000) {
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
    },

    async launch(action, context = {}) {
      try {
        await api.waitReady();
        const aliases = {
          attack: "attack",
          energyCharge: "energyCharge",
          aura: "aura",
          signatureAura: "aura",
          transform: "transform",
          transformation: "transform",
          panel: "panel",
          combatPanel: "panel",
          painel: "panel",
          hud: "hud",
          combatHud: "hud",
          hudCombate: "hud",
          gmPanel: "gmPanel",
          painelGM: "gmPanel",
          mestre: "gmPanel",
          visualConfig: "visualConfig",
          visualConfigurator: "visualConfig",
          visuals: "visualConfig",
          visuais: "visualConfig"
        };
        const method = aliases[action] || action;
        const fn = api[method];
        if (typeof fn !== "function") {
          throw new Error(`Função ${method} não foi registrada pelo módulo.`);
        }
        return await fn(context, { __skipReadyWait: true });
      } catch (error) {
        console.error(`DBU Automation | launch(${action})`, error);
        globalThis.ui?.notifications?.error(
          `DBU Automation: ${error?.message || error}`
        );
        return null;
      }
    },

    diagnostic() {
      const moduleEntry = globalThis.game?.modules?.get?.(MODULE_ID);
      const info = {
        moduleInstalled: !!moduleEntry,
        moduleActive: !!moduleEntry?.active,
        moduleVersion: moduleEntry?.version || moduleEntry?.data?.version || null,
        bootstrapLoaded: !!api.bootstrapLoaded,
        mainLoaded: !!api.mainLoaded,
        coreReady: !!api.coreReady,
        readyState: api.readyState,
        coreVersion: globalThis.DBU?.version || null,
        attack: typeof api.attack === "function",
        energyCharge: typeof api.energyCharge === "function",
        aura: typeof api.aura === "function",
        transformation: typeof api.transform === "function",
        combatPanel: typeof api.panel === "function",
        combatHud: typeof api.hud === "function",
        gmPanel: typeof api.gmPanel === "function",
        visualConfigurator: typeof api.visualConfig === "function",
        areaAttack: typeof api.resolveAreaTargets === "function",
        pendingActions: typeof api.getPendingActions === "function",
        intervene: !!globalThis.DBU_INTERVENE_AUTOMATION?.initialized,
        reflect: typeof api.reflect === "function",
        sequencer: !!globalThis.Sequencer,
        system: globalThis.game?.system?.id || null
      };
      console.log("DBU Automation | DIAGNÓSTICO", info);

      const message = [
        `DBU Automation ${VERSION}`,
        `Módulo ativo: ${info.moduleActive ? "SIM" : "NÃO"}`,
        `Bootstrap: ${info.bootstrapLoaded ? "OK" : "FALHOU"}`,
        `Main: ${info.mainLoaded ? "OK" : "FALHOU"}`,
        `Core: ${info.coreReady ? "OK" : info.readyState}`,
        `Attack: ${info.attack ? "OK" : "OFF"}`,
        `Energy Charge: ${info.energyCharge ? "OK" : "OFF"}`,
        `Signature Aura: ${info.aura ? "OK" : "OFF"}`,
        `Transformação: ${info.transformation ? "OK" : "OFF"}`,
        `Painel: ${info.combatPanel ? "OK" : "OFF"}`,
        `HUD: ${info.combatHud ? "OK" : "OFF"}`,
        `Painel GM: ${info.gmPanel ? "OK" : "OFF"}`,
        `Config. Visual: ${info.visualConfigurator ? "OK" : "OFF"}`,
        `Area Attack: ${info.areaAttack ? "OK" : "OFF"}`,
        `Pendências: ${info.pendingActions ? "OK" : "OFF"}`,
        `Intervene: ${info.intervene ? "OK" : "OFF"}`,
        `Reflect: ${info.reflect ? "OK" : "OFF"}`
      ].join(" | ");

      globalThis.ui?.notifications?.info(message, { permanent: true });
      return info;
    }
  });

  globalThis.DBUAutomation = api;
  console.log(`DBU Automation v${VERSION} | bootstrap carregado`);
})();
