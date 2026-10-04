// ============================================================
// DBU Automation v1.8.1 — Configurador Visual por personagem
// ============================================================
// Salva somente preferências visuais no Actor.
// Nenhuma regra mecânica do DBU é alterada aqui.
//
// Prioridade usada pelas integrações:
//   1) flags.dbu-automation-dev.visualConfig
//   2) configuração antiga (Notes/descrição/transformation-config)
//   3) fallback do módulo
// ============================================================

const MODULE_ID = "dbu-automation-dev";
const FLAG_KEY = "visualConfig";
const CONFIG_VERSION = 3;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function canControl(actor) {
  return !!actor && (game.user?.isGM || actor.isOwner);
}

function tokenFromContext(context = {}) {
  const direct = context?.token?.object ?? context?.token ?? null;
  if (direct?.actor) return direct;

  const byId = context?.tokenId ? canvas?.tokens?.get?.(context.tokenId) : null;
  if (byId?.actor) return byId;

  const controlled = canvas?.tokens?.controlled || [];
  if (controlled.length) return controlled[0];
  return null;
}

function actorFromContext(context = {}) {
  const direct = context?.actor;
  if (direct?.documentName === "Actor") return direct;
  if (direct?.actor?.documentName === "Actor") return direct.actor;

  const token = tokenFromContext(context);
  if (token?.actor) return token.actor;

  if (context?.actorId) {
    const actor = game.actors?.get?.(context.actorId);
    if (actor) return actor;
  }

  return game.user?.character || null;
}

function tokenForActor(actor, context = {}) {
  const direct = tokenFromContext(context);
  if (direct?.actor?.id === actor?.id) return direct;

  const controlled = (canvas?.tokens?.controlled || [])
    .find(token => token.actor?.id === actor?.id);
  if (controlled) return controlled;

  return (canvas?.tokens?.placeables || [])
    .find(token => token.actor?.id === actor?.id) || null;
}

function normalizeMode(value) {
  return ["inherit", "custom", "none"].includes(value) ? value : "inherit";
}

function cloneConfig(actor) {
  const raw = actor?.getFlag?.(MODULE_ID, FLAG_KEY) || {};
  const cfg = foundry.utils.deepClone(raw);
  cfg.version = CONFIG_VERSION;
  cfg.attacks ||= {};
  cfg.defenses ||= {};
  cfg.transformations ||= {};
  cfg.signatureAuras ||= {};
  cfg.energyCharge ||= {};
  cfg.combatReactions ||= {};
  return cfg;
}

export function getVisualConfig(actor) {
  return cloneConfig(actor);
}

export function getAttackVisualSettings(actor, sourceKey) {
  const cfg = cloneConfig(actor);
  const row = cfg.attacks?.[String(sourceKey)] || null;
  if (!row) return null;
  return {
    gifMode: normalizeMode(row.gifMode),
    gif: String(row.gif || ""),
    visualMode: normalizeMode(row.visualMode),
    visualMacro: String(row.visualMacro || ""),
    name: String(row.name || "")
  };
}

export function getDefenseVisualSettings(actor, defenseType) {
  const cfg = cloneConfig(actor);
  const row = cfg.defenses?.[String(defenseType)] || null;
  if (!row) return null;
  return {
    gifMode: normalizeMode(row.gifMode),
    gif: String(row.gif || ""),
    visualMode: normalizeMode(row.visualMode),
    visualMacro: String(row.visualMacro || "")
  };
}

export function getTransformationVisualSettings(actor, transformationOrKey) {
  const key = typeof transformationOrKey === "object"
    ? String(transformationOrKey?.id ?? transformationOrKey?.transIndex ?? "")
    : String(transformationOrKey ?? "");
  if (!key) return null;

  const cfg = cloneConfig(actor);
  const row = cfg.transformations?.[key] || null;
  if (!row) return null;

  // v1.5.3: o campo "tokenScale" da v1.5.0 é migrado automaticamente
  // para gridScale. Assim 2 passa a ocupar 2x o espaço base no grid, em vez
  // de apenas ampliar a textura por cima das casas vizinhas.
  const gridScale = Math.max(0, number(row.gridScale ?? row.tokenScale, 0));

  return {
    tokenMode: normalizeMode(row.tokenMode),
    token: String(row.token || ""),
    gridScale,
    // Reservado para compatibilidade futura/avançada. O configurador normal
    // não altera a escala interna da textura.
    tokenScale: Math.max(0, number(row.textureScale, 0)),
    visualMode: normalizeMode(row.visualMode),
    visualMacro: String(row.visualMacro || ""),
    name: String(row.name || "")
  };
}

function signatureAuraConfigKey(auraOrKey) {
  if (typeof auraOrKey === "string") return auraOrKey;
  if (!auraOrKey) return "";
  if (auraOrKey.gainedAuraKey) return `gained:${auraOrKey.gainedAuraKey}`;
  return `own:${auraOrKey.id}`;
}

export function getSignatureAuraVisualSettings(actor, auraOrKey) {
  const key = signatureAuraConfigKey(auraOrKey);
  if (!key) return null;
  const cfg = cloneConfig(actor);
  const row = cfg.signatureAuras?.[key] || null;
  if (!row) return null;
  return {
    key,
    name: String(row.name || ""),
    gifMode: normalizeMode(row.gifMode),
    gif: String(row.gif || ""),
    activateMode: normalizeMode(row.activateMode),
    activateMacro: String(row.activateMacro || ""),
    deactivateMode: normalizeMode(row.deactivateMode),
    deactivateMacro: String(row.deactivateMacro || "")
  };
}

function normalizeChargeStage(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (raw === "MAX") return "MAX";
  const n = Math.max(0, Number(value) || 0);
  if (n >= 5) return "MAX";
  if (n >= 4) return "4";
  if (n >= 3) return "3";
  if (n >= 2) return "2";
  return "1";
}


export function getCombatVisualSettings(actor, reactionType) {
  const key = String(reactionType || "").trim();
  if (!key) return null;
  const cfg = cloneConfig(actor);
  const row = cfg.combatReactions?.[key] || null;
  if (!row) return null;
  return {
    mode: normalizeMode(row.mode),
    macro: String(row.macro || ""),
    label: String(row.label || "")
  };
}

export function getEnergyChargeVisualSettings(actor, stageOrTotal) {
  const stage = normalizeChargeStage(stageOrTotal);
  const cfg = cloneConfig(actor);
  const rows = cfg.energyCharge || {};
  const order = ["1", "2", "3", "4", "MAX"];
  const idx = order.indexOf(stage);

  // O estágio exato ganha prioridade. "none" desliga explicitamente.
  // "inherit" procura o estágio anterior mais próximo configurado; se não
  // encontrar, devolve null e o Energy Charge usa Notes/fallback antigo.
  for (let i = idx; i >= 0; i--) {
    const sourceStage = order[i];
    const row = rows[sourceStage];
    if (!row) continue;
    const mode = normalizeMode(row.mode);
    if (i === idx && mode === "none") {
      return { mode: "none", macro: "", stage, sourceStage };
    }
    if (mode === "custom" && String(row.macro || "").trim()) {
      return { mode: "custom", macro: String(row.macro).trim(), stage, sourceStage };
    }
    if (i < idx && mode === "none") {
      return { mode: "none", macro: "", stage, sourceStage };
    }
  }
  return null;
}

