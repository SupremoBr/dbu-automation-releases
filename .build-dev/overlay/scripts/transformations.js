import { TRANSFORMATION_CONFIG } from "./transformation-config.js";
import { getTransformationVisualSettings } from "./visual-config.js";
import {
  MODULE_ID,
  KI_MULT_ENCOUNTER_FLAG,
  BASE_TOKEN_FLAG,
  LAST_VISUAL_FLAG,
  VISUAL_EFFECT_PREFIX,
  isTransformationVisualSyncSuppressed,
  withTransformationVisualSyncSuppressed,
  waitForTransformationState,
  queueTransformationVisualSync
} from "./transformations/core.js";

// DBU 0.9.2: estes estágios de Metamorphosis não podem se beneficiar de
// New Level of Power (mesma lista usada pela ficha nativa).
const NLOP_BLOCKED_CATALOG_KEYS = new Set([
  "full_suppression",
  "limited_suppression",
  "partial_suppression",
  "true_form"
]);

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getActorFromContext(context = {}) {
  const directActor = context?.actor;
  if (directActor?.documentName === "Actor") return directActor;

  const directToken = context?.token?.document ?? context?.token;
  if (directToken?.actor) return directToken.actor;

  const controlled = canvas?.tokens?.controlled || [];
  if (controlled.length === 1 && controlled[0]?.actor) return controlled[0].actor;
  if (controlled.length > 1) {
    ui.notifications.warn("DBU Transformação: selecione somente um token.");
    return null;
  }

  if (game.user?.character) return game.user.character;

  ui.notifications.warn("DBU Transformação: selecione um token ou vincule um personagem ao usuário.");
  return null;
}

function canControl(actor) {
  return !!actor && (game.user?.isGM || actor.isOwner);
}

function actorConditionActive(actor, id) {
  try {
    if (typeof actor?._isConditionActive === "function") {
      return !!actor._isConditionActive(actor.system, id);
    }
  } catch {}

  return (actor?.system?.conditions || []).some(c => c?.id === id && c?.active);
}

async function prepare(actor) {
  const sheet = actor?.sheet;
  if (!sheet) throw new Error(`Ficha de ${actor?.name || "Actor"} não encontrada.`);

  const data = await sheet.getData();
  const raw = actor.system.transformations || [];
  const preparedAll = Array.isArray(data?.allTransformations) ? data.allTransformations : [];
  const preparedByIndex = new Map();

  for (const entry of preparedAll) {
    if (entry?.isGained) continue;
    const idx = Number(entry?.transIndex);
    if (Number.isInteger(idx) && idx >= 0) preparedByIndex.set(idx, entry);
  }

  const transformations = raw.map((t, index) => ({
    ...foundry.utils.deepClone(t),
    ...(preparedByIndex.get(index) || {}),
    transIndex: index
  }));

  return { sheet, data, transformations };
}

function isManifestedPower(trans) {
  const type = String(
    trans?.transformationType
      ?? trans?.type
      ?? trans?.transformation_type
      ?? ""
  ).trim().toLowerCase().replace(/[\s-]+/g, "_");
  const catalogKey = String(trans?.catalogKey || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const name = String(trans?.name || "").trim();

  return type === "manifested_power"
    || catalogKey === "manifested_power"
    || /^manifested\s+power(?:\b|\s*[:—-])/i.test(name);
}

function tierRequirement(trans) {
  const match = String(trans?.tierRequirement || "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function canEnterByTier(actor, trans) {
  const metamorphosis = new Set([
    "full_suppression",
    "limited_suppression",
    "partial_suppression",
    "true_form"
  ]);
  if (metamorphosis.has(String(trans?.catalogKey || ""))) return true;
  return tierRequirement(trans) <= number(actor?.system?.tier, 1);
}

function aspectLevel(aspects, name, fallback = 1) {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i");
  const entry = (aspects || []).find(a => re.test(String(a).trim()));
  if (!entry) return 0;
  const m = String(entry).match(/\((?:LV|Level)?\s*([0-9]+)\)/i);
  return m ? Math.max(1, Number(m[1]) || fallback) : fallback;
}

function hasAspect(trans, name) {
  const normalized = String(name).toLowerCase();
  return (trans?.aspects || []).some(a => String(a).trim().toLowerCase().startsWith(normalized));
}

function temporaryRounds(trans) {
  const lv = aspectLevel(trans?.aspects || [], "Temporary", 1);
  return lv ? Math.max(1, 6 - Math.min(lv, 5)) : 0;
}

function longTransformationLevel(trans) {
  return aspectLevel(trans?.aspects || [], "Long Transformation", 1);
}

function drainingLevel(trans) {
  return aspectLevel(trans?.aspects || [], "Draining", 1);
}

function getAttrBonusLines(trans) {
  const labels = { ag: "AG", fo: "FO", te: "TE", sc: "SC", in: "IN", ma: "MA", pe: "PE" };
  const bonuses = trans?.attrBonuses || {};
  return Object.entries(labels)
    .map(([key, label]) => {
      const value = String(bonuses?.[key] ?? "").trim();
      return value && value !== "0" ? `${label} ${value}` : null;
    })
    .filter(Boolean);
}

function getTraitEffects(trans) {
  const out = [];
  for (const group of (trans?.structuredTraits || [])) {
    for (const effect of (group?.effects || [])) {
      out.push({
        group: group?.name || "Trait",
        level: group?.level ?? effect?.level ?? "",
        keyword: effect?.keyword || effect?.activationType || "",
        text: effect?.text || ""
      });
    }
  }
  return out;
}

function getCatalogGradeInfo(trans) {
  const catalog = CONFIG.DBU?.transformationsCatalog || {};
  const entry = trans?.catalogKey ? catalog[trans.catalogKey] : null;
  if (!entry?.gradesTable) return null;

  const raw = String(trans?.gradeOrStacks || "1");
  const grade = Math.max(1, parseInt(raw.match(/\d+/)?.[0] || "1", 10));
  const row = entry.gradesTable.find(g => Number(g.grade) === grade) || entry.gradesTable[0];
  return row ? { grade, row, catalog: entry } : null;
}

function formatSpecialRules(actor, trans) {
  const lines = [];
  const tmp = temporaryRounds(trans);
  const drain = drainingLevel(trans);
  const long = longTransformationLevel(trans);
  const grade = getCatalogGradeInfo(trans);

  if (tmp) lines.push(`⏳ Temporary: ${tmp} round${tmp !== 1 ? "s" : ""}`);
  if (drain) {
    const reqTier = Math.max(1, tierRequirement(trans) || number(actor.system.tier, 1));
    lines.push(`🔥 Draining LV${drain}: base ${drain * 3 * reqTier} KP/round (o DBU recalcula o valor efetivo)`);
  }
  if (long) lines.push(`⌛ Long Transformation LV${long}: Transformation Maneuver custa ${1 + long} Actions`);
  if (hasAspect(trans, "Exhausting")) lines.push("😫 Exhausting: efeitos de saída são verificados ao reverter");
  if (hasAspect(trans, "Power High")) lines.push(`⚠ Power High LV${aspectLevel(trans.aspects, "Power High", 1)}`);
  if (hasAspect(trans, "Rampaging")) lines.push(`💢 Rampaging LV${aspectLevel(trans.aspects, "Rampaging", 1)}`);
  if (hasAspect(trans, "Weakening")) lines.push("⬇ Weakening");
  if (hasAspect(trans, "Light Dependent")) lines.push("☀ Light Dependent");
  if (hasAspect(trans, "Strainless")) lines.push("✓ Strainless");
  if (hasAspect(trans, "Natural")) lines.push("✓ Natural");

  if (grade?.row?.lpCost) {
    lines.push(`❤️ Graded G${grade.grade}: LP Cost ${grade.row.lpCost} antes dos Maneuvers exigidos pela Trait`);
  }

  return lines;
}

function transformationTypeLabel(type) {
  return {
    enhancement_power: "Enhancement Power",
    form_alternate: "Alternate Form",
    form_legendary: "Legendary Form",
    transformation: "Transformation"
  }[String(type || "")] || String(type || "Transformation");
}

function notesText(actor) {
  return String(actor?.system?.notes || "");
}

function noteTagMap(actor) {
  let text = notesText(actor);
  try {
    if (/<[a-z][\s\S]*>/i.test(text)) {
      const el = document.createElement("div");
      el.innerHTML = text;
      text = el.innerText || el.textContent || text;
    }
  } catch {}

  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    map[normalizeKey(match[1])] = match[2].trim();
  }
  return map;
}

function parseBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "sim", "on"].includes(s)) return true;
  if (["0", "false", "no", "nao", "não", "off"].includes(s)) return false;
  return fallback;
}

