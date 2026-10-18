// DBU Automation — United Attack / United Duel
import { resolveParticipant, attackTargetKeys, combatantForIdentity } from "../core/token-identity.js";

export function initializeUnitedAttackCore(deps = {}) {
  const {
    DBU_SYSTEM_ID, DBU_SOCKET,
    dbuEsc, dbuGetCapacity, dbuGetCurrentRound, dbuGetDefenseState,
    dbuGetDuelHelper, dbuSleep,
    dbuGMRefreshUnitedAttackCard, dbuGMSetActiveDuelOnAttack, dbuUpdateTargetStatus
  } = deps;

function dbuMessageIdFromElement(element) {
  return element?.closest?.("[data-message-id]")?.dataset?.messageId || null;
}

function dbuFindCustomAttackMessage(message) {
  if (!message) return null;

  if (message.getFlag("world", "dbuAttackData")) {
    return message;
  }

  return game.messages.contents
    .slice()
    .reverse()
    .find(entry => {
      const attack = entry.getFlag("world", "dbuAttackData");
      return attack?.originalAttackMessageId === message.id;
    }) || null;
}

function dbuUnitedAttackStorageId(message, attack) {
  return String(
    attack?.originalAttackMessageId
    || message?.id
    || ""
  );
}

function dbuGetUnitedAttackContributions(message, attack = null) {
  attack ||= message?.getFlag("world", "dbuAttackData") || null;
  if (!message || !attack) return [];

  const storageId = dbuUnitedAttackStorageId(message, attack);
  if (!storageId) return [];

  return game.actors
    .map(actor => ({
      actor,
      contribution: actor.getFlag(
        DBU_SYSTEM_ID,
        `unitedAttacks.${storageId}`
      )
    }))
    .filter(entry => !!entry.contribution)
    .map(entry => ({
      actorId: entry.actor.id,
      actorName: entry.actor.name,
      attr: String(entry.contribution.attr || ""),
      bonus: Math.max(0, Number(entry.contribution.bonus || 0)),
      wager: Math.max(0, Number(entry.contribution.wager || 0)),
      cost: Math.max(0, Number(entry.contribution.cost || 0)),
      spentAction: entry.contribution.spentAction !== false,
      joinedAt: Number(entry.contribution.joinedAt || 0)
    }));
}

function dbuActorInActiveCombat(actor, combat = game.combat) {
  if (!actor || !combat) return false;
  const started = combat.started === true || (combat.round != null && Number(combat.round) > 0);
  if (!started) return false;
  return !!combatantForIdentity(actor, null, combat);
}

function dbuUnitedAttackUsedThisRound(actor) {
  // v1.8.1: [1/Round] só bloqueia quem participa de um Encounter ativo.
  if (!dbuActorInActiveCombat(actor)) return false;
  const rounds = actor.system.combatTabState?.rounds || [];
  const round = rounds[rounds.length - 1];

  return !!(round?.actions || []).some(
    action => action?.dbuUnitedAttack === true && !action?.dbuOutsideCombat
  );
}

async function dbuCommitUnitedAttack(
  actor,
  message,
  attack,
  {
    attr,
    bonus,
    wager,
    cost,
    spentAction
  }
) {
  const total = Math.max(0, Number(cost || 0))
    + Math.max(0, Number(wager || 0));

  const currentKi = Number(actor.system.kiPool?.value || 0);
  const capacity = dbuGetCapacity(actor);

  if (currentKi < total) {
    return {
      ok: false,
      reason: "ki",
      text: `${actor.name}: Ki insuficiente. Necessário ${total} KP.`
    };
  }

  if (capacity.max > 0 && capacity.left < total) {
    return {
      ok: false,
      reason: "capacity",
      text: `${actor.name}: Capacity insuficiente. Restante ${capacity.left}, necessário ${total}.`
    };
  }

  const previousCTS = foundry.utils.deepClone(
    actor.system.combatTabState || {}
  );

  const cts = foundry.utils.deepClone(previousCTS);
  const round = dbuGetCurrentRound(actor, cts);

  round.actions.push({
    type: spentAction ? "standard" : "instant",
    source: "",
    kiCost: total,
    dkpCost: 0,
    kiWager: Math.max(0, Number(wager || 0)),
    description:
      `United Attack → ${attack.attackerName || "Ally"} — ${attack.attackName || "Attack"}`,
    dbuUnitedAttack: true,
    dbuOutsideCombat: !dbuActorInActiveCombat(actor) || undefined,
    dbuUnitedAttackMessageId: message.id,
    dbuUnitedAttackOriginalMessageId: attack.originalAttackMessageId || null,
    dbuUnitedAttackAttackerId: attack.attackerId,
    dbuUnitedAttackBonus: Math.max(0, Number(bonus || 0)),
    dbuUnitedAttackAttr: String(attr || ""),
    dbuUnitedAttackCost: Math.max(0, Number(cost || 0)),
    dbuUnitedAttackWager: Math.max(0, Number(wager || 0)),
    dbuUnitedAttackSpentAction: !!spentAction
  });

  try {
    await actor.update({
      "system.kiPool.value": currentKi - total,
      "system.status.capacitySpent": capacity.spent + total,
      "system.combatTabState": cts
    });

    const storageId = dbuUnitedAttackStorageId(message, attack);

    await actor.setFlag(
      DBU_SYSTEM_ID,
      `unitedAttacks.${storageId}`,
      {
        attr: String(attr || ""),
        bonus: Math.max(0, Number(bonus || 0)),
        wager: Math.max(0, Number(wager || 0)),
        cost: Math.max(0, Number(cost || 0)),
        spentAction: !!spentAction,
        customMessageId: message.id,
        originalMessageId: attack.originalAttackMessageId || null,
        attackerId: attack.attackerId,
        joinedAt: Date.now()
      }
    );

    const whisperIds = game.users
      .filter(user =>
        user.isGM
        || actor.testUserPermission(user, "OWNER")
      )
      .map(user => user.id);

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: whisperIds,
      content: `
        <div class="dbu-ki-deduct">
          <i class="fas fa-hands-helping"></i>
          <b>${dbuEsc(actor.name)}</b> — United Attack<br>
          Additional Power: <b>+${Math.max(0, Number(bonus || 0))}</b> (${dbuEsc(attr)})<br>
          Wager: <b>+${Math.max(0, Number(wager || 0))}</b><br>
          Cost + Wager: <b>-${total} KP / Capacity</b><br>
          Ki: <b>${currentKi} → ${currentKi - total}</b><br>
          Capacity Spent: <b>${capacity.spent} → ${capacity.spent + total}</b>
        </div>
      `
    });

    return { ok: true, total };
  } catch (error) {
    console.error("DBU | United Attack commit:", error);

    try {
      await actor.update({
        "system.kiPool.value": currentKi,
        "system.status.capacitySpent": capacity.spent,
        "system.combatTabState": previousCTS
      });
    } catch {}

    return {
      ok: false,
      reason: "error",
      text: error.message || "Erro registrando United Attack."
    };
  }
}

