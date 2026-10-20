// DBU Automation — bridge para controles nativos do DBU 0.9.2
import { resolveParticipant, attackTargetKeys, actorIdentity } from "../core/token-identity.js";
import { resolvePaymentActor } from "../core/payment-actor.js";

export function initializeNativeDBUBridge(deps = {}) {
  const {
    DBU_INIT_VERSION, DBU_DEFENSE_SELECTOR, DBU_PENDING_TIMEOUT, DBU_SYSTEM_ID,
    dbuCheckAffordability, dbuGetCapacity, dbuPayKiAndCapacity,
    dbuGetDefenseState, dbuSetDefenseState, dbuClearDefensePending,
    dbuRequestUnitedAttackLock, dbuCombatProgress, dbuDefenseChoiceLabel,
    dbuWaitingTargetHTML, dbuSleep, dbuEsc, dbuIsPrimaryGM,
    dbuUnitedAttackStorageId, dbuGMRefreshUnitedAttackCard
  } = deps;

function dbuAttachNativeAttackCapacityGuard(app, html) {
  const actor = app?.actor;
  if (!actor) return;

  const root = html instanceof HTMLElement
    ? html
    : html?.[0] || app?.element?.[0] || app?.element || null;

  if (!root?.addEventListener) return;
  if (root.dataset?.dbuAttackCapacityGuard === DBU_INIT_VERSION) return;

  try {
    if (root.dataset) {
      root.dataset.dbuAttackCapacityGuard = DBU_INIT_VERSION;
    }
  } catch {}

  root.addEventListener(
    "click",
    event => {
      const button = event.target.closest?.(
        "[data-action='roll-tracker-attack']"
      );

      if (!button || !root.contains(button)) return;

      const roundNumber = Number(button.dataset.round || 0);
      const actionIndex = Number(button.dataset.actionIndex);

      if (!Number.isInteger(actionIndex) || actionIndex < 0) return;

      const rounds = actor.system.combatTabState?.rounds || [];
      const round = rounds.find(entry =>
        Number(entry?.roundNumber || 0) === roundNumber
      ) || rounds[rounds.length - 1];

      const action = round?.actions?.[actionIndex];
      if (!action || action.type !== "attack") return;

      const kiCost = Math.max(0, Number(action.kiCost || 0));
      const wager = Math.max(0, Number(action.kiWager || 0));
      const total = kiCost + wager;

      const check = dbuCheckAffordability(
        actor,
        total,
        `${action.description || "Ataque"} (Cost + Wager)`,
        true
      );

      if (check.ok) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      console.warn(
        "DBU | Roll Attack nativo bloqueado por recursos insuficientes",
        {
          actor: actor.name,
          action,
          kiCost,
          wager,
          total,
          check
        }
      );
    },
    true
  );
}

const nativeAttackCapacityHookId = Hooks.on(
  "renderActorSheet",
  dbuAttachNativeAttackCapacityGuard
);

globalThis.DBU_BOOTSTRAP.nativeAttackCapacityHookId =
  nativeAttackCapacityHookId;

// ============================================================
// PAY ORIGINAL DO DBU — KI + CAPACITY
// ============================================================

const dbuNativePayHandler = async event => {
  const button = event.target.closest?.(
    "[data-dbu-pay]"
  );

  if (!button) return;

  const payType = button.dataset.dbuPay;

  if (
    payType !== "combined"
    && payType !== "defend"
    && payType !== "draining"
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  // The native DBU 0.9.2 new-round card offers manual Draining Pay.
  // During combat the automation charges the synthetic token on its own
  // turn instead. Do not allow a second payment through a stale chat card.
  if (payType === "draining" && game.combat?.started) {
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-clock"></i> Draining: escolha na mensagem privada do turno';
    return;
  }

  const messageElement = button.closest(
    "[data-message-id]"
  );

  const messageId =
    messageElement?.dataset?.messageId || null;

  const card = button.closest(
    "[data-actor-id]"
  );

  const actorId =
    button.dataset.actorId
    || card?.dataset.actorId;

  const paymentMessage = messageId ? game.messages.get(messageId) : null;
  const actor = resolvePaymentActor(paymentMessage, {
    actorId,
    payType,
    tokenId: button.dataset.tokenId || card?.dataset.tokenId || null,
    sceneId: button.dataset.sceneId || card?.dataset.sceneId || null
  });

  if (!actor) {
    return ui.notifications.error(
      "DBU: não foi possível identificar o token exato deste pagamento. Não descontei Ki da ficha-base."
    );
  }

  if (
    !game.user.isGM
    && !actor.isOwner
  ) {
    return ui.notifications.warn(
      "Você não controla esse personagem."
    );
  }

  const payLockKey =
    `${messageId || "no-message"}:${actorIdentity(actor)}:${payType}`;

  if (
    globalThis.DBU_PAY_LOCKS.has(payLockKey)
  ) {
    return ui.notifications.warn(
      `${actor.name}: este pagamento já está sendo processado.`
    );
  }

  globalThis.DBU_PAY_LOCKS.add(payLockKey);

  if (button.disabled) {
    globalThis.DBU_PAY_LOCKS.delete(payLockKey);
    return;
  }

  button.disabled = true;
  button.classList.add("dbu-pay-pending");

  let amount = Number(
    button.dataset.amount
  );

  if (
    !Number.isFinite(amount)
    || amount <= 0
  ) {
    amount =
      Number(button.dataset.kiCost || 0)
      + Number(
        button.dataset.kiWager
        || button.dataset.wager
        || 0
      );
  }

  amount = Math.max(
    0,
    Number(amount) || 0
  );

  const label = payType === "combined"
    ? "Ataque"
    : payType === "draining"
      ? "Draining"
      : "Defend";

  if (amount <= 0) {
    button.classList.remove("dbu-pay-pending");
    button.classList.add("dbu-pay-paid");
    button.innerHTML = `
      <i class="fas fa-check"></i>
      Paid 0 KP
    `;
    return;
  }

  const beforeKi = Number(
    actor.system.kiPool?.value || 0
  );

  const beforeCapacity = dbuGetCapacity(actor);

  try {
    // Draining is a loss of Ki Points, not a Ki Point Cost for a Maneuver.
    // Never debit Capacity for this native maintenance card.
    const payment = payType === "draining"
      ? await (async () => {
          const from = Math.max(0, Number(actor.system.kiPool?.value) || 0);
          const to = Math.max(0, from - amount);
          await actor.update({"system.kiPool.value":to});
          return {ok:true};
        })()
      : await dbuPayKiAndCapacity(actor, amount, label);

    if (!payment.ok) {
      button.disabled = false;
      button.classList.remove("dbu-pay-pending");
      globalThis.DBU_PAY_LOCKS.delete(payLockKey);
      return;
    }

    button.classList.remove("dbu-pay-pending");
    button.classList.add("dbu-pay-paid");

    button.innerHTML = `
      <i class="fas fa-check"></i>
      Paid ${amount} KP
    `;

    const afterKi = Number(
      actor.system.kiPool?.value || 0
    );

    const afterCapacity = dbuGetCapacity(actor);

    console.log(
      "DBU | PAY depois:",
      {
        actor: actor.name,
        label,
        amount,
        kiBefore: beforeKi,
        kiAfter: afterKi,
        capacityBefore: beforeCapacity.spent,
        capacityAfter: afterCapacity.spent,
        capacityLeft: afterCapacity.left
      }
    );

    const whisperIds = game.users
      .filter(
        user =>
          user.isGM
          || actor.testUserPermission(
            user,
            "OWNER"
          )
      )
      .map(user => user.id);

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({
        actor
      }),

      whisper: whisperIds,

      content: `
        <div class="dbu-ki-deduct">
          <b>${dbuEsc(actor.name)}</b>
          <br>
          ${dbuEsc(label)}: <b>-${amount} KP</b>
          <br>
          Ki: <b>${beforeKi} → ${afterKi}</b>
          <br>
          Capacity Spent:
          <b>${beforeCapacity.spent} → ${afterCapacity.spent}</b>
          <br>
          Capacity restante:
          <b>${afterCapacity.left} / ${afterCapacity.max}</b>
        </div>
      `
    });
  } catch (error) {
    console.error(
      "DBU | Erro no pagamento:",
      error
    );

    button.disabled = false;
    button.classList.remove("dbu-pay-pending");
    globalThis.DBU_PAY_LOCKS.delete(payLockKey);

    ui.notifications.error(
      error.message || "Erro pagando ação."
    );
  }
};