async function saveCategoryEntry(actor, category, key, value) {
  if (!canControl(actor)) throw new Error(`Você não controla ${actor?.name || "este Actor"}.`);
  const cfg = cloneConfig(actor);
  cfg[category] ||= {};
  cfg[category][String(key)] = value;
  cfg.version = CONFIG_VERSION;
  await actor.setFlag(MODULE_ID, FLAG_KEY, cfg);
  return cfg;
}

async function clearCategoryEntry(actor, category, key) {
  if (!canControl(actor)) throw new Error(`Você não controla ${actor?.name || "este Actor"}.`);
  const cfg = cloneConfig(actor);
  cfg[category] ||= {};
  delete cfg[category][String(key)];
  cfg.version = CONFIG_VERSION;
  await actor.setFlag(MODULE_ID, FLAG_KEY, cfg);
  return cfg;
}

function descriptionToText(description) {
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

function readDescription(obj) {
  if (!obj) return "";
  for (const candidate of [
    obj.description,
    obj.desc,
    obj.notes,
    obj.flavor,
    obj.text,
    obj.system?.description,
    obj.system?.desc,
    obj.system?.notes,
    obj.system?.details?.description
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

function extractLegacyGif(description) {
  const raw = String(description || "");
  if (!raw) return "";

  const html = raw.match(/GIF\s*:\s*(?:<[^>]+>\s*)*<a[^>]+href=["']([^"']+)["']/i);
  if (html?.[1]) return String(html[1]).trim();

  const text = descriptionToText(raw);
  const markdown = text.match(/GIF\s*:\s*\[[^\]]*?\]\(([^\s)]+)\)/i);
  if (markdown?.[1]) return String(markdown[1]).trim();

  const direct = text.match(/GIF\s*:\s*([^\s<>"']+)/i);
  return direct?.[1] ? String(direct[1]).trim() : "";
}

function extractLegacyVisual(description) {
  const text = descriptionToText(description);
  const match = text.match(/(?:^|\n)\s*(?:VISUAL|MACRO)\s*:\s*([^\n\r]+)/i);
  return match?.[1] ? String(match[1]).trim().replace(/^['"]|['"]$/g, "") : "";
}

function attackEntries(actor) {
  const rows = [];

  for (const [index, ref] of (actor?.system?.attackRefs || []).entries()) {
    rows.push({
      key: `ref_${index}`,
      name: ref?.name || `Attack Reference ${index + 1}`,
      group: "Attack Reference",
      description: readDescription(ref)
    });
  }

  for (const [index, tech] of (actor?.system?.signatureTechniques || []).entries()) {
    const id = tech?.id ?? tech?._id ?? index;
    rows.push({
      key: `tech_${id}`,
      name: tech?.name || `Signature Technique ${index + 1}`,
      group: "Signature Technique",
      description: readDescription(tech)
    });
  }

  return rows;
}

const DEFENSES = [
  ["dodge", "Dodge"],
  ["parry", "Parry"],
  ["directHit", "Direct Hit"],
  ["powerFlare", "Power Flare"],
  ["crossCounter", "Cross Counter"],
  ["guard", "Guard"],
  ["duelClash", "Duel Clash"]
];

function normalizeTag(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function noteTagMap(actor) {
  let text = String(actor?.system?.notes || "");
  try {
    if (/<[a-z][\s\S]*>/i.test(text)) {
      const div = document.createElement("div");
      div.innerHTML = text;
      text = div.innerText || div.textContent || text;
    }
  } catch {}

  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    map[normalizeTag(match[1])] = String(match[2] || "").trim();
  }
  return map;
}

function legacyDefenseGif(actor, type) {
  const tags = noteTagMap(actor);
  const keys = {
    dodge: ["DODGE_GIF"],
    parry: ["PARRY_GIF"],
    directHit: ["DIRECT_HIT_GIF", "DIRECTHIT_GIF"],
    powerFlare: ["POWER_FLARE_GIF", "POWERFLARE_GIF"],
    crossCounter: ["CROSS_COUNTER_GIF", "CROSSCOUNTER_GIF"],
    guard: ["GUARD_GIF"],
    duelClash: ["DUEL_CLASH_GIF", "DUELCLASH_GIF"]
  }[type] || [];
  for (const key of keys) if (tags[key]) return tags[key];
  return tags.DEFENSE_GIF || "";
}

function legacyDefenseVisual(actor, type) {
  const tags = noteTagMap(actor);
  const upper = normalizeTag(type.replace(/([a-z])([A-Z])/g, "$1_$2"));
  return tags[`${upper}_VISUAL`] || tags.DEFENSE_VISUAL || "";
}

function transformationRows(actor) {
  return (actor?.system?.transformations || [])
    .map((trans, index) => ({
      key: String(trans?.id ?? index),
      index,
      trans: { ...trans, transIndex: index },
      name: trans?.name || `Transformation ${index + 1}`
    }))
    .filter(row => !String(row.name).toLowerCase().includes("manifested power"));
}

function legacyTransformation(actor, trans) {
  const tags = noteTagMap(actor);
  const nameKey = normalizeTag(trans?.name || trans?.catalogKey || `TRANS_${trans?.transIndex}`);
  const catalogKey = normalizeTag(trans?.catalogKey || "");
  const read = suffix => {
    for (const key of [
      `TRANSFORM_${nameKey}_${suffix}`,
      catalogKey ? `TRANSFORM_${catalogKey}_${suffix}` : ""
    ].filter(Boolean)) {
      if (Object.prototype.hasOwnProperty.call(tags, key)) return tags[key];
    }
    return "";
  };
  return {
    token: read("TOKEN"),
    tokenScale: number(read("TOKEN_SCALE"), 0),
    visualMacro: read("VISUAL")
  };
}

function macroNames() {
  return (game.macros?.contents || [])
    .filter(m => m && (m.type === "script" || typeof m.command === "string"))
    .map(m => String(m.name || "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function macroOptions(selected = "") {
  const names = macroNames();
  const options = [
    `<option value="">— selecione —</option>`
  ];
  for (const name of names) {
    options.push(`<option value="${esc(name)}" ${name === selected ? "selected" : ""}>${esc(name)}</option>`);
  }
  return options.join("");
}

function filePicker(input, type = "imagevideo") {
  try {
    const Picker = globalThis.FilePicker;
    if (!Picker) throw new Error("FilePicker não está disponível nesta versão do Foundry.");
    const fp = new Picker({
      type,
      current: input?.value || "",
      callback: path => {
        if (!input) return;
        input.value = path;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    fp.browse();
  } catch (error) {
    console.error("DBU Automation | FilePicker:", error);
    ui.notifications.error(error?.message || "Não foi possível abrir o seletor de arquivos.");
  }
}

async function executeMacroPreview(actor, token, macroName, payload = {}) {
  const name = String(macroName || "").trim();
  if (!name) return ui.notifications.warn("Selecione um macro visual primeiro.");
  const macro = game.macros?.getName?.(name);
  if (!macro) return ui.notifications.warn(`Macro visual não encontrado: ${name}`);

  const targets = Array.from(game.user?.targets || []);
  const firstTarget = targets[0] || null;

  await macro.execute({
    actor,
    token,
    attacker: actor,
    attackerToken: token,
    target: firstTarget,
    targetToken: firstTarget,
    targets,
    preview: true,
    test: true,
    ...payload
  });
}

function modeOptions(selected = "inherit", customLabel = "Personalizado") {
  return `
    <option value="inherit" ${selected === "inherit" ? "selected" : ""}>Usar configuração antiga/padrão</option>
    <option value="custom" ${selected === "custom" ? "selected" : ""}>${esc(customLabel)}</option>
    <option value="none" ${selected === "none" ? "selected" : ""}>Nenhum / desativar</option>
  `;
}

function getRoot(html) {
  return html instanceof HTMLElement ? html : (html?.[0] || null);
}

async function openAttackConfigurator(actor, token) {
  const rows = attackEntries(actor);
  if (!rows.length) return ui.notifications.warn(`${actor.name} não possui Attack References ou Signature Techniques.`);

  const cfg = cloneConfig(actor);
  const selectRows = rows.map((row, index) => `<option value="${index}">${esc(row.group)} — ${esc(row.name)}</option>`).join("");

  let dialog;
  dialog = new Dialog({
    title: `${actor.name} — Visuais de Ataque`,
    content: `
      <div class="dbu-visual-config" style="display:grid;gap:9px;">
        <label><b>Ataque</b><select data-vc-attack style="width:100%">${selectRows}</select></label>
        <div data-vc-inherited style="font-size:11px;opacity:.75;padding:6px;border:1px solid rgba(255,255,255,.12);border-radius:4px;"></div>
        <label><b>GIF da carta</b><select data-vc-gif-mode style="width:100%"></select></label>
        <div style="display:flex;gap:5px;align-items:center;">
          <input data-vc-gif type="text" style="flex:1" placeholder="worlds/.../ataque.gif ou https://...">
          <button type="button" data-vc-browse-gif title="Procurar arquivo"><i class="fas fa-folder-open"></i></button>
        </div>
        <div data-vc-gif-preview style="min-height:0"></div>
        <label><b>Macro visual</b><select data-vc-visual-mode style="width:100%"></select></label>
        <select data-vc-macro style="width:100%"></select>
        <div style="display:flex;gap:6px;">
          <button type="button" data-vc-test-macro style="flex:1"><i class="fas fa-play"></i> Testar macro visual</button>
          <button type="button" data-vc-clear style="flex:1"><i class="fas fa-undo"></i> Voltar ao padrão</button>
        </div>
        <p style="font-size:11px;opacity:.7;margin:0;">O jogador escolhe um macro já existente; o código JavaScript do macro não é editado por este painel.</p>
      </div>
    `,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: "Salvar",
        callback: async html => {
          const root = getRoot(html);
          const row = rows[number(root.querySelector("[data-vc-attack]")?.value, 0)];
          if (!row) return;
          const value = {
            name: row.name,
            gifMode: normalizeMode(root.querySelector("[data-vc-gif-mode]")?.value),
            gif: String(root.querySelector("[data-vc-gif]")?.value || "").trim(),
            visualMode: normalizeMode(root.querySelector("[data-vc-visual-mode]")?.value),
            visualMacro: String(root.querySelector("[data-vc-macro]")?.value || "").trim()
          };
          if (value.gifMode === "custom" && !value.gif) {
            ui.notifications.warn("Informe um GIF/arquivo ou escolha outro modo.");
            return false;
          }
          if (value.visualMode === "custom" && !value.visualMacro) {
            ui.notifications.warn("Selecione um macro visual ou escolha outro modo.");
            return false;
          }
          await saveCategoryEntry(actor, "attacks", row.key, value);
          ui.notifications.info(`${actor.name}: visual de ${row.name} salvo.`);
        }
      },
      close: { label: "Fechar" }
    },
    default: "save",
    render: html => {
      const root = getRoot(html);
      const attackSelect = root.querySelector("[data-vc-attack]");
      const gifMode = root.querySelector("[data-vc-gif-mode]");
      const gifInput = root.querySelector("[data-vc-gif]");
      const visualMode = root.querySelector("[data-vc-visual-mode]");
      const macroSelect = root.querySelector("[data-vc-macro]");
      const inherited = root.querySelector("[data-vc-inherited]");
      const preview = root.querySelector("[data-vc-gif-preview]");

      const load = () => {
        const row = rows[number(attackSelect.value, 0)];
        const stored = cfg.attacks?.[row.key] || {};
        const legacyGif = extractLegacyGif(row.description);
        const legacyVisual = extractLegacyVisual(row.description);
        const gMode = normalizeMode(stored.gifMode);
        const vMode = normalizeMode(stored.visualMode);
        gifMode.innerHTML = modeOptions(gMode, "Usar este GIF/arquivo");
        gifInput.value = String(stored.gif || "");
        visualMode.innerHTML = modeOptions(vMode, "Usar este macro");
        macroSelect.innerHTML = macroOptions(String(stored.visualMacro || ""));
        inherited.innerHTML = `<b>Configuração antiga:</b> GIF ${legacyGif ? esc(legacyGif) : "—"} · Visual ${legacyVisual ? esc(legacyVisual) : "—"}`;
        updatePreview();
      };

      const updatePreview = () => {
        const mode = gifMode.value;
        const row = rows[number(attackSelect.value, 0)];
        const src = mode === "custom" ? gifInput.value.trim() : (mode === "inherit" ? extractLegacyGif(row.description) : "");
        preview.innerHTML = src ? `<img src="${esc(src)}" style="display:block;max-width:100%;max-height:150px;margin:4px auto;border-radius:5px;object-fit:contain;">` : "";
        gifInput.disabled = mode !== "custom";
        macroSelect.disabled = visualMode.value !== "custom";
      };

      attackSelect.addEventListener("change", load);
      gifMode.addEventListener("change", updatePreview);
      visualMode.addEventListener("change", updatePreview);
      gifInput.addEventListener("input", updatePreview);
      root.querySelector("[data-vc-browse-gif]")?.addEventListener("click", e => {
        e.preventDefault();
        if (gifMode.value !== "custom") gifMode.value = "custom";
        filePicker(gifInput, "image");
        updatePreview();
      });
      root.querySelector("[data-vc-test-macro]")?.addEventListener("click", async e => {
        e.preventDefault();
        const row = rows[number(attackSelect.value, 0)];
        let name = "";
        if (visualMode.value === "custom") name = macroSelect.value;
        else if (visualMode.value === "inherit") name = extractLegacyVisual(row.description);
        await executeMacroPreview(actor, token, name, {
          attack: row,
          source: row,
          attackAction: "attack",
          action: "attack"
        });
      });
      root.querySelector("[data-vc-clear]")?.addEventListener("click", async e => {
        e.preventDefault();
        const row = rows[number(attackSelect.value, 0)];
        await clearCategoryEntry(actor, "attacks", row.key);
        delete cfg.attacks[row.key];
        load();
        ui.notifications.info(`${row.name}: configuração personalizada removida.`);
      });
      load();
    }
  }, { width: 560 });

  dialog.render(true);
  return dialog;
}

async function openDefenseConfigurator(actor, token) {
  const cfg = cloneConfig(actor);
  const options = DEFENSES.map(([key, label], index) => `<option value="${index}">${esc(label)}</option>`).join("");

  const dialog = new Dialog({
    title: `${actor.name} — Visuais de Defesa`,
    content: `
      <div class="dbu-visual-config" style="display:grid;gap:9px;">
        <label><b>Defesa</b><select data-vc-defense style="width:100%">${options}</select></label>
        <div data-vc-inherited style="font-size:11px;opacity:.75;padding:6px;border:1px solid rgba(255,255,255,.12);border-radius:4px;"></div>
        <label><b>GIF da carta</b><select data-vc-gif-mode style="width:100%"></select></label>
        <div style="display:flex;gap:5px;align-items:center;">
          <input data-vc-gif type="text" style="flex:1" placeholder="worlds/.../dodge.gif ou https://...">
          <button type="button" data-vc-browse-gif><i class="fas fa-folder-open"></i></button>
        </div>
        <div data-vc-gif-preview></div>
        <label><b>Macro visual da defesa</b><select data-vc-visual-mode style="width:100%"></select></label>
        <select data-vc-macro style="width:100%"></select>
        <div style="display:flex;gap:6px;">
          <button type="button" data-vc-test-macro style="flex:1"><i class="fas fa-play"></i> Testar visual</button>
          <button type="button" data-vc-clear style="flex:1"><i class="fas fa-undo"></i> Voltar ao padrão</button>
        </div>
      </div>
    `,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: "Salvar",
        callback: async html => {
          const root = getRoot(html);
          const [key] = DEFENSES[number(root.querySelector("[data-vc-defense]")?.value, 0)];
          const value = {
            gifMode: normalizeMode(root.querySelector("[data-vc-gif-mode]")?.value),
            gif: String(root.querySelector("[data-vc-gif]")?.value || "").trim(),
            visualMode: normalizeMode(root.querySelector("[data-vc-visual-mode]")?.value),
            visualMacro: String(root.querySelector("[data-vc-macro]")?.value || "").trim()
          };
          if (value.gifMode === "custom" && !value.gif) return ui.notifications.warn("Informe o GIF/arquivo da defesa.");
          if (value.visualMode === "custom" && !value.visualMacro) return ui.notifications.warn("Selecione um macro visual.");
          await saveCategoryEntry(actor, "defenses", key, value);
          ui.notifications.info(`${actor.name}: visual de defesa salvo.`);
        }
      },
      close: { label: "Fechar" }
    },
    default: "save",
    render: html => {
      const root = getRoot(html);
      const defenseSelect = root.querySelector("[data-vc-defense]");
      const gifMode = root.querySelector("[data-vc-gif-mode]");
      const gifInput = root.querySelector("[data-vc-gif]");
      const visualMode = root.querySelector("[data-vc-visual-mode]");
      const macroSelect = root.querySelector("[data-vc-macro]");
      const inherited = root.querySelector("[data-vc-inherited]");
      const preview = root.querySelector("[data-vc-gif-preview]");

      const load = () => {
        const [key] = DEFENSES[number(defenseSelect.value, 0)];
        const stored = cfg.defenses?.[key] || {};
        const legacyGif = legacyDefenseGif(actor, key);
        const legacyVisual = legacyDefenseVisual(actor, key);
        gifMode.innerHTML = modeOptions(normalizeMode(stored.gifMode), "Usar este GIF/arquivo");
        gifInput.value = String(stored.gif || "");
        visualMode.innerHTML = modeOptions(normalizeMode(stored.visualMode), "Usar este macro");
        macroSelect.innerHTML = macroOptions(String(stored.visualMacro || ""));
        inherited.innerHTML = `<b>Configuração antiga:</b> GIF ${legacyGif ? esc(legacyGif) : "—"} · Visual ${legacyVisual ? esc(legacyVisual) : "—"}`;
        update();
      };

      const update = () => {
        const [key] = DEFENSES[number(defenseSelect.value, 0)];
        const src = gifMode.value === "custom" ? gifInput.value.trim() : (gifMode.value === "inherit" ? legacyDefenseGif(actor, key) : "");
        preview.innerHTML = src ? `<img src="${esc(src)}" style="display:block;max-width:100%;max-height:150px;margin:4px auto;border-radius:5px;object-fit:contain;">` : "";
        gifInput.disabled = gifMode.value !== "custom";
        macroSelect.disabled = visualMode.value !== "custom";
      };

      defenseSelect.addEventListener("change", load);
      gifMode.addEventListener("change", update);
      visualMode.addEventListener("change", update);
      gifInput.addEventListener("input", update);
      root.querySelector("[data-vc-browse-gif]")?.addEventListener("click", e => {
        e.preventDefault();
        if (gifMode.value !== "custom") gifMode.value = "custom";
        filePicker(gifInput, "image");
        update();
      });
      root.querySelector("[data-vc-test-macro]")?.addEventListener("click", async e => {
        e.preventDefault();
        const [key, label] = DEFENSES[number(defenseSelect.value, 0)];
        let name = "";
        if (visualMode.value === "custom") name = macroSelect.value;
        else if (visualMode.value === "inherit") name = legacyDefenseVisual(actor, key);
        await executeMacroPreview(actor, token, name, {
          defender: actor,
          defenderToken: token,
          defenseType: key,
          defenseName: label,
          action: "defense"
        });
      });
      root.querySelector("[data-vc-clear]")?.addEventListener("click", async e => {
        e.preventDefault();
        const [key] = DEFENSES[number(defenseSelect.value, 0)];
        await clearCategoryEntry(actor, "defenses", key);
        delete cfg.defenses[key];
        load();
        ui.notifications.info("Configuração personalizada da defesa removida.");
      });
      load();
    }
  }, { width: 560 });

  dialog.render(true);
  return dialog;
}

async function previewToken(actor, token, src, gridScale = 0) {
  if (!token?.document) return ui.notifications.warn("Coloque ou selecione o token do personagem na cena para testar.");
  if (!src && !(gridScale > 0)) return ui.notifications.warn("Nenhuma imagem ou tamanho de grid configurado para testar.");

  const before = {
    src: token.document.texture?.src,
    scaleX: number(token.document.texture?.scaleX, 1),
    scaleY: number(token.document.texture?.scaleY, 1),
    width: number(token.document.width, 1),
    height: number(token.document.height, 1)
  };

  const cachedBase = actor?.getFlag?.(MODULE_ID, "transformationBaseToken") || null;
  const baseWidth = Math.max(0.5, number(cachedBase?.width, before.width || 1));
  const baseHeight = Math.max(0.5, number(cachedBase?.height, before.height || 1));

  const update = {};
  if (src) update["texture.src"] = src;
  if (gridScale > 0) {
    update.width = Math.max(0.5, baseWidth * gridScale);
    update.height = Math.max(0.5, baseHeight * gridScale);
  }
  await token.document.update(update);
  ui.notifications.info(`Preview por 3 segundos${gridScale > 0 ? ` — ocupa ${update.width}×${update.height} no grid` : ""}.`);
  setTimeout(async () => {
    try {
      await token.document.update({
        "texture.src": before.src,
        "texture.scaleX": before.scaleX,
        "texture.scaleY": before.scaleY,
        width: before.width,
        height: before.height
      });
    } catch {}
  }, 3000);
}

async function openTransformationConfigurator(actor, token) {
  const rows = transformationRows(actor);
  if (!rows.length) return ui.notifications.warn(`${actor.name} não possui Transformations.`);
  const cfg = cloneConfig(actor);
  const options = rows.map((row, index) => `<option value="${index}">${esc(row.name)}</option>`).join("");

  const dialog = new Dialog({
    title: `${actor.name} — Visuais de Transformação`,
    content: `
      <div class="dbu-visual-config" style="display:grid;gap:9px;">
        <label><b>Transformation</b><select data-vc-transform style="width:100%">${options}</select></label>
        <div data-vc-inherited style="font-size:11px;opacity:.75;padding:6px;border:1px solid rgba(255,255,255,.12);border-radius:4px;"></div>
        <label><b>Troca de imagem do token</b><select data-vc-token-mode style="width:100%"></select></label>
        <div style="display:flex;gap:5px;align-items:center;">
          <input data-vc-token type="text" style="flex:1" placeholder="worlds/.../ssj.webp">
          <button type="button" data-vc-browse-token><i class="fas fa-folder-open"></i></button>
        </div>
        <label><b>Tamanho no grid</b> <input data-vc-token-scale type="number" min="0" step="0.25" value="0" style="width:90px"> <span style="font-size:11px;opacity:.7">0 = padrão · 1 = tamanho base · 2 = dobro do espaço no grid</span></label>
        <label><b>Macro visual da transformação</b><select data-vc-visual-mode style="width:100%"></select></label>
        <select data-vc-macro style="width:100%"></select>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" data-vc-preview-token style="flex:1"><i class="fas fa-eye"></i> Testar token</button>
          <button type="button" data-vc-test-macro style="flex:1"><i class="fas fa-play"></i> Testar macro</button>
          <button type="button" data-vc-clear style="flex:1"><i class="fas fa-undo"></i> Voltar ao padrão</button>
        </div>
        <p style="font-size:11px;opacity:.7;margin:0;">Isto altera apenas aparência. Os bônus, Traits, custos e limites da Transformation continuam vindo da ficha/DBU.</p>
      </div>
    `,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: "Salvar",
        callback: async html => {
          const root = getRoot(html);
          const row = rows[number(root.querySelector("[data-vc-transform]")?.value, 0)];
          if (!row) return;
          const value = {
            name: row.name,
            tokenMode: normalizeMode(root.querySelector("[data-vc-token-mode]")?.value),
            token: String(root.querySelector("[data-vc-token]")?.value || "").trim(),
            gridScale: Math.max(0, number(root.querySelector("[data-vc-token-scale]")?.value, 0)),
            visualMode: normalizeMode(root.querySelector("[data-vc-visual-mode]")?.value),
            visualMacro: String(root.querySelector("[data-vc-macro]")?.value || "").trim()
          };
          if (value.tokenMode === "custom" && !value.token) return ui.notifications.warn("Escolha a imagem do token.");
          if (value.visualMode === "custom" && !value.visualMacro) return ui.notifications.warn("Selecione o macro visual.");
          await saveCategoryEntry(actor, "transformations", row.key, value);
          ui.notifications.info(`${actor.name}: visual de ${row.name} salvo.`);
        }
      },
      close: { label: "Fechar" }
    },
    default: "save",
    render: html => {
      const root = getRoot(html);
      const transSelect = root.querySelector("[data-vc-transform]");
      const tokenMode = root.querySelector("[data-vc-token-mode]");
      const tokenInput = root.querySelector("[data-vc-token]");
      const tokenScale = root.querySelector("[data-vc-token-scale]");
      const visualMode = root.querySelector("[data-vc-visual-mode]");
      const macroSelect = root.querySelector("[data-vc-macro]");
      const inherited = root.querySelector("[data-vc-inherited]");

      const load = () => {
        const row = rows[number(transSelect.value, 0)];
        const stored = cfg.transformations?.[row.key] || {};
        const legacy = legacyTransformation(actor, row.trans);
        tokenMode.innerHTML = modeOptions(normalizeMode(stored.tokenMode), "Usar esta imagem");
        tokenInput.value = String(stored.token || "");
        tokenScale.value = Math.max(0, number(stored.gridScale ?? stored.tokenScale, 0));
        visualMode.innerHTML = modeOptions(normalizeMode(stored.visualMode), "Usar este macro");
        macroSelect.innerHTML = macroOptions(String(stored.visualMacro || ""));
        inherited.innerHTML = `<b>Configuração antiga:</b> Token ${legacy.token ? esc(legacy.token) : "—"} · escala visual antiga ${legacy.tokenScale || "—"} · Visual ${legacy.visualMacro ? esc(legacy.visualMacro) : "—"}<br><b>v1.5.3:</b> o novo tamanho configurado altera width/height e ocupa o espaço real no grid.`;
        update();
      };

      const update = () => {
        tokenInput.disabled = tokenMode.value !== "custom";
        tokenScale.disabled = tokenMode.value === "none";
        macroSelect.disabled = visualMode.value !== "custom";
      };

      transSelect.addEventListener("change", load);
      tokenMode.addEventListener("change", update);
      visualMode.addEventListener("change", update);
      root.querySelector("[data-vc-browse-token]")?.addEventListener("click", e => {
        e.preventDefault();
        if (tokenMode.value !== "custom") tokenMode.value = "custom";
        filePicker(tokenInput, "imagevideo");
        update();
      });
      root.querySelector("[data-vc-preview-token]")?.addEventListener("click", async e => {
        e.preventDefault();
        const row = rows[number(transSelect.value, 0)];
        const legacy = legacyTransformation(actor, row.trans);
        const src = tokenMode.value === "custom" ? tokenInput.value.trim() : (tokenMode.value === "inherit" ? legacy.token : "");
        const gridScale = Math.max(0, number(tokenScale.value, 0));
        await previewToken(actor, token, src, gridScale);
      });
      root.querySelector("[data-vc-test-macro]")?.addEventListener("click", async e => {
        e.preventDefault();
        const row = rows[number(transSelect.value, 0)];
        const legacy = legacyTransformation(actor, row.trans);
        let name = "";
        if (visualMode.value === "custom") name = macroSelect.value;
        else if (visualMode.value === "inherit") name = legacy.visualMacro;
        await executeMacroPreview(actor, token, name, {
          transformation: row.trans,
          transformationData: row.trans,
          phase: "preview",
          active: true,
          action: "transformation"
        });
      });
      root.querySelector("[data-vc-clear]")?.addEventListener("click", async e => {
        e.preventDefault();
        const row = rows[number(transSelect.value, 0)];
        await clearCategoryEntry(actor, "transformations", row.key);
        delete cfg.transformations[row.key];
        load();
        ui.notifications.info(`${row.name}: configuração personalizada removida.`);
      });
      load();
    }
  }, { width: 570 });

  dialog.render(true);
  return dialog;
}


function legacySignatureAura(actor, aura) {
  const tags = noteTagMap(actor);
  const nameKey = normalizeTag(aura?.name || aura?.gainedAuraKey || aura?.id || "AURA");
  return {
    gif: tags[`SIGNATURE_AURA_${nameKey}_GIF`] || tags.AURA_GIF || "",
    activateMacro: tags[`SIGNATURE_AURA_${nameKey}_VISUAL`] || tags[`AURA_${nameKey}_VISUAL`] || tags.AURA_VISUAL || "",
    deactivateMacro: tags[`SIGNATURE_AURA_${nameKey}_VISUAL_OFF`] || tags[`AURA_${nameKey}_VISUAL_OFF`] || tags.AURA_VISUAL_OFF || ""
  };
}

async function signatureAuraRows(actor) {
  let prepared = [];
  try {
    const data = await actor?.sheet?.getData?.();
    if (Array.isArray(data?.signatureAuras)) prepared = data.signatureAuras;
  } catch (error) {
    console.warn("DBU Visual | preparando Signature Auras:", error);
  }
  if (!prepared.length) prepared = actor?.system?.signatureAuras || [];
  return prepared.filter(Boolean).map((aura, index) => ({
    key: signatureAuraConfigKey(aura) || `own:${aura?.id ?? index}`,
    name: aura?.name || `Signature Aura ${index + 1}`,
    aura
  }));
}

async function openSignatureAuraConfigurator(actor, token) {
  const rows = await signatureAuraRows(actor);
  if (!rows.length) return ui.notifications.warn(`${actor.name} não possui Signature Auras configuradas.`);
  const cfg = cloneConfig(actor);
  const options = rows.map((row, index) => `<option value="${index}">${esc(row.name)}</option>`).join("");

  const dialog = new Dialog({
    title: `${actor.name} — Visuais de Signature Aura`,
    content: `
      <div class="dbu-visual-config" style="display:grid;gap:9px;">
        <label><b>Signature Aura</b><select data-vc-aura style="width:100%">${options}</select></label>
        <div data-vc-inherited style="font-size:11px;opacity:.75;padding:6px;border:1px solid rgba(255,255,255,.12);border-radius:4px;"></div>

        <label><b>GIF da carta</b><select data-vc-gif-mode style="width:100%"></select></label>
        <div style="display:flex;gap:5px;align-items:center;">
          <input data-vc-gif type="text" style="flex:1" placeholder="worlds/.../aura.gif">
          <button type="button" data-vc-browse-gif><i class="fas fa-folder-open"></i></button>
        </div>
        <div data-vc-gif-preview></div>

        <label><b>Macro ao ativar</b><select data-vc-activate-mode style="width:100%"></select></label>
        <select data-vc-activate-macro style="width:100%"></select>
        <button type="button" data-vc-test-activate><i class="fas fa-play"></i> Testar ativação</button>

        <label><b>Macro ao desativar</b><select data-vc-deactivate-mode style="width:100%"></select></label>
        <select data-vc-deactivate-macro style="width:100%"></select>
        <button type="button" data-vc-test-deactivate><i class="fas fa-stop"></i> Testar desativação</button>

        <button type="button" data-vc-clear><i class="fas fa-undo"></i> Voltar ao padrão</button>
        <p style="font-size:11px;opacity:.7;margin:0;">Se a desativação ficar em “padrão” e a ativação usar um macro personalizado, o módulo reutiliza o mesmo macro com <code>phase: "deactivate"</code> para facilitar a limpeza de efeitos persistentes.</p>
      </div>`,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>', label: "Salvar",
        callback: async html => {
          const root = getRoot(html);
          const row = rows[number(root.querySelector("[data-vc-aura]")?.value, 0)];
          if (!row) return;
          const value = {
            name: row.name,
            gifMode: normalizeMode(root.querySelector("[data-vc-gif-mode]")?.value),
            gif: String(root.querySelector("[data-vc-gif]")?.value || "").trim(),
            activateMode: normalizeMode(root.querySelector("[data-vc-activate-mode]")?.value),
            activateMacro: String(root.querySelector("[data-vc-activate-macro]")?.value || "").trim(),
            deactivateMode: normalizeMode(root.querySelector("[data-vc-deactivate-mode]")?.value),
            deactivateMacro: String(root.querySelector("[data-vc-deactivate-macro]")?.value || "").trim()
          };
          if (value.gifMode === "custom" && !value.gif) return ui.notifications.warn("Informe o GIF da Signature Aura.");
          if (value.activateMode === "custom" && !value.activateMacro) return ui.notifications.warn("Selecione o macro de ativação.");
          if (value.deactivateMode === "custom" && !value.deactivateMacro) return ui.notifications.warn("Selecione o macro de desativação.");
          await saveCategoryEntry(actor, "signatureAuras", row.key, value);
          ui.notifications.info(`${actor.name}: visual de ${row.name} salvo.`);
        }
      },
      close: { label: "Fechar" }
    },
    default: "save",
    render: html => {
      const root = getRoot(html);
      const auraSelect = root.querySelector("[data-vc-aura]");
      const gifMode = root.querySelector("[data-vc-gif-mode]");
      const gifInput = root.querySelector("[data-vc-gif]");
      const gifPreview = root.querySelector("[data-vc-gif-preview]");
      const activateMode = root.querySelector("[data-vc-activate-mode]");
      const activateMacro = root.querySelector("[data-vc-activate-macro]");
      const deactivateMode = root.querySelector("[data-vc-deactivate-mode]");
      const deactivateMacro = root.querySelector("[data-vc-deactivate-macro]");
      const inherited = root.querySelector("[data-vc-inherited]");

      const update = () => {
        const row = rows[number(auraSelect.value, 0)];
        const legacy = legacySignatureAura(actor, row?.aura);
        const src = gifMode.value === "custom" ? gifInput.value.trim() : (gifMode.value === "inherit" ? legacy.gif : "");
        gifPreview.innerHTML = src ? `<img src="${esc(src)}" style="display:block;max-width:100%;max-height:150px;margin:4px auto;border-radius:5px;object-fit:contain;">` : "";
        gifInput.disabled = gifMode.value !== "custom";
        activateMacro.disabled = activateMode.value !== "custom";
        deactivateMacro.disabled = deactivateMode.value !== "custom";
      };

      const load = () => {
        const row = rows[number(auraSelect.value, 0)];
        const stored = cfg.signatureAuras?.[row.key] || {};
        const legacy = legacySignatureAura(actor, row.aura);
        gifMode.innerHTML = modeOptions(normalizeMode(stored.gifMode), "Usar este GIF/arquivo");
        gifInput.value = String(stored.gif || "");
        activateMode.innerHTML = modeOptions(normalizeMode(stored.activateMode), "Usar este macro");
        activateMacro.innerHTML = macroOptions(String(stored.activateMacro || ""));
        deactivateMode.innerHTML = modeOptions(normalizeMode(stored.deactivateMode), "Usar este macro");
        deactivateMacro.innerHTML = macroOptions(String(stored.deactivateMacro || ""));
        inherited.innerHTML = `<b>Configuração antiga:</b> GIF ${legacy.gif ? esc(legacy.gif) : "—"} · Ativar ${legacy.activateMacro ? esc(legacy.activateMacro) : "—"} · Desativar ${legacy.deactivateMacro ? esc(legacy.deactivateMacro) : "—"}`;
        update();
      };

      auraSelect.addEventListener("change", load);
      gifMode.addEventListener("change", update);
      gifInput.addEventListener("input", update);
      activateMode.addEventListener("change", update);
      deactivateMode.addEventListener("change", update);
      root.querySelector("[data-vc-browse-gif]")?.addEventListener("click", e => { e.preventDefault(); gifMode.value = "custom"; filePicker(gifInput, "image"); update(); });
      root.querySelector("[data-vc-test-activate]")?.addEventListener("click", async e => {
        e.preventDefault();
        const row = rows[number(auraSelect.value, 0)];
        const legacy = legacySignatureAura(actor, row.aura);
        const name = activateMode.value === "custom" ? activateMacro.value : (activateMode.value === "inherit" ? legacy.activateMacro : "");
        await executeMacroPreview(actor, token, name, { aura: row.aura, signatureAura: row.aura, phase: "activate", active: true, action: "signature-aura" });
      });
      root.querySelector("[data-vc-test-deactivate]")?.addEventListener("click", async e => {
        e.preventDefault();
        const row = rows[number(auraSelect.value, 0)];
        const legacy = legacySignatureAura(actor, row.aura);
        let name = deactivateMode.value === "custom" ? deactivateMacro.value : (deactivateMode.value === "inherit" ? legacy.deactivateMacro : "");
        if (!name && deactivateMode.value === "inherit" && activateMode.value === "custom") name = activateMacro.value;
        await executeMacroPreview(actor, token, name, { aura: row.aura, signatureAura: row.aura, phase: "deactivate", active: false, action: "signature-aura" });
      });
      root.querySelector("[data-vc-clear]")?.addEventListener("click", async e => {
        e.preventDefault();
        const row = rows[number(auraSelect.value, 0)];
        await clearCategoryEntry(actor, "signatureAuras", row.key);
        delete cfg.signatureAuras[row.key];
        load();
        ui.notifications.info(`${row.name}: configuração personalizada removida.`);
      });
      load();
    }
  }, { width: 580 });
  dialog.render(true);
  return dialog;
}

const CHARGE_STAGES = [
  ["1", "1 EC", 1],
  ["2", "2 EC", 2],
  ["3", "3 EC", 3],
  ["4", "4 EC", 4],
  ["MAX", "MAX — 5+ EC", 5]
];

function legacyEnergyChargeMacro(actor, stage) {
  const tags = noteTagMap(actor);
  return tags[`CHARGE_VISUAL_${stage}`] || tags.CHARGE_VISUAL || "";
}

async function openEnergyChargeConfigurator(actor, token) {
  const cfg = cloneConfig(actor);
  const rowsHtml = CHARGE_STAGES.map(([stage, label]) => {
    const stored = cfg.energyCharge?.[stage] || {};
    return `<div data-vc-charge-row="${stage}" style="display:grid;grid-template-columns:120px 1fr 1.4fr auto;gap:6px;align-items:center;padding:6px;border:1px solid rgba(255,255,255,.10);border-radius:4px;">
      <b>${esc(label)}</b>
      <select data-vc-charge-mode>${modeOptions(normalizeMode(stored.mode), "Usar este macro")}</select>
      <select data-vc-charge-macro>${macroOptions(String(stored.macro || ""))}</select>
      <button type="button" data-vc-charge-test title="Testar estágio"><i class="fas fa-play"></i></button>
    </div>`;
  }).join("");

  const dialog = new Dialog({
    title: `${actor.name} — Visual do Energy Charge`,
    content: `<div class="dbu-visual-config" style="display:grid;gap:8px;">
      <p style="margin:0;">Cada estágio executa um <b>macro visual</b>. MAX é usado com <b>5 ou mais Energy Charges</b>.</p>
      ${rowsHtml}
      <div style="font-size:11px;opacity:.75;padding:6px;border:1px solid rgba(255,255,255,.12);border-radius:4px;">
        Se um estágio estiver em padrão, ele herda o macro personalizado do estágio anterior mais próximo. Se nenhum existir, usa CHARGE_VISUAL das Notes / Visual Energy Charge antigo.
      </div>
      <button type="button" data-vc-charge-clear><i class="fas fa-undo"></i> Remover personalização dos estágios</button>
    </div>`,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>', label: "Salvar",
        callback: async html => {
          const root = getRoot(html);
          const next = cloneConfig(actor);
          next.energyCharge = {};
          for (const [stage] of CHARGE_STAGES) {
            const row = root.querySelector(`[data-vc-charge-row="${stage}"]`);
            const mode = normalizeMode(row?.querySelector("[data-vc-charge-mode]")?.value);
            const macro = String(row?.querySelector("[data-vc-charge-macro]")?.value || "").trim();
            if (mode === "custom" && !macro) return ui.notifications.warn(`Selecione o macro do estágio ${stage}.`);
            next.energyCharge[stage] = { mode, macro };
          }
          next.version = CONFIG_VERSION;
          await actor.setFlag(MODULE_ID, FLAG_KEY, next);
          ui.notifications.info(`${actor.name}: macros de Energy Charge salvos.`);
        }
      },
      close: { label: "Fechar" }
    },
    default: "save",
    render: html => {
      const root = getRoot(html);
      const rowElements = [...root.querySelectorAll("[data-vc-charge-row]")];
      const updateRow = row => {
        const mode = row.querySelector("[data-vc-charge-mode]");
        const macro = row.querySelector("[data-vc-charge-macro]");
        macro.disabled = mode.value !== "custom";
      };
      const effectiveFromUi = stage => {
        const order = CHARGE_STAGES.map(x => x[0]);
        const idx = order.indexOf(stage);
        for (let i = idx; i >= 0; i--) {
          const st = order[i];
          const row = root.querySelector(`[data-vc-charge-row="${st}"]`);
          const mode = normalizeMode(row?.querySelector("[data-vc-charge-mode]")?.value);
          const macro = String(row?.querySelector("[data-vc-charge-macro]")?.value || "").trim();
          if (i === idx && mode === "none") return "";
          if (mode === "custom" && macro) return macro;
          if (i < idx && mode === "none") return "";
        }
        return legacyEnergyChargeMacro(actor, stage) || (typeof globalThis.DBUAutomation?.visualEnergyCharge === "function" ? "Visual Energy Charge" : "");
      };
      for (const row of rowElements) {
        const mode = row.querySelector("[data-vc-charge-mode]");
        mode.addEventListener("change", () => updateRow(row));
        row.querySelector("[data-vc-charge-test]")?.addEventListener("click", async e => {
          e.preventDefault();
          const stage = row.dataset.vcChargeRow;
          const info = CHARGE_STAGES.find(x => x[0] === stage);
          const totalCharges = info?.[2] || 1;
          const name = effectiveFromUi(stage);
          if (!name) return ui.notifications.warn(`Nenhum visual ativo para o estágio ${stage}.`);
          if (name === "Visual Energy Charge" && typeof globalThis.DBUAutomation?.visualEnergyCharge === "function") {
            await globalThis.DBUAutomation.visualEnergyCharge({ actor, token, stage, totalCharges, mode: "update", preview: true, phase: "preview" });
          } else {
            await executeMacroPreview(actor, token, name, { stage, totalCharges, energyCharge: totalCharges, gatheredCharges: totalCharges, mode: "preview", phase: "preview", action: "energy-charge" });
          }
        });
        updateRow(row);
      }
      root.querySelector("[data-vc-charge-clear]")?.addEventListener("click", async e => {
        e.preventDefault();
        const next = cloneConfig(actor);
        next.energyCharge = {};
        next.version = CONFIG_VERSION;
        await actor.setFlag(MODULE_ID, FLAG_KEY, next);
        for (const row of rowElements) {
          row.querySelector("[data-vc-charge-mode]").value = "inherit";
          row.querySelector("[data-vc-charge-macro]").value = "";
          updateRow(row);
        }
        ui.notifications.info(`${actor.name}: personalização de Energy Charge removida.`);
      });
    }
  }, { width: 760 });
  dialog.render(true);
  return dialog;
}


const COMBAT_REACTIONS = [
  ["defenseWall", "Defense Wall", "fas fa-shield-alt"],
  ["deflect", "Deflect", "fas fa-random"],
  ["distantDeflect", "Distant Deflect", "fas fa-exchange-alt"],
  ["reflect", "Reflect", "fas fa-reply"],
  ["duelClash", "Duel Clash", "fas fa-bolt"]
];

async function openCombatReactionConfigurator(actor, token) {
  const cfg = cloneConfig(actor);
  const options = COMBAT_REACTIONS.map(([key,label], index) =>
    `<option value="${index}">${esc(label)}</option>`
  ).join("");

  let dialog;
  dialog = new Dialog({
    title: `${actor.name} — Visuais de Combate`,
    content: `
      <div class="dbu-visual-config dbu-auto-window" style="display:grid;gap:9px;">
        <div class="dbu-auto-section">
          <div class="dbu-auto-section-title purple"><span><i class="fas fa-magic"></i> Reações de Combate</span></div>
          <div class="dbu-auto-section-body" style="display:grid;gap:8px;">
            <label><b>Ação</b><select data-vc-reaction style="width:100%">${options}</select></label>
            <label><b>Visual</b><select data-vc-reaction-mode style="width:100%"></select></label>
            <label><b>Macro visual</b><select data-vc-reaction-macro style="width:100%"></select></label>
            <div class="dbu-auto-template-hint">
              Um único macro recebe a fase da ação. Exemplos: <code>start</code>, <code>success</code>, <code>fail</code>,
              <code>launch</code>, <code>accept</code>, <code>reveal</code>, <code>resolve</code>,
              <code>win</code>, <code>lose</code>, <code>tie</code>, <code>escape-success</code> e <code>escape-fail</code>.
            </div>
            <div style="display:flex;gap:6px;">
              <button type="button" data-vc-reaction-test style="flex:1"><i class="fas fa-play"></i> Testar</button>
              <button type="button" data-vc-reaction-clear style="flex:1"><i class="fas fa-undo"></i> Voltar ao padrão</button>
            </div>
          </div>
        </div>
      </div>
    `,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: "Salvar",
        callback: async html => {
          const root = getRoot(html);
          const entry = COMBAT_REACTIONS[number(root.querySelector("[data-vc-reaction]")?.value, 0)];
          if (!entry) return;
          const [key,label] = entry;
          const mode = normalizeMode(root.querySelector("[data-vc-reaction-mode]")?.value);
          const macro = String(root.querySelector("[data-vc-reaction-macro]")?.value || "").trim();
          if (mode === "custom" && !macro) return ui.notifications.warn(`Selecione um macro para ${label}.`);
          await saveCategoryEntry(actor, "combatReactions", key, { mode, macro, label });
          ui.notifications.info(`${actor.name}: visual de ${label} salvo.`);
        }
      },
      close: { label: "Fechar" }
    },
    default: "save",
    render: html => {
      const root = getRoot(html);
      const action = root.querySelector("[data-vc-reaction]");
      const mode = root.querySelector("[data-vc-reaction-mode]");
      const macro = root.querySelector("[data-vc-reaction-macro]");
      const load = () => {
        const [key] = COMBAT_REACTIONS[number(action.value,0)] || [];
        const stored = cfg.combatReactions?.[key] || {};
        mode.innerHTML = modeOptions(normalizeMode(stored.mode), "Usar este macro");
        macro.innerHTML = macroOptions(String(stored.macro || ""));
        macro.disabled = mode.value !== "custom";
      };
      action.addEventListener("change", load);
      mode.addEventListener("change", () => { macro.disabled = mode.value !== "custom"; });
      root.querySelector("[data-vc-reaction-test]")?.addEventListener("click", async e => {
        e.preventDefault();
        const [key,label] = COMBAT_REACTIONS[number(action.value,0)] || [];
        let name = mode.value === "custom" ? macro.value : "";
        if (!name) return ui.notifications.warn(`${label || "Ação"}: nenhum macro personalizado selecionado.`);
        await executeMacroPreview(actor, token, name, {
          reactionType:key, phase:"preview", success:true, action:key, combatReaction:key
        });
      });
      root.querySelector("[data-vc-reaction-clear]")?.addEventListener("click", async e => {
        e.preventDefault();
        const [key,label] = COMBAT_REACTIONS[number(action.value,0)] || [];
        if (!key) return;
        await clearCategoryEntry(actor,"combatReactions",key);
        delete cfg.combatReactions[key];
        load();
        ui.notifications.info(`${label}: configuração personalizada removida.`);
      });
      load();
    }
  }, { width: 620 });
  dialog.render(true);
  return dialog;
}

