// DBU Automation v1.8.12 DEV — Attack Core
import { getAttackVisualSettings } from "./visual-config.js";
import { getAreaSpec, resolveAreaTargets, magnitudeLabel } from "./area-attack.js";
import { validateActionUse } from "./action-economy.js";
// Migrado do DBU - Ataque v11.5 sem alterar a lógica de rolagem.

export async function attack(context = {}) {
// ============================================================
// DBU-MRR-OLD — ATAQUE v11.8
// ============================================================
//
// Baseado no v11.1:
// ✔ Attack References e Signature Techniques preparados pela ficha
// ✔ Usa _onRollTrackerAttack() ORIGINAL do DBU
// ✔ GIF: na descrição -> GIF no chat
// ✔ VISUAL: / MACRO: na descrição -> macro visual no mapa
// ✔ Um ou vários alvos
// ✔ Compatível com o Inicializador DBU v6.6
// ✔ Charging Assault manual: grava action.charging=true e deixa o DBU aplicar efeitos nativos
// ✔ NOVO v11.5: painel de United Attack integrado à carta personalizada
// ✔ NOVO v11.5: guarda a mensagem original do DBU para sincronizar United Attack nativo
// ✔ NOVO v11.5: Wound base separado do bônus de United Attack
// ✔ NOVO v11.5: lista os Actor IDs dos alvos para suporte a United Duel/multi-target
// ✔ NOVO v11.6: Strike/Wound ficam ocultos até todos os alvos registrarem suas defesas
// ✔ NOVO v11.7: registra AoE/Sudden Blast para validar Reflect
// ✔ NOVO v11.8: bloqueia o ataque ANTES da rolagem se Ki ou Capacity não cobrirem Cost + Wager
// ✔ NOVO v11.9: Area Attack — template + detecção automática de alvos para Profiles AoE
// ✔ NOVO v11.11: categoria de dano pode ser ajustada manualmente antes de anunciar o ataque
//
// NOVO v11.2 — MODIFICADORES SITUACIONAIS
// ✔ Strike Extra: +2, +1d6, +1d6(t), +1d6(bT), etc.
// ✔ Wound Extra:  +2, +2d4+1, -1d6, etc.
// ✔ Modificador de CT de Strike e Wound
// ✔ Limite de Botch de Strike e Wound (0 desliga; 2 = natural 1-2)
// ✔ Diminishing Offense editável em stacks de (bT)
// ✔ Reinterpreta crítico/botch usando o MESMO dado natural original
// ✔ Mantém Twin-Linked / Dead-Link / buffs / wager / regras nativas
//
// NOVO v11.3 — INTEGRAÇÃO COM ENERGY CHARGE
// ✔ Detecta flags.world.dbuEnergyChargeState no atacante
// ✔ Se houver Charge ativo, mostra SOMENTE o ataque declarado
// ✔ Reconhece a liberação iniciada por DBU - Energy Charge
// ✔ Salva dados do Charge em attackData para o macro de Energy Charge confirmar
// ✔ Mostra o Charge ativo na carta de ataque/defesa
//
// Fórmulas especiais:
//   +1d6(t)   = 1d6 multiplicado pelo Tier
//   +1d6(bT)  = 1d6 multiplicado pelo Base Tier
//   +2(t)     = 2 x Tier
//   +1(bT)    = 1 x Base Tier
//
// ============================================================

const DBU_ATTACK_VERSION = "11.12";

const DBU_GIF_CONFIG = {
  enabled: true,
  maxHeight: 240,
  objectFit: "cover"
};

// Fallback para golpes antigos sem VISUAL: / MACRO: na descrição.
const ATTACK_VISUAL_FALLBACK = {
  "Kamehameha": "Visual Kamehameha",
  "Galick Gun": "Visual Galick Gun",
  "Death Beam": "Visual Death Beam",
  "Ki Blast": "Visual Ki Blast",
  "Punch": "Visual Punch",
  "Final Flash": "Visual Final Flash",
  "Explosive Wave": "Visual Explosive Wave"
};

// ============================================================
// HELPERS BÁSICOS
// ============================================================

function watchNativeAttackMessage(actorId, oldMessages = new Set()) {
  let createHookId = null;
  let updateHookId = null;
  let timer = null;
  let settled = false;
  let resolvePromise = null;

  const matches = message => {
    if (!message || oldMessages.has(message.id)) return false;
    const reveal = message.getFlag?.("DBU-MRR-OLD", "attackReveal");
    return !!reveal && String(reveal.actorId || "") === String(actorId || "");
  };

  const scan = () =>
    (game.messages?.contents || []).slice().reverse().find(matches) || null;

  const cleanup = () => {
    if (createHookId != null) {
      try { Hooks.off("createChatMessage", createHookId); } catch {}
      createHookId = null;
    }
    if (updateHookId != null) {
      try { Hooks.off("updateChatMessage", updateHookId); } catch {}
      updateHookId = null;
    }
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const finish = message => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise?.(message || null);
  };

  const promise = new Promise(resolve => {
    resolvePromise = resolve;
    const inspect = message => {
      if (matches(message)) finish(message);
    };
    // Os hooks ficam ativos ANTES da chamada nativa para não perder uma carta
    // criada imediatamente pelo DBU.
    createHookId = Hooks.on("createChatMessage", inspect);
    updateHookId = Hooks.on("updateChatMessage", inspect);
  });

  // O timeout começa somente DEPOIS de _onRollTrackerAttack() terminar.
  // Assim animações/integrações lentas não consomem a janela de captura.
  const armTimeout = (timeoutMs = 3000) => {
    if (settled) return;

    const immediate = scan();
    if (immediate) {
      finish(immediate);
      return;
    }

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // Scan único final de segurança; continua sem polling.
      finish(scan());
    }, Math.max(500, Number(timeoutMs) || 3000));
  };

  return {
    promise,
    armTimeout,
    cancel: () => finish(null)
  };
}

function dbuEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dbuSigned(value) {
  const n = Number(value) || 0;
  return n >= 0 ? `+${n}` : String(n);
}

function dbuClampInt(value, min, max) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(min, Math.min(max, n));
}

function dbuNormalizeDamageCategory(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("lethal")) return "Lethal";
  if (normalized.includes("direct")) return "Direct";
  return "Standard";
}

function dbuDescriptionToText(description) {
  const raw = String(description || "");
  if (!raw) return "";

  try {
    const element = document.createElement("div");
    element.innerHTML = raw;
    return element.innerText || element.textContent || raw;
  } catch {
    return raw;
  }
}

