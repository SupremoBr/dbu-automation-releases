// ============================================================
// DBU Automation v1.8.5 TEST — Surge nativo + Terrain Lift
// ============================================================
// Surge: somente atalho para a automação nativa da ficha DBU 0.9.2.
// Terrain Lift: regra DBU 0.9.2 — Instant, 0 KP, Force Ability Check,
// Target Number por Hardness e Shielding automático enquanto carrega a Feature.
// ============================================================

import { actorInActiveCombat } from "./action-economy.js";

const MODULE_ID = "dbu-automation";
const TERRAIN_FLAG_KEY = "terrainLiftState";
const TERRAIN_USAGE_KEY = "terrain-lift:maneuver";
const SURGE_USAGE_KEY = "surge:maneuver";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

  const controlled = (canvas?.tokens?.controlled || []).find(entry => entry?.actor && (game.user?.isGM || entry.actor.isOwner));
  if (controlled?.actor) return controlled.actor;
  return game.user?.character || null;
}

function tokenFromContext(context = {}, actor = null) {
  const direct = context?.token?.object ?? context?.token ?? null;
  if (direct?.actor) return direct;

  if (context?.tokenId) {
    const token = canvas?.tokens?.get?.(context.tokenId);
    if (token?.actor) return token;
  }

  const subject = actor || context?.actor || null;
  const actorId = subject?.id || subject?.actor?.id || context?.actorId || null;
  if (!actorId) return null;
  return (canvas?.tokens?.controlled || []).find(entry => entry?.actor?.id === actorId)
    || (canvas?.tokens?.placeables || []).find(entry => entry?.actor?.id === actorId)
    || null;
}

function canControl(actor) {
  return !!actor && !!(game.user?.isGM || actor.isOwner);
}

async function prepareSheet(actor) {
  const sheet = actor?.sheet;
  if (!sheet) return null;
  try { await sheet.getData(); } catch (error) {
    console.warn("DBU Maneuvers | Não consegui preparar a ficha.", error);
  }
  return sheet;
}

function getCurrentRound(cts) {
  cts.rounds ??= [];
  if (!cts.rounds.length) {
    cts.rounds.push({ roundNumber: 1, actions: [] });
  }
  const round = cts.rounds[cts.rounds.length - 1];
  round.actions ??= [];
  round.roundNumber ??= cts.rounds.length;
  cts.currentRound = round.roundNumber;
  cts.resourceUsage ??= { round: {}, encounter: {} };
  cts.resourceUsage.round ??= {};
  cts.resourceUsage.encounter ??= {};
  return round;
}

function terrainUsage(actor) {
  if (!actorInActiveCombat(actor)) return 0;
  return number(actor?.system?.combatTabState?.resourceUsage?.round?.[TERRAIN_USAGE_KEY], 0);
}

export function getTerrainLiftState(actor) {
  try {
    const value = actor?.getFlag?.(MODULE_ID, TERRAIN_FLAG_KEY) || null;
    return value?.active ? value : null;
  } catch {
    return null;
  }
}

export function getSurgeUsage(actor) {
  if (!actorInActiveCombat(actor)) return 0;
  return number(actor?.system?.combatTabState?.resourceUsage?.encounter?.[SURGE_USAGE_KEY], 0);
}