export async function openVisualConfigurator(context = {}) {
  const actor = actorFromContext(context);
  if (!actor) {
    ui.notifications.warn("DBU Visual: selecione um token ou configure um personagem para o usuário.");
    return null;
  }
  if (!canControl(actor)) {
    ui.notifications.warn(`Você não controla ${actor.name}.`);
    return null;
  }

  const token = tokenForActor(actor, context);

  const choice = await Dialog.wait({
    title: `${actor.name} — Configurar Visuais`,
    content: `
      <div class="dbu-auto-window dbu-auto-visual-menu">
        <p style="margin:0 0 4px;">Escolha o que deseja personalizar para <b>${esc(actor.name)}</b>.</p>
        <button type="button" data-choice="attacks" style="min-height:44px"><i class="fas fa-fist-raised"></i> Ataques — GIF + macro visual</button>
        <button type="button" data-choice="defenses" style="min-height:44px"><i class="fas fa-shield-alt"></i> Defesas — GIF + macro visual</button>
        <button type="button" data-choice="transformations" style="min-height:44px"><i class="fas fa-dragon"></i> Transformações — token + macro visual</button>
        <button type="button" data-choice="signatureAuras" style="min-height:44px"><i class="fas fa-sun"></i> Signature Auras — GIF + macros de ativar/desativar</button>
        <button type="button" data-choice="energyCharge" style="min-height:44px"><i class="fas fa-bolt"></i> Energy Charge — macro por estágio (1/2/3/4/MAX)</button>
        <button type="button" data-choice="combatReactions" style="min-height:44px"><i class="fas fa-magic"></i> Intervene / Deflect / Reflect / Duel — macro por ação</button>
        <div style="font-size:11px;opacity:.7;margin-top:4px;">As preferências ficam salvas somente neste personagem. O jogador não edita o JavaScript dos macros.</div>
      </div>
    `,
    buttons: { close: { label: "Fechar", callback: () => null } },
    close: () => null,
    render: html => {
      const root = getRoot(html);
      for (const button of root.querySelectorAll("[data-choice]")) {
        button.addEventListener("click", () => {
          const app = button.closest(".app");
          const appId = app?.dataset?.appid;
          const dialog = appId ? ui.windows?.[appId] : null;
          dialog?.close?.();
          const choice = button.dataset.choice;
          if (choice === "attacks") openAttackConfigurator(actor, token);
          else if (choice === "defenses") openDefenseConfigurator(actor, token);
          else if (choice === "transformations") openTransformationConfigurator(actor, token);
          else if (choice === "signatureAuras") openSignatureAuraConfigurator(actor, token);
          else if (choice === "energyCharge") openEnergyChargeConfigurator(actor, token);
          else if (choice === "combatReactions") openCombatReactionConfigurator(actor, token);
        });
      }
    }
  });

  return choice;
}

export const VisualConfig = {
  moduleId: MODULE_ID,
  flagKey: FLAG_KEY,
  getVisualConfig,
  getAttackVisualSettings,
  getDefenseVisualSettings,
  getTransformationVisualSettings,
  getSignatureAuraVisualSettings,
  getEnergyChargeVisualSettings,
  getCombatVisualSettings,
  openVisualConfigurator
};