function transformationVisualConfig(actor, trans) {
  const nameKey = normalizeKey(trans?.name || trans?.catalogKey || `TRANS_${trans?.transIndex}`);
  const catalogKey = normalizeKey(trans?.catalogKey || "");
  const tags = noteTagMap(actor);
  const fallback = TRANSFORMATION_CONFIG[trans?.name]
    || TRANSFORMATION_CONFIG[trans?.catalogKey]
    || TRANSFORMATION_CONFIG[nameKey]
    || {};

  const read = (suffix, defaultValue = "") => {
    const keys = [
      `TRANSFORM_${nameKey}_${suffix}`,
      catalogKey ? `TRANSFORM_${catalogKey}_${suffix}` : ""
    ].filter(Boolean);
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(tags, key)) return tags[key];
    }
    return defaultValue;
  };

  const legacy = {
    token: read("TOKEN", fallback.token || ""),
    aura: read("AURA", fallback.aura || ""),
    visualMacro: read("VISUAL", fallback.visualMacro || fallback.visual || ""),
    color: read("COLOR", fallback.color || ""),
    auraScale: number(read("AURA_SCALE", fallback.auraScale ?? fallback.scale ?? 2.5), 2.5),
    opacity: Math.max(0, Math.min(1, number(read("OPACITY", fallback.opacity ?? 0.8), 0.8))),
    tokenScale: number(read("TOKEN_SCALE", fallback.tokenScale ?? 0), 0),
    gridScale: 0,
    width: number(read("WIDTH", fallback.width ?? 0), 0),
    height: number(read("HEIGHT", fallback.height ?? 0), 0),
    belowTokens: parseBool(read("BELOW_TOKENS", fallback.belowTokens ?? false), !!fallback.belowTokens)
  };

  // v1.5: preferências salvas pelo próprio jogador no Actor têm prioridade
  // sobre Notes/transformation-config, sem tocar nas regras mecânicas da Form.
  const custom = getTransformationVisualSettings(actor, trans);
  if (!custom) return legacy;

  if (custom.tokenMode === "custom") {
    legacy.token = custom.token || "";
    if (custom.tokenScale > 0) legacy.tokenScale = custom.tokenScale;
  } else if (custom.tokenMode === "none") {
    legacy.token = "";
    legacy.tokenScale = 0;
    legacy.gridScale = 0;
    legacy.width = 0;
    legacy.height = 0;
  }

  // O tamanho no grid pode ser personalizado mesmo mantendo a imagem herdada.
  if (custom.tokenMode !== "none" && custom.gridScale > 0) {
    legacy.gridScale = custom.gridScale;
  }

  if (custom.visualMode === "custom") {
    legacy.visualMacro = custom.visualMacro || "";
  } else if (custom.visualMode === "none") {
    legacy.visualMacro = "";
  }

  return legacy;
}

function activeOwnTransformations(actor) {
  return (actor?.system?.transformations || [])
    .map((t, index) => ({ ...t, transIndex: index }))
    .filter(t => t?.active && !isManifestedPower(t));
}

async function cacheBaseToken(actor) {
  const existing = actor.getFlag(MODULE_ID, BASE_TOKEN_FLAG);
  if (existing) return existing;

  const proto = actor.prototypeToken;
  const snapshot = {
    src: proto?.texture?.src || actor.img || "",
    scaleX: number(proto?.texture?.scaleX, 1),
    scaleY: number(proto?.texture?.scaleY, 1),
    width: number(proto?.width, 1),
    height: number(proto?.height, 1)
  };
  await actor.setFlag(MODULE_ID, BASE_TOKEN_FLAG, snapshot);
  return snapshot;
}

async function endTransformationEffects(actor) {
  if (!globalThis.Sequencer?.EffectManager) return;
  for (const token of actor.getActiveTokens?.() || []) {
    try {
      await Sequencer.EffectManager.endEffects({
        name: `${VISUAL_EFFECT_PREFIX}-${actor.id}-${token.id}`,
        object: token
      });
    } catch {}
  }
}

async function restoreBaseToken(actor) {
  const base = actor.getFlag(MODULE_ID, BASE_TOKEN_FLAG);
  if (!base) return;

  const actorUpdate = {};
  if (base.src) actorUpdate["prototypeToken.texture.src"] = base.src;
  if (base.scaleX) actorUpdate["prototypeToken.texture.scaleX"] = base.scaleX;
  if (base.scaleY) actorUpdate["prototypeToken.texture.scaleY"] = base.scaleY;
  if (base.width) actorUpdate["prototypeToken.width"] = base.width;
  if (base.height) actorUpdate["prototypeToken.height"] = base.height;
  if (Object.keys(actorUpdate).length) await actor.update(actorUpdate);

  for (const token of actor.getActiveTokens?.() || []) {
    const updates = {};
    if (base.src) updates["texture.src"] = base.src;
    if (base.scaleX) updates["texture.scaleX"] = base.scaleX;
    if (base.scaleY) updates["texture.scaleY"] = base.scaleY;
    if (base.width) updates.width = base.width;
    if (base.height) updates.height = base.height;
    if (Object.keys(updates).length) await token.document.update(updates);
  }
}

async function applyVisualMacro(actor, trans, phase, config) {
  const macroName = String(config?.visualMacro || "").trim();
  if (!macroName) return;
  const macro = game.macros.getName(macroName);
  if (!macro) {
    console.warn(`DBU Automation | Macro visual de transformação não encontrada: ${macroName}`);
    return;
  }
  const tokens = actor.getActiveTokens?.() || [];
  for (const token of tokens.length ? tokens : [null]) {
    try {
      await macro.execute({
        actor,
        token,
        transformation: trans,
        transformationData: trans,
        phase,
        active: phase === "activate"
      });
    } catch (error) {
      console.warn("DBU Automation | Visual macro transformação:", error);
    }
  }
}

async function applyTransformationVisual(actor, trans) {
  if (!actor || !trans) return;
  const config = transformationVisualConfig(actor, trans);
  const hasVisual = !!(config.token || config.aura || config.visualMacro || config.width || config.height || config.gridScale > 0 || config.tokenScale > 0);
  if (!hasVisual) return;

  const base = await cacheBaseToken(actor);
  await endTransformationEffects(actor);

  const previous = actor.getFlag(MODULE_ID, LAST_VISUAL_FLAG);
  if (previous?.visualMacro && previous?.name !== trans.name) {
    await applyVisualMacro(actor, previous, "deactivate", previous);
  }

  const gridScale = Math.max(0, number(config.gridScale, 0));
  const finalWidth = config.width > 0
    ? config.width
    : (gridScale > 0 ? Math.max(0.5, number(base?.width, 1) * gridScale) : null);
  const finalHeight = config.height > 0
    ? config.height
    : (gridScale > 0 ? Math.max(0.5, number(base?.height, 1) * gridScale) : null);

  const protoUpdate = {};
  if (config.token) protoUpdate["prototypeToken.texture.src"] = config.token;
  if (config.tokenScale > 0) {
    protoUpdate["prototypeToken.texture.scaleX"] = config.tokenScale;
    protoUpdate["prototypeToken.texture.scaleY"] = config.tokenScale;
  } else if (gridScale > 0 && base) {
    // Grid scale deve alterar footprint, não a escala interna da textura.
    protoUpdate["prototypeToken.texture.scaleX"] = number(base.scaleX, 1);
    protoUpdate["prototypeToken.texture.scaleY"] = number(base.scaleY, 1);
  }
  if (finalWidth != null) protoUpdate["prototypeToken.width"] = finalWidth;
  if (finalHeight != null) protoUpdate["prototypeToken.height"] = finalHeight;
  if (Object.keys(protoUpdate).length) await actor.update(protoUpdate);

  for (const token of actor.getActiveTokens?.() || []) {
    const tokenUpdate = {};
    if (config.token) tokenUpdate["texture.src"] = config.token;
    if (config.tokenScale > 0) {
      tokenUpdate["texture.scaleX"] = config.tokenScale;
      tokenUpdate["texture.scaleY"] = config.tokenScale;
    } else if (gridScale > 0 && base) {
      tokenUpdate["texture.scaleX"] = number(base.scaleX, 1);
      tokenUpdate["texture.scaleY"] = number(base.scaleY, 1);
    }
    if (finalWidth != null) tokenUpdate.width = finalWidth;
    if (finalHeight != null) tokenUpdate.height = finalHeight;
    if (Object.keys(tokenUpdate).length) await token.document.update(tokenUpdate);

    if (config.aura && globalThis.Sequence) {
      try {
        let effect = new Sequence()
          .effect()
          .file(config.aura)
          .attachTo(token)
          .scaleToObject(config.auraScale)
          .opacity(config.opacity)
          .persist()
          .name(`${VISUAL_EFFECT_PREFIX}-${actor.id}-${token.id}`);
        if (config.color) effect = effect.tint(config.color);
        if (config.belowTokens) effect = effect.belowTokens();
        await effect.play();
      } catch (error) {
        console.warn("DBU Automation | Aura visual de transformação:", error);
      }
    }
  }

  await applyVisualMacro(actor, trans, "activate", config);
  await actor.setFlag(MODULE_ID, LAST_VISUAL_FLAG, {
    id: trans.id ?? trans.transIndex,
    name: trans.name || "Transformation",
    visualMacro: config.visualMacro || "",
    ...config
  });
}

