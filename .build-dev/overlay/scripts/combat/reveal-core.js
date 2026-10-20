// DBU Automation — Reveal, sincronização GM e finalização de defesa
import { attackTargetKeys, resolveParticipant, participantKeyForAttack } from "../core/token-identity.js";

export function initializeRevealCore(deps = {}) {
  const {
    DBU_SYSTEM_ID, DBU_SOCKET, DBU_PENDING_TIMEOUT,
    dbuEsc, dbuSleep, dbuApplyDamage, dbuDefenseResult, dbuResolveDefense,
    dbuGetDefenseStates, dbuGetDefenseState, dbuSetDefenseState, dbuClearDefensePending,
    dbuGetDuelContext, dbuRefundDuelCounter, dbuGetUnitedAttackContributions
  } = deps;

function dbuIsPrimaryGM() {
  const activeGMs = game.users
    .filter(
      user => user.active && user.isGM
    )
    .sort(
      (a, b) =>
        String(a.id).localeCompare(String(b.id))
    );

  return activeGMs[0]?.id === game.user.id;
}

// ============================================================
// GM ATUALIZA A CARTA
// ============================================================

function dbuCombatTargetIds(attack) {
  return attackTargetKeys(attack);
}

function dbuCombatProgress(attack, states) {
  const ids = dbuCombatTargetIds(attack);
  const selected = ids.filter(id => states?.[id]?.resolved).length;
  return { ids, selected, total: ids.length, allSelected: ids.length > 0 && selected >= ids.length };
}

function dbuResolvedTargetHTML(defender, text, targetKey = defender.id) {
  const safeId = String(targetKey).replace(/[^a-zA-Z0-9_-]/g, "");
  return `
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
      </div>
      <div class="dbu-attack-buffs">
        <strong>${dbuEsc(text || "Defesa resolvida")}</strong>
      </div>
    </div>
  `;
}

function dbuDefenseChoiceLabel(type, fallback = "Defesa") {
  const labels = {
    dodge: "Dodge",
    parry: "Parry",
    directHit: "Direct Hit",
    powerFlare: "Power Flare",
    crossCounter: "Cross Counter",
    guard: "Guard",
    duelClash: "Duel Clash",
    unitedDuel: "United Duel"
  };
  return labels[String(type || "")] || String(fallback || "Defesa");
}

function dbuWaitingTargetHTML(defender, progress, defenseName = "Defesa", targetKey = defender.id) {
  const safeId = String(targetKey).replace(/[^a-zA-Z0-9_-]/g, "");
  const label = String(defenseName || "Defesa");
  return `
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
      </div>
      <div class="dbu-attack-buffs dbu-auto-selected-defense">
        <strong><i class="fas fa-check-circle"></i> ${dbuEsc(label)} selecionado — resultado oculto</strong><br>
        <span>Aguardando os demais alvos (${progress.selected}/${progress.total})</span>
      </div>
    </div>
  `;
}

function dbuAttackRevealHTML(attack) {
  const strikeTags = [
    attack?.strikeCritical ? '<span class="dbu-crit">CRIT</span>' : "",
    attack?.strikeBotch ? '<span class="dbu-botch">BOTCH</span>' : ""
  ].filter(Boolean).join(" ");

  const woundTags = [
    attack?.woundCritical ? '<span class="dbu-crit">CRIT</span>' : "",
    attack?.woundBotch ? '<span class="dbu-botch">BOTCH</span>' : ""
  ].filter(Boolean).join(" ");

  return `
    <div class="dbu-roll-row">
      <span class="dbu-roll-label">Strike</span>
      <span class="dbu-roll-main">
        <code class="dbu-roll-formula">${dbuEsc(attack?.strikeDisplayFormula || "")}</code>
        <span class="dbu-roll-sub">
          Nat ${Number(attack?.strikeNatural || 0)} · CT ${Number(attack?.strikeCT || 10)}+ · Botch ${Number(attack?.strikeBotchThreshold || 0) === 0 ? "OFF" : `1-${Number(attack?.strikeBotchThreshold || 1)}`}
        </span>
        ${strikeTags}
      </span>
      <span class="dbu-roll-total">${Number(attack?.strikeTotal || 0)}</span>
    </div>

    <div class="dbu-roll-row">
      <span class="dbu-roll-label">Wound</span>
      <span class="dbu-roll-main">
        <code class="dbu-roll-formula">${dbuEsc(attack?.woundDisplayFormula || "")}</code>
        <span class="dbu-roll-sub">
          Nat ${Number(attack?.woundNatural || 0)} · CT ${Number(attack?.woundCT || 10)}+${Number(attack?.wager || 0) > 0 ? ` · Wager +${Number(attack.wager)}` : ""} · Botch ${Number(attack?.woundBotchThreshold || 0) === 0 ? "OFF" : `1-${Number(attack?.woundBotchThreshold || 1)}`}
        </span>
        ${woundTags}
      </span>
      <span class="dbu-roll-total" data-dbu-wound-total>${Number(attack?.woundTotal || 0)}</span>
    </div>
  `;
}

async function dbuRevealNativeAttackMessage(attack) {
  const originalId = attack?.originalAttackMessageId;
  if (!originalId) return;

  const original = game.messages.get(originalId);
  if (!original) return;

  const reveal = foundry.utils.deepClone(
    original.getFlag(DBU_SYSTEM_ID, "attackReveal") || null
  );
  if (!reveal) return;

  // United Attack altera o Wound depois que a rolagem nativa foi criada.
  // Atualiza o reveal nativo para ele mostrar o MESMO total da carta customizada.
  if (Number.isFinite(Number(attack?.woundTotal))) {
    reveal.woundTotal = Number(attack.woundTotal);

    try {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = String(reveal.revealedHtml || "");
      const rows = wrapper.querySelectorAll(".dbu-roll-row");
      const woundRow = Array.from(rows).find(row =>
        String(row.querySelector(".dbu-roll-label")?.textContent || "")
          .trim()
          .toLowerCase() === "wound"
      );
      const total = woundRow?.querySelector(".dbu-roll-total");
      if (total) total.textContent = String(Number(attack.woundTotal));
      reveal.revealedHtml = wrapper.innerHTML;
    } catch (error) {
      console.warn("DBU | Não consegui sincronizar Wound no reveal nativo:", error);
    }
  }

  reveal.revealed = true;

  const updates = {
    content: reveal.revealedHtml,
    [`flags.${DBU_SYSTEM_ID}.attackReveal`]: reveal,
    "flags.world.dbuAutomationCombatRevealed": true,
    "flags.world.dbuAutomationSecretCombat": false
  };

  await original.update(updates);

  // Feedback de dados somente depois que todos os defensores escolheram.
  try { foundry.audio.AudioHelper.play({ src: CONFIG.sounds.dice }, true); } catch {}
  if (game.dice3d) {
    try {
      const rollDatas = [
        reveal.strikeRollData,
        reveal.woundRollData,
        reveal.strikeCritRollData,
        reveal.woundCritRollData
      ].filter(Boolean);
      for (const data of rollDatas) {
        await game.dice3d.showForRoll(Roll.fromData(data), game.user, true);
      }
    } catch (error) {
      console.warn("DBU | Dice So Nice na revelação conjunta:", error);
    }
  }
}

async function dbuFinalizeHiddenOutcome(defender, attack, outcome, { deferDamage = true } = {}) {
  if (!outcome) return { damagePending: false };

  await dbuDefenseResult(
    defender,
    outcome.defenseType,
    outcome.name,
    outcome.total,
    outcome.targetLabel,
    outcome.target,
    !!outcome.success,
    outcome.extra || ""
  );

  const damagePending = !!outcome.damageDefense;

  // v6.8 / DBU Automation v1.4:
  // o resultado é revelado primeiro. Qualquer dano fica pendente até a janela
  // de Intervene ser encerrada, porque um Deflect bem-sucedido pode cancelar
  // o ataque para TODOS os alvos.
  if (damagePending && !deferDamage) {
    await dbuApplyDamage(defender, attack, outcome.damageDefense);
  }

  return { damagePending };
}

async function dbuGMRevealCombatResults(messageId) {
  if (!game.user.isGM || !dbuIsPrimaryGM()) return;

  globalThis.DBU_COMBAT_REVEAL_LOCKS ||= new Set();
  if (globalThis.DBU_COMBAT_REVEAL_LOCKS.has(messageId)) return;

  let message = game.messages.get(messageId);
  if (!message) return;
  if (message.getFlag("world", "dbuCombatRevealed")) return;
  if (message.getFlag("world", "dbuCombatRevealInProgress")) return;

  const attack = foundry.utils.deepClone(message.getFlag("world", "dbuAttackData") || {});
  let states = foundry.utils.deepClone(message.getFlag("world", "dbuDefenseStates") || {});
  const progress = dbuCombatProgress(attack, states);
  if (!progress.allSelected) return;

  globalThis.DBU_COMBAT_REVEAL_LOCKS.add(messageId);

  try {
    await message.update({ "flags.world.dbuCombatRevealInProgress": true });

    // Resolve mensagens e dano apenas agora, quando todos já escolheram.
    for (const actorId of progress.ids) {
      const state = states[actorId];
      if (!state || state.finalized) continue;

      const defender = resolveParticipant(actorId, attack);
      let finalizeInfo = { damagePending: false };
      if (defender && state.hiddenOutcome) {
        try {
          finalizeInfo = await dbuFinalizeHiddenOutcome(
            defender,
            attack,
            state.hiddenOutcome,
            { deferDamage: true }
          );
        } catch (error) {
          console.error(`DBU | Revelação da defesa de ${defender.name}:`, error);
          ui.notifications.error(`DBU: erro finalizando a defesa de ${defender.name}.`);
        }
      }

      const damagePending = !!finalizeInfo?.damagePending;

      states[actorId] = {
        ...state,
        finalized: true,
        finalizedAt: Date.now(),
        damagePending,
        damageResolved: !damagePending,
        intervention: damagePending
          ? { status: "pending", openedAt: Date.now() }
          : null
      };

      // Salva progresso para evitar reaplicar dano se houver erro depois.
      await message.update({ "flags.world.dbuDefenseStates": states });
    }

    message = game.messages.get(messageId) || message;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = String(message.content || "");

    const secretResults = wrapper.querySelector("[data-dbu-secret-attack-results]");
    if (secretResults) secretResults.innerHTML = dbuAttackRevealHTML(attack);

    const waitStatus = wrapper.querySelector("[data-dbu-secret-wait-status]");
    if (waitStatus) {
      waitStatus.innerHTML = "<strong>🔓 Todos os alvos registraram suas defesas — resultados revelados.</strong>";
    }

    for (const actorId of progress.ids) {
      const defender = resolveParticipant(actorId, attack);
      const state = states[actorId];
      if (!defender || !state) continue;
      const safeId = String(actorId).replace(/[^a-zA-Z0-9_-]/g, "");
      const row = wrapper.querySelector(`[data-target-row="${safeId}"]`);
      if (row) row.outerHTML = dbuResolvedTargetHTML(defender, state.text || "Defesa resolvida", actorId);
    }

    await message.update({
      content: wrapper.innerHTML,
      "flags.world.dbuDefenseStates": states,
      "flags.world.dbuCombatRevealed": true,
      "flags.world.dbuCombatRevealInProgress": false
    });

    await dbuRevealNativeAttackMessage(attack);

    const pendingIntervenes = Object.values(states).filter(st => st?.damagePending && !st?.damageResolved).length;
    ui.notifications.info(
      pendingIntervenes > 0
        ? `${attack.attackerName || "Ataque"}: resultados revelados. ${pendingIntervenes} impacto(s) aguardando Intervene.`
        : `${attack.attackerName || "Ataque"}: todos escolheram suas defesas. Resultados revelados.`
    );
  } catch (error) {
    console.error("DBU | Revelação conjunta:", error);
    try {
      const current = game.messages.get(messageId);
      await current?.update({ "flags.world.dbuCombatRevealInProgress": false });
    } catch {}
  } finally {
    globalThis.DBU_COMBAT_REVEAL_LOCKS.delete(messageId);
  }
}

async function dbuGMUpdateDefenseCard({
  messageId,
  defenderId,
  status,
  text,
  defenseType = "",
  defenseName = "",
  hiddenOutcome = null,
  userId = null
}) {
  if (!game.user.isGM) return;

  const message = game.messages.get(messageId);
  const defender = resolveParticipant(defenderId, message?.getFlag("world", "dbuAttackData"));

  if (!message || !defender) return;

  if (userId) {
    const requester = game.users.get(userId);
    if (!requester) return;

    const allowed = requester.isGM || defender.testUserPermission(requester, "OWNER");
    if (!allowed) {
      console.warn("DBU | Socket recusado: usuário sem OWNER.", { userId, defenderId, messageId });
      return;
    }
  }

  const attack = foundry.utils.deepClone(message.getFlag("world", "dbuAttackData") || {});
  const states = foundry.utils.deepClone(message.getFlag("world", "dbuDefenseStates") || {});

  const hasTarget = Object.prototype.hasOwnProperty.call(states, defenderId)
    || dbuCombatTargetIds(attack).includes(defenderId);

  if (!hasTarget) {
    console.warn("DBU | Defensor não pertence a essa carta.");
    return;
  }

  // A socket and the Actor fallback can submit the same defense.
  // Already committed outcomes must not overwrite another target's progress.
  if (states[defenderId]?.resolved && states[defenderId]?.hiddenOutcome) {
    if (dbuCombatProgress(attack, states).allSelected) {
      await dbuGMRevealCombatResults(messageId);
    }
    return;
  }

  const selectedDefenseType = String(
    defenseType
    || hiddenOutcome?.defenseType
    || states[defenderId]?.defenseType
    || ""
  );
  const selectedDefenseName = String(
    defenseName
    || hiddenOutcome?.name
    || states[defenderId]?.defenseName
    || dbuDefenseChoiceLabel(selectedDefenseType)
  );

  states[defenderId] = {
    ...(states[defenderId] || {}),
    resolved: true,
    pending: false,
    status,
    text,
    defenseType: selectedDefenseType || states[defenderId]?.defenseType || null,
    defenseName: selectedDefenseName,
    hiddenOutcome: hiddenOutcome ? foundry.utils.deepClone(hiddenOutcome) : null,
    selectedAt: Date.now()
  };

  const progress = dbuCombatProgress(attack, states);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = String(message.content || "");

  const safeId = String(defenderId).replace(/[^a-zA-Z0-9_-]/g, "");
  const row = wrapper.querySelector(`[data-target-row="${safeId}"]`);
  if (row) {
    row.outerHTML = message.getFlag("world", "dbuCombatRevealed")
      ? dbuResolvedTargetHTML(defender, text, defenderId)
      : dbuWaitingTargetHTML(defender, progress, selectedDefenseName, defenderId);
  }

  const waitStatus = wrapper.querySelector("[data-dbu-secret-wait-status]");
  if (waitStatus && !message.getFlag("world", "dbuCombatRevealed")) {
    waitStatus.innerHTML = `<span><i class="fas fa-lock"></i> Resultados ocultos</span><strong>${progress.selected}/${progress.total} defesas registradas</strong>`;
  }

  await message.update({
    content: wrapper.innerHTML,
    "flags.world.dbuDefenseStates": states
  });

  console.log(`DBU | Defesa registrada secretamente: ${defender.name} (${progress.selected}/${progress.total})`);

  if (progress.allSelected) {
    await dbuGMRevealCombatResults(messageId);
  }
}

// Serialize responses for the same ChatMessage. Without this, multiple
// sockets / Actor fallback hooks can read the same old states and each write
// only one resolved target back, leaving 1/N permanently.
const dbuDefenseCardQueues = new Map();

function dbuQueueDefenseCard(payload) {
  const key = String(payload?.messageId || "");
  if (!key) return Promise.resolve();
  const previous = dbuDefenseCardQueues.get(key) || Promise.resolve();
  const running = previous.catch(error => {
    console.error("DBU | Erro na fila anterior de defesa:", error);
  }).then(() => dbuGMUpdateDefenseCard(payload));
  dbuDefenseCardQueues.set(key, running);
  return running.finally(() => {
    if (dbuDefenseCardQueues.get(key) === running) dbuDefenseCardQueues.delete(key);
  });
}

// ============================================================
// GM — UNITED ATTACK / LOCK / ACTIVE DUEL
// ============================================================

function dbuRenderUnitedAttackIntoContent(
  message,
  attack,
  contributions,
  locked
) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = String(message.content || "");

  const baseWound = Number(
    attack.baseWoundTotal
    ?? (Number(attack.woundTotal || 0) - Number(attack.unitedAttackBonus || 0))
  );

  const totalBonus = contributions.reduce(
    (sum, entry) => sum + Number(entry.bonus || 0) + Number(entry.wager || 0),
    0
  );

  const finalWound = baseWound + totalBonus;
  const secretCombat = !!message.getFlag("world", "dbuCombatSecretMode");
  const combatRevealed = !!message.getFlag("world", "dbuCombatRevealed");
  const hideFinalWound = secretCombat && !combatRevealed;

  const wound = wrapper.querySelector("[data-dbu-wound-total]");
  if (wound) wound.textContent = hideFinalWound ? "?" : String(finalWound);

  const list = wrapper.querySelector("[data-dbu-ua-list]");
  if (list) {
    if (!contributions.length) {
      list.innerHTML = `
        <div class="dbu-duel-support-row">
          <span class="dbu-meta-chip">Nenhum aliado entrou ainda.</span>
        </div>
      `;
    } else {
      list.innerHTML = contributions.map(entry => `
        <div class="dbu-duel-support-row">
          <span class="dbu-duel-support-name">
            <i class="fas fa-hands-helping"></i>
            ${dbuEsc(entry.actorName)}
          </span>
          <span class="dbu-meta-chip">
            +${entry.bonus + entry.wager} Wound
            (½${dbuEsc(entry.attr)} ${entry.bonus}${entry.wager ? ` + wager ${entry.wager}` : ""})
          </span>
        </div>
      `).join("") + `
        <div class="dbu-duel-support-row">
          <span class="dbu-meta-chip dbu-chip-hot">
            ${hideFinalWound
              ? `United Attack total: <b>+${totalBonus}</b> · WOUND FINAL 🔒`
              : `WOUND: <b>${finalWound}</b> (${baseWound} + United ${totalBonus})`}
          </span>
        </div>
      `;
    }
  }

  const status = wrapper.querySelector("[data-dbu-ua-status]");
  if (status) {
    status.textContent = locked
      ? "United Attack encerrado — uma defesa já começou."
      : contributions.length
        ? `United Attack total: +${totalBonus} Wound. Outros aliados ainda podem entrar.`
        : "Antes da primeira defesa: +½ FO/MA + Ki Wager ao Wound.";
  }

  wrapper
    .querySelectorAll("[data-dbu-united-attack-v1]")
    .forEach(button => {
      button.disabled = !!locked;
      if (locked) {
        button.innerHTML = '<i class="fas fa-lock"></i> United Attack encerrado';
      }
    });

  return {
    content: wrapper.innerHTML,
    baseWound,
    totalBonus,
    finalWound
  };
}

