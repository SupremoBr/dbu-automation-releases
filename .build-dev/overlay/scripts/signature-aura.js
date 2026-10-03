import { getSignatureAuraVisualSettings } from "./visual-config.js";
import { MODULE_ID, AURA_MAINTENANCE_FLAG, auraRuntime } from "./signature-aura/state.js";

// O DBU prepara finalKP e maintenanceKP em unidades (T).
// Ex.: 11(T) em Tier 2 = 22 KP reais.
// A v1.1.3 corrige a automação para cobrar o valor real em KP/Capacity.
const AURA_COSTS_USE_TIER = true;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getActorFromContext(context = {}) {
  const directActor = context?.actor;
  if (directActor?.documentName === "Actor") return directActor;

  const directToken = context?.token?.document ?? context?.token;
  if (directToken?.actor) return directToken.actor;

  const controlled = canvas?.tokens?.controlled || [];
  if (controlled.length === 1 && controlled[0]?.actor) {
    return controlled[0].actor;
  }

  if (controlled.length > 1) {
    ui.notifications.warn("DBU Aura: selecione somente um token.");
    return null;
  }

  if (game.user?.character) return game.user.character;

  ui.notifications.warn("DBU Aura: selecione um token ou vincule um personagem ao usuário.");
  return null;
}

function canControl(actor) {
  return !!actor && (game.user?.isGM || actor.isOwner);
}

async function prepareAuraData(actor) {
  const sheet = actor?.sheet;
  if (!sheet) throw new Error(`Ficha de ${actor?.name || "Actor"} não encontrada.`);

  const data = await sheet.getData();
  const prepared = Array.isArray(data?.signatureAuras)
    ? data.signatureAuras
    : [];

  return { sheet, data, auras: prepared };
}

function activePreparedAura(auras) {
  return (auras || []).find(a => a?.active) || null;
}

function auraKey(aura) {
  if (!aura) return "";
  if (aura.gainedAuraKey) return `gained:${aura.gainedAuraKey}`;
  return `own:${aura.id}`;
}


function normalizeAuraTag(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function auraNoteTags(actor) {
  let text = String(actor?.system?.notes || "");
  try {
    if (/<[a-z][\s\S]*>/i.test(text)) {
      const div = document.createElement("div");
      div.innerHTML = text;
      text = div.innerText || div.textContent || text;
    }
  } catch {}
  const tags = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    tags[normalizeAuraTag(m[1])] = String(m[2] || "").trim();
  }
  return tags;
}

function legacyAuraVisual(actor, aura) {
  const tags = auraNoteTags(actor);
  const nameKey = normalizeAuraTag(aura?.name || aura?.gainedAuraKey || aura?.id || "AURA");
  return {
    gif: tags[`SIGNATURE_AURA_${nameKey}_GIF`] || tags.AURA_GIF || "",
    activateMacro: tags[`SIGNATURE_AURA_${nameKey}_VISUAL`] || tags[`AURA_${nameKey}_VISUAL`] || tags.AURA_VISUAL || "",
    deactivateMacro: tags[`SIGNATURE_AURA_${nameKey}_VISUAL_OFF`] || tags[`AURA_${nameKey}_VISUAL_OFF`] || tags.AURA_VISUAL_OFF || ""
  };
}

function auraGif(actor, aura) {
  const custom = getSignatureAuraVisualSettings(actor, aura);
  if (custom?.gifMode === "none") return "";
  if (custom?.gifMode === "custom") return custom.gif || "";
  return legacyAuraVisual(actor, aura).gif || "";
}

function auraMacro(actor, aura, phase) {
  const custom = getSignatureAuraVisualSettings(actor, aura);
  const legacy = legacyAuraVisual(actor, aura);
  if (phase === "activate") {
    if (custom?.activateMode === "none") return "";
    if (custom?.activateMode === "custom") return custom.activateMacro || "";
    return legacy.activateMacro || "";
  }

  if (custom?.deactivateMode === "none") return "";
  if (custom?.deactivateMode === "custom") return custom.deactivateMacro || "";
  // Se não houver macro OFF legado, reutiliza o macro customizado de ativação
  // com phase=deactivate. Isso facilita macros Sequencer persistentes.
  return legacy.deactivateMacro
    || (custom?.activateMode === "custom" ? custom.activateMacro : "")
    || "";
}

