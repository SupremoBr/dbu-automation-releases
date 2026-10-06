// ============================================================
// DBU Automation v1.8.12 DEV — HUD de Combate
// ============================================================
// Interface própria inspirada no fluxo de HUDs de combate, sem depender
// do Argon. Os botões apenas encaminham ações para a API pública do módulo.
// ============================================================

import { getPendingActions } from "./combat-panel.js";
import { getTerrainLiftState } from "./maneuvers.js";
import { getStandardFavorites, resolveManeuverAction, StandardActions, openManeuverCategoryPreview } from "./standard-actions.js";
import { areAllies as areTeamAllies, combatantForActor, getCombatantTeam } from "./combat-teams.js";
import { MODULE_ID } from "./core/module-id.js";

const VERSION = "1.9.6 DEV";
const HUD_ID = "dbu-combat-hud";
const LAUNCHER_ID = "dbu-combat-hud-launcher";

const state = {
  open: false,
  collapsed: false,
  actorId: null,
  tokenId: null,
  rendering: false,
  renderAgain: false,
  renderTimer: null,
  relevantActorIds: new Set(),
  hooks: {}
};

let settingsPrepared = false;
let settingsRegistered = false;

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

function setting(key, fallback = false) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return fallback;
  }
}

function clampSetting(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function hudPlacement(prefix, defaults = {}) {
  const anchor = String(setting(`${prefix}Anchor`, defaults.anchor || "top-left"));
  const allowed = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);
  return {
    anchor: allowed.has(anchor) ? anchor : (defaults.anchor || "top-left"),
    x: clampSetting(setting(`${prefix}X`, defaults.x ?? 24), 0, 2000, defaults.x ?? 24),
    y: clampSetting(setting(`${prefix}Y`, defaults.y ?? 82), 0, 2000, defaults.y ?? 82)
  };
}

function placementAttrs(prefix, defaults = {}) {
  const pos = hudPlacement(prefix, defaults);
  const scale = clampSetting(setting(`${prefix}Scale`, defaults.scale ?? 100), 50, 150, defaults.scale ?? 100);
  const opacity = clampSetting(setting(`${prefix}Opacity`, defaults.opacity ?? 100), 25, 100, defaults.opacity ?? 100);
  return `data-dbu-anchor="${esc(pos.anchor)}" style="--dbu-hud-pos-x:${pos.x}px;--dbu-hud-pos-y:${pos.y}px;--dbu-hud-scale:${scale / 100};--dbu-hud-opacity:${opacity / 100}"`;
}

function actorOwnedByPlayer(actor, user) {
  if (!actor || !user || user.isGM) return false;
  try {
    const level = Number(actor.ownership?.[user.id] ?? actor.permission?.[user.id] ?? 0);
    return user.character?.id === actor.id || level >= 3;
  } catch {
    return user.character?.id === actor?.id;
  }
}

function alliedActorEntries(subjectActor) {
  const sceneTokens = Array.from(canvas?.tokens?.placeables || []);
  const subjectToken = sceneTokens.find(entry => entry?.actor?.id === subjectActor?.id) || null;
  const combat = game.combat;
  const subjectCombatant = safeCall(() => combatantForActor(subjectActor, combat), null, "combatant lookup");
  const subjectTeam = safeCall(() => getCombatantTeam(subjectCombatant), "", "team lookup");

  // Durante um Encounter com Time definido, a HUD usa diretamente os
  // Combatants do mesmo Time. Isso inclui PCs e NPCs aliados e ignora quem
  // estiver em outro Time, independentemente da Disposition do token.
  if (combat && subjectCombatant && subjectTeam) {
    const seen = new Set();
    const result = [];
    const combatants = Array.from(combat.combatants?.contents || combat.combatants || []);

    for (const combatant of combatants) {
      const actor = combatant?.actor;
      if (!actor || actor.id === subjectActor?.id || seen.has(actor.id)) continue;
      if (safeCall(() => getCombatantTeam(combatant), "", "ally team lookup") !== subjectTeam) continue;

      const tokenId = combatant.tokenId || combatant.token?.id || null;
      const token = (tokenId ? sceneTokens.find(entry => entry?.id === tokenId || entry?.document?.id === tokenId) : null)
        || sceneTokens.find(entry => entry?.actor?.id === actor.id)
        || null;

      // O painel acompanha somente aliados presentes na cena ativa.
      if (canvas?.ready && sceneTokens.length && !token) continue;
      // Não revelar por HUD um token oculto ao jogador.
      if (!game.user?.isGM && token?.document?.hidden) continue;

      seen.add(actor.id);
      result.push({ actor, token, user: null, team: subjectTeam });
    }

    return result;
  }

  // Fora de Encounter (ou em mundos legados ainda sem Time), preserva o
  // comportamento anterior de mostrar personagens de jogadores presentes.
  const users = Array.from(game.users?.contents || game.users || []).filter(user => !user?.isGM);
  const seen = new Set();
  const result = [];

  for (const user of users) {
    let actor = user?.character || null;
    if (!actor) {
      actor = (game.actors?.contents || []).find(candidate => actorOwnedByPlayer(candidate, user)) || null;
    }
    if (!actor || actor.id === subjectActor?.id || seen.has(actor.id)) continue;

    const token = sceneTokens.find(entry => entry?.actor?.id === actor.id) || null;
    if (canvas?.ready && sceneTokens.length && !token) continue;
    if (subjectToken && token && !areTeamAllies(subjectToken, token, combat)) continue;

    seen.add(actor.id);
    result.push({ actor, token, user });
  }

  return result;
}

