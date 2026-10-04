// ============================================================
// DBU Automation v1.8.1 — Recovery (DBU 0.9.2)
// ============================================================
// Defeat & Recovery 0.9.2:
// - Instant Recovery: after a Combat Encounter, regain 1/10 Maximum LP and Ki.
// - Prolonged Recovery: after Instant Recovery, each hour outside Combat grants
//   another 1/10 Maximum LP and Ki.
// Capacity is intentionally NOT recovered by these rules.
// ============================================================

const MODULE_ID = "dbu-automation";
const LAST_INSTANT_FLAG = "lastInstantRecovery092";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isPlayerCharacter(actor) {
  if (!actor || actor.type !== "character") return false;
  if (typeof actor.hasPlayerOwner === "boolean") return actor.hasPlayerOwner;

  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownership = actor.ownership || actor._source?.ownership || {};
  return (game.users?.contents || [...(game.users || [])]).some(user => {
    if (!user || user.isGM) return false;
    return number(ownership[user.id], number(ownership.default, 0)) >= ownerLevel;
  });
}

export function playerCharacters() {
  return (game.actors?.contents || [...(game.actors || [])])
    .filter(isPlayerCharacter)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}

export function combatPlayerCharacters(combat = game.combat) {
  const out = [];
  const seen = new Set();
  for (const combatant of combat?.combatants || []) {
    const actor = combatant?.actor;
    if (!isPlayerCharacter(actor)) continue;
    const key = actor.uuid || actor.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(actor);
  }
  return out;
}

export function recoveryUnit(actor) {
  const maxLP = Math.max(0, number(actor?.system?.lifePoints?.max, 0));
  const maxKi = Math.max(0, number(actor?.system?.kiPool?.max, 0));

  // DBU resources are integer-valued. Existing DBU 0.9.2 code rounds other
  // 1/10-of-maximum quantities down, so Recovery follows the same convention.
  return {
    maxLP,
    maxKi,
    lp: Math.floor(maxLP / 10),
    ki: Math.floor(maxKi / 10)
  };
}

export async function recoverActor(actor, {
  units = 1,
  mode = "prolonged",
  combatId = null,
  preventDuplicateInstant = true
} = {}) {
  if (!isPlayerCharacter(actor)) return { actor, skipped: true, reason: "not-player-character" };

  const normalizedUnits = Math.max(1, Math.trunc(number(units, 1)));

  if (mode === "instant" && combatId && preventDuplicateInstant) {
    const last = actor.getFlag?.(MODULE_ID, LAST_INSTANT_FLAG) || null;
    if (last?.combatId === combatId) {
      return { actor, skipped: true, reason: "already-recovered", combatId };
    }
  }

  const unit = recoveryUnit(actor);
  const beforeLP = Math.max(0, number(actor.system?.lifePoints?.value, 0));
  const beforeKi = Math.max(0, number(actor.system?.kiPool?.value, 0));
  const requestedLP = unit.lp * normalizedUnits;
  const requestedKi = unit.ki * normalizedUnits;
  const afterLP = Math.min(unit.maxLP, beforeLP + requestedLP);
  const afterKi = Math.min(unit.maxKi, beforeKi + requestedKi);
  const gainedLP = Math.max(0, afterLP - beforeLP);
  const gainedKi = Math.max(0, afterKi - beforeKi);

  await actor.update({
    "system.lifePoints.value": afterLP,
    "system.kiPool.value": afterKi
  });

  if (mode === "instant" && combatId) {
    await actor.setFlag(MODULE_ID, LAST_INSTANT_FLAG, {
      combatId,
      at: Date.now(),
      lp: gainedLP,
      ki: gainedKi
    }).catch(error => console.warn("DBU Recovery | não consegui registrar Instant Recovery:", error));
  }

  return {
    actor,
    skipped: false,
    mode,
    units: normalizedUnits,
    beforeLP,
    beforeKi,
    afterLP,
    afterKi,
    gainedLP,
    gainedKi,
    unitLP: unit.lp,
    unitKi: unit.ki,
    maxLP: unit.maxLP,
    maxKi: unit.maxKi,
    combatId
  };
}

async function postRecoveryCard(title, results, subtitle = "") {
  const rows = results.filter(result => result && !result.skipped);
  if (!rows.length) return null;

  const content = `<div class="dbu-attack-roll">
    <h3 class="dbu-attack-title"><span class="dbu-card-title-text"><i class="fas fa-heartbeat"></i> ${esc(title)}</span></h3>
    <div class="dbu-card-body">
      ${subtitle ? `<div class="dbu-defend-guide">${esc(subtitle)}</div>` : ""}
      <div class="dbu-attack-meta"><span class="dbu-meta-chip">DBU 0.9.2 · Recovery</span><span class="dbu-meta-chip">Capacity não é recuperada</span></div>
      <div style="display:grid;gap:5px;margin-top:8px;">
        ${rows.map(result => `<div class="dbu-defend-guide"><b>${esc(result.actor.name)}</b> · LP ${esc(result.beforeLP)} → <b>${esc(result.afterLP)}</b> / ${esc(result.maxLP)} (+${esc(result.gainedLP)}) · Ki ${esc(result.beforeKi)} → <b>${esc(result.afterKi)}</b> / ${esc(result.maxKi)} (+${esc(result.gainedKi)})</div>`).join("")}
      </div>
    </div>
  </div>`;

  return ChatMessage.create({
    speaker: { alias: "DBU Recovery" },
    content
  });
}