async function syncTransformationVisual(actor, preferredId = null) {
  if (!actor) return;
  const active = activeOwnTransformations(actor);
  if (!active.length) {
    const previous = actor.getFlag(MODULE_ID, LAST_VISUAL_FLAG);
    if (previous?.visualMacro) await applyVisualMacro(actor, previous, "deactivate", previous);
    await endTransformationEffects(actor);
    await restoreBaseToken(actor);
    await actor.unsetFlag(MODULE_ID, LAST_VISUAL_FLAG).catch(() => {});
    return;
  }

  const hasVisual = t => {
    const c = transformationVisualConfig(actor, t);
    return !!(c.token || c.aura || c.visualMacro || c.width || c.height || c.gridScale > 0 || c.tokenScale > 0);
  };

  let selected = null;
  if (preferredId != null) {
    selected = active.find(t => String(t.id ?? t.transIndex) === String(preferredId));
  }
  if (!selected || !hasVisual(selected)) {
    selected = [...active].reverse().find(hasVisual) || null;
  }

  if (!selected) {
    const previous = actor.getFlag(MODULE_ID, LAST_VISUAL_FLAG);
    if (previous?.visualMacro) await applyVisualMacro(actor, previous, "deactivate", previous);
    await endTransformationEffects(actor);
    await restoreBaseToken(actor);
    await actor.unsetFlag(MODULE_ID, LAST_VISUAL_FLAG).catch(() => {});
    return;
  }

  await applyTransformationVisual(actor, selected);
}

function getCurrentRound(actor) {
  const cts = foundry.utils.deepClone(actor.system.combatTabState || {});
  cts.rounds ??= [];
  if (!cts.rounds.length) cts.rounds.push({ roundNumber: 1, actions: [] });
  const round = cts.rounds[cts.rounds.length - 1];
  round.actions ??= [];
  round.roundNumber ??= cts.rounds.length;
  cts.currentRound = round.roundNumber;
  return { cts, round };
}

async function registerTransformAction(actor, transIndex, options = {}) {
  const { cts, round } = getCurrentRound(actor);
  const trans = actor.system.transformations?.[transIndex];
  const longLv = longTransformationLevel(trans);
  const actionCost = 1 + longLv;

  round.actions.push({
    type: "transform",
    source: "",
    kiCost: 0,
    kiWager: 0,
    description: `Transform: ${trans?.name || `Transformation ${transIndex + 1}`}${longLv ? ` [${actionCost} Actions]` : ""}`,
    transformIndex: transIndex,
    transformSameLine: !!options.sameLine,
    transformSkipTest: !!options.skipTest,
    transformReplace: options.replace !== false,
    dbuAutomation: true,
    actionCost
  });

  const actionIndex = round.actions.length - 1;
  await actor.update({ "system.combatTabState": cts });
  return { roundNum: round.roundNumber, actionIndex };
}

function encounterKey() {
  return game.combat?.id || null;
}

function transformationEntryId(trans, index) {
  return String(trans?.id ?? index);
}

function isNewLevelOfPowerEligible(trans) {
  if (!trans?.name) return false;
  return !NLOP_BLOCKED_CATALOG_KEYS.has(String(trans?.catalogKey || ""));
}

function isAlternateOrLegendary(trans) {
  const type = String(trans?.transformationType || "");
  return type === "form_alternate" || type === "form_legendary";
}

function legendRealizedEligible(trans) {
  return !!trans?.name && isAlternateOrLegendary(trans) && String(trans?.catalogKey || "") !== "full_suppression";
}

// DBU 0.9.2: Variant Transformations count as their listed Transformation
// specifically for Legend Realized.
function legendRealizedKey(trans) {
  const aspects = Array.isArray(trans?.aspects) ? trans.aspects : [];
  for (const aspect of aspects) {
    const match = String(aspect || "").match(/^\s*Variant\s*\(\s*(.*?)\s*\)\s*$/i);
    if (match?.[1]) return match[1].trim().toLowerCase();
  }
  return String(trans?.name || "").trim().toLowerCase();
}

function legendRealizedGroupNames(actor, trans) {
  const key = legendRealizedKey(trans);
  if (!key) return [String(trans?.name || "")].filter(Boolean);
  const names = (actor?.system?.transformations || [])
    .filter(candidate => legendRealizedEligible(candidate) && legendRealizedKey(candidate) === key)
    .map(candidate => String(candidate.name || ""))
    .filter(Boolean);
  if (trans?.name && !names.includes(String(trans.name))) names.push(String(trans.name));
  return [...new Set(names)];
}

function newLevelOfPowerState(actor, trans, index) {
  const meta = actor?.system?.transformationMeta || {};
  const name = String(trans?.name || "");
  const activeEncounter = !!name && (meta.nlopActiveEncounter || []).includes(name);
  return {
    eligible: isNewLevelOfPowerEligible(trans),
    // 0.9.2: newLevelOfPowerUsed é persistente (primeira vez ever).
    usedEver: !!name && (meta.newLevelOfPowerUsed || []).includes(name),
    // 0.9.2: somente nlopActiveEncounter autoriza a reentrada sem Stress Test.
    activeEncounter,
    enteredThisEncounter: activeEncounter
  };
}

function legendRealizedState(actor, trans) {
  const groupNames = legendRealizedGroupNames(actor, trans);
  const usedNames = actor?.system?.transformationMeta?.legendRealizedUsed || [];
  const used = groupNames.some(name => usedNames.includes(name));
  return {
    eligible: legendRealizedEligible(trans),
    used,
    groupNames,
    key: legendRealizedKey(trans),
    inCombat: !!encounterKey(),
    available: legendRealizedEligible(trans) && !!encounterKey() && !used
  };
}

async function setNewLevelOfPowerUsed(actor, trans, used) {
  if (!actor || !trans?.name || !isNewLevelOfPowerEligible(trans)) return false;
  const name = String(trans.name);
  const meta = actor.system.transformationMeta || {};
  const current = Array.isArray(meta.newLevelOfPowerUsed) ? [...meta.newLevelOfPowerUsed] : [];
  const without = current.filter(entry => String(entry) !== name);
  const next = used ? [...without, name] : without;
  await actor.update({ "system.transformationMeta.newLevelOfPowerUsed": next });
  return true;
}

async function setLegendRealizedUsed(actor, trans, used) {
  if (!actor || !trans?.name || !legendRealizedEligible(trans)) return false;
  const groupNames = legendRealizedGroupNames(actor, trans);
  const group = new Set(groupNames.map(String));
  const current = Array.isArray(actor.system.transformationMeta?.legendRealizedUsed)
    ? [...actor.system.transformationMeta.legendRealizedUsed]
    : [];
  const without = current.filter(entry => !group.has(String(entry)));
  const next = used ? [...without, ...groupNames] : without;
  await actor.update({ "system.transformationMeta.legendRealizedUsed": [...new Set(next)] });
  return true;
}

function kiMultiplierTypeKey(trans) {
  const type = String(trans?.transformationType || "");
  return type === "form_alternate" || type === "form_legendary" ? type : null;
}

function kiMultiplierEntryState(actor, trans) {
  const type = kiMultiplierTypeKey(trans);
  const combatId = encounterKey();
  const eligible = !!type && String(trans?.catalogKey || "") !== "full_suppression" && !!combatId;
  const data = actor?.getFlag?.(MODULE_ID, KI_MULT_ENCOUNTER_FLAG) || {};
  const used = !!(eligible && data.combatId === combatId && data.types?.[type]);
  return { eligible, type, used, available: eligible && !used };
}

async function markKiMultiplierEntry(actor, trans) {
  const state = kiMultiplierEntryState(actor, trans);
  if (!state.eligible) return false;
  const combatId = encounterKey();
  const current = actor.getFlag(MODULE_ID, KI_MULT_ENCOUNTER_FLAG) || {};
  const next = current.combatId === combatId
    ? foundry.utils.deepClone(current)
    : { combatId, types: {} };
  next.types ??= {};
  next.types[state.type] = true;
  await actor.setFlag(MODULE_ID, KI_MULT_ENCOUNTER_FLAG, next);
  return true;
}