async function dbuGMRefreshUnitedAttackCard({
  messageId,
  supporterId = null,
  userId = null
}) {
  if (!game.user.isGM) return;

  const message = game.messages.get(messageId);
  if (!message) return;

  const attack = foundry.utils.deepClone(
    message.getFlag("world", "dbuAttackData") || {}
  );

  if (!attack.attackerId) return;

  if (userId && supporterId) {
    const requester = game.users.get(userId);
    const supporter = game.actors.get(supporterId);

    const allowed = !!requester && !!supporter && (
      requester.isGM
      || supporter.testUserPermission(requester, "OWNER")
    );

    if (!allowed) {
      console.warn("DBU | United Attack socket recusado.", {
        messageId,
        supporterId,
        userId
      });
      return;
    }
  }

  const contributions = dbuGetUnitedAttackContributions(
    message,
    attack
  );

  const locked = !!message.getFlag(
    "world",
    "dbuUnitedAttackLocked"
  );

  const rendered = dbuRenderUnitedAttackIntoContent(
    message,
    attack,
    contributions,
    locked
  );

  attack.baseWoundTotal = rendered.baseWound;
  attack.woundTotal = rendered.finalWound;
  attack.unitedAttackBonus = rendered.totalBonus;
  attack.unitedAttackLocked = locked;
  attack.unitedAttackContributions = foundry.utils.deepClone(
    contributions
  );

  await message.update({
    content: rendered.content,
    "flags.world.dbuAttackData": attack,
    "flags.world.dbuUnitedAttackContributions": contributions
  });

  console.log(
    `DBU | United Attack atualizado: ${attack.attackName} +${rendered.totalBonus} Wound`
  );
}