function allyRows(subjectActor, preparedEntries = null) {
  const entries = Array.isArray(preparedEntries) ? preparedEntries : alliedActorEntries(subjectActor);
  if (!entries.length) {
    return `<div class="dbu-hud-allies-empty"><i class="fas fa-user-friends"></i><span>Nenhum aliado na cena</span></div>`;
  }

  return entries.map(({ actor, user }) => {
    const lp = {
      value: number(actor.system?.lifePoints?.value, 0),
      max: number(actor.system?.lifePoints?.max, 0)
    };
    const pct = percent(lp.value, lp.max);
    const low = pct <= 25;
    const down = lp.max > 0 && lp.value <= 0;
    return `<div class="dbu-hud-ally${low ? " low" : ""}${down ? " down" : ""}" title="${esc(actor.name)} · LP ${esc(lp.value)} / ${esc(lp.max)}">
      <img src="${esc(actor.img || "icons/svg/mystery-man.svg")}" alt="${esc(actor.name)}">
      <div class="dbu-hud-ally-copy">
        <strong>${esc(actor.name)}</strong>
        <div class="dbu-hud-ally-bar"><span style="width:${pct}%"></span></div>
      </div>
    </div>`;
  }).join("");
}

function safeCall(fn, fallback, label = "HUD") {
  try {
    return fn();
  } catch (error) {
    console.warn(`DBU HUD | ${label}:`, error);
    return fallback;
  }
}

function canControl(actor) {
  return !!actor && !!(game.user?.isGM || actor.isOwner);
}

function tokenFromContext(context = {}) {
  const direct = context?.token?.object ?? context?.token ?? null;
  if (direct?.actor) return direct;
  const tokenId = context?.tokenId || null;
  if (tokenId) {
    const byId = canvas?.tokens?.get?.(tokenId);
    if (byId?.actor) return byId;
  }
  return null;
}

function actorFromContext(context = {}) {
  const direct = context?.actor;
  if (direct?.documentName === "Actor") return direct;
  if (direct?.actor?.documentName === "Actor") return direct.actor;
  const token = tokenFromContext(context);
  if (token?.actor) return token.actor;
  if (context?.actorId) {
    const byId = game.actors?.get?.(context.actorId);
    if (byId) return byId;
  }
  return null;
}

function selectedToken() {
  return (canvas?.tokens?.controlled || []).find(token => canControl(token?.actor)) || null;
}

function resolveHudSubject(context = {}, { keepCurrent = false } = {}) {
  let actor = actorFromContext(context);
  let token = tokenFromContext(context);

  if (!actor && keepCurrent && state.actorId) {
    actor = game.actors?.get?.(state.actorId) || null;
    token = state.tokenId ? canvas?.tokens?.get?.(state.tokenId) || null : null;
  }

  if (!actor) {
    const controlled = selectedToken();
    actor = controlled?.actor || null;
    token = controlled || null;
  }

  if (!actor) actor = game.user?.character || null;
  if (!token && actor) {
    token = (canvas?.tokens?.controlled || []).find(entry => entry.actor?.id === actor.id)
      || (canvas?.tokens?.placeables || []).find(entry => entry.actor?.id === actor.id)
      || null;
  }

  return { actor, token };
}

function getCapacity(actor) {
  try {
    if (globalThis.DBU?.getCapacity) return globalThis.DBU.getCapacity(actor);
  } catch {}
  const max = number(actor?.system?.status?.maxCapacity, 0);
  const spent = number(actor?.system?.status?.capacitySpent, 0);
  return { max, spent, left: Math.max(0, max - spent) };
}