async function applyKiMultiplierEntryRecovery(actor, trans, { prepared = false } = {}) {
  const state = kiMultiplierEntryState(actor, trans);
  if (!state.eligible) return false;
  if (!prepared) await actor.sheet?.getData?.();

  // O sistema 0.9.2 prepara o valor base especificamente para esta regra.
  const amount = Math.max(0, number(actor.system.transformationRules?.baseCapacityRestore, 0));
  const before = number(actor.system.kiPool?.value, 0);
  const max = number(actor.system.kiPool?.max, before);
  const after = Math.min(max, before + amount);
  await actor.update({ "system.kiPool.value": after });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll dbu-transform-card" data-actor-id="${esc(actor.id)}">
      <h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-bolt"></i> Ki Multiplier — ${esc(trans.name)}</span></h3>
      <div class="dbu-card-body">
        <div class="dbu-attack-meta"><span class="dbu-meta-chip">DBU 0.9.2</span><span class="dbu-meta-chip">${state.type === "form_alternate" ? "Alternate Form" : "Legendary Form"}</span></div>
        <div class="dbu-defend-guide">Primeira entrada deste tipo de Form no Combat Encounter: recupera Ki igual à <b>base Max Capacity</b>.<br>Ki: <b>${before} → ${after}</b> (+${Math.max(0, after - before)}; base ${amount}).</div>
      </div>
    </div>`
  });
  return true;
}

async function applyLegendRealized(actor, trans) {
  if (!legendRealizedEligible(trans) || !encounterKey()) return false;
  await actor.sheet?.getData?.();

  const current = actor.system.transformations?.[trans.transIndex] || trans;
  if (!current?.active) return false;
  const state = legendRealizedState(actor, current);
  if (state.used) {
    ui.notifications.warn(`${current.name}: Legend Realized já foi utilizado nesta Transformation neste Combat Encounter.`);
    return false;
  }

  const sheet = actor.sheet;
  const tier = number(actor.system.tier, 1);
  const baseTier = number(actor.system.baseTier, 1);
  const pl = number(actor.system.level, 1);
  const roll = new Roll(`${2 * tier}d10 + ${pl}`);
  await roll.evaluate();

  let extra = { rollBonus: 0, lpBonus: 0, kpBonus: 0, lpMultiplier: 1, kpMultiplier: 1, allowOverMaxKP: false, bonusLines: [] };
  if (typeof sheet?._applyLegendRealizedBonuses === "function") {
    extra = await sheet._applyLegendRealizedBonuses(current, tier, baseTier, roll.total) || extra;
  }

  const effectiveRollTotal = roll.total + number(extra.rollBonus, 0);
  const lpRestored = (effectiveRollTotal + number(extra.lpBonus, 0)) * (number(extra.lpMultiplier, 1) || 1);
  const kpRestored = (effectiveRollTotal + number(extra.kpBonus, 0)) * (number(extra.kpMultiplier, 1) || 1);
  const maxLP = number(actor.system.lifePoints?.max, 100);
  const maxKP = number(actor.system.kiPool?.max, 100);
  const oldLP = number(actor.system.lifePoints?.value, 0);
  const oldKP = number(actor.system.kiPool?.value, 0);
  const newLP = Math.min(maxLP, oldLP + lpRestored);
  const uncappedKP = oldKP + kpRestored;
  const newKP = extra.allowOverMaxKP ? uncappedKP : Math.min(maxKP, uncappedKP);
  const groupNames = legendRealizedGroupNames(actor, current);
  const group = new Set(groupNames.map(String));
  const used = [...(actor.system.transformationMeta?.legendRealizedUsed || [])]
    .filter(name => !group.has(String(name)));
  used.push(...groupNames);

  await actor.update({
    "system.lifePoints.value": newLP,
    "system.kiPool.value": newKP,
    "system.transformationMeta.legendRealizedUsed": [...new Set(used)]
  });

  const bonusLines = Array.isArray(extra.bonusLines) ? extra.bonusLines : [];
  const bonusHtml = bonusLines.length ? `<br>${bonusLines.join("<br>")}` : "";
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `<div class="dbu-auto-roll-flavor"><b><i class="fas fa-star"></i> Legend Realized! (${esc(current.name)})</b><br>Roll: ${2 * tier}d10 + ${pl} PL = <b>${roll.total}</b>${extra.rollBonus ? ` + ${extra.rollBonus} bônus` : ""}<br>Restored <b>${lpRestored}</b> LP and <b>${kpRestored}</b> KP${bonusHtml}</div>`
  });
  return true;
}

async function ensureTemporaryCountdown(actor, trans, index) {
  const rounds = temporaryRounds(trans);
  if (!rounds) return;

  const id = transformationEntryId(trans, index);
  const countdowns = foundry.utils.deepClone(actor.system.transformationMeta?.temporaryCountdowns || {});
  if (number(countdowns[id], 0) > 0) return;

  countdowns[id] = rounds;
  await actor.update({ "system.transformationMeta.temporaryCountdowns": countdowns });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll dbu-draining-card" data-actor-id="${esc(actor.id)}">
      <h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-hourglass-half"></i> Temporary — ${esc(trans.name || "Transformation")}</span></h3>
      <div class="dbu-card-body"><div class="dbu-defend-guide">Limite iniciado: <b>${rounds} rounds</b>. O DBU Automation encerrará junto do controle de novo Round do sistema.</div></div>
    </div>`
  });
}

function activeGradedCosts(actor) {
  return (actor.system.aspectEffects?.gradedTransformations || []).filter(g => number(g?.lpCostNum, 0) > 0);
}

async function payTransformationLp(actor, catalogKey) {
  const graded = activeGradedCosts(actor).find(g => String(g.catalogKey) === String(catalogKey));
  if (!graded) {
    ui.notifications.warn("DBU Transformação: custo LP não está ativo/preparado.");
    return false;
  }

  const current = number(actor.system.lifePoints?.value, 0);
  const cost = number(graded.lpCostNum, 0);
  const next = current - cost;
  await actor.update({ "system.lifePoints.value": next });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll dbu-draining-card" data-actor-id="${esc(actor.id)}">
      <h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-heart-broken"></i> ${esc(graded.name || "Transformation")} — LP Cost</span></h3>
      <div class="dbu-card-body">
        <div class="dbu-attack-meta"><span class="dbu-meta-chip">Grade ${esc(graded.grade)}</span><span class="dbu-meta-chip">${esc(graded.lpCostFormula || "LP Cost")}</span></div>
        <div class="dbu-defend-guide">LP: <b>${current} → ${next}</b> (−${cost})</div>
      </div>
    </div>`
  });
  return true;
}

async function postTransformationSummary(actor, trans) {
  await actor.sheet?.getData?.();
  const aspectEffects = actor.system.aspectEffects || {};
  const graded = activeGradedCosts(actor).filter(g => String(g.catalogKey) === String(trans.catalogKey));
  const chips = [];
  if (aspectEffects.drainingKiPerTurn > 0) chips.push(`<span class="dbu-meta-chip dbu-chip-hot">Draining ${aspectEffects.drainingKiPerTurn} KP/round</span>`);
  const tmpId = transformationEntryId(trans, trans.transIndex);
  const tmpLeft = actor.system.transformationMeta?.temporaryCountdowns?.[tmpId];
  if (tmpLeft) chips.push(`<span class="dbu-meta-chip">Temporary ${tmpLeft} rounds</span>`);
  const longLv = longTransformationLevel(trans);
  if (longLv) chips.push(`<span class="dbu-meta-chip">${1 + longLv} Actions para Transform</span>`);
  if (hasAspect(trans, "Exhausting")) chips.push(`<span class="dbu-meta-chip">Exhausting</span>`);

  const gradedHtml = graded.map(g => `
    <div class="dbu-defend-guide" style="margin-top:6px;">
      <b>Graded G${esc(g.grade)} — LP Cost ${esc(g.lpCostFormula)}</b><br>
      Pague <b>${esc(g.lpCostNum)} LP</b> quando a Trait exigir antes de um Maneuver qualificável.
      <div class="dbu-attack-actions" style="margin-top:5px;">
        <button type="button" class="dbu-pay-btn" data-dbu-transform-pay-lp data-actor-id="${esc(actor.id)}" data-catalog-key="${esc(g.catalogKey)}">
          <i class="fas fa-heart-broken"></i> Pay ${esc(g.lpCostNum)} LP
        </button>
      </div>
    </div>`).join("");

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll dbu-defend-card dbu-transform-card" data-actor-id="${esc(actor.id)}">
      <h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-dragon"></i> ${esc(actor.name)} — ${esc(trans.name || "Transformation")}</span></h3>
      <div class="dbu-card-body">
        <div class="dbu-attack-meta">${chips.join("")}</div>
        <div class="dbu-attack-buffs"><strong>✅ TRANSFORMAÇÃO ATIVA</strong></div>
        ${gradedHtml}
      </div>
    </div>`
  });
}

