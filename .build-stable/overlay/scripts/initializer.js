// DBU Automation v1.8.1 — Core de Inicialização
import { getDefenseVisualSettings, getCombatVisualSettings } from "./visual-config.js";
import { dbuGetCapacity, dbuCheckAffordability, dbuPayKiAndCapacity } from "./core/resources.js";
import { dbuGetCurrentRound, dbuRecordDefend } from "./core/round-tracker.js";
import { initializeRoundHooks } from "./core/round-hooks.js";
import { dbuGetDefenseStates, dbuGetDefenseState, dbuSetDefenseState, dbuClearDefensePending } from "./combat/defense-state.js";
import { initializeDuelCore } from "./combat/duel-core.js";
import { createDefenseCore } from "./combat/defense-core.js";
import { initializeUnitedAttackCore } from "./combat/united-attack-core.js";
import { initializeRevealCore } from "./combat/reveal-core.js";
import { initializeNativeDBUBridge } from "./bridge/native-dbu.js";
import { MODULE_SOCKET } from "./core/module-id.js";
// Migrado do Inicializador v6.6.

export async function initializeDBUAutomation() {
// ============================================================
// DBU-MRR-OLD — INICIALIZADOR GLOBAL v6.10
// ============================================================
//
// v6.5
// ✔ Mantém Ki + Capacity
// ✔ Mantém Pay original do ataque interceptado
// ✔ Mantém 1 defesa por personagem por ataque
// ✔ Mantém lock local + lock salvo no Actor
// ✔ Mantém atualização da carta pelo GM via socket
// ✔ Mantém novo round automático
// ✔ Mantém GIFs de defesa lidos de system.notes do personagem
// ✔ NOVO: Duel Clash aparece como opção diretamente na carta de defesa
// ✔ NOVO: defensor escolhe o Initiating Attack e abre o Duel nativo do DBU
// ✔ NOVO: Accept Duel usa automaticamente o ataque original recebido
// ✔ NOVO: Duel Escape usa automaticamente o atacante original
// ✔ NOVO: Ki Wager do Duel também consome Capacity
// ✔ NOVO: corrige limpeza dos locks locais de defesa
// ✔ NOVO v6.6: United Attack integrado à carta personalizada do Ataque v11.5
// ✔ NOVO v6.6: +1/2 FO/MA + Ki Wager (1/4 Max Capacity; Teamwork x2)
// ✔ NOVO v6.6: United Attack paga Ki + Capacity e registra 1/Round no Round Tracker
// ✔ NOVO v6.6: intercepta o botão United Attack da carta nativa e usa a mesma automação
// ✔ NOVO v6.6: em ataque multi-target, co-target pode entrar no Duel como United Duel
// ✔ NOVO v6.6: Wound atualizado antes das defesas usa todos os United Attacks confirmados
// ✔ NOVO v6.7: Attack/Defense rolls ficam secretos até todos os alvos confirmarem a defesa
// ✔ NOVO v6.7: dano é aplicado somente na revelação conjunta
// ✔ NOVO v6.7: bloqueia o REVEAL nativo do ataque enquanto houver alvos aguardando
// ✔ NOVO v6.8: dano fica pendente após o reveal para permitir Intervene
// ✔ NOVO v6.8: Parry bem-sucedido pode oferecer Reflect via módulo v1.4
// ✔ NOVO v6.9: bloqueia Roll Attack nativo se Cost + Wager exceder Ki ou Capacity disponível
// ✔ NOVO v6.10: confirma defesa de players via socket + fallback por flags do Actor
// ✔ NOVO v6.10: mostra imediatamente qual defesa foi selecionada sem revelar o resultado
// ✔ NOVO v7.0: defesa pelo Painel 2.0 usa o mesmo resolveDefense da carta
// ✔ NOVO v7.0: fases visuais configuráveis do Duel Clash
//
// Na aba Notes do personagem, use por exemplo:
//
// DODGE_GIF: https://site.com/dodge.gif
// PARRY_GIF: https://site.com/parry.gif
// DIRECT_HIT_GIF: https://site.com/hit.gif
// POWER_FLARE_GIF: https://site.com/flare.gif
// CROSS_COUNTER_GIF: https://site.com/counter.gif
// GUARD_GIF: https://site.com/guard.gif
// DEFENSE_GIF: https://site.com/fallback.gif
//
// DEFENSE_GIF é opcional e serve como fallback.
// ============================================================

const DBU_INIT_VERSION = "7.1-refactor";
const DBU_SYSTEM_ID = "DBU-MRR-OLD";
const DBU_DEFENSE_SELECTOR = "[data-dbu-defense-v5]";
const DBU_SOCKET = MODULE_SOCKET;
const DBU_PENDING_TIMEOUT = 120000;

const DBU_DEFENSE_GIF_CONFIG = {
  enabled: true,
  maxHeight: 240,
  objectFit: "contain"
};

// ============================================================
// LIMPAR VERSÃO ANTERIOR
// ============================================================

const previousBootstrap = globalThis.DBU_BOOTSTRAP;

if (previousBootstrap?.defenseClickHandler) {
  try {
    document.removeEventListener(
      "click",
      previousBootstrap.defenseClickHandler,
      true
    );
  } catch {}
}

if (previousBootstrap?.nativePayHandler) {
  try {
    document.removeEventListener(
      "click",
      previousBootstrap.nativePayHandler,
      true
    );
  } catch {}
}

if (previousBootstrap?.nativeAttackCapacityHookId) {
  try {
    Hooks.off(
      "renderActorSheet",
      previousBootstrap.nativeAttackCapacityHookId
    );
  } catch {}
}

if (previousBootstrap?.combatHookId) {
  try {
    Hooks.off(
      "updateCombat",
      previousBootstrap.combatHookId
    );
  } catch {}
}

if (previousBootstrap?.socketHandler) {
  // Limpa tanto o canal atual quanto o canal legado usado pelo dbu-auto-start.
  for (const channel of [DBU_SOCKET, "module.dbu-auto-start"]) {
    try {
      game.socket.off(
        channel,
        previousBootstrap.socketHandler
      );
    } catch {}
  }
}

// v6.5 — listeners/hooks adicionais do Duel Clash
if (previousBootstrap?.duelInjectHookId) {
  try {
    Hooks.off(
      "renderChatMessage",
      previousBootstrap.duelInjectHookId
    );
  } catch {}
}

if (previousBootstrap?.duelAcceptHandler) {
  try {
    document.removeEventListener(
      "click",
      previousBootstrap.duelAcceptHandler,
      true
    );
  } catch {}
}

if (previousBootstrap?.duelEscapeHandler) {
  try {
    document.removeEventListener(
      "click",
      previousBootstrap.duelEscapeHandler,
      true
    );
  } catch {}
}

if (previousBootstrap?.duelRevealHandler) {
  try {
    document.removeEventListener(
      "click",
      previousBootstrap.duelRevealHandler,
      true
    );
  } catch {}
}

// v6.6 — United Attack / United Duel
if (previousBootstrap?.unitedAttackHandler) {
  try {
    document.removeEventListener(
      "click",
      previousBootstrap.unitedAttackHandler,
      true
    );
  } catch {}
}

if (previousBootstrap?.unitedDuelHandler) {
  try {
    document.removeEventListener(
      "click",
      previousBootstrap.unitedDuelHandler,
      true
    );
  } catch {}
}

if (previousBootstrap?.unitedAttackActorHookId) {
  try {
    Hooks.off(
      "updateActor",
      previousBootstrap.unitedAttackActorHookId
    );
  } catch {}
}

// v6.7 — bloqueio do Reveal nativo até todas as defesas serem registradas.
if (previousBootstrap?.secretRevealHandler) {
  try {
    document.removeEventListener("click", previousBootstrap.secretRevealHandler, true);
  } catch {}
}

if (previousBootstrap?.defenseActorSyncHookId) {
  try {
    Hooks.off("updateActor", previousBootstrap.defenseActorSyncHookId);
  } catch {}
}

if (previousBootstrap?.secretRevealHookId) {
  try {
    Hooks.off("renderChatMessage", previousBootstrap.secretRevealHookId);
  } catch {}
}

if (globalThis.DBU_ATTACK_SYSTEM?.hookId) {
  try {
    Hooks.off(
      "renderChatMessage",
      globalThis.DBU_ATTACK_SYSTEM.hookId
    );
  } catch {}
}

if (globalThis.DBU_ATTACK_DEFENSE?.hookId) {
  try {
    Hooks.off(
      "renderChatMessage",
      globalThis.DBU_ATTACK_DEFENSE.hookId
    );
  } catch {}
}

delete globalThis.DBU_ATTACK_SYSTEM;
delete globalThis.DBU_ATTACK_DEFENSE;

globalThis.DBU_BOOTSTRAP = {
  version: DBU_INIT_VERSION,
  defenseClickHandler: null,
  nativePayHandler: null,
  nativeAttackCapacityHookId: null,
  combatHookId: null,
  socketHandler: null,
  duelInjectHookId: null,
  duelAcceptHandler: null,
  duelEscapeHandler: null,
  duelRevealHandler: null,
  unitedAttackHandler: null,
  unitedDuelHandler: null,
  unitedAttackActorHookId: null,
  defenseActorSyncHookId: null,
  secretRevealHandler: null,
  secretRevealHookId: null,
  lastCombatRound: null
};

globalThis.DBU_DEFENSE_LOCKS = new Set();
globalThis.DBU_PAY_LOCKS = new Set();
globalThis.DBU_DUEL_WAGER_LOCKS = new Set();
globalThis.DBU_UNITED_ATTACK_LOCKS = new Set();
globalThis.DBU_COMBAT_REVEAL_LOCKS = new Set();

// ============================================================
// HELPERS
// ============================================================

function dbuEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dbuSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dbuPrepareSheet(actor) {
  const sheet = actor?.sheet;

  if (!sheet) {
    throw new Error(
      `Ficha de ${actor?.name || "Actor"} não encontrada.`
    );
  }

  await sheet.getData();
  return sheet;
}

// ============================================================
// GIFS DE DEFESA — NOTES DO PERSONAGEM
// ============================================================

function dbuValidateHttpUrl(value) {
  if (!value) return "";

  let url = String(value).trim();

  // Markdown: [texto](https://...)
  const markdown = url.match(/\((https?:\/\/[^)\s]+)\)/i);
  if (markdown?.[1]) {
    url = markdown[1];
  } else {
    const direct = url.match(/https?:\/\/[^\s<>"')\]]+/i);
    if (direct?.[0]) {
      url = direct[0];
    }
  }

  url = url.replace(/[.,;]+$/, "");

  try {
    const parsed = new URL(url);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return "";
    }

    return parsed.href;
  } catch {
    return "";
  }
}

function dbuNormalizeNoteTag(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

function dbuGetCharacterNotes(actor) {
  // DBU-MRR-OLD: a caixa Notes da ficha salva em system.notes.
  return String(actor?.system?.notes ?? "");
}

function dbuExtractNoteUrl(notes, acceptedTags) {
  if (!notes) return "";

  // Caso algum módulo/editor converta o conteúdo para HTML.
  let text = String(notes);

  try {
    if (/<[a-z][\s\S]*>/i.test(text)) {
      const element = document.createElement("div");
      element.innerHTML = text;
      text = element.innerText || element.textContent || text;
    }
  } catch {}

  const normalizedTags = new Set(
    acceptedTags.map(dbuNormalizeNoteTag)
  );

  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
    if (!match) continue;

    const key = dbuNormalizeNoteTag(match[1]);
    if (!normalizedTags.has(key)) continue;

    const url = dbuValidateHttpUrl(match[2]);
    if (url) return url;
  }

  return "";
}

function dbuGetDefenseGif(defender, defenseType) {
  if (!DBU_DEFENSE_GIF_CONFIG.enabled) {
    return "";
  }

  const visualSettings = getDefenseVisualSettings(defender, defenseType);
  if (visualSettings?.gifMode === "custom") {
    return String(visualSettings.gif || "").trim();
  }
  if (visualSettings?.gifMode === "none") {
    return "";
  }

  const notes = dbuGetCharacterNotes(defender);

  const tagsByDefense = {
    dodge: [
      "DODGE_GIF"
    ],

    parry: [
      "PARRY_GIF"
    ],

    directHit: [
      "DIRECT_HIT_GIF",
      "DIRECTHIT_GIF"
    ],

    powerFlare: [
      "POWER_FLARE_GIF",
      "POWERFLARE_GIF"
    ],

    crossCounter: [
      "CROSS_COUNTER_GIF",
      "CROSSCOUNTER_GIF"
    ],

    guard: [
      "GUARD_GIF"
    ],

    duelClash: [
      "DUEL_CLASH_GIF",
      "DUELCLASH_GIF"
    ]
  };

  const specific = dbuExtractNoteUrl(
    notes,
    tagsByDefense[defenseType] || []
  );

  if (specific) {
    return specific;
  }

  return dbuExtractNoteUrl(
    notes,
    ["DEFENSE_GIF"]
  );
}

function dbuExtractNoteValue(notes, acceptedTags) {
  if (!notes) return "";

  let text = String(notes);
  try {
    if (/<[a-z][\s\S]*>/i.test(text)) {
      const element = document.createElement("div");
      element.innerHTML = text;
      text = element.innerText || element.textContent || text;
    }
  } catch {}

  const normalizedTags = new Set(acceptedTags.map(dbuNormalizeNoteTag));
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const key = dbuNormalizeNoteTag(match[1]);
    if (!normalizedTags.has(key)) continue;
    return String(match[2] || "").trim();
  }
  return "";
}