async function dbuRequestUnitedAttackRefresh(
  message,
  supporter = null
) {
  const payload = {
    type: "dbuRefreshUnitedAttack",
    messageId: message.id,
    supporterId: supporter?.id || null,
    userId: game.user.id
  };

  if (game.user.isGM) {
    await dbuGMRefreshUnitedAttackCard(payload);
    return;
  }

  game.socket.emit(DBU_SOCKET, payload);

  // Espera brevemente o GM atualizar a mensagem para que uma defesa clicada
  // logo em seguida já use o novo Wound.
  if (supporter) {
    for (let attempt = 0; attempt < 40; attempt++) {
      await dbuSleep(50);
      const current = game.messages.get(message.id);
      const contributions = current?.getFlag(
        "world",
        "dbuUnitedAttackContributions"
      ) || [];

      if (contributions.some(entry => entry.actorId === supporter.id)) {
        break;
      }
    }
  }
}

async function dbuRunUnitedAttackJoin(message) {
  const attack = message?.getFlag("world", "dbuAttackData");
  if (!attack) {
    return ui.notifications.error(
      "Dados do ataque não encontrados para United Attack."
    );
  }

  if (
    message.getFlag("world", "dbuUnitedAttackLocked")
    || attack.unitedAttackLocked
  ) {
    return ui.notifications.warn(
      "United Attack encerrado: uma defesa deste ataque já começou."
    );
  }

  const contributions = dbuGetUnitedAttackContributions(
    message,
    attack
  );

  const excluded = new Set([
    attack.attackerId,
    ...contributions.map(entry => entry.actorId)
  ]);

  const owned = game.actors.filter(actor =>
    actor.type === "character"
    && (game.user.isGM || actor.isOwner)
    && !excluded.has(actor.id)
  );

  if (!owned.length) {
    return ui.notifications.warn(
      "Você não possui nenhum personagem elegível para entrar no United Attack."
    );
  }

  let supporter = owned.length === 1 ? owned[0] : null;

  if (!supporter) {
    const choice = await Dialog.wait({
      title: "United Attack — escolha quem ajuda",
      content: `
        <div class="form-group">
          <label><b>Aliado</b></label>
          <select id="dbu-ua-actor" style="width:100%;">
            ${owned.map(actor =>
              `<option value="${actor.id}">${dbuEsc(actor.name)}</option>`
            ).join("")}
          </select>
        </div>
      `,
      buttons: {
        ok: {
          label: "Escolher",
          callback: html => html.find("#dbu-ua-actor").val()
        },
        cancel: {
          label: "Cancelar",
          callback: () => null
        }
      },
      default: "ok",
      close: () => null
    });

    if (!choice) return;
    supporter = game.actors.get(choice);
  }

  if (!supporter) return;

  if (dbuUnitedAttackUsedThisRound(supporter)) {
    return ui.notifications.warn(
      `${supporter.name} já usou United Attack neste Round.`
    );
  }

  const helper = await dbuGetDuelHelper();
  const power = helper.unitedAttackPowerBonus(
    supporter,
    attack.foundation || ""
  );

  const cap = helper.unitedAttackWagerCap(supporter);
  const hasTeamwork = (supporter.system.talents || []).includes("teamwork");
  const profileBaseCost = Number(
    CONFIG.DBU?.profileData?.[attack.profile]?.kpCost || 0
  );
  const profileCost = Math.max(
    0,
    profileBaseCost * Number(supporter.system.tier || 1)
  );

  const choice = await Dialog.wait({
    title: `United Attack — ${supporter.name}`,
    content: `
      <form class="dbu-united-attack-dialog">
        <p>
          Ajudando:
          <b>${dbuEsc(attack.attackerName || "Ally")} — ${dbuEsc(attack.attackName || "Attack")}</b>
        </p>

        <div class="dbu-attack-meta">
          <span class="dbu-meta-chip">
            Additional Power +${power.bonus} (½ ${dbuEsc(power.attr)} ${power.mod})
          </span>
          <span class="dbu-meta-chip">
            Wager máx. ${cap}${hasTeamwork ? " · Teamwork ×2" : ""}
          </span>
        </div>

        <div class="form-group">
          <label><b>Ki Wager</b></label>
          <input id="dbu-ua-wager" type="number" value="0" min="0" max="${cap}" step="1" style="width:100%;">
        </div>

        <div class="form-group">
          <label><b>KP Cost — mesmo Profile${attack.profile ? ` (${dbuEsc(attack.profile)})` : ""}</b></label>
          <input id="dbu-ua-cost" type="number" value="${profileCost}" min="0" step="1" style="width:100%;">
        </div>

        <label style="display:flex;gap:6px;align-items:center;margin-top:8px;">
          <input id="dbu-ua-free-action" type="checkbox">
          Efeito especial: não gasta 1 Action
        </label>

        <p class="notes">
          Regra normal: United Attack [1/Round], aliado adjacente, 1 Action.
          Cost + Wager gastam Ki e Capacity nesta automação.
          Signature Technique pode aplicar até 1(bT) ranks de Advantages manualmente.
        </p>
      </form>
    `,
    buttons: {
      join: {
        icon: '<i class="fas fa-hands-helping"></i>',
        label: "Entrar no United Attack",
        callback: html => ({
          wager: Math.max(
            0,
            Math.min(
              cap,
              Number(html.find("#dbu-ua-wager").val()) || 0
            )
          ),
          cost: Math.max(
            0,
            Number(html.find("#dbu-ua-cost").val()) || 0
          ),
          spentAction: !html.find("#dbu-ua-free-action").prop("checked")
        })
      },
      cancel: {
        label: "Cancelar",
        callback: () => null
      }
    },
    default: "join",
    close: () => null
  });

  if (!choice) return;

  const lockKey = `${message.id}:${supporter.id}`;
  if (globalThis.DBU_UNITED_ATTACK_LOCKS.has(lockKey)) {
    return ui.notifications.warn(
      `${supporter.name}: United Attack já está sendo processado.`
    );
  }

  globalThis.DBU_UNITED_ATTACK_LOCKS.add(lockKey);

  try {
    // Reconfere o lock depois do diálogo.
    const latest = game.messages.get(message.id);
    if (
      latest?.getFlag("world", "dbuUnitedAttackLocked")
      || latest?.getFlag("world", "dbuAttackData")?.unitedAttackLocked
    ) {
      return ui.notifications.warn(
        "United Attack encerrou enquanto o diálogo estava aberto."
      );
    }

    const commit = await dbuCommitUnitedAttack(
      supporter,
      message,
      attack,
      {
        attr: power.attr,
        bonus: power.bonus,
        wager: choice.wager,
        cost: choice.cost,
        spentAction: choice.spentAction
      }
    );

    if (!commit.ok) {
      return ui.notifications.warn(commit.text);
    }

    await dbuRequestUnitedAttackRefresh(
      message,
      supporter
    );

    ui.notifications.info(
      `${supporter.name} entrou no United Attack: +${power.bonus + choice.wager} Wound.`
    );
  } finally {
    globalThis.DBU_UNITED_ATTACK_LOCKS.delete(lockKey);
  }
}

