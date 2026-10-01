// DBU Automation — Duel Clash core

export function initializeDuelCore(deps = {}) {
  const {
    DBU_SYSTEM_ID, DBU_SOCKET, DBU_INIT_VERSION,
    dbuEsc, dbuPrepareSheet, dbuRunCombatReactionVisual, dbuSleep,
    dbuGetCapacity, dbuGetCurrentRound, dbuPayKiAndCapacity,
    dbuAnnounceDuelOnAttackCard, dbuGMRefundDuelCounter
  } = deps;

  let DBU_DUEL_HELPER_CACHE = null;

  function dbuWaitForNativeDuelMessage(defenderId, knownMessageIds = new Set(), timeoutMs = 1500) {
    const findExisting = () => game.messages?.contents?.slice?.().reverse?.().find(entry => {
      if (knownMessageIds.has(entry.id)) return false;
      const meta = entry.getFlag?.(DBU_SYSTEM_ID, "duel");
      return meta?.defenderId === defenderId;
    }) || null;

    const existing = findExisting();
    if (existing) return { promise: Promise.resolve(existing), cancel: () => {} };

    let hookId = null;
    let timer = null;
    let settled = false;
    let resolvePromise;

    const cleanup = () => {
      if (hookId !== null) {
        try { Hooks.off("createChatMessage", hookId); } catch {}
        hookId = null;
      }
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const finish = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };

    const promise = new Promise(resolve => {
      resolvePromise = resolve;
      hookId = Hooks.on("createChatMessage", message => {
        if (knownMessageIds.has(message.id)) return;
        const meta = message.getFlag?.(DBU_SYSTEM_ID, "duel");
        if (meta?.defenderId === defenderId) finish(message);
      });
      timer = setTimeout(() => finish(findExisting()), timeoutMs);
    });

    return { promise, cancel: () => finish(null) };
  }

  function dbuWaitForDuelReveal(actor, duelId, timeoutMs = 2000) {
    const isRevealed = () => !!actor?.getFlag?.(DBU_SYSTEM_ID, `duels.${duelId}`)?.revealed;
    if (isRevealed()) return Promise.resolve(true);

    return new Promise(resolve => {
      let hookId = null;
      let timer = null;
      let settled = false;

      const cleanup = () => {
        if (hookId !== null) {
          try { Hooks.off("updateActor", hookId); } catch {}
          hookId = null;
        }
        if (timer) clearTimeout(timer);
        timer = null;
      };

      const finish = value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      hookId = Hooks.on("updateActor", updated => {
        if (updated?.id !== actor.id) return;
        if (isRevealed()) finish(true);
      });

      timer = setTimeout(() => finish(isRevealed()), timeoutMs);
    });
  }

const DBU_DUEL_VISUAL_RESOLVE_LOCKS = globalThis.DBU_DUEL_VISUAL_RESOLVE_LOCKS || new Set();
globalThis.DBU_DUEL_VISUAL_RESOLVE_LOCKS = DBU_DUEL_VISUAL_RESOLVE_LOCKS;

function dbuDuelParticipants(duelId) {
  const message = game.messages?.contents?.find(entry =>
    entry.getFlag?.(DBU_SYSTEM_ID, "duel")?.duelId === duelId
  ) || null;
  const meta = message?.getFlag?.(DBU_SYSTEM_ID, "duel") || null;
  const defender = meta?.defenderId ? game.actors.get(meta.defenderId) : null;
  const participants = game.actors.filter(actor => !!actor.getFlag?.(DBU_SYSTEM_ID, `duels.${duelId}`));
  const attacker = participants.find(actor => actor.id !== defender?.id && actor.getFlag(DBU_SYSTEM_ID, `duels.${duelId}`)?.role === "attacker") || null;
  const supporters = participants.filter(actor => actor.id !== defender?.id && actor.id !== attacker?.id && actor.getFlag(DBU_SYSTEM_ID, `duels.${duelId}`)?.role === "support");
  return { message, meta, defender, attacker, supporters };
}

function dbuCalculateDuelVisualOutcome(duelId) {
  const { message, defender, attacker, supporters } = dbuDuelParticipants(duelId);
  if (!message || !defender || !attacker) return null;
  const defSt = defender.getFlag(DBU_SYSTEM_ID, `duels.${duelId}`);
  const attSt = attacker.getFlag(DBU_SYSTEM_ID, `duels.${duelId}`);
  const supportRows = supporters.map(actor => ({ actor, st: actor.getFlag(DBU_SYSTEM_ID, `duels.${duelId}`) })).filter(x => x.st);
  if (!defSt?.revealed || !attSt?.revealed || !supportRows.every(x => x.st.revealed)) return null;
  if (attSt?.escaped === "success") return { escaped:true, message, defender, attacker, supporters:supportRows, defSt, attSt };

  const udSupport = supportRows.filter(x => !x.st.uaMode);
  const uaDef = supportRows.filter(x => x.st.uaMode && x.st.side !== "attacker");
  const uaAtt = supportRows.filter(x => x.st.uaMode && x.st.side === "attacker");
  const tier = Number(defender.system.tier || 1);
  const unitedFlat = udSupport.length * tier;
  const sumClash = (rows, i) => rows.reduce((acc, x) => acc + Number(x.st.wagers?.[i] || 0), 0);
  let defWins = 0, attWins = 0;
  const clashes = [];
  for (let i = 0; i < 3; i++) {
    const d = defSt.rolls?.[i], a = attSt.rolls?.[i];
    if (!d || !a) continue;
    const defBoost = unitedFlat + sumClash(udSupport, i) + sumClash(uaDef, i);
    const attBoost = sumClash(uaAtt, i);
    const defTotal = Number(d.total || 0) + defBoost;
    const attTotal = Number(a.total || 0) + attBoost;
    let winner = "tie";
    if (defTotal > attTotal) { winner = "defender"; defWins++; }
    else if (attTotal > defTotal) { winner = "attacker"; attWins++; }
    clashes.push({ index:i + 1, defenderTotal:defTotal, attackerTotal:attTotal, winner, defenderRoll:d, attackerRoll:a, defenderBoost:defBoost, attackerBoost:attBoost });
  }
  let winner = null, loser = null, result = "tie";
  if (defWins >= 2) { winner = defender; loser = attacker; result = "defender"; }
  else if (attWins >= 2) { winner = attacker; loser = defender; result = "attacker"; }
  return { message, defender, attacker, supporters:supportRows, defSt, attSt, clashes, defWins, attWins, winner, loser, result, duelId };
}

async function dbuMaybeRunDuelResolutionVisual(duelId) {
  if (!duelId || DBU_DUEL_VISUAL_RESOLVE_LOCKS.has(duelId)) return false;
  const outcome = dbuCalculateDuelVisualOutcome(duelId);
  if (!outcome || outcome.escaped) return false;
  DBU_DUEL_VISUAL_RESOLVE_LOCKS.add(duelId);
  const payload = { duelId, duelOutcome:outcome, clashes:outcome.clashes, winner:outcome.winner, loser:outcome.loser, defWins:outcome.defWins, attWins:outcome.attWins, result:outcome.result };
  await dbuRunCombatReactionVisual(outcome.defender, "duelClash", "resolve", payload);
  await dbuRunCombatReactionVisual(outcome.attacker, "duelClash", "resolve", payload);
  if (outcome.result === "tie") {
    await dbuRunCombatReactionVisual(outcome.defender, "duelClash", "tie", payload);
    await dbuRunCombatReactionVisual(outcome.attacker, "duelClash", "tie", payload);
  } else {
    await dbuRunCombatReactionVisual(outcome.winner, "duelClash", "win", payload);
    await dbuRunCombatReactionVisual(outcome.loser, "duelClash", "lose", payload);
  }
  return true;
}

async function dbuGetDuelHelper() {
  if (DBU_DUEL_HELPER_CACHE) return DBU_DUEL_HELPER_CACHE;

  const systemId = game.system?.id || DBU_SYSTEM_ID;

  try {
    DBU_DUEL_HELPER_CACHE = await import(
      `/systems/${systemId}/module/helpers/duel.mjs`
    );
  } catch (error) {
    console.error("DBU | Não foi possível importar duel.mjs:", error);
    throw new Error(
      `Não consegui carregar o Duel nativo do sistema ${systemId}.`
    );
  }

  return DBU_DUEL_HELPER_CACHE;
}

async function dbuGetPreparedAttackSource(actor, sourceKey) {
  const sheet = await dbuPrepareSheet(actor);

  for (const group of (sheet._trackerSourceGroups || [])) {
    if (
      group.label !== "Attack Refs"
      && group.label !== "Sig. Techniques"
    ) {
      continue;
    }

    const source = (group.sources || []).find(
      entry => String(entry.key) === String(sourceKey)
    );

    if (source) {
      return {
        sheet,
        group: group.label,
        source
      };
    }
  }

  return null;
}

function dbuGetDuelContexts(defender) {
  return defender.getFlag("world", "dbuDuelContexts") || {};
}

function dbuGetDuelContext(defender, duelId) {
  return dbuGetDuelContexts(defender)[duelId] || null;
}

async function dbuSetDuelContext(defender, duelId, context) {
  const contexts = foundry.utils.deepClone(
    dbuGetDuelContexts(defender)
  );

  contexts[duelId] = context;

  await defender.setFlag(
    "world",
    "dbuDuelContexts",
    contexts
  );
}

function dbuGetRawTechnique(actor, sourceKey) {
  const key = String(sourceKey || "");
  if (!key.startsWith("tech_")) return null;

  const id = key.slice(5);

  return (actor.system.signatureTechniques || []).find(
    entry => String(entry.id ?? entry._id ?? "") === id
  ) || null;
}

/**
 * Se o ataque original foi liberado por DBU Energy Charge, o source da ficha
 * pode já ter voltado ao número normal de EC. O attackData, porém, preserva
 * o total usado. Acrescentamos apenas a diferença à fórmula do Wound usada
 * pelo Duel nativo.
 */
function dbuIncomingWoundFormula(actor, attack, preparedInfo) {
  const source = preparedInfo?.source;
  const group = preparedInfo?.group || attack.sourceGroup || "";

  let formula = String(
    source?.woundFormula
    || attack.woundFormula
    || "1d10"
  );

  const tier = Number(actor.system.tier || 1);
  const attackEC = Math.max(0, Number(attack.energyCharges || 0));
  const sourceEC = Math.max(0, Number(source?.energyCharges || 0));
  const missingEC = Math.max(0, attackEC - sourceEC);

  if (missingEC > 0) {
    if (group === "Sig. Techniques" || String(attack.sourceKey || "").startsWith("tech_")) {
      const tech = dbuGetRawTechnique(actor, attack.sourceKey);
      const hasMaximumCharge = (tech?.advantages || []).some(
        advantage => String(advantage.name || "").toLowerCase() === "maximum charge"
      );

      const chain = ["d4", "d6", "d8", "d10", "d12"];
      let index = 2;
      if (hasMaximumCharge) index += 1;
      index += Number(actor.system.aptitudes?.energyChargeDiceCategory || 0);
      index += Number(actor.system.aptitudes?.signatureEnergyChargeDiceCategory || 0);
      index = Math.max(0, Math.min(chain.length - 1, index));

      formula = `(${formula})+${missingEC * tier}${chain[index]}`;

      if (String(source?.profile || attack.profile || "").toLowerCase() === "mega flare") {
        formula = `(${formula})+${missingEC * tier}`;
      }
    } else {
      formula = `(${formula})+${missingEC * tier}d6`;
    }
  }

  // Bônus situacional digitado no Ataque v11.2+ também participa da nova
  // rolagem de Wound caso este lado vença o Duel.
  const manual = String(attack.manualWoundTranslated || "").trim();
  if (manual) {
    formula = `(${formula})+(${manual})`;
  }

  // v6.6 — se o ataque normal recebeu United Attack antes do Duel Clash,
  // o Additional Power + Wager desses aliados também acompanha o Wound
  // caso o lado atacante vença o Duel.
  const unitedBonus = Math.max(0, Number(attack.unitedAttackBonus || 0));
  if (unitedBonus > 0) {
    formula = `(${formula})+${unitedBonus}`;
  }

  return formula;
}

async function dbuRecordDuelCounter(defender, source, incomingAttack) {
  const previousCTS = foundry.utils.deepClone(
    defender.system.combatTabState || {}
  );

  const cts = foundry.utils.deepClone(previousCTS);
  const round = dbuGetCurrentRound(defender, cts);

  cts.roundCounterCount =
    (Number(cts.roundCounterCount) || 0) + 1;

  const actionIndex = round.actions.length;

  round.actions.push({
    type: "duel",
    source: "",
    kiCost: Number(source.kiCost || 0),
    dkpCost: 0,
    kiWager: 0,
    description: `Duel: Duel Clash — ${source.name}`,
    duelMode: "clash",
    duelSource: source.key,
    dbuDefenseDuel: true,
    dbuIncomingAttack: incomingAttack?.attackName || ""
  });

  await defender.update({
    "system.combatTabState": cts
  });

  return {
    previousCTS,
    roundNumber: round.roundNumber,
    actionIndex,
    counterNum: cts.roundCounterCount
  };
}

async function dbuBindDuelTrackerAction(defender, tracker, duelId) {
  const cts = foundry.utils.deepClone(
    defender.system.combatTabState || {}
  );

  const round = (cts.rounds || []).find(
    entry => Number(entry.roundNumber) === Number(tracker.roundNumber)
  );

  const action = round?.actions?.[tracker.actionIndex];
  if (!action?.dbuDefenseDuel) return;

  action.dbuDuelId = duelId;

  await defender.update({
    "system.combatTabState": cts
  });
}

async function dbuRefundDuelCounter(defender, context) {
  if (!defender || !context) return;

  const cts = foundry.utils.deepClone(
    defender.system.combatTabState || {}
  );

  const round = (cts.rounds || []).find(
    entry => Number(entry.roundNumber) === Number(context.counterRound)
  );

  const preferredIndex = Number(context.counterActionIndex);
  let index = (round?.actions || []).findIndex(action =>
    action?.dbuDefenseDuel
    && String(action?.dbuDuelId || "") === String(context.duelId || "")
  );

  if (index < 0) {
    const fallback = round?.actions?.[preferredIndex];
    if (fallback?.dbuDefenseDuel) index = preferredIndex;
  }

  let refunded = false;

  if (index >= 0 && round?.actions?.[index]) {
    round.actions.splice(index, 1);
    refunded = true;
  }

  if (refunded) {
    cts.roundCounterCount = Math.max(
      0,
      (Number(cts.roundCounterCount) || 0) - 1
    );
  }

  await defender.update({
    "system.combatTabState": cts
  });

  console.log(
    `DBU | Counter Action devolvida após Duel Escape: ${defender.name}`
  );
}

async function dbuChooseDuelInitiatingAttack(defender, attack) {
  const sheet = await dbuPrepareSheet(defender);
  const list = [];
  let options = "";

  for (const group of (sheet._trackerSourceGroups || [])) {
    if (
      group.label !== "Attack Refs"
      && group.label !== "Sig. Techniques"
    ) {
      continue;
    }

    if (!(group.sources || []).length) continue;

    options += `<optgroup label="${dbuEsc(group.label)}">`;

    for (const source of group.sources) {
      const index = list.length;
      list.push({ group: group.label, source });

      const chips = [
        source.foundation || "",
        source.energyCharges ? `EC ${source.energyCharges}` : "",
        source.powerShot ? `PS ${source.powerShot}` : "",
        source.kiCost ? `${source.kiCost} KP` : "0 KP"
      ].filter(Boolean).join(" · ");

      options += `
        <option value="${index}">
          ${dbuEsc(source.name)}${chips ? ` — ${dbuEsc(chips)}` : ""}
        </option>
      `;
    }

    options += "</optgroup>";
  }

  if (!list.length) {
    ui.notifications.warn(
      `${defender.name}: nenhum ataque disponível para iniciar Duel Clash.`
    );
    return null;
  }

  const choice = await Dialog.wait({
    title: `${defender.name} — Duel Clash`,
    content: `
      <div class="dbu-duel-defense-dialog">
        <p>
          Ataque recebido:
          <b>${dbuEsc(attack.attackerName || "Atacante")} — ${dbuEsc(attack.attackName || "Attack")}</b>
        </p>

        <div class="form-group">
          <label><b>Initiating Attack</b></label>
          <select id="dbu-duel-source" style="width:100%;">
            ${options}
          </select>
        </div>

        <p class="notes">
          O Initiating Attack gasta seu KP normalmente e o Duel usa uma Counter Action.
          O atacante original poderá escolher <b>Accept Duel</b> ou <b>Duel Escape</b>.
        </p>
      </div>
    `,
    buttons: {
      duel: {
        icon: '<i class="fas fa-bolt"></i>',
        label: "Iniciar Duel Clash",
        callback: html => Number(html.find("#dbu-duel-source").val())
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancelar",
        callback: () => null
      }
    },
    default: "duel",
    close: () => null
  });

  if (choice === null || choice === undefined) return null;
  return list[choice] || null;
}

function dbuAttackAllowsDuel(defender, attack) {
  if (!defender || !attack) return false;
  const group = String(attack.sourceGroup || attack.group || "").toLowerCase();
  const name = String(attack.attackName || attack.name || "").toLowerCase();
  const signature = !!attack.isSignature
    || group.includes("sig")
    || group.includes("signature")
    || name.includes("signature technique");
  const charges = Math.max(
    0,
    Number(attack.energyCharges || 0),
    Number(attack.energyChargeGathered || 0),
    Number(attack.gatheredCharges || 0)
  );
  const wager = Math.max(0, Number(attack.kiWager ?? attack.wager ?? 0));
  const attacker = attack?.attackerId ? game.actors?.get?.(attack.attackerId) : null;
  const baseTier = Math.max(1, Number(
    attack?.attackerBaseTier
    ?? attack?.baseTier
    ?? attacker?.system?.baseTier
    ?? attacker?.system?.tier
    ?? 1
  ));
  return signature || charges >= 2 || wager >= (10 * baseTier);
}

async function dbuInitiateDuelClash(defender, attack, message) {
  if (!dbuAttackAllowsDuel(defender, attack)) {
    ui.notifications.warn(`${defender?.name || "Defensor"}: este ataque não atende aos requisitos do Duel Maneuver.`);
    return { cancelled: true, reason: "duel-not-eligible" };
  }
  const selected = await dbuChooseDuelInitiatingAttack(defender, attack);
  if (!selected) return { cancelled: true };

  const source = selected.source;
  const cost = Math.max(0, Number(source.kiCost || 0));

  await dbuRunCombatReactionVisual(defender, "duelClash", "start", {
    attack, message, source, attacker: game.actors.get(attack.attackerId)
  });

  const payment = await dbuPayKiAndCapacity(
    defender,
    cost,
    `Duel Clash — ${source.name}`
  );

  if (!payment.ok) return { cancelled: true };

  let tracker = null;
  const oldMessages = new Set(
    game.messages.contents.map(entry => entry.id)
  );

  try {
    tracker = await dbuRecordDuelCounter(
      defender,
      source,
      attack
    );

    const helper = await dbuGetDuelHelper();
    const duelMessageWaiter = dbuWaitForNativeDuelMessage(defender.id, oldMessages);

    try {
      await helper.initiateDuel(defender, {
        mode: "clash",
        sourceName: source.name,
        foundation: source.foundation || "",
        ec: Number(source.energyCharges || 0),
        ps: Number(source.powerShot || 0),
        woundFormula: source.woundFormula || "1d10",
        damageCat: source.damageCat || "Standard"
      });
    } catch (error) {
      duelMessageWaiter.cancel();
      throw error;
    }

    const duelMessage = await duelMessageWaiter.promise;

    const duelMeta = duelMessage?.getFlag(
      DBU_SYSTEM_ID,
      "duel"
    );

    if (!duelMeta?.duelId) {
      throw new Error(
        "O DBU não criou a carta nativa do Duel."
      );
    }

    const duelId = duelMeta.duelId;

    await dbuBindDuelTrackerAction(
      defender,
      tracker,
      duelId
    );

    const context = {
      version: DBU_INIT_VERSION,
      duelId,
      originalAttackMessageId: message?.id || null,
      defenderId: defender.id,
      attackerId: attack.attackerId,
      defenderSourceKey: source.key,
      defenderSourceName: source.name,
      counterRound: tracker.roundNumber,
      counterActionIndex: tracker.actionIndex,
      counterNum: tracker.counterNum,
      sourceCost: cost,
      createdAt: Date.now(),
      attack: foundry.utils.deepClone(attack)
    };

    await dbuSetDuelContext(
      defender,
      duelId,
      context
    );

    // v6.6 — avisa a carta do ataque. Em multi-target, os outros alvos
    // passam a poder escolher Join United Duel no lugar de iniciar outro Duel.
    await dbuAnnounceDuelOnAttackCard(
      message,
      defender,
      duelId,
      source.name
    );

    console.log(
      "DBU | Duel Clash iniciado pela defesa",
      context
    );

    return {
      status: "duel",
      text:
        `⚡ Duel Clash — ${source.name} vs ${attack.attackName} · ` +
        `resolva na carta DUEL`,
      duelId
    };
  } catch (error) {
    console.error("DBU | Iniciar Duel Clash:", error);

    // Se algo falhar depois do pagamento, devolve o custo e restaura o tracker.
    try {
      const currentKi = Number(defender.system.kiPool?.value || 0);
      const capacity = dbuGetCapacity(defender);

      const updates = {
        "system.kiPool.value": currentKi + cost,
        "system.status.capacitySpent": Math.max(0, capacity.spent - cost)
      };

      if (tracker?.previousCTS) {
        updates["system.combatTabState"] = tracker.previousCTS;
      }

      await defender.update(updates);
    } catch (refundError) {
      console.error("DBU | Falha devolvendo custo do Duel:", refundError);
    }

    ui.notifications.error(
      error.message || "Erro iniciando Duel Clash."
    );

    return { cancelled: true };
  }
}

async function dbuSetupIncomingDuelAttacker(
  attacker,
  defender,
  duelId,
  context,
  { escaped = null } = {}
) {
  const attack = context.attack || {};
  const helper = await dbuGetDuelHelper();

  // Garante que métodos internos usados por computeDuelSide já estão preparados.
  await dbuPrepareSheet(attacker);

  const prepared = await dbuGetPreparedAttackSource(
    attacker,
    attack.sourceKey
  );

  const side = helper.computeDuelSide(attacker, {
    mode: "clash",
    ec: Number(attack.energyCharges || 0),
    ps: Number(attack.powerShot || 0),
    foundation: attack.foundation || prepared?.source?.foundation || ""
  });

  const woundFormula = dbuIncomingWoundFormula(
    attacker,
    attack,
    prepared
  );

  await attacker.setFlag(
    DBU_SYSTEM_ID,
    `duels.${duelId}`,
    {
      role: "attacker",
      escaped,
      mode: "clash",
      sourceName: attack.attackName || prepared?.source?.name || "Attack",
      foundation: attack.foundation || prepared?.source?.foundation || "",
      ec: Number(attack.energyCharges || 0),
      ps: Number(attack.powerShot || 0),
      woundFormula,
      damageCat: attack.damageCat || attack.damageCategory || prepared?.source?.damageCat || "Standard",
      dice: side.dice,
      mod: side.mod,
      breakdown: side.breakdown,
      woundCT: side.woundCT,
      wagerCap: side.wagerCap,
      wagers: [0, 0, 0],
      revealed: false,
      rolls: null,
      dbuOriginalIncomingAttack: true,
      dbuOriginalAttackMessageId: context.originalAttackMessageId || null
    }
  );

  return {
    sourceName: attack.attackName || "Attack",
    woundFormula
  };
}

function dbuDuelContextFromButton(button) {
  const shell = button.closest?.(".dbu-duel-shell");
  const duelId = shell?.dataset?.duelId;
  if (!duelId) return null;

  const messageElement = button.closest?.("[data-message-id]");
  let message = messageElement?.dataset?.messageId
    ? game.messages.get(messageElement.dataset.messageId)
    : null;

  if (!message) {
    message = game.messages.contents.find(entry =>
      entry.getFlag(DBU_SYSTEM_ID, "duel")?.duelId === duelId
    ) || null;
  }

  const meta = message?.getFlag(DBU_SYSTEM_ID, "duel");
  if (!meta?.defenderId) return null;

  const defender = game.actors.get(meta.defenderId);
  if (!defender) return null;

  const context = dbuGetDuelContext(defender, duelId);
  if (!context) return null;

  return {
    duelId,
    message,
    defender,
    context
  };
}

// ============================================================
// INJETAR "DUEL CLASH" NA CARTA DE DEFESA
// ============================================================

function dbuInjectDuelClashButton(message, html) {
  const attack = message.getFlag("world", "dbuAttackData");
  if (!attack) return;
  // Reflect já é um Out-of-Sequence Maneuver com Wound vindo do atacante
  // original. O Duel Clash nativo espera um Initiating Attack existente na
  // ficha do atacante atual, então ele não é oferecido nesta carta especial.
  if (attack.isReflect) return;

  const activeDuel = message.getFlag("world", "dbuActiveDuel") || null;

  const root = html instanceof HTMLElement
    ? html
    : (html?.[0] || html);

  if (!root?.querySelectorAll) return;

  const rows = root.querySelectorAll(".dbu-area-target");

  for (const row of rows) {
    const actions = row.querySelector(".dbu-attack-actions");
    if (!actions) continue;

    const anyDefense = actions.querySelector("[data-defender-id]");
    const defenderId = anyDefense?.dataset?.defenderId;
    if (!defenderId) continue;
    const defender = game.actors.get(defenderId);

    // Duel é contextual: só existe contra Signature Technique, ataque com 2+
    // Energy Charges ou Ki Wager de 10(bT)+. Não deixa botão genérico no card.
    if (!dbuAttackAllowsDuel(defender, attack)) {
      actions
        .querySelectorAll('[data-dbu-defense-v5="duelClash"], [data-dbu-united-duel-v1]')
        .forEach(button => button.remove());
      continue;
    }

    // Se já existe um Duel proveniente deste ataque e este é outro co-target,
    // troca somente a opção Duel Clash por Join United Duel. As demais
    // defesas continuam disponíveis normalmente.
    if (
      activeDuel?.duelId
      && defenderId !== activeDuel.primaryDefenderId
      && (attack.targetActorIds || []).includes(defenderId)
    ) {
      actions
        .querySelectorAll('[data-dbu-defense-v5="duelClash"]')
        .forEach(button => button.remove());

      if (!actions.querySelector("[data-dbu-united-duel-v1]")) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "dbu-pay-btn dbu-united-duel-btn";
        button.dataset.dbuUnitedDuelV1 = "1";
        button.dataset.defenderId = defenderId;
        button.dataset.duelId = activeDuel.duelId;
        button.dataset.primaryDefenderId = activeDuel.primaryDefenderId;
        button.innerHTML = '<i class="fas fa-hands-helping"></i> Join United Duel';
        button.title = "Co-target: entre no Duel do alvo principal como United Duel.";
        actions.appendChild(button);
      }

      continue;
    }

    if (actions.querySelector('[data-dbu-defense-v5="duelClash"]')) {
      continue;
    }

    // O alvo principal de um Duel já iniciado não recebe outro botão.
    if (
      activeDuel?.duelId
      && defenderId === activeDuel.primaryDefenderId
    ) {
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "dbu-pay-btn dbu-duel-defense-btn";
    button.dataset.dbuDefenseV5 = "duelClash";
    button.dataset.defenderId = defenderId;
    button.innerHTML = '<i class="fas fa-bolt"></i> Duel Clash';
    button.title = "Use a Counter Action e um Initiating Attack para iniciar um Duel Clash.";

    actions.appendChild(button);
  }
}
const duelInjectHookId = Hooks.on(
  "renderChatMessage",
  (message, html) => {
    try {
      dbuInjectDuelClashButton(message, html);
    } catch (error) {
      console.error("DBU | Injetar Duel Clash:", error);
    }
  }
);

globalThis.DBU_BOOTSTRAP.duelInjectHookId =
  duelInjectHookId;

// ============================================================
// ACCEPT DUEL — USA AUTOMATICAMENTE O ATAQUE ORIGINAL
// ============================================================

const dbuDuelAcceptHandler = async event => {
  const button = event.target.closest?.(".dbu-duel-accept");
  if (!button) return;

  const info = dbuDuelContextFromButton(button);

  // Duel iniciado normalmente pela ficha: deixa o comportamento nativo intacto.
  if (!info) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const attacker = game.actors.get(info.context.attackerId);

  if (!attacker) {
    return ui.notifications.error(
      "Atacante original do Duel não encontrado."
    );
  }

  if (!game.user.isGM && !attacker.isOwner) {
    return ui.notifications.warn(
      `Somente quem controla ${attacker.name} pode aceitar este Duel.`
    );
  }

  button.disabled = true;

  try {
    const current = attacker.getFlag(
      DBU_SYSTEM_ID,
      `duels.${info.duelId}`
    );

    if (current?.role === "attacker") return;

    const setup = await dbuSetupIncomingDuelAttacker(
      attacker,
      info.defender,
      info.duelId,
      info.context,
      { escaped: null }
    );

    await dbuRunCombatReactionVisual(attacker, "duelClash", "accept", {
      duelId:info.duelId, defender:info.defender, context:info.context, setup
    });
    await dbuRunCombatReactionVisual(info.defender, "duelClash", "accept", {
      duelId:info.duelId, attacker, context:info.context, setup
    });

    ui.notifications.info(
      `${attacker.name} aceita o Duel com ${setup.sourceName}.`
    );
  } catch (error) {
    console.error("DBU | Accept Duel:", error);
    button.disabled = false;
    ui.notifications.error(
      error.message || "Erro aceitando o Duel."
    );
  }
};

document.addEventListener(
  "click",
  dbuDuelAcceptHandler,
  true
);

globalThis.DBU_BOOTSTRAP.duelAcceptHandler =
  dbuDuelAcceptHandler;

// ============================================================
// DUEL ESCAPE — FORÇA O ATACANTE ORIGINAL
// ============================================================

async function dbuRequestDuelCounterRefund(defender, duelId, context) {
  const payload = {
    type: "dbuRefundDuelCounter",
    defenderId: defender.id,
    duelId,
    userId: game.user.id
  };

  if (game.user.isGM) {
    await dbuGMRefundDuelCounter(payload);
  } else {
    game.socket.emit(DBU_SOCKET, payload);
  }
}

const dbuDuelEscapeHandler = async event => {
  const button = event.target.closest?.(".dbu-duel-escape");
  if (!button) return;

  const info = dbuDuelContextFromButton(button);
  if (!info) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const attacker = game.actors.get(info.context.attackerId);
  if (!attacker) {
    return ui.notifications.error(
      "Atacante original do Duel não encontrado."
    );
  }

  if (!game.user.isGM && !attacker.isOwner) {
    return ui.notifications.warn(
      `Somente quem controla ${attacker.name} pode tentar Duel Escape.`
    );
  }

  button.disabled = true;

  try {
    const mine = new Roll(
      `1d10+${Number(attacker.system.savingThrows?.impulsive?.bonus || 0)}`
    );

    const theirs = new Roll(
      `1d10+${Number(info.defender.system.savingThrows?.impulsive?.bonus || 0)}`
    );

    await mine.evaluate();
    await theirs.evaluate();

    const success = Number(mine.total || 0) > Number(theirs.total || 0);

    await dbuRunCombatReactionVisual(attacker, "duelClash", success ? "escape-success" : "escape-fail", {
      duelId:info.duelId, defender:info.defender, context:info.context,
      success, attackerRoll:mine, defenderRoll:theirs
    });
    await dbuRunCombatReactionVisual(info.defender, "duelClash", success ? "escape-success" : "escape-fail", {
      duelId:info.duelId, attacker, context:info.context,
      success, attackerRoll:mine, defenderRoll:theirs
    });

    if (success) {
      await attacker.setFlag(
        DBU_SYSTEM_ID,
        `duels.${info.duelId}`,
        {
          role: "attacker",
          escaped: "success"
        }
      );

      await dbuRequestDuelCounterRefund(
        info.defender,
        info.duelId,
        info.context
      );
    } else {
      await dbuSetupIncomingDuelAttacker(
        attacker,
        info.defender,
        info.duelId,
        info.context,
        { escaped: "failed" }
      );
    }

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: attacker }),
      content: `
        <div class="dbu-round-card">
          <div class="dbu-round-num">
            <i class="fas fa-running"></i>
            ${success ? "ESC" : "FAIL"}
          </div>
          <div class="dbu-round-info">
            <span class="dbu-round-title">
              Duel Escape — ${dbuEsc(attacker.name)}
            </span>
            <span class="dbu-round-detail">
              Impulsive ${mine.total} vs ${theirs.total} —
              ${
                success
                  ? "escapou! Ataque anulado e Counter Action devolvida."
                  : `falhou — o Duel continua usando ${dbuEsc(info.context.attack?.attackName || "o ataque original")}.`
              }
            </span>
          </div>
        </div>
      `
    });
  } catch (error) {
    console.error("DBU | Duel Escape:", error);
    button.disabled = false;
    ui.notifications.error(
      error.message || "Erro no Duel Escape."
    );
  }
};