async function dbuGMSetUnitedAttackLock({
  messageId,
  locked = true,
  defenderId = null,
  userId = null,
  safeUnlock = false
}) {
  if (!game.user.isGM) return;

  const message = game.messages.get(messageId);
  if (!message) return;

  if (userId && defenderId) {
    const requester = game.users.get(userId);
    const defender = resolveParticipant(defenderId, message?.getFlag("world", "dbuAttackData"));
    const allowed = !!requester && !!defender && (
      requester.isGM
      || defender.testUserPermission(requester, "OWNER")
    );
    if (!allowed) return;
  }

  const attack = foundry.utils.deepClone(
    message.getFlag("world", "dbuAttackData") || {}
  );

  if (safeUnlock && !locked) {
    const cardStates = message.getFlag("world", "dbuDefenseStates") || {};
    const hasOtherDefense = dbuCombatTargetIds(attack).some(key => {
      const actor = resolveParticipant(key, attack);
      const state = actor?.getFlag("world", "dbuDefenseStates")?.[messageId] || cardStates[key];
      return !!(state?.resolved || state?.pending);
    });

    if (hasOtherDefense) return;
  }

  attack.unitedAttackLocked = !!locked;

  const contributions = dbuGetUnitedAttackContributions(
    message,
    attack
  );

  const rendered = dbuRenderUnitedAttackIntoContent(
    message,
    attack,
    contributions,
    !!locked
  );

  attack.baseWoundTotal = rendered.baseWound;
  attack.woundTotal = rendered.finalWound;
  attack.unitedAttackBonus = rendered.totalBonus;
  attack.unitedAttackContributions = contributions;

  await message.update({
    content: rendered.content,
    "flags.world.dbuAttackData": attack,
    "flags.world.dbuUnitedAttackLocked": !!locked,
    "flags.world.dbuUnitedAttackContributions": contributions
  });
}