function dbuGetDefenseVisualMacro(defender, defenseType) {
  const visualSettings = getDefenseVisualSettings(defender, defenseType);
  if (visualSettings?.visualMode === "custom") {
    return String(visualSettings.visualMacro || "").trim();
  }
  if (visualSettings?.visualMode === "none") return "";

  const tagsByDefense = {
    dodge: ["DODGE_VISUAL"],
    parry: ["PARRY_VISUAL"],
    directHit: ["DIRECT_HIT_VISUAL", "DIRECTHIT_VISUAL"],
    powerFlare: ["POWER_FLARE_VISUAL", "POWERFLARE_VISUAL"],
    crossCounter: ["CROSS_COUNTER_VISUAL", "CROSSCOUNTER_VISUAL"],
    guard: ["GUARD_VISUAL"],
    duelClash: ["DUEL_CLASH_VISUAL", "DUELCLASH_VISUAL"]
  };

  const notes = dbuGetCharacterNotes(defender);
  return dbuExtractNoteValue(notes, tagsByDefense[defenseType] || [])
    || dbuExtractNoteValue(notes, ["DEFENSE_VISUAL"]);
}

async function dbuRunDefenseVisual(defender, defenseType, result = {}) {
  const macroName = dbuGetDefenseVisualMacro(defender, defenseType);
  if (!macroName) return;

  const macro = game.macros.getName(macroName);
  if (!macro) {
    console.warn(`DBU | Macro visual de defesa não encontrada: ${macroName}`);
    return;
  }

  const tokens = defender.getActiveTokens?.() || [];
  const token = tokens[0] || null;

  try {
    await macro.execute({
      actor: defender,
      token,
      defender,
      defenderToken: token,
      defenseType,
      defenseName: result.name || defenseType,
      defenseResult: result,
      success: !!result.success,
      action: "defense"
    });
  } catch (error) {
    console.error(`DBU | Erro na macro visual de defesa ${macroName}:`, error);
    ui.notifications.warn(`Erro executando visual de defesa: ${macroName}`);
  }
}