document.addEventListener(
  "click",
  dbuDuelEscapeHandler,
  true
);

globalThis.DBU_BOOTSTRAP.duelEscapeHandler =
  dbuDuelEscapeHandler;

// ============================================================
// KI WAGER DO DUEL TAMBÉM CONSOME CAPACITY
// ============================================================

const dbuDuelRevealHandler = async event => {
  const button = event.target.closest?.(".dbu-duel-reveal");
  if (!button) return;

  const shell = button.closest?.(".dbu-duel-shell");
  const duelId = shell?.dataset?.duelId;
  const actorId = button.dataset.actorId;

  if (!duelId || !actorId) return;

  const actor = game.actors.get(actorId);
  if (!actor?.isOwner && !game.user.isGM) return;

  const state = actor?.getFlag(
    DBU_SYSTEM_ID,
    `duels.${duelId}`
  );

  if (!state || state.revealed) return;

  await dbuRunCombatReactionVisual(actor, "duelClash", "reveal", {
    duelId, duelState:foundry.utils.deepClone(state)
  });

  const wagers = (state.wagers || [0, 0, 0]).map(
    value => Math.max(0, Number(value) || 0)
  );

  const spent = wagers.reduce((a, b) => a + b, 0);
  if (spent <= 0) {
    // O handler nativo ainda fará o Reveal. Aguarda a gravação para disparar
    // resolve/win/lose/tie mesmo quando não existe Ki Wager.
    (async () => {
      if (await dbuWaitForDuelReveal(actor, duelId)) {
        await dbuMaybeRunDuelResolutionVisual(duelId);
      }
    })();
    return;
  }

  // Replica a validação do helper nativo antes de permitir o click.
  let overCap = false;

  if (state.role === "support" && state.uaMode) {
    overCap = wagers.some(value => value > Number(state.wagerCap || 0));
  } else {
    overCap = spent > Number(state.wagerCap || 0);
  }

  if (overCap) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return ui.notifications.warn(
      `${actor.name}: Ki Wager acima do limite do Duel.`
    );
  }

  const ki = Number(actor.system.kiPool?.value || 0);
  const capacity = dbuGetCapacity(actor);

  if (ki < spent) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return ui.notifications.warn(
      `${actor.name}: Ki insuficiente para ${spent} KP de Wager.`
    );
  }

  if (capacity.max > 0 && capacity.left < spent) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return ui.notifications.warn(
      `${actor.name}: Capacity insuficiente para ${spent} KP de Wager.`
    );
  }

  const key = `${duelId}:${actor.id}`;
  if (globalThis.DBU_DUEL_WAGER_LOCKS.has(key)) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return;
  }
  globalThis.DBU_DUEL_WAGER_LOCKS.add(key);

  // Não bloqueia o handler nativo. Espera o estado "revealed" ser salvo e só
  // então espelha o custo na Capacity.
  (async () => {
    try {
      const revealed = await dbuWaitForDuelReveal(actor, duelId);

      if (!revealed) {
        globalThis.DBU_DUEL_WAGER_LOCKS.delete(key);
        return;
      }

      await dbuMaybeRunDuelResolutionVisual(duelId);

      const afterCapacity = dbuGetCapacity(actor);

      await actor.update({
        "system.status.capacitySpent":
          afterCapacity.spent + spent
      });

      const finalCapacity = dbuGetCapacity(actor);

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
            <b>${dbuEsc(actor.name)}</b><br>
            Duel Ki Wager: <b>-${spent} KP / Capacity</b><br>
            Capacity Spent:
            <b>${afterCapacity.spent} → ${finalCapacity.spent}</b><br>
            Capacity restante:
            <b>${finalCapacity.left} / ${finalCapacity.max}</b>
          </div>
        `
      });
    } catch (error) {
      console.error("DBU | Capacity do Duel Wager:", error);
      globalThis.DBU_DUEL_WAGER_LOCKS.delete(key);
    }
  })();
};

document.addEventListener(
  "click",
  dbuDuelRevealHandler,
  true
);

globalThis.DBU_BOOTSTRAP.duelRevealHandler =
  dbuDuelRevealHandler;

// ============================================================
// CAPACITY
// ============================================================


  return {
    dbuGetDuelHelper,
    dbuGetDuelContext,
    dbuRefundDuelCounter,
    dbuInitiateDuelClash,
    dbuSetupIncomingDuelAttacker
  };
}