async function dbuRequestUnitedAttackLock(
  message,
  defender,
  locked = true,
  { safeUnlock = false } = {}
) {
  if (!message) return;

  const payload = {
    type: "dbuSetUnitedAttackLock",
    messageId: message.id,
    defenderId: participantKeyForAttack(defender, message.getFlag("world", "dbuAttackData")) || null,
    locked: !!locked,
    safeUnlock: !!safeUnlock,
    userId: game.user.id
  };

  if (game.user.isGM) {
    await dbuGMSetUnitedAttackLock(payload);
    return;
  }

  game.socket.emit(DBU_SOCKET, payload);

  if (locked) {
    for (let attempt = 0; attempt < 12; attempt++) {
      await dbuSleep(25);
      const current = game.messages.get(message.id);
      if (current?.getFlag("world", "dbuUnitedAttackLocked")) break;
    }
  }
}

async function dbuGMSetActiveDuelOnAttack({
  messageId,
  primaryDefenderId,
  duelId,
  sourceName = "Duel Clash",
  userId = null
}) {
  if (!game.user.isGM) return;

  const message = game.messages.get(messageId);
  const primary = resolveParticipant(primaryDefenderId, message?.getFlag("world", "dbuAttackData"));
  if (!message || !primary) return;

  if (userId) {
    const requester = game.users.get(userId);
    const allowed = !!requester && (
      requester.isGM
      || primary.testUserPermission(requester, "OWNER")
    );
    if (!allowed) return;
  }

  const attack = foundry.utils.deepClone(
    message.getFlag("world", "dbuAttackData") || {}
  );

  const activeDuel = {
    duelId,
    primaryDefenderId,
    primaryDefenderName: primary.name,
    sourceName,
    startedAt: Date.now()
  };

  attack.unitedAttackLocked = true;

  const contributions = dbuGetUnitedAttackContributions(
    message,
    attack
  );

  const rendered = dbuRenderUnitedAttackIntoContent(
    message,
    attack,
    contributions,
    true
  );

  const wrapper = document.createElement("div");
  wrapper.innerHTML = rendered.content;

  for (const row of wrapper.querySelectorAll(".dbu-area-target")) {
    const actions = row.querySelector(".dbu-attack-actions");
    if (!actions) continue;

    const anyDefense = actions.querySelector("[data-defender-id]");
    const defenderId = anyDefense?.dataset?.defenderId;
    if (!defenderId || defenderId === primaryDefenderId) continue;
    if (!dbuCombatTargetIds(attack).includes(defenderId)) continue;

    actions
      .querySelectorAll('[data-dbu-defense-v5="duelClash"]')
      .forEach(button => button.remove());

    if (!actions.querySelector("[data-dbu-united-duel-v1]")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dbu-pay-btn dbu-united-duel-btn";
      button.dataset.dbuUnitedDuelV1 = "1";
      button.dataset.defenderId = defenderId;
      button.dataset.duelId = duelId;
      button.dataset.primaryDefenderId = primaryDefenderId;
      button.innerHTML = '<i class="fas fa-hands-helping"></i> Join United Duel';
      actions.appendChild(button);
    }
  }

  attack.baseWoundTotal = rendered.baseWound;
  attack.woundTotal = rendered.finalWound;
  attack.unitedAttackBonus = rendered.totalBonus;
  attack.unitedAttackContributions = contributions;

  await message.update({
    content: wrapper.innerHTML,
    "flags.world.dbuAttackData": attack,
    "flags.world.dbuUnitedAttackLocked": true,
    "flags.world.dbuUnitedAttackContributions": contributions,
    "flags.world.dbuActiveDuel": activeDuel
  });
}