document.addEventListener(
  "click",
  dbuNativePayHandler,
  true
);

// Native Draining buttons are legacy manual prompts. While an Encounter is
// active show the new automatic behavior, so players won't double-pay.
const drainingChatHookId = Hooks.on("renderChatMessage", (_message, html) => {
  if (!game.combat?.started) return;
  const root = html instanceof HTMLElement ? html : html?.[0] || null;
  root?.querySelectorAll?.('[data-dbu-pay="draining"]').forEach(button => {
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-clock"></i> Draining: escolha na mensagem privada do turno';
  });
});
globalThis.DBU_BOOTSTRAP.drainingChatHookId = drainingChatHookId;

globalThis.DBU_BOOTSTRAP.nativePayHandler =
  dbuNativePayHandler;

// ============================================================
// LISTENER DA DEFESA
// ============================================================

const dbuDefenseClickHandler = async event => {
  const button = event.target.closest?.(
    DBU_DEFENSE_SELECTOR
  );

  if (!button) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const defenderId = button.dataset.defenderId;
  const defenseType = button.dataset.dbuDefenseV5;

  if (!defenderId || !defenseType) {
    return ui.notifications.error(
      "Dados do botão de defesa inválidos."
    );
  }

  const defenseMessageId = button.closest("[data-message-id]")?.dataset?.messageId;
  const defenseMessage = defenseMessageId ? game.messages.get(defenseMessageId) : null;
  const defender = resolveParticipant(defenderId, defenseMessage?.getFlag("world", "dbuAttackData"));

  if (!defender) {
    return ui.notifications.error(
      "Defensor não encontrado."
    );
  }

  if (
    !game.user.isGM
    && !defender.isOwner
  ) {
    return ui.notifications.warn(
      `Você não controla ${defender.name}.`
    );
  }

  const messageElement = button.closest(
    "[data-message-id]"
  );

  const messageId =
    messageElement?.dataset?.messageId;

  if (!messageId) {
    return ui.notifications.error(
      "Mensagem do ataque não encontrada."
    );
  }

  const message = game.messages.get(messageId);

  if (!message) {
    return ui.notifications.error(
      "ChatMessage não encontrada."
    );
  }

  const targetKeys = attackTargetKeys(message.getFlag("world", "dbuAttackData"));
  if (!targetKeys.includes(defenderId)) return ui.notifications.warn("Este token não é alvo deste ataque.");
  if (message.getFlag("world", "dbuDefenseStates")?.[defenderId]?.resolved) {
    return ui.notifications.warn(`${defender.name} já resolveu esta defesa.`);
  }

  // v6.6 — United Attack só pode entrar antes da primeira defesa começar.
  await dbuRequestUnitedAttackLock(
    message,
    defender,
    true
  );

  const lockKey =
    `${messageId}:${defenderId}`;

  if (
    globalThis.DBU_DEFENSE_LOCKS.has(lockKey)
  ) {
    return ui.notifications.warn(
      `${defender.name} já está resolvendo esta defesa.`
    );
  }

  globalThis.DBU_DEFENSE_LOCKS.add(lockKey);

  let currentState = dbuGetDefenseState(
    defender,
    messageId
  );

  if (currentState?.resolved) {
    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);

    return ui.notifications.warn(
      `${defender.name} já resolveu esta defesa.`
    );
  }

  if (currentState?.pending) {
    const age =
      Date.now()
      - Number(currentState.lockedAt || 0);

    if (age < DBU_PENDING_TIMEOUT) {
      globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);

      return ui.notifications.warn(
        `${defender.name} já está resolvendo esta defesa.`
      );
    }

    await dbuClearDefensePending(
      defender,
      messageId
    );
  }

  const lockToken =
    `${game.user.id}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

  try {
    await dbuSetDefenseState(
      defender,
      messageId,
      {
        resolved: false,
        pending: true,
        defenseType,
        lockedBy: game.user.id,
        lockToken,
        lockedAt: Date.now()
      }
    );
  } catch (error) {
    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);

    console.error(
      "DBU | Lock:",
      error
    );

    return ui.notifications.error(
      "Não consegui bloquear a defesa."
    );
  }

  await dbuSleep(50);

  currentState = dbuGetDefenseState(
    defender,
    messageId
  );

  if (
    currentState?.lockToken !== lockToken
  ) {
    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);

    return ui.notifications.warn(
      `${defender.name} já está sendo defendido por outro usuário.`
    );
  }

  const attack = message.getFlag(
    "world",
    "dbuAttackData"
  );

  if (!attack) {
    await dbuClearDefensePending(
      defender,
      messageId
    );

    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);

    return ui.notifications.error(
      "Dados do ataque não encontrados."
    );
  }

  const row = button.closest(
    "[data-target-row]"
  );

  const buttons = row?.querySelectorAll(
    DBU_DEFENSE_SELECTOR
  ) || [];

  buttons.forEach(
    b => b.disabled = true
  );

  try {
    const result = await globalThis.DBU
      .resolveDefense(
        defender,
        attack,
        defenseType,
        { message, deferReveal: true }
      );

    if (result?.cancelled) {
      await dbuClearDefensePending(
        defender,
        messageId
      );

      await dbuRequestUnitedAttackLock(
        message,
        defender,
        false,
        { safeUnlock: true }
      );

      globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);

      buttons.forEach(
        b => b.disabled = false
      );

      return;
    }

    // Feedback visual imediato no cliente que escolheu a defesa.
    // O resultado numérico continua oculto até todos os alvos escolherem.
    const selectedDefenseName = String(
      result?.hiddenOutcome?.name
      || dbuDefenseChoiceLabel(defenseType)
    );

    try {
      const localStates = foundry.utils.deepClone(
        message.getFlag("world", "dbuDefenseStates") || {}
      );
      localStates[defenderId] = {
        ...(localStates[defenderId] || {}),
        resolved: true,
        pending: false
      };
      const localProgress = dbuCombatProgress(attack, localStates);
      if (row?.isConnected) {
        row.outerHTML = dbuWaitingTargetHTML(
          defender,
          localProgress,
          selectedDefenseName,
          defenderId
        );
      }
    } catch (error) {
      console.warn("DBU | Feedback local da defesa:", error);
    }

    await globalThis.DBU
      .updateTargetStatus(
        message,
        defender,
        result.status,
        result.text,
        {
          ...result,
          selectedDefenseType: defenseType,
          selectedDefenseName,
          targetKey: defenderId
        }
      );

    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);

    console.log(
      `DBU | Defesa concluída: ${defender.name}`
    );
  } catch (error) {
    console.error(
      "DBU | Defesa:",
      error
    );

    try {
      await dbuClearDefensePending(
        defender,
        messageId
      );

      await dbuRequestUnitedAttackLock(
        message,
        defender,
        false,
        { safeUnlock: true }
      );
    } catch {}

    globalThis.DBU_DEFENSE_LOCKS.delete(lockKey);

    buttons.forEach(
      b => b.disabled = false
    );

    ui.notifications.error(
      error.message || "Erro resolvendo defesa."
    );
  }
};

document.addEventListener(
  "click",
  dbuDefenseClickHandler,
  true
);

globalThis.DBU_BOOTSTRAP.defenseClickHandler =
  dbuDefenseClickHandler;

// ============================================================
// SINCRONIZAR UNITED ATTACK QUANDO FLAGS NATIVAS MUDAREM
// ============================================================

const unitedAttackActorHookId = Hooks.on(
  "updateActor",
  async (actor, changes) => {
    if (!dbuIsPrimaryGM()) return;

    const united = foundry.utils.getProperty(
      changes,
      `flags.${DBU_SYSTEM_ID}.unitedAttacks`
    );

    if (!united) return;

    try {
      for (const rawKey of Object.keys(united)) {
        const storageId = String(rawKey).replace(/^-=/, "");

        const custom = game.messages.contents
          .slice()
          .reverse()
          .find(message => {
            const attack = message.getFlag("world", "dbuAttackData");
            if (!attack) return false;
            return dbuUnitedAttackStorageId(message, attack) === storageId;
          });

        if (custom) {
          await dbuGMRefreshUnitedAttackCard({
            messageId: custom.id
          });
        }
      }
    } catch (error) {
      console.error("DBU | Sync United Attack actor hook:", error);
    }
  }
);

globalThis.DBU_BOOTSTRAP.unitedAttackActorHookId =
  unitedAttackActorHookId;


  return {
    nativeAttackCapacityHookId,
    unitedAttackActorHookId
  };
}