async function dbuRunCombatReactionVisual(actor, reactionType, phase, payload = {}) {
  try {
    const settings = getCombatVisualSettings(actor, reactionType);
    if (settings?.mode !== "custom" || !settings?.macro) return false;
    const macro = game.macros?.getName?.(settings.macro);
    if (!macro) return false;
    const token = (actor.getActiveTokens?.() || [])[0] || null;
    await macro.execute({ actor, token, reactionType, combatReaction:reactionType, phase, action:reactionType, ...payload });
    return true;
  } catch (error) {
    console.warn(`DBU | Visual ${reactionType}/${phase}:`, error);
    return false;
  }
}


// v7.0 — finaliza o ciclo visual do Duel quando todos os participantes
// revelarem os três Clashes. O macro configurado recebe resolve + win/lose/tie.
function dbuDefenseGifHTML(gifUrl, defenseName) {
  if (!gifUrl) return "";

  return `
    <div
      class="dbu-defense-gif"
      style="
        margin:8px 0 10px 0;
        overflow:hidden;
        border-radius:6px;
        line-height:0;
        text-align:center;
      "
    >
      <img
        src="${dbuEsc(gifUrl)}"
        alt="${dbuEsc(defenseName)}"
        style="
          display:block;
          width:100%;
          max-height:${DBU_DEFENSE_GIF_CONFIG.maxHeight}px;
          object-fit:${DBU_DEFENSE_GIF_CONFIG.objectFit};
          border:0;
        "
      >
    </div>
  `;
}