async function activateTransformation(actor, transIndex, options = {}) {
  const { sheet, transformations } = await prepare(actor);
  const trans = transformations[transIndex];
  if (!trans) throw new Error("Transformação não encontrada.");
  if (trans.active) {
    ui.notifications.info(`${trans.name}: já está ativa.`);
    return true;
  }
  if (isManifestedPower(trans)) {
    ui.notifications.warn("Manifested Power não é ativado por este gerenciador de Transformation.");
    return false;
  }
  if (!canEnterByTier(actor, trans)) {
    ui.notifications.warn(`${trans.name}: Tier of Power insuficiente para esta Transformation.`);
    return false;
  }
  if (actorConditionActive(actor, "stressExhaustion")) {
    ui.notifications.warn(`${actor.name}: Stress Exhaustion impede usar o Transformation Maneuver.`);
    return false;
  }

  if (!options?.__dbuaActionValidated) {
    const validation = validateActionUse(actor, {
      label: "Transformation",
      actionCost: 1 + longTransformationLevel(trans),
      effectiveType: options?.effectiveType || "standard"
    });
    if (!validation.ok) return false;
  } else if ((options?.effectiveType || "standard") === "standard") {
    const validation = validateActionUse(actor, {
      label: "Transformation",
      actionCost: 1 + longTransformationLevel(trans),
      effectiveType: "standard"
    });
    if (!validation.ok) return false;
  }

  await cacheBaseToken(actor);

  // DBU 0.9.2: reentrada sem Stress Test vem SOMENTE de New Level of Power
  // ativo neste encounter, não de um rastreio genérico de "já entrei".
  const nlopBefore = newLevelOfPowerState(actor, trans, transIndex);
  const autoSkip = !!nlopBefore.activeEncounter;
  const skipTest = isNewLevelOfPowerEligible(trans) ? (options.skipTest ?? autoSkip) : false;
  if (!isNewLevelOfPowerEligible(trans) && options.skipTest) {
    ui.notifications.warn(`${trans.name}: New Level of Power não se aplica a esta Transformation; o Stress Test não será ignorado.`);
  }

  const lrBefore = legendRealizedState(actor, trans);
  const kiBefore = kiMultiplierEntryState(actor, trans);

  const tracker = await registerTransformAction(actor, transIndex, {
    sameLine: !!options.sameLine,
    replace: options.replace !== false,
    skipTest
  });

  if (typeof sheet._onRollTrackerTransform !== "function") {
    throw new Error("DBU 0.9.2: _onRollTrackerTransform não encontrada.");
  }

  await withTransformationVisualSyncSuppressed(actor, async () => {
    await sheet._onRollTrackerTransform({
      preventDefault() {},
      currentTarget: {
        dataset: {
          round: String(tracker.roundNum),
          actionIndex: String(tracker.actionIndex)
        }
      }
    });

    if (!actor.system.transformations?.[transIndex]?.active) {
      await waitForTransformationState(actor, transIndex, true);
    }
  });

  // Um único refresh após a alteração nativa basta para recalcular os dados
  // derivados da Form (Ki Multiplier, Max Ki/Capacity etc.).
  await actor.sheet?.getData?.();

  const fresh = actor.system.transformations?.[transIndex];
  if (!fresh?.active) {
    ui.notifications.warn(`${trans.name}: Transformation falhou ou não foi ativada.`);
    return false;
  }

  const activePrepared = { ...trans, ...fresh, transIndex };

  // New Level of Power permanece separado e usa os campos nativos do DBU
  // (newLevelOfPowerUsed / nlopActiveEncounter). O DBU Automation NÃO ativa
  // NLoP automaticamente: o jogador/GM pode usar o botão nativo ou corrigir
  // o checkbox persistente no gerenciador.
  // O refresh acima já recalculou os dados derivados da Form.

  // Ki Multiplier 0.9.2: primeira entrada em Alternate Form / Legendary Form
  // no encounter recupera base Max Capacity em Ki. A caixa permite desativar
  // a aplicação automática; mesmo desativada, a primeira entrada é consumida.
  if (kiBefore.eligible && !kiBefore.used) {
    if (options.applyKiMultiplier !== false) {
      await applyKiMultiplierEntryRecovery(actor, activePrepared, { prepared: true });
    }
    await markKiMultiplierEntry(actor, activePrepared);
  } else if (kiBefore.eligible && options.applyKiMultiplier === true && kiBefore.used) {
    // Override manual explícito: útil para corrigir rastreio ou efeitos especiais.
    await applyKiMultiplierEntryRecovery(actor, activePrepared, { prepared: true });
  }

  // Legend Realized é separado de Ki Multiplier e de New Level of Power.
  // 1/Transformation/Combat Encounter; 2d10(T)+PL, restaura LP e KP.
  if (options.applyLegendRealized === true && legendRealizedEligible(activePrepared)) {
    await applyLegendRealized(actor, activePrepared);
  } else if (lrBefore.available && options.applyLegendRealized !== true) {
    ui.notifications.info(`${activePrepared.name}: Legend Realized disponível, mas desativado para esta entrada.`);
  }

  await ensureTemporaryCountdown(actor, activePrepared, transIndex);
  await syncTransformationVisual(actor, transformationEntryId(activePrepared, transIndex));
  await postTransformationSummary(actor, activePrepared);
  return true;
}

async function nativeDeactivate(actor, transIndex, { syncVisual = true } = {}) {
  const sheet = actor.sheet;
  const trans = actor.system.transformations?.[transIndex];
  if (!trans?.active) return false;

  if (actorConditionActive(actor, "compelled") && number(actor.system.aspectEffects?.rampagingLevel, 0) > 0) {
    ui.notifications.warn(`${actor.name}: Rampaging/Compelled impede Voluntary Revert neste momento.`);
    return false;
  }

  await withTransformationVisualSyncSuppressed(actor, async () => {
    if (typeof sheet?._onTransformationCheckChange === "function") {
      await sheet._onTransformationCheckChange({
        currentTarget: {
          dataset: { transIndex: String(transIndex), field: "active" },
          checked: false,
          closest() { return null; }
        }
      });
    } else {
      const arr = foundry.utils.deepClone(actor.system.transformations || []);
      arr[transIndex].active = false;
      await actor.update({ "system.transformations": arr });
      await sheet?._syncPersistentTransformationCombatStates?.(arr);
      await sheet?._syncPersistentTransformationResources?.(arr);
      await sheet?._syncPersistentTransformationFlags?.(arr);
    }

    if (actor.system.transformations?.[transIndex]?.active) {
      await waitForTransformationState(actor, transIndex, false);
    }
  });

  const id = transformationEntryId(trans, transIndex);
  const countdowns = foundry.utils.deepClone(actor.system.transformationMeta?.temporaryCountdowns || {});
  if (Object.prototype.hasOwnProperty.call(countdowns, id)) {
    delete countdowns[id];
    await actor.update({ "system.transformationMeta.temporaryCountdowns": countdowns });
  }

  if (syncVisual) await syncTransformationVisual(actor);
  return true;
}

async function revertAll(actor) {
  const active = activeOwnTransformations(actor);
  if (!active.length) {
    ui.notifications.info(`${actor.name}: nenhuma Transformation ativa.`);
    return true;
  }

  for (const trans of [...active].reverse()) {
    const ok = await nativeDeactivate(actor, trans.transIndex, { syncVisual: false });
    if (!ok) return false;
  }
  // Revert All pode desligar várias Forms; sincroniza token/visual somente uma vez.
  await syncTransformationVisual(actor);
  return true;
}

