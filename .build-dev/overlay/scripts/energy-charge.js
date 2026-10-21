import { renderActionWindow, ACTION_WINDOW_DIALOG_OPTIONS } from "./ui/action-windows.js";
import { getEnergyChargeVisualSettings } from "./visual-config.js";
import { validateActionUse } from "./action-economy.js";

// ============================================================
// DBU-MRR-OLD — ENERGY CHARGE v1.3
// Compatível com DBU 0.9.2 + Ataque v11.5 + Inicializador v6.6
// ============================================================
//
// Regras automatizadas:
// - Energy Charge é Standard, 1 Action, 2(bT) KP.
// - Practiced Charger reduz para 1(bT) KP.
// - Cada uso adiciona 1 Energy Charge ao ataque declarado.
// - Máximo normal: 7 Energy Charges totais no ataque.
// - Enquanto carregando: Guard Down, exceto Power of Movement.
// - Não pode trocar o ataque declarado sem cancelar o Charge.
// - Mandatory Charge: 2 usos do Energy Charge por rank.
// - Cancelar Charge perde as cargas reunidas e NÃO reembolsa os custos.
// - Liberar aplica temporariamente as cargas ao Attack Ref / Signature,
//   chama o macro de Ataque e depois restaura a ficha.
// - Visual progressivo opcional lido das Notes do personagem:
//   CHARGE_VISUAL_1, 2, 3, 4, MAX e CHARGE_VISUAL fallback.
//   O valor pode ser um caminho de asset do Sequencer ou nome de outro Macro.
//
// Campos avançados no diálogo permitem lidar com exceções de talentos,
// transformações e efeitos que alteram custo, quantidade de EC ou contagem
// para Mandatory Charge.
// ============================================================


export function getEnergyChargeAllowedTypes(actor) {
  const types = ["standard"];
  const system = actor?.system || {};
  const actualEffects = [
    ...(system.transformations || []).filter(effect => effect?.active),
    ...(system.signatureAuras || []).filter(effect => effect?.active),
    ...(system.uniqueAbilities || []).filter(effect => typeof effect === "object"),
    ...(system.villainousTraits || []).filter(effect => typeof effect === "object"),
    system.effectTracking?.activeEffects,
    system.activeEffects
  ];
  const talentCatalog = globalThis.CONFIG?.DBU?.talentsCatalog || [];
  for (const talentId of (system.talents || [])) {
    const talent = talentCatalog.find(entry => entry?.id === talentId);
    if (talent) actualEffects.push(talent);
  }
  const strings = [];
  const collectStrings = value => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collectStrings);
    else if (value && typeof value === "object") Object.values(value).forEach(collectStrings);
  };
  actualEffects.filter(Boolean).forEach(collectStrings);
  for (const text of strings) {
    if (/Energy Charge Maneuver.{0,180}as an Instant Maneuver|as an Instant Maneuver.{0,180}Energy Charge Maneuver/i.test(text)) types.push("instant");
    if (/Energy Charge Maneuver.{0,220}as an Out-of-Sequence Maneuver|Out-of-Sequence Maneuver.{0,220}Energy Charge Maneuver/i.test(text)) types.push("out-of-sequence");
  }
  return [...new Set(types)];
}

export async function energyCharge(context = {}) {

const DBU_CHARGE_VERSION = "1.3";
const DBU_CHARGE_FLAG_SCOPE = "world";
const DBU_CHARGE_FLAG_KEY = "dbuEnergyChargeState";
const DBU_MAX_ENERGY_CHARGES = 7;

// Tenta nesta ordem. Se o seu macro tiver outro nome, adicione aqui.
const DBU_ATTACK_MACRO_NAMES = [
  "DBU-MRR-OLD — ATAQUE v11.5",
  "DBU-MRR-OLD - ATAQUE v11.5",
  "Ataque v11.5",
  "DBU - Ataque",
  "DBU — Ataque",
  "DBU-MRR-OLD — ATAQUE v11.4",
  "DBU-MRR-OLD - ATAQUE v11.4",
  "Ataque v11.4",
  "DBU-MRR-OLD — ATAQUE v11.3",
  "DBU-MRR-OLD - ATAQUE v11.3",
  "Ataque v11.3",
  "DBU-MRR-OLD — ATAQUE v11.2",
  "DBU-MRR-OLD - ATAQUE v11.2",
  "Ataque v11.2"
];

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

// ============================================================
// VISUAL DO ENERGY CHARGE — NOTES + SEQUENCER / MACRO
// ============================================================
//
// Na ficha, em Bio > Notes, use por exemplo:
//
// CHARGE_VISUAL_1: assets/Auras/charge-1.webm
// CHARGE_VISUAL_2: assets/Auras/charge-2.webm
// CHARGE_VISUAL_3: assets/Auras/charge-3.webm
// CHARGE_VISUAL_4: assets/Auras/charge-4.webm
// CHARGE_VISUAL_MAX: assets/Auras/charge-max.webm
// CHARGE_SCALE: 2.5
//
// Ou, no lugar de um arquivo, use o nome de um Macro:
// CHARGE_VISUAL_1: Visual Charge Goku 1
//
// Um macro visual recebe:
// { actor, token, mode, stage, totalCharges, gatheredCharges,
//   state, effectName, chargeAction: "energy-charge" }
//
// mode = "update" ou "off".
// ============================================================

const DBU_CHARGE_EFFECT_PREFIX = "DBU Energy Charge";

function dbuGetNotesText(actor) {
  return String(actor?.system?.notes ?? "");
}

function dbuNotesToText(notes) {
  const raw = String(notes || "");
  if (!raw) return "";
  try {
    if (/<[a-z][\s\S]*>/i.test(raw)) {
      const el = document.createElement("div");
      el.innerHTML = raw;
      return el.innerText || el.textContent || raw;
    }
  } catch {}
  return raw;
}

function dbuGetNoteValue(actor, tag) {
  const text = dbuNotesToText(dbuGetNotesText(actor));
  const wanted = String(tag || "").trim().toUpperCase();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    if (String(match[1]).trim().toUpperCase() !== wanted) continue;
    return String(match[2] || "").trim();
  }
  return "";
}

function dbuChargeStage(totalCharges) {
  const total = Math.max(0, Number(totalCharges) || 0);
  if (total >= 5) return "MAX";
  if (total >= 4) return "4";
  if (total >= 3) return "3";
  if (total >= 2) return "2";
  return "1";
}

function dbuChargeEffectName(actor) {
  return `${DBU_CHARGE_EFFECT_PREFIX} | ${actor.id}`;
}