// ============================================================
// DUEL CLASH v6.5 — INTEGRAÇÃO COM O DUEL NATIVO DO DBU
// ============================================================


// ============================================================
// COMPOSIÇÃO DOS SUBSISTEMAS
// ============================================================
// O initializer agora apenas conecta os domínios. Proxies em `services`
// quebram dependências circulares entre Duel, United Attack e Reveal sem
// alterar a API pública usada pelos demais scripts do módulo.

const services = {};
const serviceProxy = name => (...args) => {
  const fn = services[name];
  if (typeof fn !== "function") {
    throw new Error(`DBU Core: serviço ${name} ainda não foi registrado.`);
  }
  return fn(...args);
};

const Duel = initializeDuelCore({
  DBU_SYSTEM_ID, DBU_SOCKET, DBU_INIT_VERSION,
  dbuEsc, dbuPrepareSheet, dbuRunCombatReactionVisual, dbuSleep,
  dbuGetCapacity, dbuGetCurrentRound, dbuPayKiAndCapacity,
  dbuAnnounceDuelOnAttackCard: serviceProxy("dbuAnnounceDuelOnAttackCard"),
  dbuGMRefundDuelCounter: serviceProxy("dbuGMRefundDuelCounter")
});

const {
  dbuGetDuelHelper, dbuGetDuelContext, dbuRefundDuelCounter,
  dbuInitiateDuelClash, dbuSetupIncomingDuelAttacker
} = Duel;