function detailHtml(actor, trans, sheet, action = {}) {
  if (!trans) return `<div class="dbu-defend-guide">Selecione uma Transformation.</div>`;

  let calc = null;
  try {
    if (!trans.active && typeof sheet?._computeTransformManeuver === "function") {
      calc = sheet._computeTransformManeuver(trans.transIndex, action);
    }
  } catch (error) {
    console.warn("DBU Automation | compute transformation:", error);
  }

  const attrs = getAttrBonusLines(trans);
  const aspects = trans.aspects || [];
  const traits = getTraitEffects(trans);
  const specials = formatSpecialRules(actor, trans);
  const blocked = !trans.active && !canEnterByTier(actor, trans);

  return `
    <div style="border:1px solid rgba(0,0,0,.25);padding:8px;border-radius:5px;margin-top:8px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
        <span class="dbu-meta-chip">${esc(transformationTypeLabel(trans.transformationType))}</span>
        <span class="dbu-meta-chip">Tier Req ${esc(trans.tierRequirement || "—")}</span>
        <span class="dbu-meta-chip">Stress ${esc(trans.stressTest ?? 0)}</span>
        ${trans.mastered ? `<span class="dbu-meta-chip">Mastered</span>` : ""}
        ${trans.gradeOrStacks ? `<span class="dbu-meta-chip">Grade/Stacks ${esc(trans.gradeOrStacks)}</span>` : ""}
        ${trans.active ? `<span class="dbu-meta-chip">✅ ATIVA</span>` : ""}
        ${blocked ? `<span class="dbu-meta-chip">🔒 TIER INSUFICIENTE</span>` : ""}
      </div>

      ${calc ? `<div class="dbu-defend-guide"><b>Combined Stress Test projetado:</b> ${esc(calc.required)}${calc.stepByStep ? ` · Step-by-Step −${esc(calc.stepByStep.reduction)}` : ""}${calc.crimson ? " · Crimson +2" : ""}</div>` : ""}

      <div style="margin-top:6px;"><b>Bônus de atributo da ficha</b><br>${attrs.length ? attrs.map(x => `<span class="dbu-meta-chip">${esc(x)}</span>`).join(" ") : `<em>Nenhum AMB nesta linha.</em>`}</div>

      ${aspects.length ? `<div style="margin-top:7px;"><b>Aspects</b><br>${aspects.map(a => `<span class="dbu-meta-chip">${esc(a)}</span>`).join(" ")}</div>` : ""}

      ${specials.length ? `<div style="margin-top:7px;"><b>Automação / custos relevantes</b><ul style="margin:4px 0 0 18px;">${specials.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}

      ${traits.length ? `<details style="margin-top:7px;"><summary><b>Traits (${traits.length} efeitos)</b></summary><div style="max-height:180px;overflow:auto;margin-top:5px;">${traits.slice(0, 30).map(t => `<div style="margin:0 0 6px 0;"><b>${esc(t.group)}${t.level !== "" ? ` L${esc(t.level)}` : ""}</b> <em>${esc(t.keyword)}</em><br><span>${esc(t.text)}</span></div>`).join("")}${traits.length > 30 ? `<em>+${traits.length - 30} efeitos; veja a ficha para a lista completa.</em>` : ""}</div></details>` : ""}
    </div>`;
}

export function getActiveTransformations(actor) {
  return activeOwnTransformations(actor);
}

export async function transformation(context = {}) {
  const actor = getActorFromContext(context);
  if (!actor) return null;
  if (!canControl(actor)) {
    ui.notifications.warn(`Você não controla ${actor.name}.`);
    return null;
  }

  const prepared = await prepare(actor);
  const list = prepared.transformations.filter(t => !isManifestedPower(t));
  if (!list.length) {
    ui.notifications.warn(`${actor.name}: nenhuma Transformation configurada na ficha.`);
    return null;
  }

  const active = list.filter(t => t.active);
  const inactive = list.filter(t => !t.active);
  const first = inactive.find(t => canEnterByTier(actor, t)) || inactive[0] || active[0];
  const firstNlop = first ? newLevelOfPowerState(actor, first, first.transIndex) : {
    eligible: false, enteredThisEncounter: false, usedEver: false, activeEncounter: false
  };
  const firstLegend = first ? legendRealizedState(actor, first) : { eligible:false, used:false, available:false, inCombat:false };
  const firstKiMult = first ? kiMultiplierEntryState(actor, first) : { eligible:false, used:false, available:false, type:null };
  const autoSkip = !!(firstNlop.eligible && firstNlop.activeEncounter);
  const firstUsedEver = !!(firstNlop.eligible && firstNlop.usedEver);

  const options = list.map(t => {
    const disabled = !t.active && !canEnterByTier(actor, t);
    return `<option value="${t.transIndex}" ${t.transIndex === first?.transIndex ? "selected" : ""} ${disabled ? "disabled" : ""}>${t.active ? "✓ " : ""}${esc(t.name || `Transformation ${t.transIndex + 1}`)}${disabled ? " — Tier insuficiente" : ""}</option>`;
  }).join("");

  const cap = globalThis.DBU?.getCapacity?.(actor) || {
    max: number(actor.system.status?.maxCapacity, 0),
    spent: number(actor.system.status?.capacitySpent, 0),
    left: Math.max(0, number(actor.system.status?.maxCapacity, 0) - number(actor.system.status?.capacitySpent, 0))
  };

  const result = await Dialog.wait({
    title: `${actor.name} — Transformações`,
    content: `
      <div class="dbu-transform-manager" data-actor-id="${esc(actor.id)}">
        <div class="dbu-attack-meta" style="margin-bottom:8px;">
          <span class="dbu-meta-chip">Tier ${esc(actor.system.tier || 1)}</span>
          <span class="dbu-meta-chip">Ki ${esc(actor.system.kiPool?.value ?? 0)}</span>
          <span class="dbu-meta-chip">Capacity ${esc(cap.spent)}/${esc(cap.max)}</span>
          <span class="dbu-meta-chip">Ativas ${active.length}</span>
        </div>

        <div class="form-group">
          <label><b>Transformation</b></label>
          <select id="dbu-tf-select" style="width:100%;">${options}</select>
        </div>

        <div id="dbu-tf-detail">${detailHtml(actor, first, prepared.sheet, { transformReplace: true, transformSkipTest: autoSkip })}</div>

        <div id="dbu-tf-options" style="margin-top:9px;padding:7px;border-top:1px solid rgba(0,0,0,.25);">
          <label style="display:block;margin:3px 0;"><input id="dbu-tf-replace" type="checkbox" checked> Replace current Alternate/Legendary Form quando aplicável</label>
          <label style="display:block;margin:3px 0;"><input id="dbu-tf-same-line" type="checkbox"> Same Transformation Line (Step-by-Step −1 adicional)</label>
          <div id="dbu-tf-nlop-option" class="dbu-auto-rule-block" style="${firstNlop.eligible ? "" : "display:none;"}">
            <div class="dbu-auto-rule-title"><i class="fas fa-level-up-alt"></i> New Level of Power — DBU 0.9.2</div>
            <label class="dbu-auto-checkline" title="Registro permanente: primeira vez ever desta Transformation."><input id="dbu-tf-nlop-used" type="checkbox" ${firstUsedEver ? "checked" : ""}> New Level of Power desta Transformation já foi utilizado na campanha</label>
            <div id="dbu-tf-nlop-used-state" class="dbu-auto-rule-note">${firstUsedEver ? "✓ Já utilizado. Não reseta entre combates." : "Ainda não utilizado. Use o controle nativo de New Level of Power quando esta for a primeira entrada ever durante um Combat Encounter."}</div>
            <div id="dbu-tf-nlop-native-state" class="dbu-auto-rule-note">${firstNlop.activeEncounter ? "⚡ NLoP está ativo para esta Transformation no encounter atual." : "O módulo sincroniza com newLevelOfPowerUsed / nlopActiveEncounter da ficha."}</div>

            <div class="dbu-auto-rule-subblock">
              <div class="dbu-auto-rule-title small"><i class="fas fa-redo-alt"></i> Stress Test de reentrada</div>
              <label class="dbu-auto-checkline" title="0.9.2: NLoP ativo no encounter permite reentrar nesta Transformation sem Stress Test, salvo conjunction."><input id="dbu-tf-skip" type="checkbox" ${autoSkip ? "checked" : ""}> Ignorar Stress Test nesta entrada por New Level of Power</label>
              <div id="dbu-tf-entry-state" class="dbu-auto-rule-note">${autoSkip ? "✓ NLoP ativo neste encounter: marcado automaticamente. O jogador pode desmarcar para forçar o teste." : "NLoP não está ativo para esta forma neste encounter. Marque somente como override manual."}</div>
            </div>
          </div>
          <div id="dbu-tf-nlop-unavailable" class="dbu-auto-rule-note" style="${firstNlop.eligible ? "display:none;" : ""}"><i class="fas fa-ban"></i> New Level of Power não se aplica a esta Transformation.</div>

          <div id="dbu-tf-lr-option" class="dbu-auto-rule-block" style="${firstLegend.eligible ? "" : "display:none;"}">
            <div class="dbu-auto-rule-title"><i class="fas fa-star"></i> Legend Realized — DBU 0.9.2</div>
            <label class="dbu-auto-checkline"><input id="dbu-tf-lr-apply" type="checkbox" ${firstLegend.available ? "checked" : ""}> Aplicar Legend Realized nesta entrada</label>
            <label class="dbu-auto-checkline" title="Rastreio nativo por Transformation e por Combat Encounter. O jogador pode corrigir manualmente."><input id="dbu-tf-lr-used" type="checkbox" ${firstLegend.used ? "checked" : ""}> Legend Realized desta Transformation já foi utilizado neste Combat Encounter</label>
            <div id="dbu-tf-lr-state" class="dbu-auto-rule-note">${firstLegend.available ? "Disponível: 2d10(T) + Power Level; restaura o resultado em Life Points e Ki Points. Variants compartilham o uso com a Transformation listada." : firstLegend.used ? "✓ Já utilizado nesta Transformation neste encounter." : "Disponível somente durante um Combat Encounter e em Alternate/Legendary Forms elegíveis."}</div>
          </div>
          <div id="dbu-tf-lr-unavailable" class="dbu-auto-rule-note" style="${firstLegend.eligible ? "display:none;" : ""}"><i class="fas fa-ban"></i> Legend Realized não se aplica a esta Transformation.</div>

          <div id="dbu-tf-kimult-option" class="dbu-auto-rule-block" style="${firstKiMult.eligible ? "" : "display:none;"}">
            <div class="dbu-auto-rule-title"><i class="fas fa-bolt"></i> Ki Multiplier — entrada</div>
            <label class="dbu-auto-checkline"><input id="dbu-tf-kimult-apply" type="checkbox" ${firstKiMult.available ? "checked" : ""}> Aplicar recuperação de Ki Multiplier nesta entrada</label>
            <div id="dbu-tf-kimult-state" class="dbu-auto-rule-note">${firstKiMult.available ? `Primeira entrada em ${firstKiMult.type === "form_alternate" ? "Alternate Form" : "Legendary Form"} neste encounter: recupera Ki igual à base Max Capacity.` : firstKiMult.used ? "A recuperação de primeira entrada deste tipo de Form já ocorreu neste encounter. Você ainda pode marcar a caixa como override manual." : "Ki Multiplier de entrada não está disponível fora de um Combat Encounter."}</div>
            <div class="dbu-auto-rule-note">Os máximos (Max Ki ×2 e Max Capacity +1/2) continuam sendo calculados <b>nativamente pelo DBU</b>. A automação só trata a recuperação de Ki da primeira entrada. Surging Strength não deve aplicar Ki Multiplier.</div>
          </div>

        ${activeGradedCosts(actor).length ? `<div style="margin-top:8px;border-top:1px solid rgba(0,0,0,.25);padding-top:7px;"><b>Custos LP ativos</b>${activeGradedCosts(actor).map(g => `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;"><span>${esc(g.name)} G${esc(g.grade)} — ${esc(g.lpCostNum)} LP (${esc(g.lpCostFormula)})</span><button type="button" data-dbu-tf-dialog-pay-lp data-catalog-key="${esc(g.catalogKey)}">Pagar LP</button></div>`).join("")}</div>` : ""}
      </div>`,
    buttons: {
      activate: {
        icon: '<i class="fas fa-dragon"></i>',
        label: "Transformar",
        callback: html => ({
          action: "activate",
          index: Number(html.find("#dbu-tf-select").val()),
          replace: html.find("#dbu-tf-replace").prop("checked"),
          sameLine: html.find("#dbu-tf-same-line").prop("checked"),
          skipTest: html.find("#dbu-tf-skip").prop("checked"),
          nlopUsed: html.find("#dbu-tf-nlop-used").prop("checked"),
          applyLegendRealized: html.find("#dbu-tf-lr-apply").prop("checked"),
          legendRealizedUsed: html.find("#dbu-tf-lr-used").prop("checked"),
          applyKiMultiplier: html.find("#dbu-tf-kimult-apply").prop("checked")
        })
      },
      revert: {
        icon: '<i class="fas fa-undo"></i>',
        label: "Reverter Selecionada",
        callback: html => ({ action: "revert", index: Number(html.find("#dbu-tf-select").val()) })
      },
      revertAll: {
        icon: '<i class="fas fa-angle-double-down"></i>',
        label: "Voltar à Base",
        callback: () => ({ action: "revertAll" })
      },
      close: {
        icon: '<i class="fas fa-times"></i>',
        label: "Fechar",
        callback: () => null
      }
    },
    default: "activate",
    close: () => null,
    render: html => {
      const select = html.find("#dbu-tf-select");
      const skipBox = html.find("#dbu-tf-skip");
      const entryState = html.find("#dbu-tf-entry-state");
      const nlopUsedBox = html.find("#dbu-tf-nlop-used");
      const nlopUsedState = html.find("#dbu-tf-nlop-used-state");
      const nlopOption = html.find("#dbu-tf-nlop-option");
      const nlopUnavailable = html.find("#dbu-tf-nlop-unavailable");
      const nlopNativeState = html.find("#dbu-tf-nlop-native-state");
      const lrApplyBox = html.find("#dbu-tf-lr-apply");
      const lrUsedBox = html.find("#dbu-tf-lr-used");
      const lrStateEl = html.find("#dbu-tf-lr-state");
      const lrOption = html.find("#dbu-tf-lr-option");
      const lrUnavailable = html.find("#dbu-tf-lr-unavailable");
      const kiApplyBox = html.find("#dbu-tf-kimult-apply");
      const kiStateEl = html.find("#dbu-tf-kimult-state");
      const kiOption = html.find("#dbu-tf-kimult-option");

      const updateDetail = ({ syncTracked = false, syncLifetime = false, syncLegend = false, syncKi = false } = {}) => {
        const idx = Number(select.val());
        const trans = list.find(t => t.transIndex === idx);
        const state = trans ? newLevelOfPowerState(actor, trans, trans.transIndex) : {
          eligible: false, enteredThisEncounter: false, usedEver: false, activeEncounter: false
        };
        const tracked = !!state.activeEncounter;
        const usedEver = !!state.usedEver;
        const lr = trans ? legendRealizedState(actor, trans) : { eligible:false, used:false, available:false, inCombat:false };
        const ki = trans ? kiMultiplierEntryState(actor, trans) : { eligible:false, used:false, available:false, type:null };

        // 0.9.2: skip do Stress Test só é automático quando NLoP está ativo
        // neste encounter. Legend Realized e Ki Multiplier são regras separadas.
        if (!state.eligible) {
          skipBox.prop("checked", false).prop("disabled", true);
          nlopUsedBox.prop("checked", false).prop("disabled", true);
          nlopOption.hide();
          nlopUnavailable.show();
        } else {
          skipBox.prop("disabled", false);
          nlopUsedBox.prop("disabled", false);
          nlopOption.show();
          nlopUnavailable.hide();
          if (syncTracked) skipBox.prop("checked", tracked);
          if (syncLifetime) nlopUsedBox.prop("checked", usedEver);
        }

        const checked = state.eligible && !!skipBox.prop("checked");
        const action = {
          transformReplace: html.find("#dbu-tf-replace").prop("checked"),
          transformSameLine: html.find("#dbu-tf-same-line").prop("checked"),
          transformSkipTest: checked
        };
        html.find("#dbu-tf-detail").html(detailHtml(actor, trans, prepared.sheet, action));

        if (entryState?.length && state.eligible) {
          if (checked === tracked) {
            entryState.html(tracked
              ? "✓ New Level of Power está ativo para esta Transformation neste encounter; o Stress Test pode ser ignorado em reentrada solo."
              : "NLoP não está ativo para esta Transformation neste encounter. O Stress Test permanece normal."
            );
          } else if (checked) {
            entryState.html("⚠ Override manual: o Stress Test será ignorado mesmo sem NLoP ativo detectado. Use apenas quando alguma regra permitir.");
          } else {
            entryState.html("⚠ NLoP ativo detectado, mas o jogador escolheu fazer o Stress Test nesta entrada.");
          }
        }

        if (nlopUsedState?.length && state.eligible) {
          const boxUsed = !!nlopUsedBox.prop("checked");
          if (boxUsed === usedEver) {
            nlopUsedState.html(usedEver
              ? "✓ New Level of Power desta Transformation já foi utilizado nesta campanha. Este registro é persistente e não reseta entre combates."
              : "Ainda não utilizado nesta campanha. Esta Transformation continua elegível ao New Level of Power quando a regra for acionada."
            );
          } else if (boxUsed) {
            nlopUsedState.html("Salvando: marcar como New Level of Power já utilizado nesta campanha…");
          } else {
            nlopUsedState.html("Salvando: remover a marca persistente de New Level of Power desta Transformation…");
          }
        }

        if (nlopNativeState?.length && state.eligible) {
          const encounterText = state.activeEncounter
            ? " <b>O benefício de NLoP está ativo neste encounter.</b>"
            : "";
          nlopNativeState.html(`Registro persistente nativo: <b>newLevelOfPowerUsed</b>. Estado do encounter: <b>nlopActiveEncounter</b>.${encounterText}`);
        }

        if (lr.eligible) {
          lrOption.show(); lrUnavailable.hide(); lrUsedBox.prop("disabled", false); lrApplyBox.prop("disabled", false);
          if (syncLegend) { lrUsedBox.prop("checked", lr.used); lrApplyBox.prop("checked", lr.available); }
          if (lrStateEl?.length) {
            const apply = !!lrApplyBox.prop("checked");
            lrStateEl.html(lr.used
              ? (apply ? "⚠ Override solicitado, mas marque 'já utilizado' como NÃO se o rastreio estiver incorreto." : "✓ Já utilizado nesta Transformation neste Combat Encounter.")
              : lr.inCombat
                ? (apply ? "✓ Será aplicado após a Transformation ser ativada: 2d10(T)+PL, recuperando LP e KP." : "Legend Realized está disponível, mas foi desativado para esta entrada.")
                : "Legend Realized só é aplicado durante um Combat Encounter.");
          }
        } else {
          lrOption.hide(); lrUnavailable.show(); lrApplyBox.prop("checked", false).prop("disabled", true); lrUsedBox.prop("checked", false).prop("disabled", true);
        }

        if (ki.eligible) {
          kiOption.show(); kiApplyBox.prop("disabled", false);
          if (syncKi) kiApplyBox.prop("checked", ki.available);
          if (kiStateEl?.length) {
            const apply = !!kiApplyBox.prop("checked");
            kiStateEl.html(ki.used
              ? (apply ? "⚠ Override manual: a recuperação de primeira entrada deste tipo já foi rastreada, mas será aplicada novamente." : "✓ Recuperação de primeira entrada deste tipo já consumida neste encounter.")
              : (apply ? `Será recuperado Ki igual à base Max Capacity após a entrada em ${ki.type === "form_alternate" ? "Alternate Form" : "Legendary Form"}.` : "Recuperação de Ki Multiplier desativada para esta entrada."));
          }
        } else {
          kiOption.hide(); kiApplyBox.prop("checked", false).prop("disabled", true);
        }
      };
      select.on("change", () => updateDetail({ syncTracked: true, syncLifetime: true, syncLegend: true, syncKi: true }));
      html.find("#dbu-tf-replace,#dbu-tf-same-line,#dbu-tf-skip,#dbu-tf-lr-apply,#dbu-tf-kimult-apply").on("change", () => updateDetail());
      nlopUsedBox.on("change", async () => {
        const idx = Number(select.val());
        const trans = list.find(t => t.transIndex === idx);
        if (!trans || !isNewLevelOfPowerEligible(trans)) return;

        const desired = !!nlopUsedBox.prop("checked");
        nlopUsedBox.prop("disabled", true);
        try {
          await setNewLevelOfPowerUsed(actor, trans, desired);
          updateDetail({ syncLifetime: true });
          ui.notifications.info(`${trans.name}: New Level of Power ${desired ? "marcado como já utilizado na campanha" : "marcado como ainda não utilizado"}.`);
        } catch (error) {
          console.error("DBU Automation | New Level of Power persistent marker:", error);
          ui.notifications.error(error?.message || "Não foi possível atualizar New Level of Power.");
          updateDetail({ syncLifetime: true });
        } finally {
          nlopUsedBox.prop("disabled", false);
        }
      });
      lrUsedBox.on("change", async () => {
        const idx = Number(select.val());
        const trans = list.find(t => t.transIndex === idx);
        if (!trans || !legendRealizedEligible(trans)) return;
        const desired = !!lrUsedBox.prop("checked");
        lrUsedBox.prop("disabled", true);
        try {
          await setLegendRealizedUsed(actor, trans, desired);
          updateDetail({ syncLegend: true });
          ui.notifications.info(`${trans.name}: Legend Realized ${desired ? "marcado como já utilizado neste encounter" : "marcado como disponível neste encounter"}.`);
        } catch (error) {
          console.error("DBU Automation | Legend Realized marker:", error);
          ui.notifications.error(error?.message || "Não foi possível atualizar Legend Realized.");
          updateDetail({ syncLegend: true });
        } finally {
          lrUsedBox.prop("disabled", false);
        }
      });

      html.find("[data-dbu-tf-dialog-pay-lp]").on("click", async ev => {
        ev.preventDefault();
        const key = ev.currentTarget.dataset.catalogKey;
        await payTransformationLp(actor, key);
        ev.currentTarget.disabled = true;
      });
    }
  }, { width: 650, classes: ["dbu-auto-dialog", "dbu-auto-transform-dialog"] });

  if (!result) return null;
  if (result.action === "activate") {
    const selected = actor.system.transformations?.[result.index];
    if (selected && isNewLevelOfPowerEligible(selected) && typeof result.nlopUsed === "boolean") {
      await setNewLevelOfPowerUsed(actor, selected, result.nlopUsed);
    }
    if (selected && legendRealizedEligible(selected) && typeof result.legendRealizedUsed === "boolean") {
      await setLegendRealizedUsed(actor, selected, result.legendRealizedUsed);
    }
    if (selected?.active) {
      ui.notifications.info(`${selected.name}: já está ativa.`);
      return true;
    }
    return activateTransformation(actor, result.index, {
      ...result,
      __dbuaActionValidated: !!context?.__dbuaActionValidated,
      effectiveType: context?.effectiveType || "standard"
    });
  }
  if (result.action === "revert") {
    const selected = actor.system.transformations?.[result.index];
    if (!selected?.active) {
      ui.notifications.warn("Selecione uma Transformation ativa para reverter.");
      return false;
    }
    return nativeDeactivate(actor, result.index);
  }
  if (result.action === "revertAll") return revertAll(actor);
  return null;
}

export const transform = transformation;

export function initializeTransformationAutomation() {
  if (globalThis.DBU_TRANSFORMATION_AUTOMATION?.initialized) return globalThis.DBU_TRANSFORMATION_AUTOMATION;

  const clickHandler = async event => {
    const btn = event.target.closest?.("[data-dbu-transform-pay-lp]");
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const actor = game.actors.get(btn.dataset.actorId);
    if (!actor) return ui.notifications.error("DBU Transformação: Actor não encontrado.");
    if (!canControl(actor)) return ui.notifications.warn("Você não controla este personagem.");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const ok = await payTransformationLp(actor, btn.dataset.catalogKey);
      if (ok) {
        btn.classList.add("dbu-pay-paid");
        btn.innerHTML = '<i class="fas fa-check"></i> LP pago';
      } else {
        btn.disabled = false;
      }
    } catch (error) {
      btn.disabled = false;
      console.error("DBU Automation | Transformation LP Cost:", error);
      ui.notifications.error(error?.message || "Erro pagando LP Cost.");
    }
  };

  document.addEventListener("click", clickHandler, true);

  const previous = globalThis.DBU_TRANSFORMATION_AUTOMATION;
  // Limpa também o hook antigo da 1.8.15 quando há hot reload na mesma sessão.
  if (previous?.preUpdateHookId) { try { Hooks.off("preUpdateActor", previous.preUpdateHookId); } catch {} }
  if (previous?.updateHookId) { try { Hooks.off("updateActor", previous.updateHookId); } catch {} }

  const updateHookId = Hooks.on("updateActor", (actor, changes) => {
    const sys = changes?.system || {};
    const touchedTransformations =
      Object.prototype.hasOwnProperty.call(sys, "transformations")
      || Object.keys(changes || {}).some(key => String(key).startsWith("system.transformations"));
    if (!touchedTransformations) return;

    // Ativações/reversões feitas por este módulo sincronizam explicitamente
    // no fim da operação. O hook fica para alterações nativas/manuais.
    if (isTransformationVisualSyncSuppressed(actor)) return;

    queueTransformationVisualSync(actor, () => syncTransformationVisual(actor));
  });

  globalThis.DBU_TRANSFORMATION_AUTOMATION = {
    initialized: true,
    version: "1.8.16",
    clickHandler,
    preUpdateHookId: null,
    updateHookId
  };

  console.log("DBU Automation | Transformation automation registrada");
  return globalThis.DBU_TRANSFORMATION_AUTOMATION;
}

export { activateTransformation, nativeDeactivate as deactivateTransformation, revertAll, payTransformationLp, syncTransformationVisual, transformationVisualConfig, setNewLevelOfPowerUsed, setLegendRealizedUsed, applyLegendRealized, applyKiMultiplierEntryRecovery };
import { validateActionUse } from "./action-economy.js";