// ============================================================
// UNITED ATTACK — HANDLER CUSTOM + CARTA NATIVA
// ============================================================

const dbuUnitedAttackClickHandler = async event => {
  const customButton = event.target.closest?.(
    "[data-dbu-united-attack-v1]"
  );

  const nativeButton = event.target.closest?.(
    ".dbu-united-attack-join"
  );

  if (!customButton && !nativeButton) return;

  const messageId = dbuMessageIdFromElement(
    customButton || nativeButton
  );

  const clickedMessage = messageId
    ? game.messages.get(messageId)
    : null;

  if (!clickedMessage) return;

  const customMessage = dbuFindCustomAttackMessage(
    clickedMessage
  );

  // Se for uma carta nativa sem correspondente do nosso Ataque v11.5,
  // deixa o comportamento original do DBU intacto.
  if (!customMessage) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  try {
    await dbuRunUnitedAttackJoin(customMessage);
  } catch (error) {
    console.error("DBU | United Attack:", error);
    ui.notifications.error(
      error.message || "Erro no United Attack."
    );
  }
};

document.addEventListener(
  "click",
  dbuUnitedAttackClickHandler,
  true
);

globalThis.DBU_BOOTSTRAP.unitedAttackHandler =
  dbuUnitedAttackClickHandler;