// ============================================================
// GM — DEVOLVER COUNTER ACTION APÓS DUEL ESCAPE
// ============================================================

async function dbuGMRefundDuelCounter({
  defenderId,
  duelId,
  userId = null
}) {
  if (!game.user.isGM) return;

  const defender = game.actors.get(defenderId);
  if (!defender) return;

  const context = dbuGetDuelContext(defender, duelId);
  if (!context) return;

  if (userId) {
    const requester = game.users.get(userId);
    const attacker = game.actors.get(context.attackerId);

    const allowed = !!requester && (
      requester.isGM
      || attacker?.testUserPermission(requester, "OWNER")
    );

    if (!allowed) {
      console.warn(
        "DBU | Socket recusado: refund de Duel sem permissão.",
        { defenderId, duelId, userId }
      );
      return;
    }
  }

  await dbuRefundDuelCounter(
    defender,
    context
  );
}

// ============================================================
// SOCKET
// ============================================================

const dbuSocketHandler = async data => {
  if (!data) return;
  if (!dbuIsPrimaryGM()) return;

  try {
    if (data.type === "dbuUpdateDefenseCard") {
      await dbuQueueDefenseCard(data);
      return;
    }

    if (data.type === "dbuRefundDuelCounter") {
      await dbuGMRefundDuelCounter(data);
      return;
    }

    if (data.type === "dbuRefreshUnitedAttack") {
      await dbuGMRefreshUnitedAttackCard(data);
      return;
    }

    if (data.type === "dbuSetUnitedAttackLock") {
      await dbuGMSetUnitedAttackLock(data);
      return;
    }

    if (data.type === "dbuSetActiveDuel") {
      await dbuGMSetActiveDuelOnAttack(data);
      return;
    }
  } catch (error) {
    console.error(
      "DBU | Socket:",
      error
    );
  }
};