function isManifestedPowerEntry(entry) {
  const type = String(
    entry?.transformationType
      ?? entry?.type
      ?? entry?.transformation_type
      ?? ""
  ).trim().toLowerCase().replace(/[\s-]+/g, "_");
  const catalogKey = String(entry?.catalogKey || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const name = String(entry?.name || "").trim();

  return type === "manifested_power"
    || catalogKey === "manifested_power"
    || /^manifested\s+power(?:\b|\s*[:—-])/i.test(name);
}

function activeTransformNames(actor) {
  return (actor?.system?.transformations || [])
    .filter(entry => entry?.active && !isManifestedPowerEntry(entry))
    .map(entry => entry?.name || "Transformation");
}

function activeAuraName(actor) {
  return (actor?.system?.signatureAuras || []).find(entry => entry?.active)?.name || "Sem aura";
}

function energyChargeState(actor) {
  try {
    const charge = actor?.getFlag?.("world", "dbuEnergyChargeState") || null;
    return charge?.active ? charge : null;
  } catch {
    return null;
  }
}

function combatLabel(actor) {
  const combat = game.combat;
  if (!combat) return "Fora de combate";
  const combatant = combat.combatants?.find?.(entry => entry.actor?.id === actor?.id);
  if (!combatant) return `Round ${number(combat.round, 0)} · fora da iniciativa`;
  return `Round ${number(combat.round, 0)}${combat.combatant?.id === combatant.id ? " · SEU TURNO" : ""}`;
}

function percent(value, max) {
  return max > 0 ? Math.max(0, Math.min(100, Math.round(value / max * 100))) : 0;
}

function resource(label, value, max, kind, title = "") {
  const icons = { lp: "fas fa-heart", ki: "fas fa-bolt", capacity: "fas fa-fire" };
  const valuePercent = percent(value, max);
  return `<div class="dbu-hud-resource ${esc(kind)}${valuePercent <= 25 ? " low" : ""}"${title ? ` title="${esc(title)}"` : ""}>
    <div class="dbu-hud-resource-line"><span><i class="${icons[kind] || "fas fa-circle"}"></i>${esc(label)}</span><b>${esc(value)} <em>/ ${esc(max)}</em></b></div>
    <div class="dbu-hud-resource-bar"><span style="width:${valuePercent}%"></span><i></i></div>
  </div>`;
}

function actionButton(action, icon, label, options = {}) {
  const classes = ["dbu-hud-action", options.primary ? "primary" : "", options.alert ? "alert" : ""]
    .filter(Boolean).join(" ");
  const badge = options.badge ? `<span class="dbu-hud-badge">${esc(options.badge)}</span>` : "";
  return `<button type="button" class="${classes}" data-dbu-hud-action="${esc(action)}" title="${esc(options.title || label)}">
    <i class="${esc(icon)}"></i><span>${esc(label)}</span>${badge}
  </button>`;
}

function standardFavoriteButtons(actor) {
  const favorites = getStandardFavorites();
  return favorites.map((key, index) => {
    const def = resolveManeuverAction(key, actor);
    if (!def) return "";
    const available = typeof def.available !== "function" || def.available(actor);
    const detail = typeof def.detail === "function" ? def.detail(actor) : "";
    return `<button type="button" class="dbu-hud-action ${index === 0 ? "primary" : ""} dbua-hud-favorite" data-dbu-hud-action="standard-favorite" data-standard-key="${esc(key)}" ${available ? "" : "disabled"} title="${esc(available ? (detail || `${def.label} — favorito Standard`) : `${def.label} não está disponível agora`)}">
      <i class="${esc(def.icon || "fas fa-star")}"></i><span>${esc(def.label)}</span><span class="dbua-favorite-star"><i class="fas fa-star"></i></span>
    </button>`;
  }).join("");
}

function hudContent(actor, token) {
  const lp = {
    value: number(actor.system?.lifePoints?.value, 0),
    max: number(actor.system?.lifePoints?.max, 0)
  };
  const ki = {
    value: number(actor.system?.kiPool?.value, 0),
    max: number(actor.system?.kiPool?.max, 0)
  };
  const capacity = getCapacity(actor);
  const tier = number(actor.system?.tier, 1);
  const baseTier = number(actor.system?.baseTier, tier);
  const transformations = activeTransformNames(actor);
  const aura = activeAuraName(actor);
  const charge = energyChargeState(actor);
  const terrain = getTerrainLiftState(actor);
  const terrainShield = terrain ? Math.max(0, number(terrain.shieldReduction, 5 * Math.max(1, number(terrain.hardness, 1)))) : 0;
  const grapple = safeCall(() => StandardActions.getGrappleState(actor), null, "Grapple state");
  const powerStacks = Math.max(0, number(actor.system?.tracking?.powerStacks, 0));
  const pending = safeCall(() => getPendingActions(actor).length, 0, "pending actions");
  const targets = game.user?.targets?.size || 0;
  const turn = combatLabel(actor);
  const activeForm = transformations.length ? transformations.join(" + ") : "Forma base";
  const chargeLabel = charge
    ? `Energy Charge ${number(charge.gatheredCharges, 0)} · ${charge.attackName || "Ataque"}`
    : "Sem Energy Charge";

  const showAllies = !!setting("combatHudShowAllies", true);
  const allyEntries = showAllies
    ? safeCall(() => alliedActorEntries(actor), [], "allies panel")
    : [];
  state.relevantActorIds = new Set([
    actor.id,
    ...allyEntries.map(entry => entry?.actor?.id).filter(Boolean)
  ]);
  const allies = showAllies ? allyRows(actor, allyEntries) : "";

  return `<section id="${HUD_ID}" class="dbu-combat-hud${state.collapsed ? " collapsed" : ""}" data-actor-id="${esc(actor.id)}" data-token-id="${esc(token?.id || "")}" aria-label="HUD de Combate DBU">
    <aside class="dbu-hud-player-card" ${placementAttrs("combatHudVitals", { anchor: "top-left", x: 72, y: 82, scale: 100, opacity: 100 })}>
      <button type="button" class="dbu-hud-drag-handle" data-dbu-hud-drag="vitals" title="Arrastar e salvar posição do HP, Ki e Capacidade" aria-label="Mover HUD de recursos"><i class="fas fa-grip-lines"></i></button>
      <button type="button" class="dbu-hud-identity" data-dbu-hud-action="sheet" title="Abrir ficha de ${esc(actor.name)}">
        <span class="dbu-hud-portrait-frame"><span class="dbu-hud-portrait"><img src="${esc(actor.img || "icons/svg/mystery-man.svg")}" alt="${esc(actor.name)}"></span></span>
        <span class="dbu-hud-character">
          <span class="dbu-hud-nameplate"><b>T${esc(tier)}</b><strong>${esc(actor.name)}</strong><em>BT ${esc(baseTier)}</em></span>
          <small class="${/SEU TURNO/.test(turn) ? "turn" : ""}">${esc(turn)}</small>
        </span>
      </button>
      <div class="dbu-hud-resources">
        ${resource("VIDA · LP", lp.value, lp.max, "lp")}
        ${resource("KI", ki.value, ki.max, "ki")}
        ${resource("CAPACIDADE", capacity.left, capacity.max, "capacity", `${capacity.spent} de Capacity gastos`)}
      </div>
      <div class="dbu-hud-vital-states dbua-v180-states">
        <span title="Transformation ativa"><i class="fas fa-dragon"></i>${esc(activeForm)}</span>
        <span title="Signature Aura ativa"><i class="fas fa-sun"></i>${esc(aura)}</span>
        ${charge ? `<span class="charged" title="Energy Charge ativo"><i class="fas fa-bolt"></i>${esc(number(charge.gatheredCharges, 0))} EC</span>` : ""}
        ${powerStacks > 0 ? `<span class="power" title="Power Stacks"><i class="fas fa-fire"></i>Power ${powerStacks}</span>` : ""}
        ${terrain ? `<span class="terrain" title="Feature carregada · Terrain Shield automático"><i class="fas fa-mountain"></i>H${esc(terrain.hardness)} · S${esc(terrainShield)}</span>` : ""}
        ${grapple ? `<span class="grapple" title="Grapple ativo"><i class="fas fa-hand-rock"></i>${grapple.role === "grappler" ? "Grappler" : "Grappled"}</span>` : ""}
      </div>
    </aside>

    ${showAllies ? `<aside class="dbu-hud-allies-panel" ${placementAttrs("combatHudAllies", { anchor: "top-right", x: 24, y: 82, scale: 100, opacity: 100 })} aria-label="HP dos aliados">
      <button type="button" class="dbu-hud-drag-handle ally" data-dbu-hud-drag="allies" title="Arrastar e salvar posição dos aliados" aria-label="Mover aliados"><i class="fas fa-grip-lines"></i></button>
      <div class="dbu-hud-allies-list">${allies}</div>
    </aside>` : ""}

    <div class="dbu-hud-dock">
      <div class="dbu-hud-scanline"></div>
      <header class="dbu-hud-top">
        <nav class="dbu-hud-primary dbua-v180-primary" aria-label="Standard Maneuvers e favoritos">
          <span class="dbua-hud-favorites-label"><i class="fas fa-star"></i> FAVORITOS</span>
          ${standardFavoriteButtons(actor)}
          <span class="dbua-hud-category-divider"></span>
          ${actionButton("standard", "fas fa-circle", "STANDARD", { title: "Abrir Standard Maneuvers" })}
          ${actionButton("instant-preview", "fas fa-bolt", "INSTANT", { title: "Instant Maneuvers · reutiliza automações existentes" })}
          ${actionButton("counter-preview", "fas fa-shield-alt", "COUNTER", { title: "Counter Maneuvers · mostra apenas oportunidades contextuais" })}
        </nav>

        <div class="dbu-hud-tools">
          ${actionButton("panel", "fas fa-shield-alt", "Pendências", { alert: pending > 0, badge: pending || "" })}
          ${actionButton("targets", "fas fa-crosshairs", "Alvos", { badge: targets || "", title: targets ? "Limpar alvos marcados" : "Nenhum alvo marcado" })}
          <button type="button" class="dbu-hud-icon" data-dbu-hud-action="settings" title="Preferências do HUD"><i class="fas fa-cog"></i></button>
          <button type="button" class="dbu-hud-icon" data-dbu-hud-action="collapse" title="${state.collapsed ? "Expandir HUD" : "Recolher HUD"}"><i class="fas fa-chevron-${state.collapsed ? "up" : "down"}"></i></button>
          <button type="button" class="dbu-hud-icon close" data-dbu-hud-action="close" title="Fechar HUD"><i class="fas fa-times"></i></button>
        </div>
      </header>

      <div class="dbu-hud-body dbua-v180-body">
        <section class="dbua-standard-overview">
          <div class="dbu-hud-section-head"><span><i class="fas fa-layer-group"></i> Standard Maneuvers</span><button type="button" data-dbu-hud-action="standard">Abrir menu</button></div>
          <div class="dbua-standard-overview-grid">
            <div><small>Power</small><b>${powerStacks}</b></div>
            <div><small>Energy Charge</small><b>${esc(charge ? `${number(charge.gatheredCharges, 0)} EC` : "—")}</b></div>
            <div><small>Terrain Lift</small><b>${esc(terrain ? `H${terrain.hardness} · S${terrainShield}` : "—")}</b></div>
            <div><small>Grapple</small><b>${esc(grapple ? (grapple.role === "grappler" ? "Grappler" : "Grappled") : "—")}</b></div>
          </div>
          <p class="dbua-standard-overview-note">Use <b>STANDARD</b>, <b>INSTANT</b> e <b>COUNTER</b> pela HUD. Instant reaproveita funções já existentes; Counter mostra somente oportunidades válidas e encaminha para as Pendências.</p>
        </section>
        <aside class="dbu-hud-status">
          <div class="dbu-hud-status-title">Estado atual</div>
          <div class="dbua-state-readonly"><i class="fas fa-dragon"></i><span><small>Transformation</small><b>${esc(activeForm)}</b></span></div>
          <div class="dbua-state-readonly"><i class="fas fa-sun"></i><span><small>Signature Aura</small><b>${esc(aura)}</b></span></div>
          <div class="dbua-state-readonly ${charge ? "active" : ""}"><i class="fas fa-bolt"></i><span><small>Energy Charge</small><b>${esc(chargeLabel)}</b></span></div>
          <button type="button" data-dbu-hud-action="visualConfig" title="Configurar animações e efeitos"><i class="fas fa-palette"></i><span><small>Personagem</small><b>Configurar visuais</b></span></button>
        </aside>
      </div>
      <footer class="dbu-hud-footer"><span>DBU AUTOMATION ${VERSION}</span><span>HUD próprio · sem dependência externa</span></footer>
    </div>
  </section>`;
}

function applyUiState() {
  const body = document.body;
  body?.classList.toggle("dbu-combat-hud-open", state.open);
  body?.classList.toggle(
    "dbu-combat-hud-hotbar-hidden",
    state.open && !!setting("combatHudHideHotbar", false)
  );
  const launcher = document.getElementById(LAUNCHER_ID);
  if (launcher) {
    launcher.classList.toggle("active", state.open);
    launcher.hidden = state.open;
  }
}

function clearHudElement() {
  document.getElementById(HUD_ID)?.remove();
}

async function dispatchHudAction(button, actor, token) {
  const action = button.dataset.dbuHudAction;
  const api = globalThis.DBUAutomation;
  const context = { actor, token };

  if (action === "close") return closeCombatHud();
  if (action === "collapse") {
    state.collapsed = !state.collapsed;
    return renderCombatHud();
  }
  if (action === "sheet") return actor.sheet?.render?.(true);
  if (action === "settings") return openCombatHudPreferences();
  if (action === "targets") {
    const targets = Array.from(game.user?.targets || []);
    if (!targets.length) return ui.notifications.info("DBU HUD: nenhum alvo marcado.");
    for (const target of targets) {
      await target.setTarget?.(false, { user: game.user, releaseOthers: false, groupSelection: false });
    }
    return scheduleHudRender(20);
  }

  if (action === "standard") {
    if (typeof api?.standard !== "function") return ui.notifications.error("DBU HUD: Standard Maneuvers indisponíveis.");
    return api.standard(context);
  }
  if (action === "instant-preview") return openManeuverCategoryPreview("instant", context);
  if (action === "counter-preview") return openManeuverCategoryPreview("counter", { ...context, pendingActions: getPendingActions(actor) });
  if (action === "standard-favorite") {
    const key = button.dataset.standardKey || "";
    if (!key || typeof api?.maneuver !== "function") return ui.notifications.error("DBU HUD: favorito Standard indisponível.");
    return api.maneuver(key, context);
  }

  const method = {
    panel: "panel",
    visualConfig: "visualConfig"
  }[action];

  if (!method || typeof api?.[method] !== "function") {
    return ui.notifications.error(`DBU HUD: ação ${action || "desconhecida"} indisponível.`);
  }

  return api[method](context);
}

async function saveHudPlacement(prefix, anchor, x, y) {
  await game.settings.set(MODULE_ID, `${prefix}Anchor`, anchor);
  await game.settings.set(MODULE_ID, `${prefix}X`, Math.max(0, Math.round(x)));
  await game.settings.set(MODULE_ID, `${prefix}Y`, Math.max(0, Math.round(y)));
}

function attachHudDrag(root, selector, prefix) {
  const panel = root.querySelector(selector);
  const handle = panel?.querySelector(`[data-dbu-hud-drag="${prefix === "combatHudVitals" ? "vitals" : "allies"}"]`);
  if (!panel || !handle) return;

  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    const pointerId = event.pointerId;
    panel.classList.add("dragging");

    // Durante o arraste usamos origem superior esquerda para que o movimento
    // continue natural mesmo quando o jogador alterou a escala do bloco.
    panel.setAttribute("data-dbu-anchor", "top-left");
    panel.style.setProperty("left", `${Math.round(startLeft)}px`, "important");
    panel.style.setProperty("top", `${Math.round(startTop)}px`, "important");
    panel.style.setProperty("right", "auto", "important");
    panel.style.setProperty("bottom", "auto", "important");
    handle.setPointerCapture?.(pointerId);

    const move = moveEvent => {
      if (moveEvent.pointerId !== pointerId) return;
      const currentRect = panel.getBoundingClientRect();
      const maxLeft = Math.max(6, window.innerWidth - currentRect.width - 6);
      const maxTop = Math.max(6, window.innerHeight - currentRect.height - 6);
      const left = Math.max(6, Math.min(maxLeft, startLeft + moveEvent.clientX - startX));
      const top = Math.max(6, Math.min(maxTop, startTop + moveEvent.clientY - startY));
      panel.style.setProperty("left", `${Math.round(left)}px`, "important");
      panel.style.setProperty("top", `${Math.round(top)}px`, "important");
      panel.style.setProperty("right", "auto", "important");
      panel.style.setProperty("bottom", "auto", "important");
    };

    const end = async endEvent => {
      if (endEvent.pointerId !== pointerId) return;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      panel.classList.remove("dragging");
      try { handle.releasePointerCapture?.(pointerId); } catch {}

      const finalRect = panel.getBoundingClientRect();
      const horizontal = finalRect.left + finalRect.width / 2 <= window.innerWidth / 2 ? "left" : "right";
      const vertical = finalRect.top + finalRect.height / 2 <= window.innerHeight / 2 ? "top" : "bottom";
      const anchor = `${vertical}-${horizontal}`;
      const x = horizontal === "left" ? finalRect.left : window.innerWidth - finalRect.right;
      const y = vertical === "top" ? finalRect.top : window.innerHeight - finalRect.bottom;
      await saveHudPlacement(prefix, anchor, x, y);
      scheduleHudRender(10);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}

function attachHudListeners(root, actor, token) {
  for (const button of root.querySelectorAll("[data-dbu-hud-action]")) {
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      try {
        await dispatchHudAction(button, actor, token);
      } catch (error) {
        console.error("DBU HUD | Ação", error);
        ui.notifications.error(error?.message || "Erro executando ação do HUD.");
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  }

  attachHudDrag(root, ".dbu-hud-player-card", "combatHudVitals");
  attachHudDrag(root, ".dbu-hud-allies-panel", "combatHudAllies");
}

export async function renderCombatHud() {
  if (!state.open || !setting("combatHudEnabled", true)) {
    clearHudElement();
    applyUiState();
    return null;
  }

  if (state.rendering) {
    state.renderAgain = true;
    return null;
  }

  state.rendering = true;
  try {
    const { actor, token } = resolveHudSubject({}, { keepCurrent: true });
    if (!actor || !canControl(actor)) return closeCombatHud();

    state.actorId = actor.id;
    state.tokenId = token?.id || null;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = hudContent(actor, token);
    const next = wrapper.firstElementChild;
    if (!next) return null;

    clearHudElement();
    document.body.appendChild(next);
    attachHudListeners(next, actor, token);
    applyUiState();
    return next;
  } catch (error) {
    console.error("DBU HUD | render failed:", error);
    ui.notifications?.error?.("DBU HUD: ocorreu um erro ao renderizar o HUD. Veja o console para detalhes.");
    return null;
  } finally {
    state.rendering = false;
    if (state.renderAgain) {
      state.renderAgain = false;
      queueMicrotask(renderCombatHud);
    }
  }
}

export function scheduleHudRender(delay = 60) {
  if (!state.open) return;
  if (state.renderTimer) clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    renderCombatHud();
  }, delay);
}

export async function openCombatHud(context = {}) {
  if (!setting("combatHudEnabled", true)) {
    ui.notifications.warn("DBU HUD: ative o HUD nas Configurações do Módulo.");
    return null;
  }

  const { actor, token } = resolveHudSubject(context);
  if (!actor) {
    ui.notifications.warn("DBU HUD: selecione um token ou configure um personagem para o usuário.");
    return null;
  }
  if (!canControl(actor)) {
    ui.notifications.warn(`Você não controla ${actor.name}.`);
    return null;
  }

  state.open = true;
  state.actorId = actor.id;
  state.tokenId = token?.id || null;
  return renderCombatHud();
}

export function closeCombatHud() {
  state.open = false;
  state.relevantActorIds = new Set();
  if (state.renderTimer) clearTimeout(state.renderTimer);
  state.renderTimer = null;
  clearHudElement();
  applyUiState();
  return true;
}

export async function toggleCombatHud(context = {}) {
  if (state.open) return closeCombatHud();
  return openCombatHud(context);
}

function ensureLauncher() {
  const enabled = setting("combatHudEnabled", true);
  const existing = document.getElementById(LAUNCHER_ID);
  if (!enabled) {
    existing?.remove();
    closeCombatHud();
    return null;
  }
  if (existing) {
    applyUiState();
    return existing;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.id = LAUNCHER_ID;
  button.className = "dbu-combat-hud-launcher";
  button.title = "Abrir HUD de Combate DBU";
  button.innerHTML = '<i class="fas fa-dragon"></i><span>DBU HUD</span>';
  button.addEventListener("click", event => {
    event.preventDefault();
    toggleCombatHud();
  });
  document.body.appendChild(button);
  applyUiState();
  return button;
}

function syncEnabledState() {
  if (!setting("combatHudEnabled", true)) closeCombatHud();
  ensureLauncher();
  applyUiState();
}

function registerSettingsNow() {
  if (settingsRegistered || !globalThis.game?.settings) return;
  const registry = game.settings.settings;
  const has = key => registry?.has?.(`${MODULE_ID}.${key}`);

  if (!has("combatHudEnabled")) game.settings.register(MODULE_ID, "combatHudEnabled", {
    name: "HUD de Combate DBU",
    hint: "Exibe um lançador para abrir o HUD personalizado do personagem.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: syncEnabledState
  });
  if (!has("combatHudAutoOpen")) game.settings.register(MODULE_ID, "combatHudAutoOpen", {
    name: "HUD DBU: abrir ao selecionar token",
    hint: "Abre ou troca automaticamente o HUD quando você seleciona um token controlável.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
  if (!has("combatHudHideHotbar")) game.settings.register(MODULE_ID, "combatHudHideHotbar", {
    name: "HUD DBU: ocultar hotbar padrão",
    hint: "Oculta apenas visualmente a hotbar normal enquanto o HUD DBU estiver aberto.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: applyUiState
  });
  const registerClientHidden = (key, type, defaultValue) => {
    if (has(key)) return;
    game.settings.register(MODULE_ID, key, {
      name: `HUD DBU: ${key}`,
      scope: "client",
      config: false,
      type,
      default: defaultValue
    });
  };
  registerClientHidden("combatHudVitalsAnchor", String, "top-left");
  registerClientHidden("combatHudVitalsX", Number, 72);
  registerClientHidden("combatHudVitalsY", Number, 82);
  registerClientHidden("combatHudVitalsScale", Number, 100);
  registerClientHidden("combatHudVitalsOpacity", Number, 100);
  registerClientHidden("combatHudShowAllies", Boolean, true);
  registerClientHidden("combatHudAlliesAnchor", String, "top-right");
  registerClientHidden("combatHudAlliesX", Number, 24);
  registerClientHidden("combatHudAlliesY", Number, 82);
  registerClientHidden("combatHudAlliesScale", Number, 100);
  registerClientHidden("combatHudAlliesOpacity", Number, 100);
  settingsRegistered = true;
}

export function registerCombatHudSettings() {
  if (settingsPrepared) return;
  settingsPrepared = true;
  if (globalThis.game?.ready) registerSettingsNow();
  else Hooks.once("init", registerSettingsNow);
}

export async function openCombatHudPreferences() {
  const vitals = hudPlacement("combatHudVitals", { anchor: "top-left", x: 72, y: 82 });
  const allies = hudPlacement("combatHudAllies", { anchor: "top-right", x: 24, y: 82 });
  const vitalsScale = clampSetting(setting("combatHudVitalsScale", 100), 50, 150, 100);
  const vitalsOpacity = clampSetting(setting("combatHudVitalsOpacity", 100), 25, 100, 100);
  const alliesScale = clampSetting(setting("combatHudAlliesScale", 100), 50, 150, 100);
  const alliesOpacity = clampSetting(setting("combatHudAlliesOpacity", 100), 25, 100, 100);
  const anchorOptions = (selected) => [
    ["top-left", "Superior esquerda"],
    ["top-right", "Superior direita"],
    ["bottom-left", "Inferior esquerda"],
    ["bottom-right", "Inferior direita"]
  ].map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");

  const result = await Dialog.wait({
    title: "DBU HUD — Preferências",
    content: `<div class="dbu-auto-window dbu-hud-preferences">
      <div class="dbu-auto-section"><div class="dbu-auto-section-title"><span>HUD por jogador</span></div><div class="dbu-auto-section-body">
        <div class="form-group"><label><input id="dbu-hud-pref-enabled" type="checkbox" ${setting("combatHudEnabled", true) ? "checked" : ""}> Ativar HUD de Combate</label></div>
        <div class="form-group"><label><input id="dbu-hud-pref-auto" type="checkbox" ${setting("combatHudAutoOpen", false) ? "checked" : ""}> Abrir ao selecionar meu token</label></div>
        <div class="form-group"><label><input id="dbu-hud-pref-hotbar" type="checkbox" ${setting("combatHudHideHotbar", false) ? "checked" : ""}> Ocultar hotbar padrão enquanto o HUD estiver aberto</label></div>
      </div></div>

      <div class="dbu-auto-section"><div class="dbu-auto-section-title"><span>HP, Ki e Capacidade</span></div><div class="dbu-auto-section-body">
        <div class="form-group"><label>Posição base</label><select id="dbu-hud-pref-vitals-anchor">${anchorOptions(vitals.anchor)}</select></div>
        <div class="dbu-hud-pref-offsets">
          <div class="form-group"><label>Distância horizontal (px)</label><input id="dbu-hud-pref-vitals-x" type="number" min="0" max="2000" step="1" value="${vitals.x}"></div>
          <div class="form-group"><label>Distância vertical (px)</label><input id="dbu-hud-pref-vitals-y" type="number" min="0" max="2000" step="1" value="${vitals.y}"></div>
        </div>
        <div class="dbu-hud-pref-offsets">
          <div class="form-group"><label>Tamanho (%)</label><input id="dbu-hud-pref-vitals-scale" type="number" min="50" max="150" step="5" value="${vitalsScale}"></div>
          <div class="form-group"><label>Transparência / visibilidade (%)</label><input id="dbu-hud-pref-vitals-opacity" type="number" min="25" max="100" step="5" value="${vitalsOpacity}"></div>
        </div>
        <p class="notes"><i class="fas fa-grip-lines"></i> Você também pode arrastar o bloco de HP/Ki/Capacidade pela alça; a nova posição é salva automaticamente só para você.</p>
      </div></div>

      <div class="dbu-auto-section"><div class="dbu-auto-section-title"><span>HP dos aliados</span></div><div class="dbu-auto-section-body">
        <div class="form-group"><label><input id="dbu-hud-pref-allies" type="checkbox" ${setting("combatHudShowAllies", true) ? "checked" : ""}> Mostrar painel de aliados presentes na cena</label></div>
        <div class="form-group"><label>Posição base</label><select id="dbu-hud-pref-allies-anchor">${anchorOptions(allies.anchor)}</select></div>
        <div class="dbu-hud-pref-offsets">
          <div class="form-group"><label>Distância horizontal (px)</label><input id="dbu-hud-pref-allies-x" type="number" min="0" max="2000" step="1" value="${allies.x}"></div>
          <div class="form-group"><label>Distância vertical (px)</label><input id="dbu-hud-pref-allies-y" type="number" min="0" max="2000" step="1" value="${allies.y}"></div>
        </div>
        <div class="dbu-hud-pref-offsets">
          <div class="form-group"><label>Tamanho (%)</label><input id="dbu-hud-pref-allies-scale" type="number" min="50" max="150" step="5" value="${alliesScale}"></div>
          <div class="form-group"><label>Transparência / visibilidade (%)</label><input id="dbu-hud-pref-allies-opacity" type="number" min="25" max="100" step="5" value="${alliesOpacity}"></div>
        </div>
        <p class="notes">Os aliados ficam em formato compacto: foto, nome e barra de LP. Passe o mouse sobre um aliado para ver o LP atual/máximo. O conjunto também pode ser arrastado.</p>
      </div></div>

      <p class="notes">Todas essas escolhas usam configurações de cliente: cada jogador pode montar sua própria HUD sem mudar a dos demais.</p>
    </div>`,
    buttons: {
      reset: {
        icon: '<i class="fas fa-undo"></i>',
        label: "Padrão",
        callback: () => ({
          enabled: true, autoOpen: false, hideHotbar: false,
          vitalsAnchor: "top-left", vitalsX: 72, vitalsY: 82, vitalsScale: 100, vitalsOpacity: 100,
          showAllies: true, alliesAnchor: "top-right", alliesX: 24, alliesY: 82, alliesScale: 100, alliesOpacity: 100
        })
      },
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: "Salvar",
        callback: html => ({
          enabled: !!html.find("#dbu-hud-pref-enabled").prop("checked"),
          autoOpen: !!html.find("#dbu-hud-pref-auto").prop("checked"),
          hideHotbar: !!html.find("#dbu-hud-pref-hotbar").prop("checked"),
          vitalsAnchor: String(html.find("#dbu-hud-pref-vitals-anchor").val() || "top-left"),
          vitalsX: clampSetting(html.find("#dbu-hud-pref-vitals-x").val(), 0, 2000, 72),
          vitalsY: clampSetting(html.find("#dbu-hud-pref-vitals-y").val(), 0, 2000, 82),
          vitalsScale: clampSetting(html.find("#dbu-hud-pref-vitals-scale").val(), 50, 150, 100),
          vitalsOpacity: clampSetting(html.find("#dbu-hud-pref-vitals-opacity").val(), 25, 100, 100),
          showAllies: !!html.find("#dbu-hud-pref-allies").prop("checked"),
          alliesAnchor: String(html.find("#dbu-hud-pref-allies-anchor").val() || "top-right"),
          alliesX: clampSetting(html.find("#dbu-hud-pref-allies-x").val(), 0, 2000, 24),
          alliesY: clampSetting(html.find("#dbu-hud-pref-allies-y").val(), 0, 2000, 82),
          alliesScale: clampSetting(html.find("#dbu-hud-pref-allies-scale").val(), 50, 150, 100),
          alliesOpacity: clampSetting(html.find("#dbu-hud-pref-allies-opacity").val(), 25, 100, 100)
        })
      },
      cancel: { label: "Cancelar", callback: () => null }
    },
    default: "save",
    close: () => null
  }, { width: 520, classes: ["dbu-auto-dialog", "dbu-hud-preferences-dialog"] });

  if (!result) return null;
  await game.settings.set(MODULE_ID, "combatHudAutoOpen", result.autoOpen);
  await game.settings.set(MODULE_ID, "combatHudHideHotbar", result.hideHotbar);
  await game.settings.set(MODULE_ID, "combatHudVitalsAnchor", result.vitalsAnchor);
  await game.settings.set(MODULE_ID, "combatHudVitalsX", result.vitalsX);
  await game.settings.set(MODULE_ID, "combatHudVitalsY", result.vitalsY);
  await game.settings.set(MODULE_ID, "combatHudVitalsScale", result.vitalsScale);
  await game.settings.set(MODULE_ID, "combatHudVitalsOpacity", result.vitalsOpacity);
  await game.settings.set(MODULE_ID, "combatHudShowAllies", result.showAllies);
  await game.settings.set(MODULE_ID, "combatHudAlliesAnchor", result.alliesAnchor);
  await game.settings.set(MODULE_ID, "combatHudAlliesX", result.alliesX);
  await game.settings.set(MODULE_ID, "combatHudAlliesY", result.alliesY);
  await game.settings.set(MODULE_ID, "combatHudAlliesScale", result.alliesScale);
  await game.settings.set(MODULE_ID, "combatHudAlliesOpacity", result.alliesOpacity);
  await game.settings.set(MODULE_ID, "combatHudEnabled", result.enabled);
  syncEnabledState();
  if (state.open) scheduleHudRender(10);
  return result;
}

function addTokenHudButton(app, html, data) {
  if (!setting("combatHudEnabled", true)) return;
  const tokenId = data?._id || data?.id || app?.object?.id || app?.object?.document?.id;
  const token = tokenId ? canvas?.tokens?.get?.(tokenId) : app?.object;
  const actor = token?.actor;
  if (!actor || !canControl(actor)) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector("[data-dbu-combat-hud-button]")) return;
  const column = root.querySelector(".col.right") || root.querySelector(".right") || root;
  const control = document.createElement("div");
  control.className = "control-icon";
  control.dataset.dbuCombatHudButton = "1";
  control.title = "DBU — HUD de Combate";
  control.innerHTML = '<i class="fas fa-gamepad"></i>';
  control.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (state.open && state.actorId === actor.id) closeCombatHud();
    else openCombatHud({ actor, token });
  });
  column.appendChild(control);
}