export async function applyInstantRecovery(combat, { announce = true } = {}) {
  if (!combat?.id) return { combatId: null, actors: 0, recovered: 0, results: [] };

  const actors = combatPlayerCharacters(combat);
  const results = [];
  for (const actor of actors) {
    results.push(await recoverActor(actor, {
      mode: "instant",
      units: 1,
      combatId: combat.id,
      preventDuplicateInstant: true
    }));
  }

  const recovered = results.filter(result => result && !result.skipped).length;
  if (announce && recovered) {
    await postRecoveryCard(
      "Instant Recovery",
      results,
      "Fim do Combat Encounter: cada personagem recupera 1/10 do Maximum Life Points e Ki Point Pool."
    );
  }

  return { combatId: combat.id, actors: actors.length, recovered, results };
}

export async function applyProlongedRecovery(actors, { hours = 1, announce = true } = {}) {
  const normalizedHours = Math.max(1, Math.trunc(number(hours, 1)));
  const unique = [];
  const seen = new Set();
  for (const actor of actors || []) {
    if (!isPlayerCharacter(actor)) continue;
    const key = actor.uuid || actor.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(actor);
  }

  const results = [];
  for (const actor of unique) {
    results.push(await recoverActor(actor, {
      mode: "prolonged",
      units: normalizedHours,
      preventDuplicateInstant: false
    }));
  }

  if (announce && results.some(result => result && !result.skipped)) {
    await postRecoveryCard(
      "Prolonged Recovery",
      results,
      `${normalizedHours} hora(s) fora de Combat Encounter: +1/10 dos máximos de LP e Ki por hora.`
    );
  }

  return { hours: normalizedHours, actors: unique.length, results };
}

function dialogRoot(html) {
  return html instanceof HTMLElement ? html : html?.[0] || html || null;
}

export async function openProlongedRecoveryDialog({ actors = null } = {}) {
  if (!game.user?.isGM) {
    ui.notifications.warn("DBU Recovery: Prolonged Recovery pelo painel é controlada pelo GM/ARC.");
    return null;
  }
  if (game.combat?.started) {
    ui.notifications.warn("DBU Recovery: Prolonged Recovery exige tempo fora de um Combat Encounter.");
    return null;
  }

  const choices = (actors || playerCharacters()).filter(isPlayerCharacter);
  if (!choices.length) {
    ui.notifications.warn("DBU Recovery: nenhum personagem de jogador encontrado.");
    return null;
  }

  const result = await Dialog.wait({
    title: "DBU — Prolonged Recovery",
    content: `<div class="dbu-auto-window">
      <div class="dbu-auto-rule-block">
        <div class="dbu-auto-rule-title"><i class="fas fa-hourglass-half"></i> Prolonged Recovery · DBU 0.9.2</div>
        <p>Após Instant Recovery, cada hora fora de Combat recupera mais <b>1/10 do Maximum Life Points e Ki Point Pool</b>.</p>
        <p><b>Capacity não é recuperada.</b></p>
      </div>
      <div class="form-group"><label><b>Horas de recuperação</b></label><input type="number" min="1" step="1" value="1" data-dbu-recovery-hours style="width:100%;"></div>
      <div style="display:grid;gap:5px;margin-top:8px;">
        ${choices.map(actor => {
          const unit = recoveryUnit(actor);
          return `<label style="display:flex;gap:8px;align-items:center;"><input type="checkbox" data-dbu-recovery-actor value="${esc(actor.id)}" checked><span><b>${esc(actor.name)}</b> · por hora: +${esc(unit.lp)} LP / +${esc(unit.ki)} Ki</span></label>`;
        }).join("")}
      </div>
    </div>`,
    buttons: {
      apply: {
        icon: '<i class="fas fa-heartbeat"></i>',
        label: "Aplicar Recovery",
        callback: html => {
          const root = dialogRoot(html);
          const hours = Math.max(1, Math.trunc(number(root?.querySelector?.("[data-dbu-recovery-hours]")?.value, 1)));
          const actorIds = [...(root?.querySelectorAll?.("[data-dbu-recovery-actor]:checked") || [])].map(input => input.value);
          return { hours, actorIds };
        }
      },
      cancel: { label: "Cancelar", callback: () => null }
    },
    default: "apply",
    close: () => null
  }, { width: 560, classes: ["dbu-auto-window-shell"] });

  if (!result?.actorIds?.length) return null;
  const selected = result.actorIds.map(id => game.actors?.get?.(id)).filter(Boolean);
  const applied = await applyProlongedRecovery(selected, { hours: result.hours, announce: true });
  ui.notifications.info(`DBU Recovery: Prolonged Recovery aplicada a ${applied.actors} personagem(ns) por ${applied.hours} hora(s).`);
  return applied;
}

export const Recovery = {
  isPlayerCharacter,
  playerCharacters,
  combatPlayerCharacters,
  recoveryUnit,
  recoverActor,
  applyInstantRecovery,
  applyProlongedRecovery,
  openProlongedRecoveryDialog
};