game.socket.on(
  DBU_SOCKET,
  dbuSocketHandler
);

globalThis.DBU_BOOTSTRAP.socketHandler =
  dbuSocketHandler;

// ============================================================
// v6.7 — BLOQUEAR REVEAL NATIVO ATÉ TODAS AS DEFESAS
// ============================================================

function dbuSecretCombatFromNativeMessage(message) {
  const defenseMessageId = message?.getFlag("world", "dbuAutomationDefenseMessageId");
  if (!defenseMessageId) return null;

  const defenseMessage = game.messages.get(defenseMessageId);
  if (!defenseMessage) return null;

  const attack = defenseMessage.getFlag("world", "dbuAttackData") || {};
  const states = defenseMessage.getFlag("world", "dbuDefenseStates") || {};
  const progress = dbuCombatProgress(attack, states);

  return {
    defenseMessage,
    revealed: !!defenseMessage.getFlag("world", "dbuCombatRevealed"),
    progress
  };
}

const dbuSecretRevealHandler = event => {
  const button = event.target.closest?.("[data-dbu-reveal]");
  if (!button) return;

  const messageElement = button.closest?.("[data-message-id]");
  const messageId = messageElement?.dataset?.messageId;
  const message = messageId ? game.messages.get(messageId) : null;
  if (!message) return;

  const secret = dbuSecretCombatFromNativeMessage(message);
  if (!secret || secret.revealed || secret.progress.allSelected) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  ui.notifications.warn(
    `Ataque oculto: aguardando defesas (${secret.progress.selected}/${secret.progress.total}).`
  );
};