function dbuLooksLikeAsset(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (/^(https?:\/\/)/i.test(v)) return true;
  if (/\.(?:webm|webp|png|jpg|jpeg|gif|mp4)(?:[?#].*)?$/i.test(v)) return true;
  if (/^(?:assets|modules|systems|worlds)\//i.test(v)) return true;
  return false;
}

function dbuGetChargeVisualSpec(actor, totalCharges) {
  const stage = dbuChargeStage(totalCharges);

  // v1.5.3: configuração visual do Actor tem prioridade. O configurador usa
  // somente macros por estágio (1/2/3/4/MAX); MAX = 5+ EC.
  const custom = getEnergyChargeVisualSettings(actor, stage);
  if (custom?.mode === "none") {
    return { stage, sourceStage: custom.sourceStage || stage, value: "", scale: 2.5, kind: "none", custom: true };
  }
  if (custom?.mode === "custom" && custom.macro) {
    return {
      stage,
      sourceStage: custom.sourceStage || stage,
      value: custom.macro,
      scale: 2.5,
      kind: "macro",
      custom: true
    };
  }

  const configuredValue =
    dbuGetNoteValue(actor, `CHARGE_VISUAL_${stage}`)
    || dbuGetNoteValue(actor, "CHARGE_VISUAL");

  // Fallback legado: Notes ou Visual Energy Charge padrão.
  const value = configuredValue
    || (typeof globalThis.DBUAutomation?.visualEnergyCharge === "function"
      ? "Visual Energy Charge"
      : (game.macros.getName("Visual Energy Charge") ? "Visual Energy Charge" : ""));

  const scaleRaw =
    dbuGetNoteValue(actor, `CHARGE_SCALE_${stage}`)
    || dbuGetNoteValue(actor, "CHARGE_SCALE");

  const scaleNum = Number(scaleRaw);
  const scale = Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : 2.5;

  return {
    stage,
    sourceStage: stage,
    value,
    scale,
    kind: value ? (dbuLooksLikeAsset(value) ? "asset" : "macro") : "none",
    custom: false
  };
}

async function dbuEndSequencerChargeEffect(actor, token) {
  try {
    if (globalThis.Sequencer?.EffectManager) {
      await globalThis.Sequencer.EffectManager.endEffects({
        name: dbuChargeEffectName(actor),
        object: token
      });
    }
  } catch (error) {
    console.warn("DBU Energy Charge | Não consegui encerrar efeito Sequencer:", error);
  }
}

async function dbuCallChargeVisualMacro(actor, token, macroName, payload) {
  if (!macroName) return;

  if (
    String(macroName).trim().toLowerCase() === "visual energy charge"
    && typeof globalThis.DBUAutomation?.visualEnergyCharge === "function"
  ) {
    return globalThis.DBUAutomation.visualEnergyCharge({
      actor,
      token,
      attacker: actor,
      attackerToken: token,
      chargeAction: "energy-charge",
      ...payload
    });
  }

  const macro = game.macros.getName(macroName);
  if (!macro) {
    ui.notifications.warn(`Visual de Charge não encontrado: ${macroName}`);
    return;
  }
  try {
    await macro.execute({
      actor,
      token,
      attacker: actor,
      attackerToken: token,
      chargeAction: "energy-charge",
      ...payload
    });
  } catch (error) {
    console.error(`DBU Energy Charge | Erro no visual ${macroName}:`, error);
  }
}

async function dbuClearChargeVisual(actor, token, state = null) {
  await dbuEndSequencerChargeEffect(actor, token);

  const oldMacro =
    state?.visualKind === "macro"
      ? String(state.visualValue || "")
      : "";

  if (oldMacro) {
    await dbuCallChargeVisualMacro(actor, token, oldMacro, {
      mode: "off",
      phase: "deactivate",
      stage: state.visualStage || null,
      sourceStage: state.visualSourceStage || state.visualStage || null,
      totalCharges: Number(state.visualTotalCharges || 0),
      gatheredCharges: Number(state.gatheredCharges || 0),
      state: foundry.utils.deepClone(state),
      effectName: dbuChargeEffectName(actor)
    });
  }
}

async function dbuSyncChargeVisual(actor, token, state, totalCharges) {
  if (!state?.active || !token) return state;

  const spec = dbuGetChargeVisualSpec(actor, totalCharges);
  const previousValue = String(state.visualValue || "");
  const previousKind = String(state.visualKind || "none");
  const previousStage = String(state.visualStage || "");

  const changed =
    previousValue !== String(spec.value || "")
    || previousKind !== spec.kind
    || previousStage !== spec.stage
    || Number(state.visualTotalCharges || -1) !== Number(totalCharges || 0);

  if (!changed) return state;

  // Desliga o estágio anterior antes de iniciar o novo.
  await dbuClearChargeVisual(actor, token, state);

  if (spec.kind === "asset" && spec.value) {
    if (!globalThis.Sequence) {
      ui.notifications.warn("Sequencer/Sequence não está disponível para o visual de Energy Charge.");
    } else {
      try {
        await new globalThis.Sequence()
          .effect()
            .file(spec.value)
            .attachTo(token)
            .scaleToObject(spec.scale)
            .persist()
            .name(dbuChargeEffectName(actor))
          .play();
      } catch (error) {
        console.error("DBU Energy Charge | Erro criando visual Sequencer:", error);
      }
    }
  }

  if (spec.kind === "macro" && spec.value) {
    await dbuCallChargeVisualMacro(actor, token, spec.value, {
      mode: "update",
      phase: "activate",
      stage: spec.stage,
      sourceStage: spec.sourceStage || spec.stage,
      previousStage: previousStage || null,
      totalCharges: Number(totalCharges || 0),
      gatheredCharges: Number(state.gatheredCharges || 0),
      state: foundry.utils.deepClone(state),
      effectName: dbuChargeEffectName(actor)
    });
  }

  const next = foundry.utils.deepClone(state);
  next.visualKind = spec.kind;
  next.visualValue = spec.value || "";
  next.visualStage = spec.stage;
  next.visualSourceStage = spec.sourceStage || spec.stage;
  next.visualTotalCharges = Number(totalCharges || 0);
  next.visualScale = spec.scale;

  await dbuSetState(actor, next);
  return next;
}

function dbuGetCurrentRound(cts) {
  cts.rounds ??= [];

  if (!cts.rounds.length) {
    cts.rounds.push({
      roundNumber: 1,
      actions: []
    });
  }

  const round = cts.rounds[cts.rounds.length - 1];
  round.actions ??= [];
  round.roundNumber ??= cts.rounds.length;
  cts.currentRound = round.roundNumber;
  return round;
}

function dbuHasTalent(actor, id) {
  return (actor.system.talents || []).includes(id);
}

function dbuGetCondition(actor, id) {
  return (actor.system.conditions || []).find(c => c.id === id) || null;
}

function dbuConditionIsActive(actor, id) {
  const cond = dbuGetCondition(actor, id);
  return !!(cond?.active);
}

function dbuSetConditionInArray(conditions, id, active) {
  let cond = conditions.find(c => c.id === id);

  if (!cond) {
    cond = {
      id,
      active: !!active,
      stacks: 0
    };
    conditions.push(cond);
  } else {
    cond.active = !!active;
    if (!active) cond.stacks = 0;
  }

  return conditions;
}

async function dbuPrepareSheet(actor) {
  const sheet = actor?.sheet;

  if (!sheet) {
    throw new Error("Ficha do personagem não encontrada.");
  }

  await sheet.getData();
  return sheet;
}

function dbuFindAttackMacro() {
  if (typeof globalThis.DBUAutomation?.attack === "function") {
    return {
      name: "DBU Automation — Attack Core",
      execute: payload => globalThis.DBUAutomation.attack(payload)
    };
  }

  for (const name of DBU_ATTACK_MACRO_NAMES) {
    const macro = game.macros.getName(name);
    if (macro) return macro;
  }

  // Fallback: tenta achar um macro de ataque DBU sem pegar Visual.
  const candidates = game.macros.contents.filter(macro => {
    const name = String(macro.name || "").toLowerCase();
    return (
      name.includes("ataque") &&
      !name.includes("visual") &&
      (name.includes("11.4") || name.includes("11.3") || name.includes("11.2") || name.includes("dbu"))
    );
  });

  return candidates[0] || null;
}

function dbuGetSourceFromPrepared(sheet, sourceKey) {
  for (const group of (sheet._trackerSourceGroups || [])) {
    if (group.label !== "Attack Refs" && group.label !== "Sig. Techniques") {
      continue;
    }

    const source = (group.sources || []).find(s => s.key === sourceKey);
    if (source) {
      return {
        group: group.label,
        source
      };
    }
  }

  return null;
}

function dbuGetMandatoryChargeInfo(actor, sourceKey) {
  if (!String(sourceKey).startsWith("tech_")) {
    return {
      ranks: 0,
      requiredUses: 0
    };
  }

  const techId = String(sourceKey).slice(5);
  const tech = (actor.system.signatureTechniques || []).find(t =>
    String(t.id ?? t._id ?? "") === techId
  );

  const mandatory = (tech?.disadvantages || []).find(d =>
    String(d.name || "").trim().toLowerCase() === "mandatory charge"
  );

  const ranks = mandatory ? Math.max(1, Number(mandatory.ranks) || 1) : 0;

  return {
    ranks,
    requiredUses: ranks * 2
  };
}

function dbuGetChargeDie(actor, sourceKey) {
  // Basic Attacks: 1d6(T) por EC.
  if (!String(sourceKey).startsWith("tech_")) {
    return "d6";
  }

  // Signature: base d8; Maximum Charge aumenta uma categoria.
  const techId = String(sourceKey).slice(5);
  const tech = (actor.system.signatureTechniques || []).find(t =>
    String(t.id ?? t._id ?? "") === techId
  );

  const hasMaxCharge = (tech?.advantages || []).some(a =>
    String(a.name || "").trim().toLowerCase() === "maximum charge"
  );

  const chain = ["d4", "d6", "d8", "d10", "d12"];

  let index = 2;
  if (hasMaxCharge) index += 1;

  // Mesma lógica que o DBU usa para Signature Energy Charge Dice Category.
  index += Number(actor.system.aptitudes?.energyChargeDiceCategory || 0);
  index += Number(actor.system.aptitudes?.signatureEnergyChargeDiceCategory || 0);

  index = Math.max(0, Math.min(chain.length - 1, index));
  return chain[index];
}

function dbuGetProjectedChargeFormula(actor, sourceKey, totalCharges) {
  const tier = Number(actor.system.tier || 1);
  const die = dbuGetChargeDie(actor, sourceKey);
  const diceCount = Math.max(0, Number(totalCharges) || 0) * tier;

  if (!diceCount) return "0";
  return `${diceCount}${die}`;
}

function dbuGetState(actor) {
  return actor.getFlag(DBU_CHARGE_FLAG_SCOPE, DBU_CHARGE_FLAG_KEY) || null;
}

async function dbuSetState(actor, state) {
  await actor.setFlag(
    DBU_CHARGE_FLAG_SCOPE,
    DBU_CHARGE_FLAG_KEY,
    state
  );
}

async function dbuClearState(actor) {
  await actor.unsetFlag(
    DBU_CHARGE_FLAG_SCOPE,
    DBU_CHARGE_FLAG_KEY
  );
}

function dbuGetChargeActions(actor, stateId) {
  const result = [];
  const rounds = actor.system.combatTabState?.rounds || [];

  for (const round of rounds) {
    for (const action of (round.actions || [])) {
      if (
        action?.dbuEnergyCharge === true &&
        action?.dbuChargeStateId === stateId
      ) {
        result.push(action);
      }
    }
  }

  return result;
}

async function dbuReconcileState(actor, state) {
  if (!state?.active || !state.stateId) return state;

  const actions = dbuGetChargeActions(actor, state.stateId);

  const gatheredCharges = actions.reduce(
    (sum, action) => sum + Math.max(0, Number(action.energyChargesGained) || 0),
    0
  );

  const maneuverUses = actions.reduce(
    (sum, action) => sum + Math.max(0, Number(action.energyChargeCountsAsUses) || 0),
    0
  );

  if (
    gatheredCharges !== Number(state.gatheredCharges || 0) ||
    maneuverUses !== Number(state.maneuverUses || 0)
  ) {
    state = foundry.utils.deepClone(state);
    state.gatheredCharges = gatheredCharges;
    state.maneuverUses = maneuverUses;
    state.lastUpdatedAt = Date.now();
    await dbuSetState(actor, state);
  }

  return state;
}

function dbuGetDefaultChargeCost(actor) {
  const baseTier = Number(actor.system.baseTier || 1);

  // Practiced Charger L1: Energy Charge custa 1(bT).
  if (dbuHasTalent(actor, "practiced_charger")) {
    return baseTier;
  }

  // Regra base: 2(bT).
  return 2 * baseTier;
}

// Action Windows 2.0: presentation and live preview only. Payments, EC
// thresholds and Maneuver rules continue through the existing handlers.
function dbuChargeWindow(actor, {
  attackName = "Selecionar ataque", sourceKey = "", baseCharges = 0,
  gatheredCharges = 0, maneuverUses = 0, requiredUses = 0,
  defaultCost = 0, hasPowerOfMovement = false, extra = ""
} = {}) {
  const ki = Math.max(0, Number(actor.system.kiPool?.value || 0));
  const maxCapacity = Math.max(0, Number(actor.system.status?.maxCapacity || 0));
  const capacitySpent = Math.max(0, Number(actor.system.status?.capacitySpent || 0));
  const capacityLeft = Math.max(0, maxCapacity - capacitySpent);
  const total = baseCharges + gatheredCharges;
  const formula = sourceKey ? dbuGetProjectedChargeFormula(actor, sourceKey, total + 1) : "Selecione o ataque";
  return renderActionWindow({
    actorName:actor.name, actionName:"ENERGY CHARGE", icon:"fas fa-bolt",
    portrait:actor.img, type:"STANDARD MANEUVER · variantes conforme Traits",
    description:"Concentre Energy Charges em um ataque declarado. Cada uso pode modificar o custo, os EC ganhos e o tipo permitido pela ficha.",
    status:attackName === "Selecionar ataque" ? "Declarar ataque" : "Carregando: " + attackName,
    statusTone:"green",cost:defaultCost + " Ki + Capacity",
    usage:requiredUses ? maneuverUses+"/"+requiredUses+" Mandatory" : "Máximo normal: "+DBU_MAX_ENERGY_CHARGES+" EC",
    conditions:hasPowerOfMovement?"Power of Movement ativo":"Guard Down enquanto carregar",
    current:[
      {label:"Ki atual",value:ki,icon:"fas fa-bolt"},
      {label:"Capacity restante",value:capacityLeft+"/"+maxCapacity,icon:"fas fa-shield-alt"},
      {label:"EC acumulados",value:total+"/"+DBU_MAX_ENERGY_CHARGES,icon:"fas fa-layer-group"}
    ],
    effects:[
      {label:"EC ganhos neste uso",value:"Configurável (padrão +1)",icon:"fas fa-plus"},
      {label:"Ataque declarado",value:attackName,icon:"fas fa-crosshairs"},
      {label:"Wound projetado",value:formula,icon:"fas fa-dice",tone:"orange"}
    ],
    preview:[
      {label:"EC após este uso",valueHTML:'<strong data-dbua-charge-preview-ec>'+total+'</strong>',icon:"fas fa-layer-group",tone:"orange"},
      {label:"Ki após o custo",valueHTML:'<strong data-dbua-charge-preview-ki>'+ki+'</strong>',icon:"fas fa-bolt"},
      {label:"Capacity após o custo",valueHTML:'<strong data-dbua-charge-preview-cap>'+capacityLeft+'</strong>',icon:"fas fa-shield-alt"},
      {label:"Wound após Charge",valueHTML:'<strong data-dbua-charge-preview-wound>'+dbuEsc(formula)+'</strong>',icon:"fas fa-dice"},
      {label:"Usos Mandatory",valueHTML:'<strong data-dbua-charge-preview-uses>'+maneuverUses+(requiredUses?"/"+requiredUses:" (sem exigência)")+'</strong>',icon:"fas fa-hourglass"}
    ],
    extra,
    notes:[
      "Custo base: 2(bT) Ki e Capacity; Practiced Charger pode reduzir para 1(bT).",
      "O limite normal é 7 EC. Ignorá-lo exige permissão aplicável na mesa.",
      "Mandatory Charge exige 2 usos por rank; o progresso considera os usos contados.",
      hasPowerOfMovement ? "Power of Movement evita Guard Down." : "Guard Down permanece ativo até liberar ou cancelar o Charge.",
      "Cancelar o Charge não devolve Ki ou Capacity pagos anteriormente."
    ]
  });
}

function dbuBindChargeWindowPreview(html, actor, { sources = null, activeState = null } = {}) {
  const refresh = () => {
    const current = sources?.[Math.trunc(Number(html.find("#dbu-charge-source").val()))] || null;
    const sourceKey = current?.source?.key || activeState?.sourceKey || null;
    const base = Number(current?.baseCharges ?? activeState?.baseCharges ?? 0);
    const gathered = Number(activeState?.gatheredCharges ?? 0);
    const gain = Math.max(0, Math.trunc(Number(html.find("#dbu-charge-gain").val()) || 0));
    const count = Math.max(0, Math.trunc(Number(html.find("#dbu-charge-count").val()) || 0));
    const cost = Math.max(0, Number(html.find("#dbu-charge-cost").val()) || 0);
    const total = Math.max(0, base+gathered+gain);
    const ki = Math.max(0, Number(actor.system.kiPool?.value || 0));
    const left = Math.max(0, Number(actor.system.status?.maxCapacity || 0)-Number(actor.system.status?.capacitySpent || 0));
    const required = Number(current?.mandatory?.requiredUses ?? activeState?.requiredUses ?? 0);
    const uses = Number(activeState?.maneuverUses ?? 0)+count;
    const formula = sourceKey ? dbuGetProjectedChargeFormula(actor,sourceKey,total) : "Selecione o ataque";
    html.find("[data-dbua-charge-preview-ec]").text(total+"/"+DBU_MAX_ENERGY_CHARGES + (total>DBU_MAX_ENERGY_CHARGES?" · acima do limite":""));
    html.find("[data-dbua-charge-preview-ki]").text(Math.max(0,ki-cost)+(cost>ki?" · Ki insuficiente":""));
    html.find("[data-dbua-charge-preview-cap]").text(Math.max(0,left-cost)+(cost>left?" · Capacity insuficiente":""));
    html.find("[data-dbua-charge-preview-wound]").text(formula);
    html.find("[data-dbua-charge-preview-uses]").text(required?uses+"/"+required:uses+" (sem exigência)");
  };
  html.find("#dbu-charge-source,#dbu-charge-cost,#dbu-charge-gain,#dbu-charge-count,#dbu-charge-type,#dbu-charge-ignore-max")
    .on("input change",refresh);
  refresh();
}

function dbuGetManeuverTypeLabel(type) {
  switch (type) {
    case "instant": return "Instant";
    case "out-of-sequence": return "Out-of-Sequence";
    default: return "Standard";
  }
}

function dbuGetManeuverActionType(type) {
  if (type === "instant") return "instant";
  if (type === "out-of-sequence") return "out-of-sequence";
  return "standard";
}


function dbuChargeTypeField(actor) {
  const allowed = getEnergyChargeAllowedTypes(actor);
  if (allowed.length === 1) return `<input id="dbu-charge-type" type="hidden" value="standard"><p class="notes"><b>Standard — 1 Action.</b> Nenhum efeito ativo deste Actor permite usar Energy Charge como Instant/OoS.</p>`;
  const labels = { standard: "Standard — 1 Action", instant: "Instant", "out-of-sequence": "Out-of-Sequence" };
  return `<label><b>Tipo deste uso</b></label><select id="dbu-charge-type" style="width:100%;">${allowed.map(type => `<option value="${type}">${labels[type]}</option>`).join("")}</select><p class="notes">As exceções listadas foram detectadas nos efeitos atuais do Actor; confirme também o trigger e o custo específico do efeito.</p>`;
}

function dbuBuildStatusCard({
  actor,
  attackName,
  sourceKey,
  baseCharges,
  gatheredCharges,
  totalCharges,
  maneuverUses,
  mandatoryRequiredUses,
  cost,
  maneuverType,
  gainedThisUse,
  countAsUses,
  maxIgnored = false
}) {
  const projected = dbuGetProjectedChargeFormula(actor, sourceKey, totalCharges);
  const mandatoryOk = maneuverUses >= mandatoryRequiredUses;

  const mandatoryText = mandatoryRequiredUses > 0
    ? `<span class="dbu-meta-chip">
        Mandatory ${maneuverUses}/${mandatoryRequiredUses}
        ${mandatoryOk ? "✓" : ""}
      </span>`
    : "";

  return `
    <div class="dbu-attack-roll dbu-energy-charge-card">
      <h3 class="dbu-attack-title">
        <span class="dbu-card-title-text">
          ${dbuEsc(actor.name)} — Energy Charge
        </span>
      </h3>

      <div class="dbu-card-body">
        <div class="dbu-attack-meta">
          <span class="dbu-meta-chip">
            <i class="fas fa-bolt"></i>
            ${dbuEsc(attackName)}
          </span>

          <span class="dbu-meta-chip">
            ${dbuEsc(dbuGetManeuverTypeLabel(maneuverType))}
          </span>

          <span class="dbu-meta-chip">
            Cost ${cost} KP
          </span>

          ${mandatoryText}
        </div>

        <div class="dbu-roll-row">
          <span class="dbu-roll-label">Energy Charges</span>
          <span class="dbu-roll-main">
            Base ${baseCharges}
            + Charge ${gatheredCharges}
            ${maxIgnored ? " · limite 7 ignorado" : ""}
          </span>
          <span class="dbu-roll-total">${totalCharges}</span>
        </div>

        <div class="dbu-roll-row">
          <span class="dbu-roll-label">Wound Extra</span>
          <span class="dbu-roll-main">
            ${totalCharges} EC × Tier
          </span>
          <span class="dbu-roll-total">${dbuEsc(projected)}</span>
        </div>

        <div class="dbu-attack-buffs">
          <span class="dbu-attack-buff">
            +${gainedThisUse} EC neste uso
          </span>

          ${
            countAsUses !== 1
              ? `<span class="dbu-attack-buff">Conta como ${countAsUses} usos para Mandatory Charge</span>`
              : ""
          }

          <span class="dbu-attack-buff">
            Guard Down até liberar/cancelar
          </span>
        </div>
      </div>
    </div>
  `;
}

async function dbuPostChargeCard(data) {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: data.actor }),
    content: dbuBuildStatusCard(data)
  });
}