function dbuReadDescription(obj) {
  if (!obj) return "";

  const candidates = [
    obj.description,
    obj.desc,
    obj.notes,
    obj.flavor,
    obj.text,
    obj.system?.description,
    obj.system?.desc,
    obj.system?.notes,
    obj.system?.details?.description
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  return "";
}

function dbuGetSourceDescription(actor, source) {
  let description = dbuReadDescription(source);
  if (description) return description;

  const key = String(source?.key || "");

  // Attack Reference: ref_0, ref_1...
  if (key.startsWith("ref_")) {
    const index = Number(key.substring(4));
    if (Number.isInteger(index)) {
      const ref = actor.system.attackRefs?.[index];
      description = dbuReadDescription(ref);
      if (description) return description;
    }
  }

  // Signature Technique: tech_ID
  if (key.startsWith("tech_")) {
    const techId = key.substring(5);
    const tech = (actor.system.signatureTechniques || []).find(entry =>
      String(entry.id ?? entry._id ?? "") === techId
    );
    description = dbuReadDescription(tech);
    if (description) return description;
  }

  // Fallback pelo nome.
  const sourceName = String(source?.name || "").trim().toLowerCase();
  if (!sourceName) return "";

  const attackRef = (actor.system.attackRefs || []).find(entry =>
    String(entry?.name || "").trim().toLowerCase() === sourceName
  );
  description = dbuReadDescription(attackRef);
  if (description) return description;

  const technique = (actor.system.signatureTechniques || []).find(entry =>
    String(entry?.name || "").trim().toLowerCase() === sourceName
  );

  return dbuReadDescription(technique);
}

// ============================================================
// GIF / VISUAL NA DESCRIÇÃO
// ============================================================

function dbuValidateHttpUrl(value) {
  if (!value) return "";

  let url = String(value).trim();
  const markdown = url.match(/\((https?:\/\/[^)\s]+)\)/i);
  if (markdown?.[1]) url = markdown[1];
  else {
    const direct = url.match(/https?:\/\/[^\s<>"')\]]+/i);
    if (direct?.[0]) url = direct[0];
  }

  url = url.replace(/[.,;]+$/, "");

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function dbuExtractGif(description) {
  if (!DBU_GIF_CONFIG.enabled) return "";

  const raw = String(description || "");
  if (!raw) return "";

  const htmlLink = raw.match(
    /GIF\s*:\s*(?:<[^>]+>\s*)*<a[^>]+href=["'](https?:\/\/[^"']+)["']/i
  );
  if (htmlLink?.[1]) {
    const result = dbuValidateHttpUrl(htmlLink[1]);
    if (result) return result;
  }

  const text = dbuDescriptionToText(raw);

  const markdown = text.match(
    /GIF\s*:\s*\[[^\]]*?\]\((https?:\/\/[^\s)]+)\)/i
  );
  if (markdown?.[1]) {
    const result = dbuValidateHttpUrl(markdown[1]);
    if (result) return result;
  }

  const direct = text.match(/GIF\s*:\s*(https?:\/\/[^\s<>"']+)/i);
  if (direct?.[1]) return dbuValidateHttpUrl(direct[1]);

  return "";
}

function dbuExtractVisualMacroName(description) {
  const text = dbuDescriptionToText(description);
  if (!text) return "";

  const match = text.match(/(?:^|\n)\s*(?:VISUAL|MACRO)\s*:\s*([^\n\r]+)/i);
  if (!match?.[1]) return "";

  return String(match[1])
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function dbuGetVisualMacroName(actor, source) {
  const description = dbuGetSourceDescription(actor, source);
  const fromDescription = dbuExtractVisualMacroName(description);
  if (fromDescription) return fromDescription;

  const wanted = String(source?.name || "").trim().toLowerCase();
  for (const [attackName, macroName] of Object.entries(ATTACK_VISUAL_FALLBACK)) {
    if (attackName.trim().toLowerCase() === wanted) return macroName;
  }

  return "";
}

function dbuAttackGifHTML(gifUrl) {
  if (!gifUrl) return "";

  return `
    <div class="dbu-attack-gif" style="margin:8px 0 10px;overflow:hidden;border-radius:6px;line-height:0;">
      <img
        src="${dbuEsc(gifUrl)}"
        alt="Attack animation"
        loading="lazy"
        style="display:block;width:100%;max-height:${DBU_GIF_CONFIG.maxHeight}px;object-fit:${DBU_GIF_CONFIG.objectFit};border:0;"
      >
    </div>
  `;
}

async function dbuRunVisual(actor, attackerToken, targetTokens, source, attackData, visualMacroName) {
  if (!visualMacroName) return;

  const macro = game.macros.getName(visualMacroName);
  if (!macro) {
    console.warn(`DBU | Macro visual não encontrada: ${visualMacroName}`);
    ui.notifications.warn(`Macro visual não encontrada: ${visualMacroName}`);
    return;
  }

  const targets = Array.from(targetTokens || []);
  const firstTarget = targets[0] || null;

  try {
    await macro.execute({
      actor,
      token: attackerToken,
      attacker: actor,
      attackerToken,
      target: firstTarget,
      targetToken: firstTarget,
      targets,
      attack: source,
      source,
      attackData,
      attackAction: "attack",
      action: "attack",
      isAreaAttack: targets.length > 1
    });
  } catch (error) {
    console.error(`DBU | Erro na macro visual ${visualMacroName}:`, error);
    ui.notifications.error(`Erro executando visual: ${visualMacroName}`);
  }
}

// ============================================================
// FÓRMULAS DE BÔNUS SITUACIONAL
// ============================================================

/**
 * Converte a notação amigável para uma fórmula do Foundry.
 *
 * +1d6(t)  -> 0+(1d6)*TIER
 * +1d6(bT) -> 0+(1d6)*BASE_TIER
 * +2(t)    -> 0+(2)*TIER
 * +1(bT)   -> 0+(1)*BASE_TIER
 */
function dbuTranslateBonusFormula(rawFormula, tier, baseTier) {
  let raw = String(rawFormula ?? "").trim();
  if (!raw || raw === "0" || raw === "+0" || raw === "-0") return "";

  let translated = raw;

  // Base Tier primeiro para não colidir com (t).
  translated = translated.replace(
    /(\d*d\d+|\d+(?:\.\d+)?)\s*\(\s*bt\s*\)/gi,
    `($1)*${baseTier}`
  );

  translated = translated.replace(
    /(\d*d\d+|\d+(?:\.\d+)?)\s*\(\s*t\s*\)/gi,
    `($1)*${tier}`
  );

  // Facilita fórmulas começando com + ou -.
  if (/^[+-]/.test(translated)) translated = `0${translated}`;

  return translated;
}

function dbuValidateBonusFormula(rawFormula, tier, baseTier, label) {
  const translated = dbuTranslateBonusFormula(rawFormula, tier, baseTier);
  if (!translated) return { raw: "", translated: "" };

  try {
    // Apenas constrói. Não rola ainda, para não gastar dados caso o DBU bloqueie o ataque.
    new Roll(translated);
    return {
      raw: String(rawFormula).trim(),
      translated
    };
  } catch (error) {
    console.error(`DBU | Fórmula inválida (${label}):`, error);
    throw new Error(`${label} inválido: ${rawFormula}`);
  }
}

async function dbuRollBonus(prepared) {
  if (!prepared?.translated) {
    return {
      raw: prepared?.raw || "",
      translated: "",
      total: 0,
      roll: null
    };
  }

  const roll = new Roll(prepared.translated);
  await roll.evaluate();

  return {
    raw: prepared.raw,
    translated: prepared.translated,
    total: Number(roll.total || 0),
    roll
  };
}

function dbuRollFromData(data) {
  if (!data) return null;
  try {
    return Roll.fromData(data);
  } catch (error) {
    console.warn("DBU | Não consegui reconstruir Roll.fromData:", error);
    return null;
  }
}

function dbuNaturalFromRoll(roll) {
  return Number(roll?.dice?.[0]?.results?.[0]?.result ?? NaN);
}

async function dbuGetCustomCritRoll({ shouldCrit, originalCritData, sheet, tier }) {
  if (!shouldCrit) return null;

  if (originalCritData) {
    const reused = dbuRollFromData(originalCritData);
    if (reused) return reused;
  }

  if (typeof sheet?._critExtraFormula !== "function") return null;

  const formula = sheet._critExtraFormula(tier);
  if (!formula) return null;

  const roll = new Roll(formula);
  await roll.evaluate();
  return roll;
}

// ============================================================
// ATUALIZAR A CARTA ORIGINAL DO DBU
// ============================================================

function dbuPatchOriginalRevealHtml(originalHtml, data) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = String(originalHtml || "");

  const meta = wrapper.querySelector(".dbu-attack-meta");

  if (data.damageCategoryAdjusted && meta) {
    const originalCategory = String(data.originalDamageCategory || "").trim().toLowerCase();
    const categoryChip = Array.from(meta.querySelectorAll(".dbu-meta-chip"))
      .find(chip => String(chip.textContent || "").trim().toLowerCase() === originalCategory);
    if (categoryChip) categoryChip.textContent = data.damageCategory;
  }

  const modChips = [];

  if (data.strikeBonus.raw) {
    modChips.push(
      `<span class="dbu-attack-buff" title="Fórmula processada: ${dbuEsc(data.strikeBonus.translated)}">Strike Extra ${dbuEsc(data.strikeBonus.raw)} = ${dbuSigned(data.strikeBonus.total)}</span>`
    );
  }

  if (data.woundBonus.raw) {
    modChips.push(
      `<span class="dbu-attack-buff" title="Fórmula processada: ${dbuEsc(data.woundBonus.translated)}">Wound Extra ${dbuEsc(data.woundBonus.raw)} = ${dbuSigned(data.woundBonus.total)}</span>`
    );
  }

  if (data.strikeCT !== data.defaultStrikeCT) {
    modChips.push(
      `<span class="dbu-attack-buff">Strike CT ${data.defaultStrikeCT}+ → ${data.strikeCT}+</span>`
    );
  }

  if (data.woundCT !== data.defaultWoundCT) {
    modChips.push(
      `<span class="dbu-attack-buff">Wound CT ${data.defaultWoundCT}+ → ${data.woundCT}+</span>`
    );
  }

  if (data.strikeBotchThreshold !== 1) {
    modChips.push(
      `<span class="dbu-attack-buff">Strike Botch ${data.strikeBotchThreshold === 0 ? "OFF" : `1-${data.strikeBotchThreshold}`}</span>`
    );
  }

  if (data.woundBotchThreshold !== 1) {
    modChips.push(
      `<span class="dbu-attack-buff">Wound Botch ${data.woundBotchThreshold === 0 ? "OFF" : `1-${data.woundBotchThreshold}`}</span>`
    );
  }

  if (data.dimUsedStacks !== data.dimDefaultStacks) {
    modChips.push(
      `<span class="dbu-attack-buff">Diminishing ${data.dimDefaultStacks}(bT) → ${data.dimUsedStacks}(bT)</span>`
    );
  }

  if (data.chargingAssault) {
    modChips.push(
      `<span class="dbu-attack-buff">🏃 Charging Assault</span>`
    );
  }

  if (data.damageCategoryAdjusted) {
    modChips.push(
      `<span class="dbu-attack-buff">🎯 Categoria de dano ${dbuEsc(data.originalDamageCategory)} → ${dbuEsc(data.damageCategory)} · ajuste manual</span>`
    );
  }

  if (modChips.length) {
    const modBlock = document.createElement("div");
    modBlock.className = "dbu-attack-buffs dbu-manual-modifiers";
    modBlock.innerHTML = `<strong>Situational:</strong> ${modChips.join("")}`;

    if (meta) meta.insertAdjacentElement("afterend", modBlock);
    else wrapper.querySelector(".dbu-card-body")?.prepend(modBlock);
  }

  // Diminishing Offense.
  let dimLine = wrapper.querySelector(".dbu-penalty-line");
  const needsDimLine = data.dimUsedPenalty > 0 || data.dimDefaultStacks !== data.dimUsedStacks;

  if (needsDimLine) {
    if (!dimLine) {
      dimLine = document.createElement("div");
      dimLine.className = "dbu-penalty-line";
      const body = wrapper.querySelector(".dbu-card-body");
      const manual = wrapper.querySelector(".dbu-manual-modifiers");
      if (manual) manual.insertAdjacentElement("afterend", dimLine);
      else if (meta) meta.insertAdjacentElement("afterend", dimLine);
      else body?.prepend(dimLine);
    }

    if (data.dimUsedPenalty > 0) {
      dimLine.innerHTML = `<i class="fas fa-angle-double-down"></i> Diminishing Offense −${data.dimUsedPenalty} Strike <span class="dbu-penalty-why">${data.dimUsedStacks}(bT) no ataque #${data.attackNum}${data.dimUsedStacks !== data.dimDefaultStacks ? ` · padrão ${data.dimDefaultStacks}(bT)` : ""}</span>`;
    } else {
      dimLine.innerHTML = `<i class="fas fa-shield-alt"></i> Diminishing Offense ignorado <span class="dbu-penalty-why">ataque #${data.attackNum} · padrão ${data.dimDefaultStacks}(bT)</span>`;
    }
  } else if (dimLine) {
    dimLine.remove();
  }

  const rows = Array.from(wrapper.querySelectorAll(".dbu-roll-row"));

  for (const row of rows) {
    const label = String(row.querySelector(".dbu-roll-label")?.textContent || "").trim().toLowerCase();
    const main = row.querySelector(".dbu-roll-main");
    const totalEl = row.querySelector(".dbu-roll-total");
    const formulaEl = row.querySelector(".dbu-roll-formula");
    const subEl = row.querySelector(".dbu-roll-sub");

    if (label === "strike") {
      if (formulaEl) formulaEl.textContent = data.strikeDisplayFormula;
      if (subEl) {
        subEl.textContent = `Nat ${data.strikeNat} · CT ${data.strikeCT}+ · Botch ${data.strikeBotchThreshold === 0 ? "OFF" : `1-${data.strikeBotchThreshold}`}`;
      }
      if (totalEl) totalEl.textContent = String(data.strikeTotal);

      main?.querySelectorAll(".dbu-crit,.dbu-botch").forEach(el => el.remove());
      if (main) {
        if (data.strikeCritRoll) {
          main.insertAdjacentHTML(
            "beforeend",
            ` <span class="dbu-crit">CRIT! +${dbuEsc(data.critFormula)}: ${data.strikeCritRoll.total}</span>`
          );
        }
        if (data.strikeBotch) {
          main.insertAdjacentHTML(
            "beforeend",
            ` <span class="dbu-botch">BOTCH -${data.botchPenalty}</span>`
          );
        }
      }
    }

    if (label === "wound") {
      if (formulaEl && data.woundBonus.raw) {
        formulaEl.textContent = `${data.woundOriginalFormula} [Extra ${data.woundBonus.raw}]`;
      }
      if (subEl) {
        subEl.textContent = `Nat ${data.woundNat} · CT ${data.woundCT}+${data.wager > 0 ? ` · Wager +${data.wager}` : ""} · Botch ${data.woundBotchThreshold === 0 ? "OFF" : `1-${data.woundBotchThreshold}`}`;
      }
      if (totalEl) totalEl.textContent = String(data.woundTotal);

      main?.querySelectorAll(".dbu-crit,.dbu-botch").forEach(el => el.remove());
      if (main) {
        if (data.woundCritRoll) {
          main.insertAdjacentHTML(
            "beforeend",
            ` <span class="dbu-crit">CRIT! +${dbuEsc(data.critFormula)}: ${data.woundCritRoll.total}</span>`
          );
        }
        if (data.woundBotch) {
          main.insertAdjacentHTML(
            "beforeend",
            ` <span class="dbu-botch">BOTCH -${data.botchPenalty}</span>`
          );
        }
      }
    }
  }

  return wrapper.innerHTML;
}

// ============================================================
// ATACANTE / ALVOS
// ============================================================

const attackerToken =
  context?.attackerToken
  ?? context?.token
  ?? canvas.tokens.controlled[0];

if (!attackerToken) return ui.notifications.warn("Selecione o token atacante.");

const actor =
  context?.actor
  ?? context?.attacker
  ?? attackerToken.actor;

if (!actor) return ui.notifications.error("Actor atacante não encontrado.");

if (!context?.__dbuaActionValidated) {
  const validation = validateActionUse(actor, {
    label: context?.dialogTitle || "Ataque",
    actionCost: 1,
    effectiveType: context?.effectiveType || "standard",
    attacking: true
  });
  if (!validation.ok) return null;
}

const explicitTargets = context?.targets ?? context?.targetTokens ?? null;
const singleTarget = context?.target ?? context?.targetToken ?? null;
let targetTokens = explicitTargets
  ? Array.from(explicitTargets)
  : singleTarget
    ? [singleTarget]
    : Array.from(game.user.targets);

// v11.9: ataques AoE podem ser declarados sem Target prévio. Depois que o
// Profile for escolhido, o módulo posiciona o template e detecta os alvos.

const sheet = actor.sheet;
if (!sheet) return ui.notifications.error("Ficha não encontrada.");

try {
  await sheet.getData();
} catch (error) {
  console.error("DBU | Erro preparando ficha:", error);
  return ui.notifications.error("Erro preparando a ficha.");
}

// ============================================================
// ENERGY CHARGE ATIVO
// ============================================================
//
// O macro DBU - Energy Charge salva:
// flags.world.dbuEnergyChargeState
//
// Quando o jogador escolhe "Liberar Ataque", o macro de Charge
// também cria temporariamente globalThis.DBU_CHARGE_RELEASE.
//
// O v11.4 usa esses dados para impedir que outro ataque seja
// selecionado enquanto existe um Energy Charge declarado.
// ============================================================

const chargeStateRaw = actor.getFlag("world", "dbuEnergyChargeState") || null;
const chargeState = chargeStateRaw?.active ? chargeStateRaw : null;

const chargeReleaseContext = globalThis.DBU_CHARGE_RELEASE || null;

const chargeReleaseActive = !!(
  chargeState
  && chargeReleaseContext
  && chargeReleaseContext.actorId === actor.id
  && chargeReleaseContext.sourceKey === chargeState.sourceKey
  && (
    !chargeReleaseContext.stateId
    || !chargeState.stateId
    || chargeReleaseContext.stateId === chargeState.stateId
  )
);

if (chargeState) {
  console.log("DBU v11.4 | Energy Charge detectado:", {
    actor: actor.name,
    attackName: chargeState.attackName,
    sourceKey: chargeState.sourceKey,
    gatheredCharges: Number(chargeState.gatheredCharges || 0),
    maneuverUses: Number(chargeState.maneuverUses || 0),
    releasing: chargeReleaseActive
  });
}

// ============================================================
// SOURCES PREPARADAS PELO DBU
// ============================================================

const sourceGroups = sheet._trackerSourceGroups || [];
const normalizedGroupLabel = group => String(group?.label || "").trim().toLowerCase();
const isAttackReferenceGroup = group => {
  const label = normalizedGroupLabel(group);
  return label === "attack refs"
    || label === "attack references"
    || label.startsWith("attack ref")
    || String(group?.key || group?.id || "").toLowerCase().includes("attackref");
};
const isSignatureTechniqueGroup = group => {
  const label = normalizedGroupLabel(group);
  return label === "sig. techniques"
    || label === "signature techniques"
    || label.startsWith("sig. technique")
    || label.startsWith("signature technique");
};
const allowedGroups = sourceGroups.filter(group => {
  if (context?.basicOnly) return isAttackReferenceGroup(group);
  return isAttackReferenceGroup(group) || isSignatureTechniqueGroup(group);
});

if (!allowedGroups.length) {
  return ui.notifications.warn(context?.basicOnly
    ? "Nenhum Attack Reference disponível para este Basic Attack."
    : "Nenhum Attack Reference ou Signature Technique disponível.");
}

// Se existe Energy Charge ativo, somente a source declarada fica disponível.
const availableGroups = chargeState
  ? allowedGroups
      .map(group => ({
        ...group,
        sources: (group.sources || []).filter(source =>
          String(source.key) === String(chargeState.sourceKey)
        )
      }))
      .filter(group => group.sources.length)
  : allowedGroups;

if (chargeState && !availableGroups.length) {
  return ui.notifications.error(
    `Energy Charge ativo em ${chargeState.attackName || chargeState.sourceKey}, ` +
    "mas esse ataque não foi encontrado na ficha. Abra DBU - Energy Charge e cancele o Charge."
  );
}

const sources = [];
const preferredSourceKey = String(context?.sourceKey || "");
let initialSourceIndex = 0;
let selectHTML = `<select id="dbu-source" style="width:100%;">`;

for (const group of availableGroups) {
  selectHTML += `<optgroup label="${dbuEsc(group.label)}">`;

  for (const source of group.sources) {
    const index = sources.length;
    const description = dbuGetSourceDescription(actor, source);
    const visualSettings = getAttackVisualSettings(actor, source.key);

    let gif = dbuExtractGif(description);
    if (visualSettings?.gifMode === "custom") gif = visualSettings.gif || "";
    else if (visualSettings?.gifMode === "none") gif = "";

    let visual = dbuExtractVisualMacroName(description) || dbuGetVisualMacroName(actor, source);
    if (visualSettings?.visualMode === "custom") visual = visualSettings.visualMacro || "";
    else if (visualSettings?.visualMode === "none") visual = "";

    sources.push({ group: group.label, source, description, gif, visual });

    if (preferredSourceKey && String(source.key) === preferredSourceKey) {
      initialSourceIndex = index;
    }

    const cost = Number(source.kiCost || 0);
    const markers = [gif ? "🎞" : "", visual ? "✨" : ""].filter(Boolean).join(" ");

    selectHTML += `
      <option value="${index}" ${preferredSourceKey && String(source.key) === preferredSourceKey ? "selected" : ""}>
        ${markers ? `${markers} ` : ""}${dbuEsc(source.name)}${cost ? ` — ${cost} KP` : ""}
      </option>
    `;
  }

  selectHTML += `</optgroup>`;
}

selectHTML += `</select>`;

// ============================================================
// VALORES PARA MODIFICADORES
// ============================================================

const tier = Number(actor.system.tier || 1);
const baseTier = Number(actor.system.baseTier || 1);
const expectedAttackNum = Number(actor.system.combatTabState?.roundAttackCount || 0) + 1;
const expectedDimStacks = Math.max(0, expectedAttackNum - 3);

// A fórmula preparada pelo DBU também pode carregar o tracking do ataque anterior.
// Guardamos esse valor para retirar a penalidade já embutida e substituir pelo
// valor escolhido no diálogo, evitando somar Diminishing duas vezes.
const preExistingDimStacks = Math.max(0, Number(actor.system.tracking?.diminishingOffense || 0));
const preExistingDimPenalty = preExistingDimStacks * baseTier;

// ============================================================
// AREA OF EFFECT — DBU 0.9.2 (.ZIM)
// ============================================================
// O detector é apenas um auxílio. O jogador sempre pode marcar/desmarcar e
// corrigir Tipo/Magnitude manualmente para Traits/Talents opcionais.
const initialAreaSpec = getAreaSpec(sources[initialSourceIndex]?.source || {});
const initialAreaEnabled = !!initialAreaSpec?.isAoE;
const initialAreaShape = initialAreaSpec?.shape === "choose"
  ? "cone"
  : ["circle", "cone", "ray"].includes(initialAreaSpec?.shape)
    ? initialAreaSpec.shape
    : "circle";
const initialAreaMagnitude = Math.max(0, Math.min(5, Number(initialAreaSpec?.magnitude ?? 1)));
const initialAreaPosition = initialAreaSpec?.centeredOnAttacker ? "attacker" : "map";

const areaMagnitudeOptions = [
  [0, "Minor — Sphere apenas"],
  [1, "Standard"],
  [2, "Large"],
  [3, "Huge"],
  [4, "Destructive"],
  [5, "Cataclysmic — especial / Battlefield"]
].map(([value, label]) => `<option value="${value}" ${Number(value) === initialAreaMagnitude ? "selected" : ""}>${label}</option>`).join("");

const initialDamageCategory = dbuNormalizeDamageCategory(sources[initialSourceIndex]?.source?.damageCat);
const damageCategoryOptions = ["Standard", "Direct", "Lethal"]
  .map(category => `<option value="${category}" ${category === initialDamageCategory ? "selected" : ""}>${category}</option>`)
  .join("");

// ============================================================
// DIÁLOGO DO ATAQUE
// ============================================================

const selection = await Dialog.wait({
  title: context?.dialogTitle || `${actor.name} — Ataque v${DBU_ATTACK_VERSION}`,

  content: `
    <div class="dbu-v114-dialog">
      ${context?.attackMode === "exploit" ? `
        <div class="dbu-attack-buffs" style="margin-bottom:10px;padding:8px;border:1px solid rgba(255,180,0,.5);border-radius:6px;">
          <strong><i class="fas fa-bolt"></i> EXPLOIT — BASIC ATTACK OOS</strong><br>
          Alvo travado: <b>${dbuEsc(context?.target?.actor?.name || context?.targetToken?.actor?.name || "oponente que provocou o Exploit")}</b>.
          O uso da Counter Action é apenas registrado; o módulo não bloqueia por economia de Actions.
        </div>` : ""}
      ${context?.attackMode === "throw" ? `
        <div class="dbu-attack-buffs" style="margin-bottom:10px;padding:8px;border:1px solid rgba(0,210,255,.45);border-radius:6px;">
          <strong><i class="fas fa-people-carry"></i> THROW MANEUVER</strong><br>
          ${context?.throwFeatureLabel ? `Feature: <b>${dbuEsc(context.throwFeatureLabel)}</b>${context?.throwHardness ? ` · Hardness <b>${dbuEsc(context.throwHardness)}</b>` : ""}<br>` : ""}
          ${Number(context?.flatDamageBonus) > 0 ? `Collision após o Damage normal: <b>+${Math.max(0, Math.trunc(Number(context.flatDamageBonus)))} LP</b>.` : ""}
        </div>` : ""}
      }
      ${
        chargeState
          ? `
            <div
              class="dbu-attack-buffs"
              style="margin-bottom:10px;padding:8px;border:1px solid rgba(255,215,0,.45);border-radius:6px;"
            >
              <strong>⚡ ENERGY CHARGE ATIVO</strong><br>
              Ataque declarado: <b>${dbuEsc(chargeState.attackName || chargeState.sourceKey)}</b><br>
              EC reunidos: <b>${Number(chargeState.gatheredCharges || 0)}</b>
              · Usos: <b>${Number(chargeState.maneuverUses || 0)}</b><br>
              ${
                chargeReleaseActive
                  ? `<span class="dbu-attack-buff">✅ Liberando o ataque carregado</span>`
                  : `<span class="dbu-attack-buff">🔒 Somente o ataque carregado está disponível</span>`
              }
            </div>
          `
          : ""
      }

      <div class="form-group" style="margin-bottom:10px;">
        <label><b>Ataque</b></label>
        ${selectHTML}
      </div>

      <div class="dbu-auto-damage-category" style="margin-bottom:10px;">
        <div class="form-group">
          <label><b>Categoria do dano</b></label>
          <select id="dbu-damage-category" style="width:100%;">${damageCategoryOptions}</select>
          <p class="notes">
            Preenchida pela técnica. Altere somente quando uma habilidade, recurso ou efeito mudar
            a categoria deste ataque.
          </p>
        </div>
        <div id="dbu-damage-category-state" class="dbu-auto-damage-category-state">
          ORIGINAL: ${dbuEsc(initialDamageCategory)}
        </div>
      </div>

      <div class="form-group" style="margin-bottom:10px;">
        <label><b>Ki Wager</b></label>
        <input id="dbu-wager" type="number" value="0" min="0" ${Number(context?.wagerMaxOverride) >= 0 ? `max="${Math.max(0, Math.trunc(Number(context.wagerMaxOverride)))}"` : ""} step="1" style="width:100%;">
        ${Number(context?.wagerMaxOverride) >= 0 ? `<p class="notes">Limite desta ação: <b>${Math.max(0, Math.trunc(Number(context.wagerMaxOverride)))}</b> Ki Wager.</p>` : ""}
      </div>

      <hr>

      <h3 style="margin:6px 0;">Modificadores situacionais</h3>

      <div class="form-group" style="margin-bottom:8px;">
        <label><b>Strike Extra</b></label>
        <input id="dbu-strike-extra" type="text" value="${dbuEsc(context?.strikeExtraDefault || "")}" placeholder="Ex.: +2, +1d6, +1d6(t), -1d4" style="width:100%;">
        <p class="notes">Aceita dados. (t) = Tier; (bT) = Base Tier.</p>
      </div>

      <div class="form-group" style="margin-bottom:8px;">
        <label><b>Wound / Dano Extra</b></label>
        <input id="dbu-wound-extra" type="text" value="${dbuEsc(context?.woundExtraDefault || "")}" placeholder="Ex.: +3, +2d4+1, +1d6(bT)" style="width:100%;">
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
        <div class="form-group">
          <label><b>Strike CT Mod</b></label>
          <input id="dbu-strike-ct-mod" type="number" value="0" step="1" style="width:100%;">
          <p class="notes">-1 facilita crítico; +1 dificulta.</p>
        </div>

        <div class="form-group">
          <label><b>Wound CT Mod</b></label>
          <input id="dbu-wound-ct-mod" type="number" value="0" step="1" style="width:100%;">
          <p class="notes">-1 facilita crítico; +1 dificulta.</p>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
        <div class="form-group">
          <label><b>Strike Botch até</b></label>
          <input id="dbu-strike-botch" type="number" value="1" min="0" max="10" step="1" style="width:100%;">
          <p class="notes">1 = padrão; 0 = desliga; 2 = natural 1-2.</p>
        </div>

        <div class="form-group">
          <label><b>Wound Botch até</b></label>
          <input id="dbu-wound-botch" type="number" value="1" min="0" max="10" step="1" style="width:100%;">
          <p class="notes">1 = padrão; 0 = desliga; 2 = natural 1-2.</p>
        </div>
      </div>

      <div
        class="form-group"
        style="margin:10px 0;padding:8px;border:1px solid rgba(255,255,255,.18);border-radius:6px;"
      >
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input id="dbu-charging-assault" type="checkbox">
          <b>🏃 Charging Assault</b>
        </label>
        <p class="notes" style="margin:5px 0 0;">
          Marque quando este Attacking Maneuver possui ou recebeu a Advantage Charging Assault.
          O macro grava <code>charging: true</code> no Round Tracker para o DBU aplicar efeitos nativos,
          como Impaling Horns.
        </p>
      </div>

      <div class="dbu-auto-area-inline" id="dbu-area-inline">
        <div class="dbu-auto-area-inline-head">
          <label class="dbu-auto-checkline">
            <input id="dbu-has-area" type="checkbox" ${initialAreaEnabled ? "checked" : ""}>
            <b><i class="fas fa-bullseye"></i> Tem Área de Ataque?</b>
          </label>
          <span id="dbu-area-mode-chip" class="dbu-auto-chip ${initialAreaEnabled ? "warn" : ""}">${initialAreaEnabled ? "AUTO" : "MANUAL DISPONÍVEL"}</span>
        </div>

        <div id="dbu-area-options" ${initialAreaEnabled ? "" : 'style="display:none;"'}>
          <div class="dbu-auto-chip-row" id="dbu-area-detected-row">
            <span class="dbu-auto-chip" id="dbu-area-source-chip">${initialAreaEnabled ? dbuEsc(initialAreaSpec?.reasons?.[0] || "AoE detectada") : "AoE manual"}</span>
          </div>

          <div class="dbu-auto-area-grid">
            <div class="form-group">
              <label><b>Tipo da Área</b></label>
              <select id="dbu-area-shape" style="width:100%;">
                <option value="circle" ${initialAreaShape === "circle" ? "selected" : ""}>Sphere</option>
                <option value="cone" ${initialAreaShape === "cone" ? "selected" : ""}>Cone</option>
                <option value="ray" ${initialAreaShape === "ray" ? "selected" : ""}>Line</option>
              </select>
            </div>
            <div class="form-group">
              <label><b>Magnitude</b></label>
              <select id="dbu-area-magnitude" style="width:100%;">${areaMagnitudeOptions}</select>
            </div>
          </div>

          <div class="form-group" id="dbu-area-position-row">
            <label><b>Posição da Sphere</b></label>
            <select id="dbu-area-position" style="width:100%;">
              <option value="attacker" ${initialAreaPosition === "attacker" ? "selected" : ""}>Centrada no atacante</option>
              <option value="map" ${initialAreaPosition === "map" ? "selected" : ""}>Escolher Target Square no mapa</option>
            </select>
            <p class="notes">Cone e Line sempre começam na Square do usuário; você escolhe apenas a direção no mapa.</p>
          </div>

          <label class="dbu-auto-checkline">
            <input id="dbu-area-current-targets" type="checkbox">
            Usar Targets atuais em vez de posicionar template
          </label>
          <label class="dbu-auto-checkline">
            <input id="dbu-area-keep" type="checkbox">
            Manter o template no mapa depois de detectar os alvos
          </label>

          <div class="dbu-auto-template-hint" id="dbu-area-hint">
            DBU 0.9.2: Sphere, Cone e Line usam Magnitude. Se um efeito conceder uma AoE sem tamanho, use Standard.
            Qualquer personagem dentro da área é alvo, inclusive aliados, salvo exceção do efeito (como Sweeping).
          </div>
        </div>
      </div>

      <div class="form-group" style="margin-bottom:8px;">
        <label><b>Diminishing Offense usado (bT)</b></label>
        <input id="dbu-dim-stacks" type="number" value="${expectedDimStacks}" min="0" step="1" style="width:100%;">
        <p class="notes">
          Ataque esperado #${expectedAttackNum}. Padrão do DBU: ${expectedDimStacks}(bT)
          = -${expectedDimStacks * baseTier} Strike.
          Coloque 0 para ignorar a penalidade neste ataque.
        </p>
      </div>

      <p style="margin-top:8px;opacity:.8;font-size:.9em;">
        🎞 GIF no chat &nbsp;|&nbsp; ✨ Macro visual &nbsp;|&nbsp; T ${tier} &nbsp;|&nbsp; bT ${baseTier}
      </p>
    </div>
  `,

  buttons: {
    attack: {
      icon: '<i class="fas fa-fist-raised"></i>',
      label: "Atacar",
      callback: html => ({
        index: Number(html.find("#dbu-source").val()),
        damageCategory: dbuNormalizeDamageCategory(html.find("#dbu-damage-category").val()),
        wager: Math.min(
          Number(context?.wagerMaxOverride) >= 0 ? Math.max(0, Math.trunc(Number(context.wagerMaxOverride))) : Number.POSITIVE_INFINITY,
          Math.max(0, Number(html.find("#dbu-wager").val()) || 0)
        ),
        strikeExtra: String(html.find("#dbu-strike-extra").val() || "").trim(),
        woundExtra: String(html.find("#dbu-wound-extra").val() || "").trim(),
        strikeCTMod: Math.trunc(Number(html.find("#dbu-strike-ct-mod").val()) || 0),
        woundCTMod: Math.trunc(Number(html.find("#dbu-wound-ct-mod").val()) || 0),
        strikeBotch: dbuClampInt(html.find("#dbu-strike-botch").val(), 0, 10),
        woundBotch: dbuClampInt(html.find("#dbu-wound-botch").val(), 0, 10),
        chargingAssault: !!html.find("#dbu-charging-assault").prop("checked"),
        hasArea: !!html.find("#dbu-has-area").prop("checked"),
        areaShape: String(html.find("#dbu-area-shape").val() || "circle"),
        areaMagnitude: Math.max(0, Math.min(5, Math.trunc(Number(html.find("#dbu-area-magnitude").val()) || 0))),
        areaPosition: String(html.find("#dbu-area-position").val() || "map"),
        areaUseTargets: !!html.find("#dbu-area-current-targets").prop("checked"),
        areaKeep: !!html.find("#dbu-area-keep").prop("checked"),
        dimStacks: Math.max(0, Math.trunc(Number(html.find("#dbu-dim-stacks").val()) || 0))
      })
    },
    cancel: {
      icon: '<i class="fas fa-times"></i>',
      label: "Cancelar",
      callback: () => null
    }
  },

  default: "attack",
  close: () => null,
  render: html => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    const sourceSelect = root.querySelector("#dbu-source");
    const damageCategorySelect = root.querySelector("#dbu-damage-category");
    const damageCategoryState = root.querySelector("#dbu-damage-category-state");
    const enabled = root.querySelector("#dbu-has-area");
    const optionsBox = root.querySelector("#dbu-area-options");
    const shape = root.querySelector("#dbu-area-shape");
    const magnitude = root.querySelector("#dbu-area-magnitude");
    const position = root.querySelector("#dbu-area-position");
    const positionRow = root.querySelector("#dbu-area-position-row");
    const modeChip = root.querySelector("#dbu-area-mode-chip");
    const sourceChip = root.querySelector("#dbu-area-source-chip");

    const sourceDamageCategory = () => {
      const idx = Number(sourceSelect?.value || 0);
      return dbuNormalizeDamageCategory(sources[idx]?.source?.damageCat);
    };

    const refreshDamageCategoryState = () => {
      const original = sourceDamageCategory();
      const chosen = dbuNormalizeDamageCategory(damageCategorySelect?.value);
      const adjusted = chosen !== original;
      if (damageCategoryState) {
        damageCategoryState.textContent = adjusted
          ? `AJUSTE MANUAL: ${original} → ${chosen}`
          : `ORIGINAL: ${original}`;
        damageCategoryState.classList.toggle("manual", adjusted);
      }
    };

    const applySourceDamageCategory = () => {
      if (damageCategorySelect) damageCategorySelect.value = sourceDamageCategory();
      refreshDamageCategoryState();
    };

    let applyingAuto = false;
    const refreshShape = () => {
      const shp = String(shape?.value || "circle");
      if (positionRow) positionRow.style.display = shp === "circle" ? "block" : "none";
      const minor = magnitude?.querySelector('option[value="0"]');
      if (minor) minor.disabled = shp !== "circle";
      if (shp !== "circle" && Number(magnitude?.value) === 0) magnitude.value = "1";
    };

    const markManualChange = () => {
      if (applyingAuto || !enabled?.checked) return;
      const idx = Number(sourceSelect?.value || 0);
      const auto = getAreaSpec(sources[idx]?.source || {});
      if (modeChip) {
        modeChip.textContent = auto?.isAoE ? "AUTO + AJUSTE" : "MANUAL";
        modeChip.classList.add("warn");
      }
      refreshShape();
    };

    const applySourceArea = () => {
      const idx = Number(sourceSelect?.value || 0);
      const auto = getAreaSpec(sources[idx]?.source || {});
      applyingAuto = true;
      enabled.checked = !!auto?.isAoE;
      if (optionsBox) optionsBox.style.display = enabled.checked ? "block" : "none";
      if (auto?.isAoE) {
        shape.value = auto.shape === "choose"
          ? "cone"
          : (["circle", "cone", "ray"].includes(auto.shape) ? auto.shape : "circle");
        magnitude.value = String(Math.max(0, Math.min(5, Number(auto.magnitude ?? 1))));
        position.value = auto.centeredOnAttacker ? "attacker" : "map";
        if (modeChip) { modeChip.textContent = "AUTO"; modeChip.classList.add("warn"); }
        if (sourceChip) sourceChip.textContent = (auto.reasons || []).join(" · ") || "AoE detectada";
      } else {
        shape.value = "circle";
        magnitude.value = "1";
        position.value = "map";
        if (modeChip) { modeChip.textContent = "MANUAL DISPONÍVEL"; modeChip.classList.remove("warn"); }
        if (sourceChip) sourceChip.textContent = "Nenhuma AoE detectada — marque manualmente se um efeito conceder uma.";
      }
      refreshShape();
      applyingAuto = false;
    };

    sourceSelect?.addEventListener("change", () => {
      applySourceDamageCategory();
      applySourceArea();
    });
    damageCategorySelect?.addEventListener("change", refreshDamageCategoryState);
    enabled?.addEventListener("change", () => {
      if (optionsBox) optionsBox.style.display = enabled.checked ? "block" : "none";
      if (enabled.checked) markManualChange();
      else if (modeChip) { modeChip.textContent = "SEM AOE"; modeChip.classList.remove("warn"); }
    });
    shape?.addEventListener("change", markManualChange);
    magnitude?.addEventListener("change", markManualChange);
    position?.addEventListener("change", markManualChange);
    applySourceDamageCategory();
    applySourceArea();
  }
}, { width: 640, classes: ["dbu-auto-dialog", "dbu-auto-attack-dialog"] });

if (!selection) return;

const selected = sources[selection.index];
if (!selected) return ui.notifications.error("Ataque selecionado não encontrado.");

const source = selected.source;
const originalDamageCategory = dbuNormalizeDamageCategory(source.damageCat);
const chosenDamageCategory = dbuNormalizeDamageCategory(
  selection.damageCategory || originalDamageCategory
);
const damageCategoryAdjusted = chosenDamageCategory !== originalDamageCategory;

// ============================================================
// AREA ATTACK v11.11 — DBU 0.9.2: Tipo + Magnitude + override manual
// ============================================================
const areaSpec = getAreaSpec(source);
const chosenShape = ["circle", "cone", "ray"].includes(selection.areaShape) ? selection.areaShape : "circle";
let chosenMagnitude = Math.max(0, Math.min(5, Number(selection.areaMagnitude ?? 1)));
if (chosenShape !== "circle" && chosenMagnitude === 0) chosenMagnitude = 1;

const autoShape = ["circle", "cone", "ray"].includes(areaSpec?.shape) ? areaSpec.shape : null;
const autoPosition = areaSpec?.centeredOnAttacker ? "attacker" : "map";
const areaAdjusted = !!areaSpec?.isAoE && (
  chosenShape !== autoShape
  || chosenMagnitude !== Number(areaSpec?.magnitude ?? 1)
  || (chosenShape === "circle" && String(selection.areaPosition || "map") !== autoPosition)
);
const areaMode = !areaSpec?.isAoE ? "manual" : areaAdjusted ? "auto-adjusted" : "auto";
const areaEnabled = !!selection.hasArea;
let areaResolution = null;

if (areaEnabled && !context?.skipAreaTemplate) {
  areaResolution = await resolveAreaTargets({
    actor,
    attackerToken,
    source,
    existingTargets: targetTokens,
    config: {
      enabled: true,
      shape: chosenShape,
      magnitude: chosenMagnitude,
      position: selection.areaPosition,
      keep: !!selection.areaKeep,
      useSelected: !!selection.areaUseTargets,
      mode: areaMode,
      excludeAllies: areaSpec?.excludeAllies ?? false
    }
  });
  if (areaResolution?.cancelled) return null;
  targetTokens = Array.from(areaResolution?.targets || []);
}

if (!targetTokens.length) {
  return ui.notifications.warn(
    areaEnabled
      ? "Nenhum alvo foi detectado/selecionado para este Area Attack."
      : "Marque pelo menos um alvo."
  );
}

// Segurança extra: com Energy Charge ativo, nenhuma outra source pode ser usada.
if (
  chargeState
  && String(source.key) !== String(chargeState.sourceKey)
) {
  return ui.notifications.error(
    `Energy Charge está preso a ${chargeState.attackName || chargeState.sourceKey}. ` +
    "Cancele o Charge antes de usar outro ataque."
  );
}

const wager = Number(selection.wager || 0);

// ============================================================
// PRÉ-VALIDAÇÃO DE KI + CAPACITY
// ============================================================
//
// O DBU original cobra Cost + Wager somente depois do REVEAL. Isso permite
// que a rolagem seja criada mesmo quando o personagem já não possui recursos
// para pagar. No DBU Automation a declaração do ataque é bloqueada antes de
// registrar a Action/rolar os dados se o custo não puder ser pago.
//
// O pagamento em si continua no botão Pay da carta revelada, preservando o
// fluxo original do DBU e o interceptor Ki + Capacity do módulo.
// ============================================================

const attackKiCost = Math.max(0, Number(source.kiCost || 0));
const attackTotalCost = attackKiCost + Math.max(0, wager);

let affordability = null;

if (typeof globalThis.DBU?.canAfford === "function") {
  affordability = globalThis.DBU.canAfford(
    actor,
    attackTotalCost,
    `${source.name || "Ataque"} (Cost + Wager)`,
    true
  );
} else {
  const currentKi = Math.max(0, Number(actor.system.kiPool?.value || 0));
  const capacityMax = Math.max(0, Number(actor.system.status?.maxCapacity || 0));
  const capacitySpent = Math.max(0, Number(actor.system.status?.capacitySpent || 0));
  const capacityLeft = Math.max(0, capacityMax - capacitySpent);

  affordability = {
    ok: currentKi >= attackTotalCost
      && (capacityMax <= 0 || capacityLeft >= attackTotalCost),
    amount: attackTotalCost,
    ki: currentKi,
    capacityMax,
    capacitySpent,
    capacityLeft
  };

  if (!affordability.ok) {
    if (currentKi < attackTotalCost) {
      ui.notifications.warn(
        `${actor.name}: Ki insuficiente para ${source.name}. ` +
        `Cost ${attackKiCost} + Wager ${wager} = ${attackTotalCost} KP; disponível ${currentKi}.`
      );
    } else {
      ui.notifications.warn(
        `${actor.name}: Capacity insuficiente para ${source.name}. ` +
        `Cost ${attackKiCost} + Wager ${wager} = ${attackTotalCost}; restante ${capacityLeft}.`
      );
    }
  }
}

if (!affordability?.ok) {
  console.warn("DBU | Ataque bloqueado por recursos insuficientes", {
    actor: actor.name,
    attack: source.name,
    kiCost: attackKiCost,
    wager,
    total: attackTotalCost,
    affordability
  });
  return null;
}

const attackGif = selected.gif || dbuExtractGif(selected.description);
const visualMacroName = selected.visual || dbuGetVisualMacroName(actor, source);
const attackGifHTML = dbuAttackGifHTML(attackGif);

// Valida as fórmulas ANTES de registrar o ataque.
let preparedStrikeBonus;
let preparedWoundBonus;

try {
  preparedStrikeBonus = dbuValidateBonusFormula(
    selection.strikeExtra,
    tier,
    baseTier,
    "Strike Extra"
  );

  preparedWoundBonus = dbuValidateBonusFormula(
    selection.woundExtra,
    tier,
    baseTier,
    "Wound Extra"
  );
} catch (error) {
  return ui.notifications.error(error.message || "Fórmula de bônus inválida.");
}

// ============================================================
// ROUND TRACKER — MESMO FORMATO DO DBU
// ============================================================

const cts = foundry.utils.deepClone(actor.system.combatTabState || {});
if (!Array.isArray(cts.rounds)) cts.rounds = [];

if (!cts.rounds.length) {
  cts.rounds.push({
    roundNumber: 1,
    actions: []
  });
}

const currentRound = cts.rounds[cts.rounds.length - 1];
currentRound.actions ??= [];
if (!currentRound.roundNumber) currentRound.roundNumber = cts.rounds.length;
cts.currentRound = currentRound.roundNumber;

const actionIndex = currentRound.actions.length;

currentRound.actions.push({
  type: "attack",
  source: source.key,
  kiCost: Number(source.kiCost || 0),
  dkpCost: 0,
  kiWager: wager,
  description: source.name || "",
  charging: !!selection.chargingAssault,

  // Ajuste manual declarado antes do anúncio. O sistema ignora estes campos,
  // enquanto o DBU Automation os usa no dano e no registro do ataque.
  dbuDamageCategory: chosenDamageCategory,
  dbuDamageCategoryOriginal: originalDamageCategory,
  dbuDamageCategoryManual: damageCategoryAdjusted,

  // Metadados do Energy Charge. O DBU ignora campos desconhecidos,
  // mas eles ajudam no histórico e em integrações futuras.
  dbuEnergyChargeRelease: chargeReleaseActive,
  dbuChargeStateId: chargeState?.stateId || null,
  dbuChargeGathered: Number(chargeState?.gatheredCharges || 0),

  // v1.8.0 — permite que Maneuvers que reutilizam o Attack Core (ex.: Throw)
  // mantenham seu próprio limite/identidade sem duplicar o custo de Action.
  dbuStandardKey: String(context?.standardActionKey || ""),
  dbuAttackMode: String(context?.attackMode || ""),
  dbuOutOfSequence: String(context?.effectiveType || "") === "out-of-sequence",
  dbuExploitPendingId: String(context?.exploitPendingId || ""),
  dbuExploitRecoveryActorId: String(context?.exploitRecoveryActorId || "")
});

await actor.update({
  "system.combatTabState": cts
});

await sheet.getData();

// ============================================================
// ROLAGEM ORIGINAL DO DBU
// ============================================================

const oldMessages = new Set(game.messages.map(message => message.id));
const nativeAttackWatch = watchNativeAttackMessage(actor.id, oldMessages);

const fakeButton = {
  dataset: {
    round: String(currentRound.roundNumber),
    actionIndex: String(actionIndex)
  }
};

const fakeEvent = {
  preventDefault() {},
  stopPropagation() {},
  currentTarget: fakeButton,
  target: fakeButton
};

try {
  await sheet._onRollTrackerAttack(fakeEvent);
} catch (error) {
  nativeAttackWatch.cancel();
  console.error("DBU | _onRollTrackerAttack:", error);
  return ui.notifications.error("Erro executando a rolagem original do DBU.");
}

// ============================================================
// LOCALIZAR MENSAGEM ORIGINAL
// ============================================================

// v1.8.15: os hooks já estavam ativos durante a rolagem, mas a janela de
// timeout só começa agora, depois que o handler nativo concluiu. Isso mantém
// a captura orientada a eventos sem falhar em rolagens/animações mais lentas.
nativeAttackWatch.armTimeout(3000);
const attackMessage = await nativeAttackWatch.promise;

if (!attackMessage) {
  return ui.notifications.warn(
    "O DBU não gerou a rolagem. Verifique se alguma regra bloqueou o ataque."
  );
}

const reveal = attackMessage.getFlag("DBU-MRR-OLD", "attackReveal");
if (!reveal) return ui.notifications.error("attackReveal não encontrado.");

// ============================================================
// RECONSTRUIR OS DADOS ORIGINAIS DA ROLAGEM
// ============================================================

const strikeRoll = dbuRollFromData(reveal.strikeRollData);
const woundRoll = dbuRollFromData(reveal.woundRollData);

if (!strikeRoll || !woundRoll) {
  return ui.notifications.error("Não consegui reconstruir os dados originais de Strike/Wound.");
}

const strikeNat = dbuNaturalFromRoll(strikeRoll);
const woundNat = dbuNaturalFromRoll(woundRoll);

if (!Number.isFinite(strikeNat) || !Number.isFinite(woundNat)) {
  return ui.notifications.error("Não consegui identificar o dado natural de Strike/Wound.");
}

// O DBU acabou de incrementar roundAttackCount.
const actualAttackNum = Number(actor.system.combatTabState?.roundAttackCount || expectedAttackNum);
const dimDefaultStacks = Math.max(0, actualAttackNum - 3);
const dimDefaultPenalty = dimDefaultStacks * baseTier;
const dimUsedStacks = Math.max(0, Number(selection.dimStacks) || 0);
const dimUsedPenalty = dimUsedStacks * baseTier;

// ============================================================
// ROLAR BÔNUS EXTRAS
// ============================================================

let strikeBonus;
let woundBonus;

try {
  strikeBonus = await dbuRollBonus(preparedStrikeBonus);
  woundBonus = await dbuRollBonus(preparedWoundBonus);
} catch (error) {
  console.error("DBU | Erro rolando bônus situacional:", error);
  return ui.notifications.error("Erro rolando bônus situacional.");
}

// ============================================================
// CT / BOTCH PERSONALIZADOS
// ============================================================

const defaultStrikeCT = Number(source.strikeCT || 10);
const defaultWoundCT = Number(source.woundCT || 10);

// Não limitamos o máximo: CT 11+ pode representar crítico impossível em d10.
const strikeCT = Math.max(1, defaultStrikeCT + Number(selection.strikeCTMod || 0));
const woundCT = Math.max(1, defaultWoundCT + Number(selection.woundCTMod || 0));

const strikeBotchThreshold = dbuClampInt(selection.strikeBotch, 0, 10);
const woundBotchThreshold = dbuClampInt(selection.woundBotch, 0, 10);

const strikeCrit = strikeNat >= strikeCT;
const woundCrit = woundNat >= woundCT;

const strikeBotch = strikeBotchThreshold > 0 && strikeNat <= strikeBotchThreshold;
const woundBotch = woundBotchThreshold > 0 && woundNat <= woundBotchThreshold;

const critFormula = typeof sheet._critExtraFormula === "function"
  ? sheet._critExtraFormula(tier)
  : "";

const botchPenalty = 2 * baseTier;

const strikeCritRoll = await dbuGetCustomCritRoll({
  shouldCrit: strikeCrit,
  originalCritData: reveal.strikeCritRollData,
  sheet,
  tier
});

const woundCritRoll = await dbuGetCustomCritRoll({
  shouldCrit: woundCrit,
  originalCritData: reveal.woundCritRollData,
  sheet,
  tier
});

// ============================================================
// TOTAIS FINAIS
// ============================================================
//
// strikeRoll.total JÁ possui o Diminishing padrão aplicado pelo DBU.
// Portanto:
//   + devolvemos o Diminishing padrão
//   - aplicamos o Diminishing escolhido
//   + aplicamos o bônus situacional
//   + crítico reinterpretado
//   - botch reinterpretado
//
// Wound não recebe Diminishing Offense.
// ============================================================

const strikeBaseAdjusted =
  Number(strikeRoll.total || 0)
  + preExistingDimPenalty
  + dimDefaultPenalty
  - dimUsedPenalty
  + Number(strikeBonus.total || 0);

const woundBaseAdjusted =
  Number(woundRoll.total || 0)
  + Number(woundBonus.total || 0);

const strikeTotal =
  strikeBaseAdjusted
  + Number(strikeCritRoll?.total || 0)
  - (strikeBotch ? botchPenalty : 0);

const woundTotal =
  woundBaseAdjusted
  + Number(woundCritRoll?.total || 0)
  - (woundBotch ? botchPenalty : 0);

// Fórmula mostrada na carta original.
const sourceStrikeBaseFormula = String(source.strikeFormula || strikeRoll.formula || "1d10");
let strikeDisplayFormula = sourceStrikeBaseFormula;

// A source preparada pode ter a penalidade anterior já embutida. Para a fórmula
// exibida, cancelamos essa parcela e aplicamos somente o Diminishing escolhido.
if (preExistingDimPenalty > 0) {
  strikeDisplayFormula = `(${strikeDisplayFormula})+${preExistingDimPenalty}`;
}
if (dimUsedPenalty > 0) {
  strikeDisplayFormula = `(${strikeDisplayFormula})-${dimUsedPenalty}`;
}

if (strikeBonus.raw) {
  strikeDisplayFormula += ` [Extra ${strikeBonus.raw}]`;
}

const woundOriginalFormula = String(woundRoll.formula || source.woundFormula || "1d10");

// ============================================================
// CORRIGIR O REVEAL ORIGINAL DO DBU
// ============================================================

const patchedRevealHtml = dbuPatchOriginalRevealHtml(
  reveal.revealedHtml,
  {
    attackNum: actualAttackNum,
    wager,
    strikeNat,
    woundNat,
    defaultStrikeCT,
    defaultWoundCT,
    strikeCT,
    woundCT,
    strikeBotchThreshold,
    woundBotchThreshold,
    strikeCrit,
    woundCrit,
    strikeBotch,
    woundBotch,
    strikeCritRoll,
    woundCritRoll,
    critFormula,
    botchPenalty,
    strikeTotal,
    woundTotal,
    strikeBonus,
    woundBonus,
    dimDefaultStacks,
    dimUsedStacks,
    dimUsedPenalty,
    chargingAssault: !!selection.chargingAssault,
    originalDamageCategory,
    damageCategory: chosenDamageCategory,
    damageCategoryAdjusted,
    strikeDisplayFormula,
    woundOriginalFormula
  }
);

const updatedReveal = foundry.utils.deepClone(reveal);
updatedReveal.strikeTotal = strikeTotal;
updatedReveal.woundTotal = woundTotal;
updatedReveal.strikeCritRollData = strikeCritRoll ? strikeCritRoll.toJSON() : null;
updatedReveal.woundCritRollData = woundCritRoll ? woundCritRoll.toJSON() : null;
updatedReveal.revealedHtml = patchedRevealHtml;
updatedReveal.damageCategory = chosenDamageCategory;
updatedReveal.damageCat = chosenDamageCategory;

// Dados extras para outros macros / debug.
updatedReveal.manualModifiers = {
  version: DBU_ATTACK_VERSION,
  attackNum: actualAttackNum,
  strikeExtraFormula: strikeBonus.raw,
  strikeExtraTranslated: strikeBonus.translated,
  strikeExtraTotal: strikeBonus.total,
  woundExtraFormula: woundBonus.raw,
  woundExtraTranslated: woundBonus.translated,
  woundExtraTotal: woundBonus.total,
  defaultStrikeCT,
  strikeCT,
  defaultWoundCT,
  woundCT,
  strikeBotchThreshold,
  woundBotchThreshold,
  diminishingDefaultBT: dimDefaultStacks,
  diminishingUsedBT: dimUsedStacks,
  diminishingDefaultPenalty: dimDefaultPenalty,
  diminishingUsedPenalty: dimUsedPenalty,
  chargingAssault: !!selection.chargingAssault,
  originalDamageCategory,
  damageCategory: chosenDamageCategory,
  damageCategoryAdjusted
};

const originalMessageUpdates = {
  "flags.DBU-MRR-OLD.attackReveal": updatedReveal
};

// Normalmente ainda está oculto. Se por algum motivo já estiver revelado,
// também atualiza o conteúdo visível.
if (reveal.revealed) {
  originalMessageUpdates.content = patchedRevealHtml;
}

try {
  await attackMessage.update(originalMessageUpdates);
} catch (error) {
  console.error("DBU | Não consegui atualizar o reveal original:", error);
  ui.notifications.warn(
    "O resultado modificado foi calculado, mas a carta original do DBU não pôde ser atualizada."
  );
}

// ============================================================
// ATTACK DATA USADO PELA DEFESA / VISUAIS
// ============================================================

// Reflect só pode ser usado contra ataques Energy/Magic sem AoE.
// O perfil já informa AoE pelo campo range; Widespread Assault também cria AoE.
const reflectProfileInfo = CONFIG.DBU?.profileData?.[source.profile] || source.profileInfo || {};
const reflectAdvantages = Array.isArray(source.advantages) ? source.advantages : [];
const attackHasAoE = !!areaEnabled
  || /\bAoE\b/i.test(String(reflectProfileInfo?.range || source.profileRange || ""))
  || reflectAdvantages.some(adv => /widespread assault/i.test(String(adv?.name || adv || "")));
const suddenBlast = reflectAdvantages.some(adv => /sudden blast/i.test(String(adv?.name || adv || "")));

const attackData = {
  version: DBU_ATTACK_VERSION,
  createdAt: Date.now(),
  combatId: game.combat?.id || null,
  combatRound: Number(game.combat?.round || 0),

  attackerId: actor.id,
  attackerTokenId: attackerToken.id,
  attackerName: actor.name,
  attackerTier: tier,
  attackerBaseTier: baseTier,

  attackName: source.name,
  sourceKey: source.key,
  sourceGroup: selected.group,

  strikeTotal,

  // v11.5 — o Inicializador 6.6 usa o Wound base para recalcular
  // United Attack sem acumular o bônus duas vezes.
  baseWoundTotal: woundTotal,
  woundTotal,
  unitedAttackBonus: 0,
  unitedAttackContributions: [],
  unitedAttackLocked: false,

  // Mensagem oculta/original criada pelo _onRollTrackerAttack.
  // Mantemos a referência para sincronizar com o helper nativo de United Attack.
  originalAttackMessageId: attackMessage.id,

  strikeNatural: strikeNat,
  woundNatural: woundNat,

  foundation: source.foundation || "",
  profile: source.profile || "",

  damageCategory: chosenDamageCategory,
  damageCat: chosenDamageCategory,
  originalDamageCategory,
  damageCategoryAdjusted,

  energyCharges: Number(source.energyCharges || 0),
  powerShot: Number(source.powerShot || 0),

  kiCost: Number(source.kiCost || 0),
  wager,

  gif: attackGif,
  visualMacro: visualMacroName,

  // Modificadores situacionais.
  attackNumber: actualAttackNum,

  manualStrikeFormula: strikeBonus.raw,
  manualStrikeTranslated: strikeBonus.translated,
  strikeBonusTotal: strikeBonus.total,

  manualWoundFormula: woundBonus.raw,
  manualWoundTranslated: woundBonus.translated,
  woundBonusTotal: woundBonus.total,

  defaultStrikeCT,
  strikeCT,
  strikeCTModifier: Number(selection.strikeCTMod || 0),

  defaultWoundCT,
  woundCT,
  woundCTModifier: Number(selection.woundCTMod || 0),

  strikeBotchThreshold,
  woundBotchThreshold,

  strikeCritical: strikeCrit,
  woundCritical: woundCrit,
  strikeBotch,
  woundBotch,

  diminishingDefaultBT: dimDefaultStacks,
  diminishingUsedBT: dimUsedStacks,
  diminishingDefaultPenalty: dimDefaultPenalty,
  diminishingUsedPenalty: dimUsedPenalty,
  diminishingPreExistingBT: preExistingDimStacks,
  diminishingPreExistingPenalty: preExistingDimPenalty,

  // Charging Assault — gravado também em action.charging para o DBU nativo.
  chargingAssault: !!selection.chargingAssault,

  // Energy Charge.
  energyChargeActive: !!chargeState,
  energyChargeRelease: chargeReleaseActive,
  energyChargeStateId: chargeState?.stateId || null,
  energyChargeDeclaredAttack: chargeState?.attackName || "",
  energyChargeGathered: Number(chargeState?.gatheredCharges || 0),
  energyChargeManeuverUses: Number(chargeState?.maneuverUses || 0),

  // v11.6 — dados necessários para revelar a carta somente após todas as defesas.
  strikeDisplayFormula,
  woundDisplayFormula: woundBonus.raw
    ? `${woundOriginalFormula} [Extra ${woundBonus.raw}]`
    : woundOriginalFormula,
  secretCombat: true,

  isAreaAttack: !!areaEnabled || targetTokens.length > 1,
  areaAttack: areaResolution?.areaData || (areaEnabled ? {
    shape: chosenShape,
    magnitude: chosenMagnitude,
    magnitudeLabel: magnitudeLabel(chosenMagnitude),
    label: `${magnitudeLabel(chosenMagnitude)} ${chosenShape === "circle" ? "Sphere" : chosenShape === "cone" ? "Cone" : "Line"} AoE`,
    mode: areaMode,
    source: selection.areaUseTargets ? "current-targets" : "manual-no-template"
  } : null),
  hasAoE: attackHasAoE,
  reflectBlocked: attackHasAoE || suddenBlast,
  reflectBlockedReason: attackHasAoE
    ? "AoE"
    : suddenBlast
      ? "Sudden Blast"
      : "",

  // v11.12 — metadados para Standard Maneuvers que reutilizam o Attack Core.
  attackMode: String(context?.attackMode || ""),
  flatDamageBonus: Math.max(0, Math.trunc(Number(context?.flatDamageBonus) || 0)),
  flatDamageLabel: String(context?.flatDamageLabel || ""),
  throwHardness: Math.max(0, Math.trunc(Number(context?.throwHardness) || 0)),
  throwFeatureLabel: String(context?.throwFeatureLabel || ""),
  exploitSource: String(context?.exploitSource || ""),
  exploitPendingId: String(context?.exploitPendingId || ""),
  exploitRecoveryActorId: String(context?.exploitRecoveryActorId || ""),
  outOfSequence: String(context?.effectiveType || "") === "out-of-sequence",
  basicOnly: !!context?.basicOnly,

  targetActorIds: targetTokens
    .map(token => token.actor?.id)
    .filter(Boolean)
};

// ============================================================
// VISUAL NO MAPA
// ============================================================

await dbuRunVisual(
  actor,
  attackerToken,
  targetTokens,
  source,
  attackData,
  visualMacroName
);

// ============================================================
// ESTADOS DOS DEFENSORES
// ============================================================

const defenseStates = {};

for (const targetToken of targetTokens) {
  const defender = targetToken.actor;
  if (!defender) continue;

  defenseStates[defender.id] = {
    resolved: false,
    pending: false,
    status: "waiting"
  };
}

// ============================================================
// TARGET ROWS
// ============================================================

const targetRows = targetTokens
  .map(targetToken => {
    const defender = targetToken.actor;
    if (!defender) return "";

    const safeId = String(defender.id).replace(/[^a-zA-Z0-9_-]/g, "");

    return `
      <!-- DBU-TARGET-START-${safeId} -->

      <div
        class="dbu-area-target"
        data-target-row="${safeId}"
        style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.18);"
      >
        <div class="dbu-attack-meta">
          <span class="dbu-meta-chip">
            <i class="fas fa-crosshairs"></i>
            ${dbuEsc(defender.name)}
          </span>
          <span class="dbu-meta-chip dbu-auto-wait-chip">
            <i class="fas fa-hourglass-half"></i> Aguardando defesa
          </span>
        </div>

        <div class="dbu-attack-actions" style="display:flex;flex-wrap:wrap;gap:4px;">
          <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="dodge" data-defender-id="${defender.id}">
            <i class="fas fa-running"></i> Dodge
          </button>

          <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="parry" data-defender-id="${defender.id}">
            <i class="fas fa-shield-alt"></i> Parry
          </button>

          <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="directHit" data-defender-id="${defender.id}">
            <i class="fas fa-bullseye"></i> Direct Hit
          </button>

          <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="powerFlare" data-defender-id="${defender.id}">
            <i class="fas fa-fire"></i> Power Flare
          </button>

          <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="crossCounter" data-defender-id="${defender.id}">
            <i class="fas fa-fist-raised"></i> Cross Counter
          </button>

          <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="guard" data-defender-id="${defender.id}">
            <i class="fas fa-shield-alt"></i> Guard
          </button>
        </div>
      </div>

      <!-- DBU-TARGET-END-${safeId} -->
    `;
  })
  .join("");

// ============================================================
// META / MODIFICADORES NA CARTA DE DEFESA
// ============================================================

const metaChips = [
  `${source.foundation || ""}${source.profile ? ` / ${source.profile}` : ""}`.trim(),
  chosenDamageCategory,
  source.energyCharges ? `EC ${source.energyCharges}` : "",
  source.powerShot ? `Power Shot ${source.powerShot}` : "",
  areaEnabled ? `🎯 ${areaResolution?.areaData?.label || `${magnitudeLabel(chosenMagnitude)} ${chosenShape === "circle" ? "Sphere" : chosenShape === "cone" ? "Cone" : "Line"} AoE`} · ${areaMode === "auto" ? "AUTO" : areaMode === "auto-adjusted" ? "AUTO + AJUSTE" : "MANUAL"}` : "",
  selection.chargingAssault ? "🏃 Charging Assault" : "",
  chargeState
    ? `⚡ Charge +${Number(chargeState.gatheredCharges || 0)} EC${chargeReleaseActive ? " · LIBERANDO" : ""}`
    : "",
  visualMacroName ? `Visual: ${visualMacroName}` : ""
]
  .filter(Boolean)
  .map(value => `<span class="dbu-meta-chip">${dbuEsc(value)}</span>`)
  .join("");

const situationalChips = [];

if (damageCategoryAdjusted) {
  situationalChips.push(
    `<span class="dbu-attack-buff">🎯 Categoria de dano ${dbuEsc(originalDamageCategory)} → ${dbuEsc(chosenDamageCategory)} · ajuste manual</span>`
  );
}

if (chargeState) {
  situationalChips.push(
    `<span class="dbu-attack-buff">⚡ Energy Charge: +${Number(chargeState.gatheredCharges || 0)} EC${chargeReleaseActive ? " · liberado" : ""}</span>`
  );
}

if (strikeBonus.raw) {
  situationalChips.push(
    `<span class="dbu-attack-buff" title="${dbuEsc(strikeBonus.translated)}">Strike Extra ${dbuEsc(strikeBonus.raw)} = ${dbuSigned(strikeBonus.total)}</span>`
  );
}

if (woundBonus.raw) {
  situationalChips.push(
    `<span class="dbu-attack-buff" title="${dbuEsc(woundBonus.translated)}">Wound Extra ${dbuEsc(woundBonus.raw)} = ${dbuSigned(woundBonus.total)}</span>`
  );
}

if (strikeCT !== defaultStrikeCT) {
  situationalChips.push(`<span class="dbu-attack-buff">Strike CT ${defaultStrikeCT}+ → ${strikeCT}+</span>`);
}

if (woundCT !== defaultWoundCT) {
  situationalChips.push(`<span class="dbu-attack-buff">Wound CT ${defaultWoundCT}+ → ${woundCT}+</span>`);
}

if (strikeBotchThreshold !== 1) {
  situationalChips.push(
    `<span class="dbu-attack-buff">Strike Botch ${strikeBotchThreshold === 0 ? "OFF" : `1-${strikeBotchThreshold}`}</span>`
  );
}

if (woundBotchThreshold !== 1) {
  situationalChips.push(
    `<span class="dbu-attack-buff">Wound Botch ${woundBotchThreshold === 0 ? "OFF" : `1-${woundBotchThreshold}`}</span>`
  );
}

if (dimUsedStacks !== dimDefaultStacks) {
  situationalChips.push(
    `<span class="dbu-attack-buff">Diminishing ${dimDefaultStacks}(bT) → ${dimUsedStacks}(bT)</span>`
  );
}

if (selection.chargingAssault) {
  situationalChips.push(
    `<span class="dbu-attack-buff">🏃 Charging Assault</span>`
  );
}

const situationalHTML = situationalChips.length
  ? `<div class="dbu-attack-buffs"><strong>Situational:</strong> ${situationalChips.join("")}</div>`
  : "";

const strikeStatusTags = [
  strikeCrit ? `<span class="dbu-crit">CRIT</span>` : "",
  strikeBotch ? `<span class="dbu-botch">BOTCH</span>` : ""
].filter(Boolean).join(" ");

const woundStatusTags = [
  woundCrit ? `<span class="dbu-crit">CRIT</span>` : "",
  woundBotch ? `<span class="dbu-botch">BOTCH</span>` : ""
].filter(Boolean).join(" ");

// ============================================================
// CARTA DE DEFESA
// ============================================================

const defenseMessage = await ChatMessage.create({
  speaker: ChatMessage.getSpeaker({ actor }),

  flags: {
    world: {
      dbuAttackData: attackData,
      dbuDefenseStates: defenseStates,
      dbuUnitedAttackLocked: false,
      dbuUnitedAttackContributions: [],
      dbuCombatSecretMode: true,
      dbuCombatRevealed: false,
      dbuCombatRevealInProgress: false
    }
  },

  content: `
    <div class="dbu-attack-roll dbu-defend-card" data-actor-id="${actor.id}">
      <h3 class="dbu-attack-title">
        <span class="dbu-card-title-text">
          ${dbuEsc(actor.name)} — ${dbuEsc(source.name)}
        </span>
        <span class="dbu-action-count">ATK ${actualAttackNum}</span>
      </h3>

      <div class="dbu-card-body">
        ${attackGifHTML}

        <div class="dbu-attack-meta">
          ${metaChips}
        </div>

        ${situationalHTML}

        ${
          dimUsedPenalty > 0
            ? `<div class="dbu-penalty-line"><i class="fas fa-angle-double-down"></i> Diminishing Offense −${dimUsedPenalty} Strike <span class="dbu-penalty-why">${dimUsedStacks}(bT) · ataque #${actualAttackNum}${dimUsedStacks !== dimDefaultStacks ? ` · padrão ${dimDefaultStacks}(bT)` : ""}</span></div>`
            : dimDefaultStacks !== dimUsedStacks
              ? `<div class="dbu-penalty-line"><i class="fas fa-shield-alt"></i> Diminishing Offense ignorado <span class="dbu-penalty-why">padrão ${dimDefaultStacks}(bT)</span></div>`
              : ""
        }

        <div data-dbu-secret-attack-results>
          <div class="dbu-roll-row">
            <span class="dbu-roll-label">Strike</span>
            <span class="dbu-roll-main">
              <code class="dbu-roll-formula">🔒 Resultado oculto</code>
              <span class="dbu-roll-sub">Revelado quando todos os alvos registrarem suas defesas.</span>
            </span>
            <span class="dbu-roll-total">?</span>
          </div>

          <div class="dbu-roll-row">
            <span class="dbu-roll-label">Wound</span>
            <span class="dbu-roll-main">
              <code class="dbu-roll-formula">🔒 Resultado oculto</code>
              <span class="dbu-roll-sub">United Attack pode entrar antes da primeira defesa.</span>
            </span>
            <span class="dbu-roll-total" data-dbu-wound-total>?</span>
          </div>
        </div>

        <div
          class="dbu-duel-united dbu-united-attack-panel"
          data-dbu-united-attack-panel
          style="margin-top:10px;"
        >
          <div class="dbu-duel-united-title">
            🤝 UNITED ATTACK
          </div>

          <div data-dbu-ua-list>
            <div class="dbu-duel-support-row">
              <span class="dbu-meta-chip">
                Nenhum aliado entrou ainda.
              </span>
            </div>
          </div>

          <div class="dbu-attack-actions" style="margin-top:6px;">
            <button
              type="button"
              class="dbu-pay-btn dbu-united-attack-join-custom"
              data-dbu-united-attack-v1
              data-attacker-id="${actor.id}"
              title="United Attack [1/Round]: um aliado ajuda este ataque antes da primeira defesa ser resolvida."
            >
              <i class="fas fa-hands-helping"></i>
              United Attack
            </button>
          </div>

          <div class="dbu-penalty-why" data-dbu-ua-status style="margin-top:4px;">
            Antes da primeira defesa: +½ FO/MA + Ki Wager ao Wound.
          </div>
        </div>

        <div class="dbu-attack-buffs">
          <strong>Escolha a defesa de cada alvo:</strong>
        </div>

        <div class="dbu-auto-defense-progress" data-dbu-secret-wait-status>
          <span><i class="fas fa-lock"></i> Resultados ocultos</span>
          <strong>0/${targetTokens.length} defesas registradas</strong>
        </div>

        ${targetRows}
      </div>
    </div>
  `
});

attackData.messageId = defenseMessage?.id || null;

// v11.6 — liga a mensagem nativa oculta do DBU à carta de defesas.
// O Inicializador 6.7 bloqueia REVEAL até todos os alvos registrarem a defesa.
if (defenseMessage?.id) {
  try {
    await attackMessage.update({
      "flags.world.dbuAutomationDefenseMessageId": defenseMessage.id,
      "flags.world.dbuAutomationSecretCombat": true,
      "flags.world.dbuAutomationCombatRevealed": false
    });
  } catch (error) {
    console.warn("DBU | Não consegui vincular a carta secreta ao ataque nativo:", error);
  }
}

// ============================================================
// DEBUG
// ============================================================

console.log("==========================================");
console.log(`DBU | Ataque v${DBU_ATTACK_VERSION}`);
console.log("Ataque:", source.name);
console.log("ATK #:", actualAttackNum);
console.log("Strike natural:", strikeNat);
console.log("Strike CT:", `${defaultStrikeCT} -> ${strikeCT}`);
console.log("Strike Extra:", strikeBonus.raw || "Nenhum", "=", strikeBonus.total);
console.log("Strike Botch até:", strikeBotchThreshold);
console.log("Diminishing:", `${dimDefaultStacks}(bT) -> ${dimUsedStacks}(bT)`, "pré-embutido:", `${preExistingDimStacks}(bT)`);
console.log("Strike final:", strikeTotal);
console.log("Wound natural:", woundNat);
console.log("Wound CT:", `${defaultWoundCT} -> ${woundCT}`);
console.log("Wound Extra:", woundBonus.raw || "Nenhum", "=", woundBonus.total);
console.log("Wound Botch até:", woundBotchThreshold);
console.log("Wound base/final antes de United Attack:", woundTotal);
console.log("Charging Assault:", !!selection.chargingAssault);
console.log("Categoria de dano:", `${originalDamageCategory} -> ${chosenDamageCategory}`, damageCategoryAdjusted ? "(ajuste manual)" : "(original)");
console.log("GIF:", attackGif || "Nenhum");
console.log("Visual:", visualMacroName || "Nenhum");
console.log("Energy Charge ativo:", !!chargeState);
console.log("Energy Charge liberando:", chargeReleaseActive);
if (chargeState) {
  console.log("Charge attack:", chargeState.attackName || chargeState.sourceKey);
  console.log("Charge EC reunidos:", Number(chargeState.gatheredCharges || 0));
}
console.log("==========================================");


return attackData;
}