async function playAuraVisual(actor, aura, phase) {
  const macroName = String(auraMacro(actor, aura, phase) || "").trim();
  if (!macroName) return;
  const macro = game.macros?.getName?.(macroName);
  if (!macro) {
    console.warn(`DBU Automation | Macro visual de Signature Aura não encontrado: ${macroName}`);
    return;
  }
  const tokens = actor.getActiveTokens?.() || [];
  for (const token of tokens.length ? tokens : [null]) {
    try {
      await macro.execute({
        actor,
        token,
        aura,
        signatureAura: aura,
        phase,
        active: phase === "activate",
        action: "signature-aura"
      });
    } catch (error) {
      console.warn(`DBU Automation | visual Signature Aura (${phase}):`, error);
    }
  }
}

function hasDisadvantage(aura, name) {
  return (aura?.disadvantages || []).some(d => d?.name === name);
}

function auraCostUnits(preparedAura, kind = "activation") {
  return Math.max(0, Number(
    kind === "maintenance"
      ? preparedAura?.maintenanceKP
      : preparedAura?.finalKP
  ) || 0);
}

function actualCost(actor, preparedAura, kind = "activation") {
  const units = auraCostUnits(preparedAura, kind);
  if (!AURA_COSTS_USE_TIER) return units;
  const tier = Math.max(1, Number(actor?.system?.tier || 1));
  return Math.max(0, units * tier);
}

function costText(actor, preparedAura, kind = "activation") {
  const units = auraCostUnits(preparedAura, kind);
  const tier = Math.max(1, Number(actor?.system?.tier || 1));
  const actual = actualCost(actor, preparedAura, kind);
  return tier > 1
    ? `${units}(T) = ${actual} KP`
    : `${units}(T) = ${actual} KP`;
}

function capacitySnapshot(actor) {
  const helper = globalThis.DBU?.getCapacity;
  if (typeof helper === "function") return helper(actor);

  const max = Number(actor?.system?.status?.maxCapacity || 0);
  const spent = Number(actor?.system?.status?.capacitySpent || 0);
  return { max, spent, left: Math.max(0, max - spent) };
}

async function pay(actor, amount, label) {
  amount = Math.max(0, Number(amount) || 0);

  const helper = globalThis.DBU?.payKiAndCapacity;
  if (typeof helper === "function") {
    return helper(actor, amount, label);
  }

  if (!amount) return { ok: true, amount: 0 };

  const ki = Number(actor?.system?.kiPool?.value || 0);
  const cap = capacitySnapshot(actor);

  if (ki < amount) {
    ui.notifications.warn(`${actor.name}: Ki insuficiente. Necessário ${amount} KP.`);
    return { ok: false, reason: "ki" };
  }

  if (cap.max > 0 && cap.left < amount) {
    ui.notifications.warn(
      `${actor.name}: Capacity insuficiente. Restante ${cap.left}, necessário ${amount}.`
    );
    return { ok: false, reason: "capacity" };
  }

  await actor.update({
    "system.kiPool.value": ki - amount,
    "system.status.capacitySpent": cap.spent + amount
  });

  return { ok: true, amount };
}