function isRelevantCombatMessage(message) {
  if (!message) return false;
  try {
    return !!(
      message.getFlag?.("world", "dbuAttackData")
      || message.getFlag?.("world", "dbuDefenseStates")
      || message.getFlag?.("world", "dbuCombatRevealed")
      || message.getFlag?.("world", "dbuDeflectReflectOpportunity")
      || message.getFlag?.("world", "dbuReflectUses")
    );
  } catch {
    return false;
  }
}

function isHudRelevantActorId(actorId) {
  if (!actorId) return false;
  return actorId === state.actorId || state.relevantActorIds?.has?.(actorId);
}

function removeOldHooks() {
  const old = globalThis.DBU_COMBAT_HUD_AUTOMATION;
  for (const [hook, id] of Object.entries(old?.hooks || {})) {
    try { Hooks.off(hook, id); } catch {}
  }
}

export function initializeCombatHudAutomation() {
  registerSettingsNow();
  removeOldHooks();

  state.hooks = {
    renderTokenHUD: Hooks.on("renderTokenHUD", addTokenHudButton),
    controlToken: Hooks.on("controlToken", (token, controlled) => {
      if (!controlled || !canControl(token?.actor)) return;
      if (state.open || setting("combatHudAutoOpen", false)) {
        state.open = true;
        state.actorId = token.actor.id;
        state.tokenId = token.id;
        scheduleHudRender(30);
      }
    }),
    updateActor: Hooks.on("updateActor", actor => {
      if (isHudRelevantActorId(actor?.id)) scheduleHudRender(80);
    }),
    updateToken: Hooks.on("updateToken", tokenDocument => {
      if (tokenDocument?.id === state.tokenId || isHudRelevantActorId(tokenDocument?.actorId)) {
        scheduleHudRender(80);
      }
    }),
    updateCombat: Hooks.on("updateCombat", () => scheduleHudRender(60)),
    updateCombatant: Hooks.on("updateCombatant", () => scheduleHudRender(60)),
    deleteCombat: Hooks.on("deleteCombat", () => scheduleHudRender(60)),
    targetToken: Hooks.on("targetToken", user => {
      if (user?.id === game.user?.id) scheduleHudRender(30);
    }),
    createChatMessage: Hooks.on("createChatMessage", message => {
      if (isRelevantCombatMessage(message)) scheduleHudRender(90);
    }),
    updateChatMessage: Hooks.on("updateChatMessage", message => {
      if (isRelevantCombatMessage(message)) scheduleHudRender(90);
    }),
    deleteChatMessage: Hooks.on("deleteChatMessage", message => {
      if (isRelevantCombatMessage(message)) scheduleHudRender(90);
    }),
    canvasReady: Hooks.on("canvasReady", () => {
      ensureLauncher();
      scheduleHudRender(100);
    }),
    deleteActor: Hooks.on("deleteActor", actor => {
      if (actor?.id === state.actorId) closeCombatHud();
    })
  };

  ensureLauncher();
  globalThis.DBU_COMBAT_HUD_AUTOMATION = {
    version: VERSION,
    initialized: true,
    state,
    hooks: state.hooks,
    open: openCombatHud,
    close: closeCombatHud,
    toggle: toggleCombatHud,
    render: renderCombatHud,
    preferences: openCombatHudPreferences
  };
  console.log(`DBU Automation ${VERSION} | HUD de Combate pronto`);
  return globalThis.DBU_COMBAT_HUD_AUTOMATION;
}