// ============================================================
// UNITED DUEL — CO-TARGET DE ATAQUE MULTI-TARGET
// ============================================================

async function dbuAnnounceDuelOnAttackCard(
  message,
  primaryDefender,
  duelId,
  sourceName
) {
  if (!message) return;

  const payload = {
    type: "dbuSetActiveDuel",
    messageId: message.id,
    primaryDefenderId: primaryDefender.id,
    duelId,
    sourceName: sourceName || "Duel Clash",
    userId: game.user.id
  };

  if (game.user.isGM) {
    await dbuGMSetActiveDuelOnAttack(payload);
  } else {
    game.socket.emit(DBU_SOCKET, payload);

    // Evita corrida entre a atualização "Duel ativo" e a atualização da
    // linha do defensor principal logo depois.
    for (let attempt = 0; attempt < 40; attempt++) {
      await dbuSleep(50);
      const current = game.messages.get(message.id);
      const active = current?.getFlag("world", "dbuActiveDuel");
      if (active?.duelId === duelId) break;
    }
  }
}

const dbuUnitedDuelClickHandler = async event => {
  const button = event.target.closest?.(
    "[data-dbu-united-duel-v1]"
  );

  if (!button) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const messageId = dbuMessageIdFromElement(button);
  const message = messageId ? game.messages.get(messageId) : null;
  const defenderId = button.dataset.defenderId;
  const duelId = button.dataset.duelId;
  const primaryDefenderId = button.dataset.primaryDefenderId;

  if (!message || !defenderId || !duelId) {
    return ui.notifications.error(
      "Dados do United Duel incompletos."
    );
  }

  const defender = resolveParticipant(defenderId, message?.getFlag("world", "dbuAttackData"));
  if (!defender) return;

  if (!game.user.isGM && !defender.isOwner) {
    return ui.notifications.warn(
      `Você não controla ${defender.name}.`
    );
  }

  const attack = message.getFlag("world", "dbuAttackData");
  if (!attackTargetKeys(attack).includes(defenderId)) {
    return ui.notifications.warn(
      `${defender.name} não é co-target deste ataque.`
    );
  }

  if (defenderId === primaryDefenderId) return;

  const defenseState = dbuGetDefenseState(
    defender,
    message.id
  );

  if (defenseState?.resolved || defenseState?.pending) {
    return ui.notifications.warn(
      `${defender.name} já escolheu uma defesa para este ataque.`
    );
  }

  if (defender.getFlag(DBU_SYSTEM_ID, `duels.${duelId}`)) {
    return ui.notifications.warn(
      `${defender.name} já participa deste Duel.`
    );
  }

  const helper = await dbuGetDuelHelper();
  const cap = helper.unitedWagerCap(defender);
  const teamwork = (defender.system.talents || []).includes("teamwork");
  const primary = resolveParticipant(primaryDefenderId, attack);

  const confirmed = await Dialog.wait({
    title: `${defender.name} — United Duel`,
    content: `
      <p>
        Entrar como co-target apoiando
        <b>${dbuEsc(primary?.name || "o defensor principal")}</b>?
      </p>
      <p>
        Você concede <b>+1(T)</b> aos Clashes do defensor principal e pode
        distribuir até <b>${cap} KP</b> de wager total no Duel${teamwork ? " (Teamwork ×2)" : ""}.
      </p>
      <p class="notes">
        Depois de entrar no United Duel, você não poderá escolher Dodge/Parry/Guard separadamente para este ataque.
      </p>
    `,
    buttons: {
      join: {
        icon: '<i class="fas fa-hands-helping"></i>',
        label: "Join United Duel",
        callback: () => true
      },
      cancel: {
        label: "Cancelar",
        callback: () => false
      }
    },
    default: "join",
    close: () => false
  });

  if (!confirmed) return;

  await defender.setFlag(
    DBU_SYSTEM_ID,
    `duels.${duelId}`,
    {
      role: "support",
      wagerCap: cap,
      wagers: [0, 0, 0],
      revealed: false,
      dbuUnitedDuelCoTarget: true,
      dbuOriginalAttackMessageId: message.id,
      primaryDefenderId
    }
  );

  await dbuUpdateTargetStatus(
    message,
    defender,
    "unitedDuel",
    `🤝 United Duel → ${primary?.name || "Primary"} · wager cap ${cap}`
  );

  ui.notifications.info(
    `${defender.name} entrou no United Duel.`
  );
};

document.addEventListener(
  "click",
  dbuUnitedDuelClickHandler,
  true
);

globalThis.DBU_BOOTSTRAP.unitedDuelHandler =
  dbuUnitedDuelClickHandler;

// ============================================================
// GM PRINCIPAL
// ============================================================


  return {
    dbuUnitedAttackStorageId,
    dbuGetUnitedAttackContributions,
    dbuRequestUnitedAttackRefresh,
    dbuRunUnitedAttackJoin,
    dbuAnnounceDuelOnAttackCard
  };
}