async function dbuPostCancelCard(actor, state) {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="dbu-attack-roll dbu-energy-charge-card">
        <h3 class="dbu-attack-title">
          <span class="dbu-card-title-text">
            ${dbuEsc(actor.name)} — Cancel Energy Charge
          </span>
        </h3>
        <div class="dbu-card-body">
          <div class="dbu-attack-meta">
            <span class="dbu-meta-chip">
              ${dbuEsc(state.attackName || "Ataque")}
            </span>
          </div>
          <div class="dbu-attack-buffs">
            <strong>
              Energy Charge cancelado. ${Number(state.gatheredCharges || 0)} EC reunido(s) foram perdidos.
            </strong>
          </div>
        </div>
      </div>
    `
  });
}

// ============================================================
// REMOVER GUARD DOWN APLICADO PELO MACRO
// ============================================================

async function dbuRemoveChargeGuardDown(actor, state) {
  if (!state) return;

  // Se Guard Down já existia antes do Charge, não removemos.
  if (state.guardDownWasActiveBefore) return;

  // Power of Movement não deveria ter recebido Guard Down deste macro.
  if (state.powerOfMovement) return;

  const conditions = foundry.utils.deepClone(actor.system.conditions || []);
  dbuSetConditionInArray(conditions, "guardDown", false);

  await actor.update({
    "system.conditions": conditions
  });
}

// ============================================================
// CANCELAR
// ============================================================

async function dbuCancelCharge(actor, token, state) {
  const confirmed = await Dialog.confirm({
    title: "Cancelar Energy Charge?",
    content: `
      <p>
        <b>${dbuEsc(state.attackName || "Ataque")}</b>
      </p>
      <p>
        Você perderá <b>${Number(state.gatheredCharges || 0)} Energy Charge(s)</b> reunidos.
      </p>
      <p>
        Os Ki Points já gastos <b>não são reembolsados</b>.
      </p>
    `,
    yes: () => true,
    no: () => false,
    defaultYes: false
  });

  if (!confirmed) return false;

  await dbuRemoveChargeGuardDown(actor, state);
  await dbuClearChargeVisual(actor, token, state);
  await dbuClearState(actor);
  await dbuPostCancelCard(actor, state);

  ui.notifications.info(
    `${actor.name}: Energy Charge cancelado.`
  );

  return true;
}

// ============================================================
// APLICAR TEMPORARIAMENTE AS CARGAS AO SOURCE
// ============================================================

async function dbuApplyTemporaryCharges(actor, state) {
  const sourceKey = String(state.sourceKey || "");
  const extra = Math.max(0, Number(state.gatheredCharges) || 0);

  if (sourceKey.startsWith("ref_")) {
    const index = Number(sourceKey.slice(4));
    const refs = foundry.utils.deepClone(actor.system.attackRefs || []);

    if (!Number.isInteger(index) || !refs[index]) {
      throw new Error("Attack Reference carregado não foi encontrado.");
    }

    const original = Number(refs[index].energyCharges || 0);
    refs[index].energyCharges = original + extra;

    await actor.update({
      "system.attackRefs": refs
    });

    return {
      type: "ref",
      index,
      original
    };
  }

  if (sourceKey.startsWith("tech_")) {
    const techId = sourceKey.slice(5);
    const techniques = foundry.utils.deepClone(actor.system.signatureTechniques || []);
    const index = techniques.findIndex(t =>
      String(t.id ?? t._id ?? "") === techId
    );

    if (index < 0) {
      throw new Error("Signature Technique carregada não foi encontrada.");
    }

    const original = Number(techniques[index].extraEnergyCharges || 0);
    techniques[index].extraEnergyCharges = original + extra;

    await actor.update({
      "system.signatureTechniques": techniques
    });

    return {
      type: "tech",
      index,
      techId,
      original
    };
  }

  throw new Error("Tipo de ataque carregado não reconhecido.");
}

async function dbuRestoreTemporaryCharges(actor, snapshot) {
  if (!snapshot) return;

  if (snapshot.type === "ref") {
    const refs = foundry.utils.deepClone(actor.system.attackRefs || []);

    if (refs[snapshot.index]) {
      refs[snapshot.index].energyCharges = snapshot.original;
      await actor.update({
        "system.attackRefs": refs
      });
    }

    return;
  }

  if (snapshot.type === "tech") {
    const techniques = foundry.utils.deepClone(actor.system.signatureTechniques || []);
    const index = techniques.findIndex(t =>
      String(t.id ?? t._id ?? "") === String(snapshot.techId)
    );

    if (index >= 0) {
      techniques[index].extraEnergyCharges = snapshot.original;
      await actor.update({
        "system.signatureTechniques": techniques
      });
    }
  }
}

// ============================================================
// LIBERAR ATAQUE
// ============================================================

async function dbuReleaseCharge(actor, token, state) {
  const mandatory = dbuGetMandatoryChargeInfo(actor, state.sourceKey);
  const maneuverUses = Number(state.maneuverUses || 0);

  if (maneuverUses < mandatory.requiredUses) {
    return ui.notifications.warn(
      `${state.attackName}: Mandatory Charge exige ${mandatory.requiredUses} uso(s) do Energy Charge. Atual: ${maneuverUses}.`
    );
  }

  const attackMacro = dbuFindAttackMacro();

  if (!attackMacro) {
    return ui.notifications.error(
      'Macro de ataque não encontrado. Renomeie para "DBU - Ataque" ou adicione o nome em DBU_ATTACK_MACRO_NAMES.'
    );
  }

  const beforeMessageIds = new Set(
    game.messages.contents.map(m => m.id)
  );

  let snapshot = null;

  try {
    snapshot = await dbuApplyTemporaryCharges(actor, state);
    await dbuPrepareSheet(actor);

    globalThis.DBU_CHARGE_RELEASE = {
      actorId: actor.id,
      tokenId: token.id,
      sourceKey: state.sourceKey,
      attackName: state.attackName,
      gatheredCharges: Number(state.gatheredCharges || 0),
      maneuverUses: Number(state.maneuverUses || 0),
      stateId: state.stateId
    };

    ui.notifications.info(
      `${state.attackName}: o Ataque do DBU Automation abrirá travado no ataque declarado para liberar as cargas.`
    );

    await attackMacro.execute({
      actor,
      token,
      attacker: actor,
      attackerToken: token,
      chargeRelease: foundry.utils.deepClone(globalThis.DBU_CHARGE_RELEASE)
    });

    // Dá um instante para a carta customizada do Ataque v11.4 aparecer.
    await dbuSleep(150);

    const newMessages = game.messages.contents
      .filter(m => !beforeMessageIds.has(m.id))
      .slice()
      .reverse();

    const releasedMessage = newMessages.find(message => {
      const attackData = message.getFlag("world", "dbuAttackData");
      return (
        attackData &&
        attackData.attackerId === actor.id &&
        attackData.sourceKey === state.sourceKey
      );
    });

    if (!releasedMessage) {
      ui.notifications.warn(
        `Energy Charge continua ativo. O ataque foi cancelado ou você selecionou um ataque diferente de ${state.attackName}.`
      );
      return false;
    }

    await dbuRemoveChargeGuardDown(actor, state);
    await dbuClearChargeVisual(actor, token, state);
    await dbuClearState(actor);

    ui.notifications.info(
      `${actor.name}: ${state.attackName} liberado com ${state.gatheredCharges} EC de Energy Charge.`
    );

    return true;
  }

  catch (error) {
    console.error("DBU Energy Charge | Release:", error);
    ui.notifications.error(
      error.message || "Erro ao liberar o ataque carregado."
    );
    return false;
  }

  finally {
    try {
      await dbuRestoreTemporaryCharges(actor, snapshot);
      await dbuPrepareSheet(actor);
    } catch (restoreError) {
      console.error(
        "DBU Energy Charge | Erro restaurando EC temporários:",
        restoreError
      );
    }

    delete globalThis.DBU_CHARGE_RELEASE;
  }
}

// ============================================================
// INÍCIO
// ============================================================

const token =
  context?.token
  ?? context?.attackerToken
  ?? canvas.tokens.controlled[0];

if (!token) {
  return ui.notifications.warn(
    "Selecione o token do personagem que vai usar Energy Charge."
  );
}

const actor =
  context?.actor
  ?? context?.attacker
  ?? token.actor;

if (!actor) {
  return ui.notifications.error(
    "Actor não encontrado."
  );
}

if (!game.user.isGM && !actor.isOwner) {
  return ui.notifications.warn(
    `Você não controla ${actor.name}.`
  );
}

let sheet;

try {
  sheet = await dbuPrepareSheet(actor);
} catch (error) {
  return ui.notifications.error(error.message);
}

let state = dbuGetState(actor);

if (state?.active) {
  state = await dbuReconcileState(actor, state);
}

// ============================================================
// CHARGE JÁ ATIVO
// ============================================================

if (state?.active) {
  const prepared = dbuGetSourceFromPrepared(sheet, state.sourceKey);

  if (!prepared) {
    const cancelBroken = await Dialog.confirm({
      title: "Energy Charge inválido",
      content: `
        <p>O ataque declarado <b>${dbuEsc(state.attackName || state.sourceKey)}</b> não existe mais na ficha.</p>
        <p>Deseja limpar o estado de Energy Charge?</p>
      `,
      yes: () => true,
      no: () => false,
      defaultYes: true
    });

    if (cancelBroken) {
      await dbuRemoveChargeGuardDown(actor, state);
      await dbuClearChargeVisual(actor, token, state);
      await dbuClearState(actor);
    }

    return;
  }

  const source = prepared.source;
  const baseCharges = Math.max(0, Number(source.energyCharges || 0));
  const gatheredCharges = Math.max(0, Number(state.gatheredCharges || 0));
  const totalCharges = baseCharges + gatheredCharges;
  state = await dbuSyncChargeVisual(actor, token, state, totalCharges);
  const mandatory = dbuGetMandatoryChargeInfo(actor, state.sourceKey);
  const defaultCost = dbuGetDefaultChargeCost(actor);
  const hasPowerOfMovement = dbuHasTalent(actor, "power_of_movement");


  const decision = await Dialog.wait({
    title: `${actor.name} — Energy Charge v${DBU_CHARGE_VERSION}`,
    content: dbuChargeWindow(actor,{
      attackName:state.attackName,sourceKey:state.sourceKey,baseCharges,gatheredCharges,
      maneuverUses:Number(state.maneuverUses||0),requiredUses:mandatory.requiredUses,
      defaultCost,hasPowerOfMovement,
      extra:`<section class="dbua-aw-extra-fields">
        <h4><i class="fas fa-bolt"></i> CONFIGURAR PRÓXIMO CHARGE</h4>
        <div class="dbua-aw-form-grid">
          <label>Custo deste uso (KP)<input id="dbu-charge-cost" type="number" min="0" step="1" value="${defaultCost}"></label>
          <div class="dbua-aw-type-field">${dbuChargeTypeField(actor)}</div>
          <label>EC ganhos neste uso<input id="dbu-charge-gain" type="number" min="0" step="1" value="1"></label>
          <label>Conta como quantos usos?<input id="dbu-charge-count" type="number" min="0" step="1" value="1"></label>
        </div>
        <label class="dbua-aw-checkbox"><input id="dbu-charge-ignore-max" type="checkbox">
          Ignorar limite normal de 7 EC (somente quando permitido)</label>
        <p class="dbua-aw-help">Wound atual ao liberar: ${dbuEsc(dbuGetProjectedChargeFormula(actor,state.sourceKey,totalCharges))}.
          ${mandatory.requiredUses>0?`Mandatory Charge: ${state.maneuverUses||0}/${mandatory.requiredUses} usos registrados.`:""}</p>
      </section>`
    }),
    render:html=>dbuBindChargeWindowPreview(html,actor,{
      activeState:{sourceKey:state.sourceKey,baseCharges,gatheredCharges,
        maneuverUses:Number(state.maneuverUses||0),requiredUses:mandatory.requiredUses}
    }),
    buttons: {
      charge: {
        icon: '<i class="fas fa-bolt"></i>',
        label: "+ Energy Charge",
        callback: html => ({
          action: "charge",
          cost: Math.max(0, Number(html.find("#dbu-charge-cost").val()) || 0),
          maneuverType: String(html.find("#dbu-charge-type").val() || "standard"),
          gain: Math.max(0, Math.trunc(Number(html.find("#dbu-charge-gain").val()) || 0)),
          countAsUses: Math.max(0, Math.trunc(Number(html.find("#dbu-charge-count").val()) || 0)),
          ignoreMax: !!html.find("#dbu-charge-ignore-max").prop("checked")
        })
      },

      release: {
        icon: '<i class="fas fa-fist-raised"></i>',
        label: "Liberar Ataque",
        callback: () => ({ action: "release" })
      },

      cancelCharge: {
        icon: '<i class="fas fa-times-circle"></i>',
        label: "Cancelar Charge",
        callback: () => ({ action: "cancel" })
      },

      close: {
        icon: '<i class="fas fa-times"></i>',
        label: "Fechar",
        callback: () => null
      }
    },

    default: "charge",
    close: () => null
  }, {...ACTION_WINDOW_DIALOG_OPTIONS, width:790});

  if (!decision) return;

  if (decision.action === "cancel") {
    await dbuCancelCharge(actor, token, state);
    return;
  }

  if (decision.action === "release") {
    await dbuReleaseCharge(actor, token, state);
    return;
  }

  // Novo uso do Energy Charge no ataque já declarado.
  const cost = decision.cost;
  const gain = decision.gain;
  const countAsUses = decision.countAsUses;
  const ignoreMax = decision.ignoreMax;
  const allowedTypes = getEnergyChargeAllowedTypes(actor);
  if (!allowedTypes.includes(decision.maneuverType)) return ui.notifications.warn("Este Actor não possui um efeito 0.9.2 que permita esse tipo de Energy Charge.");
  const actionValidation = validateActionUse(actor, {
    label: "Energy Charge",
    actionCost: decision.maneuverType === "standard" ? 1 : 0,
    effectiveType: decision.maneuverType
  });
  if (!actionValidation.ok) return null;
  const newTotal = totalCharges + gain;

  if (!ignoreMax && newTotal > DBU_MAX_ENERGY_CHARGES) {
    return ui.notifications.warn(
      `${state.attackName}: o máximo normal é ${DBU_MAX_ENERGY_CHARGES} Energy Charges. Atual ${totalCharges}, este uso adicionaria ${gain}.`
    );
  }

  const currentKi = Number(actor.system.kiPool?.value || 0);
  const capacityMax = Number(actor.system.status?.maxCapacity || 0);
  const capacitySpent = Number(actor.system.status?.capacitySpent || 0);
  const capacityLeft = Math.max(0, capacityMax - capacitySpent);

  if (currentKi < cost) {
    return ui.notifications.warn(
      `${actor.name}: Ki insuficiente. Necessário ${cost} KP.`
    );
  }

  if (capacityMax > 0 && capacityLeft < cost) {
    return ui.notifications.warn(
      `${actor.name}: Capacity insuficiente. Restante ${capacityLeft}, necessário ${cost}.`
    );
  }

  const cts = foundry.utils.deepClone(actor.system.combatTabState || {});
  const round = dbuGetCurrentRound(cts);

  round.actions.push({
    type: dbuGetManeuverActionType(decision.maneuverType),
    actionCost: decision.maneuverType === "standard" ? 1 : 0,
    source: "",
    kiCost: cost,
    dkpCost: 0,
    kiWager: 0,
    description: `Energy Charge: ${state.attackName} (+${gain} EC)`,

    // Marcadores nossos para reconciliação caso o row seja apagado.
    dbuEnergyCharge: true,
    dbuChargeStateId: state.stateId,
    dbuChargeSourceKey: state.sourceKey,
    energyChargesGained: gain,
    energyChargeCountsAsUses: countAsUses
  });

  const newState = foundry.utils.deepClone(state);
  newState.gatheredCharges = gatheredCharges + gain;
  newState.maneuverUses = Number(state.maneuverUses || 0) + countAsUses;
  newState.lastUpdatedAt = Date.now();

  const updates = {
    "system.kiPool.value": currentKi - cost,
    "system.status.capacitySpent": capacitySpent + cost,
    "system.combatTabState": cts
  };

  await actor.update(updates);
  await dbuSetState(actor, newState);
  const syncedState = await dbuSyncChargeVisual(
    actor,
    token,
    newState,
    baseCharges + newState.gatheredCharges
  );

  await dbuPostChargeCard({
    actor,
    attackName: syncedState.attackName,
    sourceKey: syncedState.sourceKey,
    baseCharges,
    gatheredCharges: syncedState.gatheredCharges,
    totalCharges: baseCharges + syncedState.gatheredCharges,
    maneuverUses: syncedState.maneuverUses,
    mandatoryRequiredUses: mandatory.requiredUses,
    cost,
    maneuverType: decision.maneuverType,
    gainedThisUse: gain,
    countAsUses,
    maxIgnored: ignoreMax
  });

  ui.notifications.info(
    `${actor.name}: ${state.attackName} agora terá ${baseCharges + newState.gatheredCharges} EC ao ser liberado.`
  );

  return;
}

// ============================================================
// PRIMEIRO USO — DECLARAR ATAQUE
// ============================================================

const sourceGroups = (sheet._trackerSourceGroups || []).filter(group =>
  group.label === "Attack Refs" ||
  group.label === "Sig. Techniques"
);

if (!sourceGroups.length) {
  return ui.notifications.warn(
    "Nenhum Attack Reference ou Signature Technique disponível para Energy Charge."
  );
}

const sources = [];
let optionsHTML = "";

for (const group of sourceGroups) {
  optionsHTML += `<optgroup label="${dbuEsc(group.label)}">`;

  for (const source of (group.sources || [])) {
    const index = sources.length;
    const mandatory = dbuGetMandatoryChargeInfo(actor, source.key);
    const baseCharges = Math.max(0, Number(source.energyCharges || 0));

    sources.push({
      group: group.label,
      source,
      mandatory,
      baseCharges
    });

    const mandatoryLabel = mandatory.requiredUses > 0
      ? ` · Mandatory ${mandatory.requiredUses} usos`
      : "";

    optionsHTML += `
      <option value="${index}">
        ${dbuEsc(source.name)} · EC Base ${baseCharges}${dbuEsc(mandatoryLabel)}
      </option>
    `;
  }

  optionsHTML += "</optgroup>";
}

const defaultCost = dbuGetDefaultChargeCost(actor);
const hasPracticedCharger = dbuHasTalent(actor, "practiced_charger");
const hasPowerOfMovement = dbuHasTalent(actor, "power_of_movement");


const declaration = await Dialog.wait({
  title: `${actor.name} — Energy Charge v${DBU_CHARGE_VERSION}`,
  content:dbuChargeWindow(actor,{
    defaultCost,hasPowerOfMovement,
    attackName:"Selecionar ataque",
    baseCharges:sources[0]?.baseCharges||0,
    sourceKey:sources[0]?.source?.key||"",
    requiredUses:sources[0]?.mandatory?.requiredUses||0,
    extra:`<section class="dbua-aw-extra-fields">
      <h4><i class="fas fa-crosshairs"></i> DECLARAÇÃO DO ATAQUE</h4>
      <p class="dbua-aw-help">Escolha o ataque que receberá Energy Charge. Depois do primeiro uso,
      os seguintes Charge continuam vinculados a esse ataque até liberar ou cancelar.</p>
      <label class="dbua-aw-full">Ataque declarado
        <select id="dbu-charge-source">${optionsHTML}</select></label>
      <div class="dbua-aw-form-grid">
        <label>Custo deste uso (KP)<input id="dbu-charge-cost" type="number" min="0" step="1" value="${defaultCost}"></label>
        <div class="dbua-aw-type-field">${dbuChargeTypeField(actor)}</div>
        <label>EC ganhos neste uso<input id="dbu-charge-gain" type="number" min="0" step="1" value="1"></label>
        <label>Conta como quantos usos?<input id="dbu-charge-count" type="number" min="0" step="1" value="1"></label>
      </div>
      <label class="dbua-aw-checkbox"><input id="dbu-charge-ignore-max" type="checkbox">
        Ignorar limite normal de 7 EC (somente quando permitido)</label>
      <p class="dbua-aw-help">${hasPracticedCharger?"Practiced Charger aplicado: 1(bT) Ki.":"Custo base: 2(bT) Ki."}
      ${hasPowerOfMovement?"Power of Movement: não aplica Guard Down.":"Guard Down permanece até liberar/cancelar."}
      Os visuais existentes continuam selecionados por estágio.</p>
    </section>`
  }),
  render:html=>dbuBindChargeWindowPreview(html,actor,{sources}),
  buttons: {
    charge: {
      icon: '<i class="fas fa-bolt"></i>',
      label: "Usar Energy Charge",
      callback: html => ({
        index: Number(html.find("#dbu-charge-source").val()),
        cost: Math.max(0, Number(html.find("#dbu-charge-cost").val()) || 0),
        maneuverType: String(html.find("#dbu-charge-type").val() || "standard"),
        gain: Math.max(0, Math.trunc(Number(html.find("#dbu-charge-gain").val()) || 0)),
        countAsUses: Math.max(0, Math.trunc(Number(html.find("#dbu-charge-count").val()) || 0)),
        ignoreMax: !!html.find("#dbu-charge-ignore-max").prop("checked")
      })
    },

    cancel: {
      icon: '<i class="fas fa-times"></i>',
      label: "Cancelar",
      callback: () => null
    }
  },

  default: "charge",
  close: () => null
}, {...ACTION_WINDOW_DIALOG_OPTIONS, width:790});

if (!declaration) return;

const selected = sources[declaration.index];

if (!selected) {
  return ui.notifications.error(
    "Ataque declarado não encontrado."
  );
}

const source = selected.source;
const baseCharges = selected.baseCharges;
const gain = declaration.gain;
const countAsUses = declaration.countAsUses;
const cost = declaration.cost;
const totalAfter = baseCharges + gain;
const allowedTypes = getEnergyChargeAllowedTypes(actor);
if (!allowedTypes.includes(declaration.maneuverType)) {
  return ui.notifications.warn("Este Actor não possui um efeito 0.9.2 que permita esse tipo de Energy Charge.");
}
const actionValidation = validateActionUse(actor, {
  label: "Energy Charge",
  actionCost: declaration.maneuverType === "standard" ? 1 : 0,
  effectiveType: declaration.maneuverType
});
if (!actionValidation.ok) return null;

if (!declaration.ignoreMax && totalAfter > DBU_MAX_ENERGY_CHARGES) {
  return ui.notifications.warn(
    `${source.name}: já possui ${baseCharges} EC e este uso adicionaria ${gain}. Máximo normal: ${DBU_MAX_ENERGY_CHARGES}.`
  );
}

const currentKi = Number(actor.system.kiPool?.value || 0);
const capacityMax = Number(actor.system.status?.maxCapacity || 0);
const capacitySpent = Number(actor.system.status?.capacitySpent || 0);
const capacityLeft = Math.max(0, capacityMax - capacitySpent);

if (currentKi < cost) {
  return ui.notifications.warn(
    `${actor.name}: Ki insuficiente. Necessário ${cost} KP.`
  );
}

if (capacityMax > 0 && capacityLeft < cost) {
  return ui.notifications.warn(
    `${actor.name}: Capacity insuficiente. Restante ${capacityLeft}, necessário ${cost}.`
  );
}

const cts = foundry.utils.deepClone(actor.system.combatTabState || {});
const round = dbuGetCurrentRound(cts);
const stateId = `${actor.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const guardDownWasActiveBefore = dbuConditionIsActive(actor, "guardDown");
const powerOfMovement = dbuHasTalent(actor, "power_of_movement");

round.actions.push({
  type: dbuGetManeuverActionType(declaration.maneuverType),
  actionCost: declaration.maneuverType === "standard" ? 1 : 0,
  source: "",
  kiCost: cost,
  dkpCost: 0,
  kiWager: 0,
  description: `Energy Charge: ${source.name} (+${gain} EC)`,

  dbuEnergyCharge: true,
  dbuChargeStateId: stateId,
  dbuChargeSourceKey: source.key,
  energyChargesGained: gain,
  energyChargeCountsAsUses: countAsUses
});

const conditions = foundry.utils.deepClone(actor.system.conditions || []);

if (!powerOfMovement) {
  dbuSetConditionInArray(conditions, "guardDown", true);
}

const newState = {
  version: DBU_CHARGE_VERSION,
  active: true,
  stateId,

  sourceKey: source.key,
  sourceGroup: selected.group,
  attackName: source.name,
  foundation: source.foundation || "",
  profile: source.profile || "",

  gatheredCharges: gain,
  maneuverUses: countAsUses,

  startedRound: round.roundNumber,
  startedAt: Date.now(),
  lastUpdatedAt: Date.now(),

  guardDownWasActiveBefore,
  powerOfMovement,

  visualKind: "none",
  visualValue: "",
  visualStage: "",
  visualTotalCharges: 0
};

await actor.update({
  "system.kiPool.value": currentKi - cost,
  "system.status.capacitySpent": capacitySpent + cost,
  "system.combatTabState": cts,
  "system.conditions": conditions
});

await dbuSetState(actor, newState);
const syncedNewState = await dbuSyncChargeVisual(
  actor,
  token,
  newState,
  totalAfter
);

await dbuPostChargeCard({
  actor,
  attackName: source.name,
  sourceKey: source.key,
  baseCharges,
  gatheredCharges: syncedNewState.gatheredCharges,
  totalCharges: totalAfter,
  maneuverUses: syncedNewState.maneuverUses,
  mandatoryRequiredUses: selected.mandatory.requiredUses,
  cost,
  maneuverType: declaration.maneuverType,
  gainedThisUse: gain,
  countAsUses,
  maxIgnored: declaration.ignoreMax
});

ui.notifications.info(
  `${actor.name}: Energy Charge iniciado em ${source.name}. Total projetado: ${totalAfter} EC.`
);

console.log("==========================================");
console.log(`DBU | Energy Charge v${DBU_CHARGE_VERSION}`);
console.log("Actor:", actor.name);
console.log("Ataque declarado:", source.name, source.key);
console.log("EC base:", baseCharges);
console.log("EC reunidos:", gain);
console.log("Mandatory uses:", `${countAsUses}/${selected.mandatory.requiredUses}`);
console.log("Cost:", cost);
console.log("Guard Down:", !powerOfMovement);
console.log("Charge Visual:", syncedNewState.visualValue || "Nenhum", "stage", syncedNewState.visualStage || "-");
console.log("==========================================");

}