document.addEventListener("click", dbuSecretRevealHandler, true);
globalThis.DBU_BOOTSTRAP.secretRevealHandler = dbuSecretRevealHandler;

const secretRevealHookId = Hooks.on("renderChatMessage", (message, html) => {
  try {
    const secret = dbuSecretCombatFromNativeMessage(message);
    if (!secret || secret.revealed) return;

    const root = html instanceof HTMLElement ? html : (html?.[0] || html);
    const button = root?.querySelector?.("[data-dbu-reveal]");
    if (!button) return;

    if (!secret.progress.allSelected) {
      button.disabled = true;
      button.innerHTML = `<i class="fas fa-lock"></i> Aguardando defesas ${secret.progress.selected}/${secret.progress.total}`;
      button.title = "O resultado será revelado automaticamente quando todos os alvos registrarem suas defesas.";
    }
  } catch (error) {
    console.error("DBU | Secret Reveal render:", error);
  }
});

globalThis.DBU_BOOTSTRAP.secretRevealHookId = secretRevealHookId;

// ============================================================
// FINALIZAR DEFESA
// ============================================================

async function dbuUpdateTargetStatus(
  message,
  defender,
  status,
  text,
  details = null
) {
  const hiddenOutcome = details?.hiddenOutcome
    ? foundry.utils.deepClone(details.hiddenOutcome)
    : null;
  const defenseType = String(
    details?.selectedDefenseType
    || hiddenOutcome?.defenseType
    || ""
  );
  const defenseName = String(
    details?.selectedDefenseName
    || hiddenOutcome?.name
    || dbuDefenseChoiceLabel(defenseType)
  );

  const targetKey = details?.targetKey || participantKeyForAttack(defender, message.getFlag("world", "dbuAttackData"));
  if (!targetKey) throw new Error("DBU: token de defesa não corresponde aos alvos do ataque.");
  await dbuSetDefenseState(
    defender,
    message.id,
    {
      resolved: true,
      pending: false,
      status,
      text,
      defenseType,
      defenseName,
      hiddenOutcome,
      resolvedBy: game.user.id,
      resolvedAt: Date.now()
    }
  );

  const payload = {
    type: "dbuUpdateDefenseCard",
    messageId: message.id,
    defenderId: targetKey,
    status,
    text,
    defenseType,
    defenseName,
    hiddenOutcome,
    userId: game.user.id
  };

  if (game.user.isGM) {
    await dbuQueueDefenseCard(payload);
  } else {
    game.socket.emit(
      DBU_SOCKET,
      payload
    );
  }
}

// ============================================================
// v6.10 — FALLBACK DE SINCRONIZAÇÃO DA DEFESA VIA ACTOR
// ============================================================
//
// O player é dono do próprio Actor e consegue salvar dbuDefenseStates mesmo
// quando não tem permissão para editar a ChatMessage do atacante. O socket é
// a via principal; este hook no GM observa a flag do Actor e sincroniza a
// carta como fallback, evitando que o combate fique preso aguardando uma
// defesa que já foi escolhida.
// ============================================================

const defenseActorSyncHookId = Hooks.on(
  "updateActor",
  async (actor, changes) => {
    if (!dbuIsPrimaryGM()) return;

    const touched =
      foundry.utils.hasProperty(changes, "flags.world.dbuDefenseStates")
      || Object.keys(changes || {}).some(key =>
        String(key).startsWith("flags.world.dbuDefenseStates")
      );

    if (!touched) return;

    const actorStates = dbuGetDefenseStates(actor);

    for (const [messageId, state] of Object.entries(actorStates || {})) {
      if (!state?.resolved) continue;

      // Se foi o próprio GM que resolveu, a rota direta já atualiza a carta.
      if (state.resolvedBy === game.user.id) continue;

      const message = game.messages.get(messageId);
      if (!message) continue;

      const attack = message.getFlag("world", "dbuAttackData");
      const targetKey = attack ? participantKeyForAttack(actor, attack) : null;
      if (!targetKey) continue;

      const messageStates = message.getFlag("world", "dbuDefenseStates") || {};
      if (messageStates?.[targetKey]?.resolved) continue;

      try {
        await dbuQueueDefenseCard({
          messageId,
          defenderId: targetKey,
          status: state.status || "selected",
          text: state.text || `${state.defenseName || "Defesa"} selecionada`,
          defenseType: state.defenseType || "",
          defenseName: state.defenseName || "",
          hiddenOutcome: state.hiddenOutcome || null,
          userId: null
        });

        console.log(
          `DBU | Defesa sincronizada via Actor fallback: ${actor.name}`
        );
      } catch (error) {
        console.error(
          "DBU | Falha sincronizando defesa via Actor:",
          error
        );
      }
    }
  }
);