async function chooseSurge(actor) {
  const used = getSurgeUsage(actor);
  const system = actor?.system || {};
  const tier = Math.max(1, number(system.tier, 1));
  const healingFormula = String(system.status?.healingSurge || `${2 * tier}d10`);
  const kiMax = Math.max(0, number(system.kiPool?.max, 0));
  const capacityMax = Math.max(0, number(system.status?.maxCapacity ?? system.capacity?.max, 0));
  const powerKi = Math.max(0, number(system.status?.powerSurgeKi, Math.floor(kiMax / 4)));
  const powerCapacity = Math.max(0, number(system.status?.powerSurgeCapacity, Math.floor(capacityMax / 4)));

  return Dialog.wait({
    title: `${actor.name} — Surge Maneuver`,
    content: `<div class="dbua-system-dialog-content">
      <div class="combat-panel combat-conditions-panel surge-panel">
        <div class="section-header">
          <span><i class="fas fa-heart-pulse"></i> Surge Maneuver</span>
          <span class="surge-status ${used > 0 ? "surge-used" : ""}">${actorInActiveCombat(actor) ? `Usos registrados neste Encounter: ${used} · ficha nativa controla usos extras` : "Fora de Encounter"}</span>
        </div>
        <div class="combat-panel-body">
          <p class="dbua-system-note">Escolha qual Surge usar. O DBU Automation chama o <b>mesmo handler nativo da ficha</b>; recursos que concedem Surges extras continuam sendo resolvidos pelo sistema DBU 0.9.2.</p>
          <table class="status-table dbua-system-status-table">
            <tbody>
              <tr>
                <td class="status-label"><i class="fas fa-heart"></i> Healing Surge</td>
                <td class="status-value"><span>${esc(healingFormula)} LP</span></td>
              </tr>
              <tr>
                <td class="status-label"><i class="fas fa-bolt"></i> Power Surge</td>
                <td class="status-value"><span>+${esc(powerKi)} KP · +${esc(powerCapacity)} Cap</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,
    buttons: {
      healing: { icon: '<i class="fas fa-heart"></i>', label: "Healing Surge", callback: () => "healing" },
      power: { icon: '<i class="fas fa-bolt"></i>', label: "Power Surge", callback: () => "power" },
      cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancelar", callback: () => null }
    },
    close: () => null
  }, { width: 520, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
}

export async function surge(context = {}) {
  const actor = actorFromContext(context);
  if (!actor) return ui.notifications.warn("DBU Surge: selecione um token ou configure seu personagem.");
  if (!canControl(actor)) return ui.notifications.warn(`Você não controla ${actor.name}.`);
  if (!actorInActiveCombat(actor)) return ui.notifications.warn(`${actor.name}: Surge só pode ser usado durante um Encounter ativo.`);

  const type = String(context?.surgeType || "") || await chooseSurge(actor);
  if (!type) return null;

  const sheet = await prepareSheet(actor);
  // Fonte única: o mesmo handler que os botões de Surge da ficha/Painel de
  // Combate do DBU 0.9.2 usam. Ele próprio lê Healing/Power Surge da ficha e
  // permite usos extras após o primeiro quando outro recurso os concede.
  if (typeof sheet?._onUseSurge !== "function") {
    return ui.notifications.error("DBU Surge: o handler nativo da ficha (_onUseSurge) não foi encontrado. Nenhum Surge paralelo será executado.");
  }

  const fakeButton = { dataset: { surgeType: type === "healing" ? "healing" : "power" } };
  const fakeEvent = {
    preventDefault() {},
    stopPropagation() {},
    currentTarget: fakeButton,
    target: fakeButton
  };
  await sheet._onUseSurge(fakeEvent);
  return { type, native: true, source: "sheet" };
}

function getAttributeScore(actor, key) {
  return Math.max(0, number(actor?.system?.attributes?.[key]?.score, 0));
}

function hasTelekinesis(actor) {
  const list = actor?.system?.uniqueAbilities || [];
  return list.some(entry => {
    const key = String(entry?.abilityKey ?? entry?.id ?? entry?.key ?? "").toLowerCase();
    const name = String(entry?.name ?? "").toLowerCase();
    return key === "telekinesis" || name === "telekinesis";
  });
}

function terrainTargetNumber(hardness) {
  const h = Math.max(1, Math.trunc(number(hardness, 1)));
  return 6 + (4 * (h - 1));
}

function documentCenter(document) {
  const object = document?.object ?? document;
  if (object?.center) return { x: object.center.x, y: object.center.y };
  const width = number(object?.w ?? document?.width, canvas?.grid?.size || 100);
  const height = number(object?.h ?? document?.height, canvas?.grid?.size || 100);
  return { x: number(object?.x ?? document?.x, 0) + width / 2, y: number(object?.y ?? document?.y, 0) + height / 2 };
}

function distanceSquaresBetween(a, b) {
  if (!a || !b) return Infinity;
  const ac = documentCenter(a);
  const bc = b.x != null && b.y != null && !b.object && !b.document ? b : documentCenter(b);
  const size = canvas?.grid?.size || canvas?.dimensions?.size || 100;
  return Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y)) / size;
}

function meleeRangeSquares(actor) {
  const raw = actor?.system?.status?.meleeReach ?? actor?.system?.status?.meleeRange ?? 1;
  if (Number.isFinite(Number(raw))) return Math.max(1, Number(raw));
  const match = String(raw).match(/\d+/);
  return Math.max(1, number(match?.[0], 1));
}

function selectedFeatureDocument(context = {}) {
  const direct = context.featureDocument?.document ?? context.featureDocument;
  if (direct) return direct;
  const targets = Array.from(game.user?.targets || []);
  const tiles = canvas?.tiles?.controlled || [];
  if (targets.length + tiles.length !== 1) return null;
  return targets[0]?.document || tiles[0]?.document || null;
}

function isFeatureDocument(document, context = {}) {
  if (!document) return false;
  if (["Tile", "Drawing"].includes(document.documentName)) return true;
  if (context.featureDocument) return true;
  if (document.getFlag?.(MODULE_ID, "terrainFeature") || document.actor?.getFlag?.(MODULE_ID, "terrainFeature")) return true;
  // DBU 0.9.2 has no Feature Actor document type. NPC tokens are the native
  // practical representation; character/battleJacket tokens are not Features.
  return document.documentName === "Token" && document.actor?.type === "npc";
}

async function pickGroundPoint(context = {}) {
  if (context.groundPoint && Number.isFinite(Number(context.groundPoint.x)) && Number.isFinite(Number(context.groundPoint.y))) {
    return { x: Number(context.groundPoint.x), y: Number(context.groundPoint.y) };
  }
  if (!canvas?.ready || !canvas?.stage) return null;
  ui.notifications.info("Terrain Lift: clique no Square de chão que será levantado.");
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), 30000);
    canvas.stage.once("pointerdown", event => {
      const point = event?.data?.getLocalPosition?.(canvas.stage) || event?.getLocalPosition?.(canvas.stage);
      finish(point ? { x: number(point.x, 0), y: number(point.y, 0) } : null);
    });
  });
}

function terrainShieldValue(state) {
  if (!state?.active) return 0;
  const hardness = Math.max(1, Math.trunc(number(state.hardness, 1)));
  return Math.max(0, number(state.shieldReduction, 5 * hardness));
}

export function getTerrainShieldReduction(actor) {
  return terrainShieldValue(getTerrainLiftState(actor));
}

/**
 * Prepara a redução automática do Shielding do Terrain Lift (DBU 0.9.2).
 * A regra reduz o Dice Score do Wound Roll antes do cálculo de Damage.
 */
export function prepareTerrainShield(actor, woundTotal) {
  const state = getTerrainLiftState(actor);
  if (!state) return null;

  const hardness = Math.max(1, Math.trunc(number(state.hardness, 1)));
  const reduction = terrainShieldValue(state);
  const originalWound = Math.max(0, number(woundTotal, 0));
  const reducedWound = Math.max(0, originalWound - reduction);

  return {
    state,
    hardness,
    reduction,
    originalWound,
    reducedWound
  };
}

/**
 * Resolve o desgaste/destruição depois que o Damage nativo foi aplicado.
 * - Se ainda houve Damage, a Feature é destruída.
 * - Se o Damage foi 0, a Feature sobrevive e a redução perde Hardness.
 */
export async function resolveTerrainShield(actor, shield, damageTaken = 0) {
  if (!actor || !shield?.state) return null;

  const current = getTerrainLiftState(actor);
  if (!current) return null;

  // Evita alterar uma nova Feature levantada entre preparação e resolução.
  if (
    shield.state.startedAt
    && current.startedAt
    && Number(shield.state.startedAt) !== Number(current.startedAt)
  ) return null;

  const damage = Math.max(0, number(damageTaken, 0));
  const hardness = Math.max(1, Math.trunc(number(current.hardness, shield.hardness || 1)));
  const usedReduction = Math.max(0, number(shield.reduction, terrainShieldValue(current)));
  let destroyed = false;
  let nextReduction = usedReduction;

  if (damage > 0) {
    destroyed = true;
    await actor.unsetFlag(MODULE_ID, TERRAIN_FLAG_KEY);
  } else {
    nextReduction = Math.max(0, usedReduction - hardness);
    const nextState = {
      ...current,
      shieldReduction: nextReduction,
      shieldUses: Math.max(0, Math.trunc(number(current.shieldUses, 0))) + 1,
      lastShieldAt: Date.now()
    };
    await actor.setFlag(MODULE_ID, TERRAIN_FLAG_KEY, nextState);
  }

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll dbu-terrain-lift-card">
      <h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-shield-alt"></i> ${esc(actor.name)} — Terrain Shield</span></h3>
      <div class="dbu-card-body">
        <div class="dbu-attack-meta"><span class="dbu-meta-chip">Automático</span><span class="dbu-meta-chip">Hardness ${esc(hardness)}</span><span class="dbu-meta-chip">Shield ${esc(usedReduction)}</span></div>
        <div class="dbu-roll-row"><span class="dbu-roll-label">Wound Dice Score</span><span class="dbu-roll-main">${esc(shield.originalWound)} − ${esc(usedReduction)}</span><span class="dbu-roll-total">${esc(shield.reducedWound)}</span></div>
        <div class="dbu-attack-buffs">${
          destroyed
            ? `<strong>${esc(current.label || "Feature")}</strong> foi destruído porque o ataque ainda causou <strong>${esc(damage)} Damage</strong>.`
            : `<strong>${esc(current.label || "Feature")}</strong> bloqueou o Damage. A redução do Shield diminui de <strong>${esc(usedReduction)}</strong> para <strong>${esc(nextReduction)}</strong>.`
        }</div>
      </div>
    </div>`
  });

  if (destroyed) {
    ui.notifications.info(`${actor.name}: ${current.label || "Feature"} foi destruído pelo Terrain Shield.`);
  }

  return { destroyed, damage, hardness, usedReduction, nextReduction };
}