async function postAuraCard(actor, title, body, icon = "fa-sun", gif = "") {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="dbu-attack-roll dbu-aura-card" data-actor-id="${esc(actor.id)}">
        <h3 class="dbu-attack-title">
          <span class="dbu-card-title-text">
            <i class="fas ${icon}"></i> ${esc(actor.name)} — ${esc(title)}
          </span>
        </h3>
        <div class="dbu-card-body">
          ${gif ? `<div style="text-align:center;margin:5px 0 8px;"><img src="${esc(gif)}" style="max-width:100%;max-height:220px;object-fit:contain;border-radius:5px;"></div>` : ""}
          ${body}
        </div>
      </div>
    `
  });
}

async function burnoutReminder(actor, aura) {
  if (!hasDisadvantage(aura, "Burnout")) return;

  await postAuraCard(
    actor,
    aura?.name || "Aura",
    `<div class="dbu-defend-guide">
      <b>Burnout:</b> ao sair desta Aura, você ganha a condição
      <b>Fatigued</b> até o fim do seu próximo turno.
      <br><em>A condição continua como lembrete manual, igual ao macro anterior.</em>
    </div>`,
    "fa-fire"
  );
}

async function setAuraState(actor, preparedAura, makeActive) {
  const ownAuras = foundry.utils.deepClone(actor.system.signatureAuras || []);
  const fusion = foundry.utils.deepClone(actor.system.fusion || {});
  const update = {};

  if (preparedAura?.gainedAuraKey) {
    if (makeActive) {
      for (const a of ownAuras) a.active = false;
      update["system.signatureAuras"] = ownAuras;
      update["system.fusion.activeGainedAuraId"] = preparedAura.gainedAuraKey;
    } else if (fusion.activeGainedAuraId === preparedAura.gainedAuraKey) {
      update["system.fusion.activeGainedAuraId"] = "";
    }
  } else {
    const id = Number(preparedAura?.id);
    const aura = ownAuras.find(a => Number(a.id) === id);
    if (!aura) throw new Error("Aura não encontrada em system.signatureAuras.");

    if (makeActive) {
      for (const a of ownAuras) a.active = Number(a.id) === id;
      update["system.signatureAuras"] = ownAuras;
      if (fusion.activeGainedAuraId) {
        update["system.fusion.activeGainedAuraId"] = "";
      }
    } else {
      aura.active = false;
      update["system.signatureAuras"] = ownAuras;
    }
  }

  if (Object.keys(update).length) await actor.update(update);
}

async function deactivateAura(actor, preparedAura, { reason = "manual", silent = false } = {}) {
  if (!preparedAura) return false;

  await setAuraState(actor, preparedAura, false);
  await playAuraVisual(actor, preparedAura, "deactivate");
  await burnoutReminder(actor, preparedAura);

  if (!silent) {
    const reasonText = reason === "maintenance"
      ? "Aura encerrada por não ser mantida."
      : "Aura desativada.";

    await postAuraCard(
      actor,
      preparedAura.name || "Aura",
      `<div class="dbu-attack-buffs"><strong>🔻 ${esc(reasonText)}</strong></div>`,
      "fa-circle-down",
      auraGif(actor, preparedAura)
    );
  }

  return true;
}

async function entryBlocked(actor, preparedAura, sheet) {
  if (typeof sheet?._auraEntryBlocked === "function") {
    try {
      return !!sheet._auraEntryBlocked(preparedAura);
    } catch (error) {
      console.warn("DBU Automation | Aura entry gate nativo falhou:", error);
    }
  }

  // Fallback mínimo caso o método do sistema mude.
  const sys = actor.system || {};

  if (hasDisadvantage(preparedAura, "Base Aura")) {
    const formTypes = ["form_alternate", "form_legendary"];
    const inCore = [
      ...(sys.transformations || []),
      ...(sys._gainedActiveTransformations || [])
    ].some(t => t?.active && formTypes.includes(t.transformationType));

    if (inCore) {
      ui.notifications.warn(
        `${preparedAura.name || "Aura"} possui Base Aura e não pode ser usada em uma Core Transformation.`
      );
      return true;
    }
  }

  const restricted = (preparedAura.disadvantages || [])
    .find(d => d?.name === "Restricted Aura");
  const wanted = String(restricted?.notes || "").trim().toLowerCase();

  if (restricted && wanted) {
    const activeForms = [
      ...(sys.transformations || []),
      ...(sys._gainedActiveTransformations || [])
    ].filter(t => t?.active);

    const matches = activeForms.some(t => {
      const n = String(t?.name || "").trim().toLowerCase();
      return n && (n.includes(wanted) || wanted.includes(n));
    });

    if (!matches) {
      ui.notifications.warn(
        `${preparedAura.name || "Aura"} possui Restricted Aura e exige "${restricted.notes}".`
      );
      return true;
    }
  }

  const climactic = (preparedAura.disadvantages || [])
    .find(d => d?.name === "Climactic");

  if (climactic) {
    const rank = Number(climactic.ranks || 1);
    const status = String(sys.status?.healthStatus || "healthy");
    const allowed = rank >= 3
      ? ["critical"]
      : rank === 2
        ? ["injured", "critical"]
        : ["bruised", "injured", "critical"];

    if (!allowed.includes(status)) {
      const threshold = rank >= 3 ? "Critical" : rank === 2 ? "Injured" : "Bruised";
      ui.notifications.warn(
        `${preparedAura.name || "Aura"} possui Climactic (${rank}) e exige estar abaixo do threshold ${threshold}.`
      );
      return true;
    }
  }

  return false;
}

async function activateAura(actor, preparedAura, sheet, context = {}, preparedAuras = null) {
  if (!preparedAura) return false;
  if (preparedAura.active) {
    ui.notifications.info(`${preparedAura.name}: Aura já está ativa.`);
    return true;
  }

  if (preparedAura.gainedSource === "battleJacket" && !preparedAura.gainedAuraKey) {
    ui.notifications.warn(
      `${preparedAura.name}: Aura ganha via Battle Jacket ainda não possui toggle persistente compatível nesta versão.`
    );
    return false;
  }

  if (await entryBlocked(actor, preparedAura, sheet)) return false;

  if (!context?.__dbuaActionValidated) {
    const validation = validateActionUse(actor, {
      label: "Aura",
      actionCost: 1,
      effectiveType: context?.effectiveType || "standard"
    });
    if (!validation.ok) return false;
  }

  const auras = Array.isArray(preparedAuras)
    ? preparedAuras
    : (await prepareAuraData(actor)).auras;
  const previous = activePreparedAura(auras);
  const activationCost = actualCost(actor, preparedAura, "activation");
  const maintenanceCost = actualCost(actor, preparedAura, "maintenance");

  const payment = await pay(actor, activationCost, `Aura: ${preparedAura.name}`);
  if (!payment?.ok) return false;

  await setAuraState(actor, preparedAura, true);
  if ((context?.effectiveType || "standard") === "standard") {
    await recordStandardAction(actor, {
      type: "aura",
      dbuStandardKey: "aura",
      actionCost: 1,
      kiCost: activationCost,
      description: `Aura: ${preparedAura.name || "Aura"}`
    });
  }

  if (previous && auraKey(previous) !== auraKey(preparedAura)) {
    await playAuraVisual(actor, previous, "deactivate");
    await burnoutReminder(actor, previous);
  }

  await postAuraCard(
    actor,
    preparedAura.name || "Aura",
    `<div class="dbu-attack-meta">
      <span class="dbu-meta-chip">🔵 Aura ativa</span>
      <span class="dbu-meta-chip">Ativação: ${activationCost} KP / Capacity</span>
      <span class="dbu-meta-chip">Manutenção: ${maintenanceCost} KP / Capacity</span>
    </div>
    <div class="dbu-attack-buffs">
      <strong>✅ ${esc(preparedAura.name || "Aura")} ATIVADA</strong>
    </div>`,
    "fa-sun",
    auraGif(actor, preparedAura)
  );

  await playAuraVisual(actor, preparedAura, "activate");

  ui.notifications.info(`${actor.name}: ${preparedAura.name} ativada.`);
  return true;
}

function auraOptionHTML(aura, actor) {
  const actUnits = auraCostUnits(aura, "activation");
  const maintUnits = auraCostUnits(aura, "maintenance");
  const badges = [];
  if (aura.active) badges.push("ATIVA");
  if (aura.isGained) badges.push(`Gained: ${aura.gainedFrom || "Fusion"}`);
  if (hasDisadvantage(aura, "Base Aura")) badges.push("Base Aura");
  if (hasDisadvantage(aura, "Restricted Aura")) badges.push("Restricted");
  if (hasDisadvantage(aura, "Climactic")) badges.push("Climactic");
  if (hasDisadvantage(aura, "Burnout")) badges.push("Burnout");

  const type = String(aura.type || "Aura");
  return `
    <option value="${esc(auraKey(aura))}">
      ${esc(aura.name || "Aura")} [${esc(type)}] — ${actUnits}(T) / maint. ${maintUnits}(T)${badges.length ? ` — ${esc(badges.join(" · "))}` : ""}
    </option>
  `;
}

function auraRowsHTML(rows = [], emptyText = "Nenhum") {
  if (!Array.isArray(rows) || !rows.length) {
    return `<span style="opacity:.7;">${esc(emptyText)}</span>`;
  }

  return rows.map(row => {
    const rank = Math.max(1, Number(row?.ranks || 1));
    const notes = String(row?.notes || "").trim();
    return `
      <div style="margin:2px 0;">
        • <b>${esc(row?.name || "Sem nome")}</b>${rank > 1 ? ` x${rank}` : ""}${notes ? ` — ${esc(notes)}` : ""}
      </div>
    `;
  }).join("");
}

function auraDetailHTML(aura, actor) {
  if (!aura) return "";

  const defaultNameWarning = String(aura.name || "").trim() === "New Aura"
    ? `<div style="padding:6px 8px;border:1px solid rgba(255,180,0,.55);border-radius:4px;margin-bottom:8px;">
         ⚠ <b>New Aura</b> é o nome padrão criado pela própria ficha do DBU.
         Renomeie esta Aura na aba <b>Auras</b> da ficha se quiser outro nome.
       </div>`
    : "";

  const description = String(aura.description || "").trim();
  return `
    <div style="padding:8px;border:1px solid rgba(0,0,0,.18);border-radius:5px;">
      ${defaultNameWarning}
      <div class="dbu-attack-meta" style="margin-bottom:6px;">
        <span class="dbu-meta-chip">Tipo: ${esc(aura.type || "—")}</span>
        <span class="dbu-meta-chip">Ativação: ${esc(costText(actor, aura, "activation"))}</span>
        <span class="dbu-meta-chip">Manutenção: ${esc(costText(actor, aura, "maintenance"))}</span>
      </div>
      ${description ? `<div style="margin-bottom:7px;"><b>Descrição:</b> ${esc(description)}</div>` : ""}
      <div><b>Advantages</b></div>
      <div style="margin:3px 0 7px 8px;">${auraRowsHTML(aura.advantages, "Nenhuma")}</div>
      <div><b>Disadvantages</b></div>
      <div style="margin:3px 0 0 8px;">${auraRowsHTML(aura.disadvantages, "Nenhuma")}</div>
    </div>
  `;
}

export async function signatureAura(context = {}) {
  const actor = getActorFromContext(context);
  if (!actor) return null;

  if (!canControl(actor)) {
    return ui.notifications.warn(`Você não controla ${actor.name}.`);
  }

  const prepared = await prepareAuraData(actor);
  const auras = prepared.auras.filter(a => !!a && a.id !== undefined);

  if (!auras.length) {
    return ui.notifications.warn(`${actor.name} não possui Signature Auras configuradas.`);
  }

  const active = activePreparedAura(auras);
  const selectedKey = auraKey(active) || auraKey(auras[0]);
  const cap = capacitySnapshot(actor);
  const ki = Number(actor.system.kiPool?.value || 0);

  const choice = await Dialog.wait({
    title: `${actor.name} — Signature Aura`,
    content: `
      <div class="dbu-aura-manager" style="display:flex;flex-direction:column;gap:10px;">
        <div class="dbu-attack-meta">
          <span class="dbu-meta-chip">Ki ${ki}</span>
          <span class="dbu-meta-chip">Capacity ${cap.left}/${cap.max}</span>
          <span class="dbu-meta-chip">Ativa: ${esc(active?.name || "Nenhuma")}</span>
        </div>

        <div>
          <label><b>Signature Aura</b></label>
          <select id="dbu-aura-select" style="width:100%; margin-top:4px;">
            ${auras.map(aura => auraOptionHTML(aura, actor)).join("")}
          </select>
        </div>

        <div id="dbu-aura-details">
          ${auraDetailHTML(active || auras[0], actor)}
        </div>

        <div style="font-size:0.85em;opacity:0.75;">
          A ativação liga a Signature Aura configurada na ficha; os efeitos mecânicos continuam sendo calculados pelo DBU.
        </div>
      </div>
    `,
    buttons: {
      activate: {
        label: "Ativar / Trocar Aura",
        icon: '<i class="fas fa-sun"></i>',
        callback: html => ({
          action: "activate",
          key: String(html.find("#dbu-aura-select").val() || "")
        })
      },
      deactivate: {
        label: "Desativar Atual",
        icon: '<i class="fas fa-power-off"></i>',
        callback: () => ({ action: "deactivate" })
      },
      close: {
        label: "Fechar",
        callback: () => ({ action: "close" })
      }
    },
    default: "activate",
    close: () => ({ action: "close" }),
    render: html => {
      const select = html.find("#dbu-aura-select");
      const details = html.find("#dbu-aura-details");

      const renderDetails = () => {
        const key = String(select.val() || "");
        const aura = auras.find(a => auraKey(a) === key) || auras[0];
        details.html(auraDetailHTML(aura, actor));
      };

      select.val(selectedKey);
      select.on("change", renderDetails);
      renderDetails();
    }
  });

  if (!choice || choice.action === "close") return null;

  if (choice.action === "deactivate") {
    if (!active) {
      ui.notifications.info(`${actor.name}: nenhuma Aura ativa.`);
      return null;
    }
    return deactivateAura(actor, active);
  }

  const targetAura = auras.find(a => auraKey(a) === choice.key);
  if (!targetAura) {
    return ui.notifications.error("DBU Aura: opção selecionada não encontrada.");
  }

  return activateAura(actor, targetAura, prepared.sheet, context, auras);
}

function primaryGMId() {
  return game.users
    .filter(u => u.active && u.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0]?.id || null;
}

function designatedControllerId(actor) {
  const owners = game.users
    .filter(u =>
      u.active &&
      !u.isGM &&
      (u.character?.id === actor.id || actor.testUserPermission?.(u, "OWNER"))
    )
    .sort((a, b) => {
      const aCharacter = a.character?.id === actor.id ? 0 : 1;
      const bCharacter = b.character?.id === actor.id ? 0 : 1;
      if (aCharacter !== bCharacter) return aCharacter - bCharacter;
      return String(a.id).localeCompare(String(b.id));
    });

  return owners[0]?.id || primaryGMId();
}

async function maintainAuraAtTurnStart(combat) {
  const combatant = combat?.combatant;
  const actor = combatant?.actor;
  if (!actor) return;

  if (designatedControllerId(actor) !== game.user.id) return;

  const state = globalThis.DBU_AURA_AUTOMATION;
  if (!state) return;

  const localKey = `${combat.id}:${combat.round ?? 0}:${combat.turn ?? -1}:${actor.id}`;
  if (state.pending.has(localKey)) return;
  state.pending.add(localKey);

  try {
    // Dá tempo para o core v6.6 processar o início do Round antes da manutenção.
    await sleep(250);

    if (
      game.combat?.id !== combat.id ||
      game.combat?.round !== combat.round ||
      game.combat?.turn !== combat.turn ||
      game.combat?.combatant?.actor?.id !== actor.id
    ) {
      return;
    }

    const { auras } = await prepareAuraData(actor);
    const active = activePreparedAura(auras);
    if (!active) return;

    const maintenanceKey = `${localKey}:${auraKey(active)}`;
    const processed = actor.getFlag(MODULE_ID, AURA_MAINTENANCE_FLAG);
    if (processed === maintenanceKey) return;

    const cost = actualCost(actor, active, "maintenance");
    const cap = capacitySnapshot(actor);
    const ki = Number(actor.system.kiPool?.value || 0);

    const decision = await Dialog.wait({
      title: `${actor.name} — Manutenção de Aura`,
      content: `
        <div class="dbu-aura-maintenance">
          <p><b>${esc(active.name || "Aura")}</b> está ativa.</p>
          <div class="dbu-attack-meta">
            <span class="dbu-meta-chip">Manutenção: ${cost} KP / Capacity</span>
            <span class="dbu-meta-chip">Ki: ${ki}</span>
            <span class="dbu-meta-chip">Capacity: ${cap.left}/${cap.max}</span>
          </div>
          <p style="margin-top:10px;">Pague a manutenção para manter a Aura ativa neste turno.</p>
        </div>
      `,
      buttons: {
        maintain: {
          label: `Manter — ${cost} KP`,
          icon: '<i class="fas fa-sun"></i>',
          callback: () => "maintain"
        },
        deactivate: {
          label: "Desativar Aura",
          icon: '<i class="fas fa-power-off"></i>',
          callback: () => "deactivate"
        }
      },
      default: "maintain",
      close: () => "deactivate"
    });

    if (decision === "maintain") {
      const payment = await pay(actor, cost, `Manutenção de Aura: ${active.name}`);

      if (payment?.ok) {
        await actor.setFlag(MODULE_ID, AURA_MAINTENANCE_FLAG, maintenanceKey);
        await postAuraCard(
          actor,
          active.name || "Aura",
          `<div class="dbu-attack-buffs"><strong>☀️ AURA MANTIDA</strong></div>
           <div class="dbu-attack-meta">
             <span class="dbu-meta-chip">-${cost} KP / Capacity</span>
           </div>`
        );
        return;
      }

      ui.notifications.warn(
        `${actor.name} não conseguiu pagar a manutenção de ${active.name}; a Aura será desativada.`
      );
    }

    await deactivateAura(actor, active, { reason: "maintenance" });
    await actor.setFlag(MODULE_ID, AURA_MAINTENANCE_FLAG, maintenanceKey);
  } catch (error) {
    console.error("DBU Automation | Signature Aura maintenance:", error);
    ui.notifications.error(`DBU Aura: ${error?.message || error}`);
  } finally {
    state.pending.delete(localKey);
  }
}

export function initializeSignatureAuraAutomation() {
  const previous = globalThis.DBU_AURA_AUTOMATION;

  if (previous?.combatHookId) {
    try { Hooks.off("updateCombat", previous.combatHookId); } catch {}
  }

  const state = {
    version: "1.8.18",
    combatHookId: null,
    pending: auraRuntime.pending
  };

  const hookId = Hooks.on("updateCombat", async (combat, changes) => {
    const turnChanged = Object.prototype.hasOwnProperty.call(changes, "turn");
    const roundChanged = Object.prototype.hasOwnProperty.call(changes, "round");
    if (!turnChanged && !roundChanged) return;
    if (Number(combat?.round || 0) <= 0 || Number(combat?.turn ?? -1) < 0) return;
    await maintainAuraAtTurnStart(combat);
  });

  state.combatHookId = hookId;
  globalThis.DBU_AURA_AUTOMATION = state;

  console.log("DBU Automation | Signature Aura v1.8.18 pronta", {
    combatHookId: hookId
  });

  return state;
}

export async function getActiveSignatureAura(actorOrContext = {}) {
  const actor = actorOrContext?.documentName === "Actor"
    ? actorOrContext
    : getActorFromContext(actorOrContext);
  if (!actor) return null;
  const { auras } = await prepareAuraData(actor);
  return activePreparedAura(auras);
}
import { validateActionUse, recordStandardAction } from "./action-economy.js";