globalThis.DBU_BOOTSTRAP.defenseActorSyncHookId =
  defenseActorSyncHookId;

// ============================================================
// v7.0 — DEFESA PELO PAINEL (MESMO CORE DA CARTA)
// ============================================================

async function dbuDefendFromPanel(messageId, defenderId, defenseType) {
  const message = game.messages.get(String(messageId || ""));
  const defender = typeof defenderId === "object" ? defenderId : resolveParticipant(String(defenderId || ""), message?.getFlag("world", "dbuAttackData"));
  const type = String(defenseType || "");
  if (!message || !defender || !type) {
    return ui.notifications.error("DBU Painel: dados da defesa incompletos.");
  }
  if (!game.user.isGM && !defender.isOwner) {
    return ui.notifications.warn(`Você não controla ${defender.name}.`);
  }

  const attack = message.getFlag("world", "dbuAttackData");
  const targetKey = participantKeyForAttack(defender, attack);
  if (!attack || !targetKey || !dbuCombatTargetIds(attack).includes(targetKey)) {
    return ui.notifications.warn(`${defender.name} não é alvo deste ataque.`);
  }

  await dbuRequestUnitedAttackLock(message, defender, true);
  const lockKey = `${message.id}:${targetKey}`;
  if (globalThis.DBU_DEFENSE_LOCKS.has(lockKey)) {
    return ui.notifications.warn(`${defender.name} já está resolvendo esta defesa.`);
  }
  globalThis.DBU_DEFENSE_LOCKS.add(lockKey);

  if (message.getFlag("world", "dbuDefenseStates")?.[targetKey]?.resolved) {
    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);
    return ui.notifications.warn(`${defender.name} já resolveu esta defesa.`);
  }
  let currentState = dbuGetDefenseState(defender, message.id);
  if (currentState?.resolved) {
    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);
    return ui.notifications.warn(`${defender.name} já resolveu esta defesa.`);
  }
  if (currentState?.pending) {
    const age = Date.now() - Number(currentState.lockedAt || 0);
    if (age < DBU_PENDING_TIMEOUT) {
      globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);
      return ui.notifications.warn(`${defender.name} já está resolvendo esta defesa.`);
    }
    await dbuClearDefensePending(defender, message.id);
  }

  const lockToken = `${game.user.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await dbuSetDefenseState(defender, message.id, {
      resolved:false, pending:true, defenseType:type,
      lockedBy:game.user.id, lockToken, lockedAt:Date.now()
    });
    await dbuSleep(50);
    currentState = dbuGetDefenseState(defender, message.id);
    if (currentState?.lockToken !== lockToken) {
      globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);
      return ui.notifications.warn(`${defender.name} já está sendo defendido por outro usuário.`);
    }

    const result = await dbuResolveDefense(defender, attack, type, { message, deferReveal:true });
    if (result?.cancelled) {
      await dbuClearDefensePending(defender, message.id);
      await dbuRequestUnitedAttackLock(message, defender, false, {safeUnlock:true});
      globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);
      return null;
    }

    const selectedDefenseName = String(result?.hiddenOutcome?.name || dbuDefenseChoiceLabel(type));
    await dbuUpdateTargetStatus(message, defender, result.status, result.text, {
      ...result,
      selectedDefenseType:type,
      selectedDefenseName,
      targetKey
    });
    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);
    return result;
  } catch (error) {
    console.error("DBU | Defesa pelo painel:", error);
    try {
      await dbuClearDefensePending(defender, message.id);
      await dbuRequestUnitedAttackLock(message, defender, false, {safeUnlock:true});
    } catch {}
    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);
    ui.notifications.error(error?.message || "Erro resolvendo defesa pelo painel.");
    return null;
  }
}

  return {
    dbuIsPrimaryGM,
    dbuCombatProgress,
    dbuDefenseChoiceLabel,
    dbuWaitingTargetHTML,
    dbuGMRefreshUnitedAttackCard,
    dbuRequestUnitedAttackLock,
    dbuGMSetActiveDuelOnAttack,
    dbuGMRefundDuelCounter,
    dbuUpdateTargetStatus,
    dbuDefendFromPanel
  };
}