const Defense = createDefenseCore({
  dbuEsc, dbuPrepareSheet, dbuGetDefenseGif, dbuDefenseGifHTML,
  dbuRunDefenseVisual, dbuInitiateDuelClash, dbuPayKiAndCapacity, dbuRecordDefend
});

const {
  dbuRollDodge, dbuRollDefend, dbuApplyDamage,
  dbuDefenseResult, dbuResolveDefense
} = Defense;

const United = initializeUnitedAttackCore({
  DBU_SYSTEM_ID, DBU_SOCKET, dbuEsc, dbuGetCapacity, dbuGetCurrentRound,
  dbuGetDefenseState, dbuGetDuelHelper, dbuSleep,
  dbuGMRefreshUnitedAttackCard: serviceProxy("dbuGMRefreshUnitedAttackCard"),
  dbuGMSetActiveDuelOnAttack: serviceProxy("dbuGMSetActiveDuelOnAttack"),
  dbuUpdateTargetStatus: serviceProxy("dbuUpdateTargetStatus")
});

const {
  dbuUnitedAttackStorageId, dbuGetUnitedAttackContributions,
  dbuRequestUnitedAttackRefresh, dbuRunUnitedAttackJoin,
  dbuAnnounceDuelOnAttackCard
} = United;

services.dbuAnnounceDuelOnAttackCard = dbuAnnounceDuelOnAttackCard;

const Reveal = initializeRevealCore({
  DBU_SYSTEM_ID, DBU_SOCKET, DBU_PENDING_TIMEOUT, dbuEsc, dbuSleep,
  dbuApplyDamage, dbuDefenseResult, dbuResolveDefense,
  dbuGetDefenseStates, dbuGetDefenseState, dbuSetDefenseState, dbuClearDefensePending,
  dbuGetDuelContext, dbuRefundDuelCounter, dbuGetUnitedAttackContributions
});

const {
  dbuIsPrimaryGM, dbuCombatProgress, dbuDefenseChoiceLabel, dbuWaitingTargetHTML,
  dbuGMRefreshUnitedAttackCard, dbuRequestUnitedAttackLock,
  dbuGMSetActiveDuelOnAttack, dbuGMRefundDuelCounter,
  dbuUpdateTargetStatus, dbuDefendFromPanel
} = Reveal;

Object.assign(services, {
  dbuGMRefreshUnitedAttackCard, dbuGMSetActiveDuelOnAttack,
  dbuGMRefundDuelCounter, dbuUpdateTargetStatus
});

// ============================================================
// API GLOBAL
// ============================================================