async function placeTerrain(actor, state) {
  await actor.unsetFlag(MODULE_ID, TERRAIN_FLAG_KEY);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll dbu-terrain-lift-card">
      <h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-mountain"></i> ${esc(actor.name)} — Colocar Terreno</span></h3>
      <div class="dbu-card-body">
        <div class="dbu-attack-meta"><span class="dbu-meta-chip">Terrain Lift</span><span class="dbu-meta-chip">Instant</span><span class="dbu-meta-chip">0 KP</span></div>
        <div class="dbu-attack-buffs"><strong>${esc(state?.label || "Feature")}</strong> foi colocado em um Square dentro do Melee Range.</div>
      </div>
    </div>`
  });
  ui.notifications.info(`${actor.name}: terreno colocado.`);
  return { placed: true, state };
}

async function carryingTerrainDialog(actor, state) {
  const reduction = terrainShieldValue(state);
  return Dialog.wait({
    title: `${actor.name} — Terrain Lift`,
    content: `<div class="dbua-system-dialog-content">
      <div class="combat-panel combat-conditions-panel dbua-terrain-panel">
        <div class="section-header">
          <span><i class="fas fa-mountain"></i> Feature carregada</span>
          <span class="conditions-round-badge">Hardness ${esc(state.hardness)}</span>
        </div>
        <div class="combat-panel-body">
          <table class="status-table dbua-system-status-table">
            <tbody>
              <tr><td class="status-label">Feature</td><td class="status-value"><span>${esc(state.label || "Terreno")}</span></td></tr>
              <tr><td class="status-label">Terrain Shield</td><td class="status-value"><span>${esc(reduction)} Wound</span></td></tr>
              <tr><td class="status-label">Colocar terreno</td><td class="status-value"><span>Instant · 0 KP</span></td></tr>
            </tbody>
          </table>
          <p class="dbua-system-note dbua-system-note-spaced">Ao ser atingido por uma Attacking Maneuver, o Shield reduz automaticamente o Dice Score do Wound. Se ainda houver Damage, a Feature é destruída. Se o Damage chegar a 0, a redução perde ${esc(state.hardness)}.</p>
        </div>
      </div>
    </div>`,
    buttons: {
      place: { icon: '<i class="fas fa-level-down-alt"></i>', label: "Colocar terreno", callback: () => "place" },
      close: { icon: '<i class="fas fa-times"></i>', label: "Fechar", callback: () => null }
    },
    close: () => null
  }, { width: 520, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
}

async function terrainLiftDialog(actor) {
  const force = getAttributeScore(actor, "fo");
  const magic = getAttributeScore(actor, "ma");
  const telekinesis = hasTelekinesis(actor);
  const used = terrainUsage(actor);

  return Dialog.wait({
    title: `${actor.name} — Levantar Terreno`,
    content: `<div class="dbua-system-dialog-content">
      <div class="combat-panel combat-conditions-panel dbua-terrain-panel">
        <div class="section-header">
          <span><i class="fas fa-mountain"></i> Terrain Lift</span>
          <span class="conditions-round-badge">${used ? "Usado neste Round" : "1/Round"}</span>
        </div>
        <div class="combat-panel-body">
          <div class="tap-row dbua-system-meta-row">
            <span class="tap-meta-item"><i class="fas fa-bolt"></i> Instant</span>
            <span class="tap-meta-item">0 KP</span>
            <span class="tap-meta-item"><i class="fas fa-fist-raised"></i> Force ${esc(force)}</span>
            <span class="tap-meta-item"><i class="fas fa-shield-alt"></i> Shield = 5 × Hardness</span>
          </div>

          <label class="dbua-system-check-row">
            <input id="dbu-terrain-standard" type="checkbox" checked>
            <span>Estou no <b>Standard Environment</b></span>
          </label>

          <table class="status-table dbua-system-form-table">
            <tbody>
              <tr>
                <td class="status-label"><label for="dbu-terrain-label">Feature</label></td>
                <td class="status-value"><input id="dbu-terrain-label" type="text" value="Terreno"></td>
              </tr>
              <tr>
                <td class="status-label"><label for="dbu-terrain-source">Alvo</label></td>
                <td class="status-value"><select id="dbu-terrain-source"><option value="ground">Chão</option><option value="feature">Feature existente</option></select></td>
              </tr>
              <tr>
                <td class="status-label"><label for="dbu-terrain-hardness">Hardness</label></td>
                <td class="status-value"><input id="dbu-terrain-hardness" type="number" min="1" step="1" value="1"></td>
              </tr>
              <tr>
                <td class="status-label"><label for="dbu-terrain-attribute">Ability Check</label></td>
                <td class="status-value"><select id="dbu-terrain-attribute"><option value="force">Force Score (${esc(force)})</option>${telekinesis ? `<option value="magic">Magic Score (${esc(magic)}) — Telekinesis</option>` : ""}</select></td>
              </tr>
            </tbody>
          </table>

          <div class="dbua-system-rule-box">
            <div><b>TN por Hardness:</b> H1 6 · H2 10 · H3 14 · H4 18.</div>
            <div>Feature existente precisa estar no Melee Range${telekinesis ? ", ou não estar em Long Range por Telekinesis" : ""}.</div>
            <div>Regra base: <b>1d10 + Force Score</b>.${telekinesis ? " Telekinesis permite usar Magic no lugar de Force." : ""}</div>
            <div>Se o teste passar, você passa a carregar a Feature. Se levantar o chão, ele se torna uma Feature de 1 Square. O uso conta mesmo se o Ability Check falhar.</div>
          </div>
        </div>
      </div>
    </div>`,
    buttons: {
      lift: {
        icon: '<i class="fas fa-hand-rock"></i>',
        label: "Fazer Ability Check",
        callback: html => ({
          standardEnvironment: !!html.find("#dbu-terrain-standard").prop("checked"),
          label: String(html.find("#dbu-terrain-label").val() || "Terreno").trim() || "Terreno",
          sourceType: String(html.find("#dbu-terrain-source").val() || "ground"),
          hardness: Math.trunc(number(html.find("#dbu-terrain-hardness").val(), 1)),
          attribute: String(html.find("#dbu-terrain-attribute").val() || "force")
        })
      },
      cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancelar", callback: () => null }
    },
    close: () => null
  }, { width: 570, classes: ["dbu-old", "sheet", "dbua-system-dialog"] });
}

export async function terrainLift(context = {}) {
  const actor = actorFromContext(context);
  if (!actor) return ui.notifications.warn("DBU Terrain Lift: selecione um token ou configure seu personagem.");
  if (!canControl(actor)) return ui.notifications.warn(`Você não controla ${actor.name}.`);

  const currentState = getTerrainLiftState(actor);
  if (currentState) {
    const action = await carryingTerrainDialog(actor, currentState);
    if (action === "place") return placeTerrain(actor, currentState);
    return currentState;
  }

  if (terrainUsage(actor) > 0) {
    return ui.notifications.warn(`${actor.name}: Terrain Lift já foi usado neste Round (1/Round).`);
  }

  const selection = await terrainLiftDialog(actor);
  if (!selection) return null;

  if (!selection.standardEnvironment) {
    return ui.notifications.warn("Terrain Lift só pode ser usado no Standard Environment.");
  }

  const telekinesis = hasTelekinesis(actor);
  if (selection.attribute === "magic" && !telekinesis && !context?.allowMagicTerrainLift) {
    return ui.notifications.warn("Terrain Lift usa Force. Magic só pode substituir Force quando um efeito, como Telekinesis, permitir.");
  }

  const sourceToken = tokenFromContext(context, actor);
  if (!sourceToken) return ui.notifications.warn("Terrain Lift exige o token do personagem na Scene para validar alcance.");
  let targetDocument = null;
  let targetPoint = null;
  if (selection.sourceType === "feature") {
    targetDocument = selectedFeatureDocument(context);
    if (!targetDocument) return ui.notifications.warn("Terrain Lift: marque exatamente uma Feature como Target ou selecione um Tile.");
    if (!isFeatureDocument(targetDocument, context)) return ui.notifications.warn("O alvo selecionado não é uma Feature válida. Tokens de personagem não podem ser levantados como terreno.");
    targetPoint = documentCenter(targetDocument);
  } else {
    targetPoint = await pickGroundPoint(context);
    if (!targetPoint) return ui.notifications.warn("Terrain Lift cancelado: nenhum Square de chão foi selecionado.");
  }
  const targetDistance = distanceSquaresBetween(sourceToken, targetPoint);
  const melee = meleeRangeSquares(actor);
  const longRange = Math.max(1, number(actor.system?.status?.longRangeNumeric, 9));
  const allowedDistance = selection.sourceType === "feature" && telekinesis ? longRange - 0.001 : melee + 0.001;
  if (targetDistance > allowedDistance) {
    const rangeLabel = selection.sourceType === "feature" && telekinesis ? `fora de Long Range (${longRange} Squares)` : `Melee Range (${melee} Squares)`;
    return ui.notifications.warn(`Terrain Lift: o alvo está a ${targetDistance.toFixed(1)} Squares e precisa estar em ${rangeLabel}.`);
  }

  const hardness = Math.trunc(number(selection.hardness, 1));
  if (hardness < 1) {
    return ui.notifications.warn("Terrain Lift não pode ser usado se o Hardness Value for menor que 1.");
  }
  const attributeKey = selection.attribute === "magic" ? "ma" : "fo";
  const attributeLabel = selection.attribute === "magic" ? "Magic" : "Force";
  const score = getAttributeScore(actor, attributeKey);
  const targetNumber = terrainTargetNumber(hardness);
  const roll = new Roll(`1d10 + ${score}`);
  await roll.evaluate();
  const total = Math.max(0, number(roll.total, 0));
  const success = total >= targetNumber;

  try {
    if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
  } catch {}

  const cts = foundry.utils.deepClone(actor.system?.combatTabState || {});
  const round = getCurrentRound(cts);
  const inCombat = actorInActiveCombat(actor);
  const used = inCombat ? number(cts.resourceUsage.round[TERRAIN_USAGE_KEY], 0) : 0;
  if (inCombat && used > 0) {
    return ui.notifications.warn(`${actor.name}: Terrain Lift já foi usado neste Round (1/Round).`);
  }

  if (inCombat) cts.resourceUsage.round[TERRAIN_USAGE_KEY] = used + 1;
  round.actions.push({
    type: "instant",
    dbuOutsideCombat: !inCombat || undefined,
    source: "",
    kiCost: 0,
    dkpCost: 0,
    kiWager: 0,
    description: `Terrain Lift: ${selection.label} (Hardness ${hardness}) — ${attributeLabel} Ability Check ${total} vs TN ${targetNumber} — ${success ? "Success" : "Failure"}`,
    dbuTerrainLift: true,
    dbuTerrainHardness: hardness,
    dbuTerrainTN: targetNumber,
    dbuTerrainRoll: total,
    dbuTerrainSuccess: success
  });

  await actor.update({ "system.combatTabState": cts });

  let state = null;
  if (success) {
    state = {
      version: "1.1",
      active: true,
      label: selection.label,
      sourceType: selection.sourceType,
      hardness,
      squares: selection.sourceType === "ground" ? 1 : null,
      attribute: selection.attribute,
      abilityScore: score,
      targetNumber,
      rollTotal: total,
      shieldReduction: 5 * hardness,
      shieldUses: 0,
      startedRound: round.roundNumber,
      sceneId: canvas?.scene?.id || null,
      sourceTokenId: sourceToken?.document?.id || sourceToken?.id || null,
      targetDocumentName: targetDocument?.documentName || "Ground",
      targetDocumentId: targetDocument?.id || null,
      targetActorId: targetDocument?.actor?.id || null,
      targetActorUuid: targetDocument?.actor?.uuid || null,
      targetPoint: { x: number(targetPoint.x, 0), y: number(targetPoint.y, 0) },
      targetDistance,
      startedAt: Date.now()
    };
    await actor.setFlag(MODULE_ID, TERRAIN_FLAG_KEY, state);
  }

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="dbu-attack-roll dbu-terrain-lift-card">
      <h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-mountain"></i> ${esc(actor.name)} — Terrain Lift</span></h3>
      <div class="dbu-card-body">
        <div class="dbu-attack-meta"><span class="dbu-meta-chip">${inCombat ? "1/Round" : "Fora de Encounter · limite/Round livre"}</span><span class="dbu-meta-chip">Instant</span><span class="dbu-meta-chip">0 KP</span><span class="dbu-meta-chip">Standard Environment</span></div>
        <div class="dbu-roll-row"><span class="dbu-roll-label">${esc(attributeLabel)} Ability Check</span><span class="dbu-roll-main"><code class="dbu-roll-formula">1d10 + ${esc(score)}</code><span class="dbu-roll-sub">Hardness ${esc(hardness)} · TN ${esc(targetNumber)}</span></span><span class="dbu-roll-total">${esc(total)}</span></div>
        <div class="dbu-attack-buffs">${
          success
            ? `<strong>SUCESSO.</strong> ${esc(selection.label)} levantado${selection.sourceType === "ground" ? " · 1 Square" : ""}. Shield automático inicial: <strong>${esc(5 * hardness)}</strong>.`
            : `<strong>FALHA.</strong> O Ability Check não alcançou TN ${esc(targetNumber)}; nenhuma Feature foi levantada.`
        }</div>
      </div>
    </div>`
  });

  if (success) {
    ui.notifications.info(`${actor.name}: ${selection.label} levantado (Hardness ${hardness}, Shield ${5 * hardness}).`);
  } else {
    ui.notifications.warn(`${actor.name}: Terrain Lift falhou (${total} vs TN ${targetNumber}).`);
  }

  return { success, state, total, targetNumber, hardness, attribute: selection.attribute };
}