globalThis.DBU = {
  version: DBU_INIT_VERSION,
  getCapacity: dbuGetCapacity,
  canAfford: dbuCheckAffordability,
  payKiAndCapacity: dbuPayKiAndCapacity,
  resolveDefense: dbuResolveDefense,
  defendFromPanel: dbuDefendFromPanel,
  updateTargetStatus: dbuUpdateTargetStatus,
  getDefenseState: dbuGetDefenseState,
  setDefenseState: dbuSetDefenseState,
  getDefenseGif: dbuGetDefenseGif,
  initiateDuelClash: dbuInitiateDuelClash,
  getDuelContext: dbuGetDuelContext,
  setupIncomingDuelAttacker: dbuSetupIncomingDuelAttacker,
  getUnitedAttackContributions: dbuGetUnitedAttackContributions,
  refreshUnitedAttack: dbuRequestUnitedAttackRefresh,
  joinUnitedAttack: dbuRunUnitedAttackJoin,
  rollDodge: dbuRollDodge,
  rollDefend: dbuRollDefend,
  applyDamage: dbuApplyDamage,
  recordDefend: dbuRecordDefend
};

initializeNativeDBUBridge({
  DBU_INIT_VERSION, DBU_DEFENSE_SELECTOR, DBU_PENDING_TIMEOUT, DBU_SYSTEM_ID,
  dbuCheckAffordability, dbuGetCapacity, dbuPayKiAndCapacity,
  dbuGetDefenseState, dbuSetDefenseState, dbuClearDefensePending,
  dbuRequestUnitedAttackLock, dbuCombatProgress, dbuDefenseChoiceLabel,
  dbuWaitingTargetHTML, dbuSleep, dbuEsc, dbuIsPrimaryGM,
  dbuUnitedAttackStorageId, dbuGMRefreshUnitedAttackCard
});

initializeRoundHooks({ dbuIsPrimaryGM });


// ============================================================
// TESTE MANUAL
// ============================================================

globalThis.DBU.test = function () {
  console.log(
    "============================="
  );

  console.log(
    "DBU Inicializador",
    DBU_INIT_VERSION
  );

  console.log(
    "resolveDefense:",
    typeof globalThis.DBU.resolveDefense
  );

  console.log(
    "Native Pay:",
    !!globalThis.DBU_BOOTSTRAP.nativePayHandler
  );

  console.log(
    "Defense handler:",
    !!globalThis.DBU_BOOTSTRAP.defenseClickHandler
  );

  console.log(
    "Socket handler:",
    !!globalThis.DBU_BOOTSTRAP.socketHandler
  );

  console.log(
    "Round hook:",
    globalThis.DBU_BOOTSTRAP.combatHookId
  );

  console.log(
    "Defense GIF notes:",
    "system.notes"
  );

  console.log(
    "Duel Clash injection:",
    !!globalThis.DBU_BOOTSTRAP.duelInjectHookId
  );

  console.log(
    "United Attack handler:",
    !!globalThis.DBU_BOOTSTRAP.unitedAttackHandler
  );

  console.log(
    "United Duel handler:",
    !!globalThis.DBU_BOOTSTRAP.unitedDuelHandler
  );

  console.log(
    "Duel Accept handler:",
    !!globalThis.DBU_BOOTSTRAP.duelAcceptHandler
  );

  console.log(
    "Duel Escape handler:",
    !!globalThis.DBU_BOOTSTRAP.duelEscapeHandler
  );

  console.log(
    "============================="
  );

  ui.notifications.info(
    `DBU Inicializador v${DBU_INIT_VERSION} funcionando.`
  );
};

// ============================================================
// FINAL
// ============================================================

console.log(
  "=========================================="
);
console.log(
  `DBU Inicializador v${DBU_INIT_VERSION}`
);
console.log(
  "✓ Ki + Capacity"
);
console.log(
  "✓ Pay de ataque cobra Capacity"
);
console.log(
  "✓ Ataque bloqueado se Cost + Wager exceder Ki/Capacity"
);
console.log(
  "✓ Uma defesa por ataque"
);
console.log(
  "✓ Player não edita ChatMessage"
);
console.log(
  "✓ GM atualiza carta via socket"
);
console.log(
  "✓ GIFs de defesa via system.notes"
);
console.log(
  "✓ Duel Clash na carta de defesa"
);
console.log(
  "✓ United Attack no ataque normal"
);
console.log(
  "✓ United Attack cobra Ki + Capacity"
);
console.log(
  "✓ Multi-target pode Join United Duel"
);
console.log(
  "✓ Accept Duel usa o ataque original"
);
console.log(
  "✓ Duel Escape usa o atacante original"
);
console.log(
  "✓ Duel Wager cobra Capacity"
);
console.log(
  "✓ Novo Round"
);
console.log(
  "=========================================="
);

ui.notifications.info(
  `DBU Inicializador v${DBU_INIT_VERSION} ativo.`
);


return globalThis.DBU;
}
