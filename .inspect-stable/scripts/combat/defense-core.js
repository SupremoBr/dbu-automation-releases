// DBU Automation — rolagens, resolução e dano de defesa
import { prepareTerrainShield, resolveTerrainShield } from "../maneuvers.js";

const MODULE_ID = "dbu-automation-dev";

export function createDefenseCore(deps = {}) {
  const {
    dbuEsc, dbuPrepareSheet, dbuGetDefenseGif, dbuDefenseGifHTML,
    dbuRunDefenseVisual, dbuInitiateDuelClash, dbuPayKiAndCapacity,
    dbuRecordDefend
  } = deps;

async function dbuCritRoll(actor, sheet) {
  if (
    typeof sheet._critExtraFormula !== "function"
  ) {
    return null;
  }

  const tier = Number(
    actor.system.tier || 1
  );

  let formula = null;

  try {
    formula = sheet._critExtraFormula(tier);
  } catch {
    try {
      formula = sheet._critExtraFormula();
    } catch {
      formula = null;
    }
  }

  if (!formula) return null;

  const roll = new Roll(formula);
  await roll.evaluate();

  return roll;
}

// ============================================================
// DODGE
// ============================================================

async function dbuRollDodge(defender, { silent = false } = {}) {
  const sheet = await dbuPrepareSheet(defender);

  const td = sheet._trackerDodge || {
    formula: "1d10",
    ct: 10
  };

  const baseTier = Number(
    defender.system.baseTier ||
    defender.system.tier ||
    1
  );

  const currentCount = Number(
    defender.system.combatTabState
      ?.roundDodgeCount || 0
  );

  const dodgeNum = currentCount + 1;
  const perStack = Math.ceil(baseTier / 2);
  const penalty = (dodgeNum - 1) * perStack;

  const formula = penalty > 0
    ? `(${td.formula})-${penalty}`
    : String(td.formula);

  const roll = new Roll(formula);
  await roll.evaluate();

  const rawNatural = Number(
    roll.dice?.[0]
      ?.results?.[0]
      ?.result || 0
  );

  const naturalBonus = Number(
    defender.system
      ._bestialDodgeNaturalBonus || 0
  );

  const natural = Math.min(
    10,
    rawNatural + naturalBonus
  );

  const critical =
    natural >= Number(td.ct || 10);

  const botch = rawNatural === 1;

  let critRoll = null;

  if (critical) {
    critRoll = await dbuCritRoll(
      defender,
      sheet
    );
  }

  const total =
    Number(roll.total || 0)
    + (natural - rawNatural)
    + Number(critRoll?.total || 0)
    - (botch ? 2 * baseTier : 0);

  await defender.update({
    "system.combatTabState.roundDodgeCount":
      dodgeNum,

    "system.tracking.diminishingDefense":
      dodgeNum - 1
  });

  if (!silent) await roll.toMessage({
    speaker: ChatMessage.getSpeaker({
      actor: defender
    }),

    flavor: `
      <div class="dbu-attack-roll dbu-dodge-card">
        <h3 class="dbu-attack-title">
          <span class="dbu-card-title-text">
            ${dbuEsc(defender.name)} — Dodge
          </span>
          <span class="dbu-action-count">
            DGE ${dodgeNum}
          </span>
        </h3>

        <div class="dbu-card-body">
          <div class="dbu-roll-row">
            <span class="dbu-roll-label">Dodge</span>

            <span class="dbu-roll-main">
              <code class="dbu-roll-formula">
                ${dbuEsc(formula)}
              </code>

              <span class="dbu-roll-sub">
                Nat ${natural} · CT ${td.ct}+
              </span>
            </span>

            <span class="dbu-roll-total">
              ${total}
            </span>
          </div>
        </div>
      </div>
    `
  });

  return {
    total,
    natural,
    critical,
    botch
  };
}

// ============================================================
// PARRY / POWER FLARE
// ============================================================

async function dbuRollDefend(
  defender,
  type,
  attack,
  wager = 0,
  { silent = false } = {}
) {
  const sheet = await dbuPrepareSheet(defender);

  const tier = Number(
    defender.system.tier || 1
  );

  const baseTier = Number(
    defender.system.baseTier || tier
  );

  const isParry = type === "parry";

  let strikeCT = 10;
  let woundCT = 10;

  if (
    typeof sheet._calcCombatCTs === "function"
  ) {
    const calculated = sheet._calcCombatCTs(
      defender.system
    );

    strikeCT = Number(
      calculated?.strikeCT || 10
    );

    woundCT = Number(
      calculated?.woundCT || 10
    );
  }

  const rollCT = isParry
    ? strikeCT
    : woundCT;

  const penaltyRanks = isParry
    ? Math.max(
        0,
        Number(attack.energyCharges || 0)
      )
      + Math.max(
        0,
        Number(attack.powerShot || 0)
      )
    : 0;

  const penalty = penaltyRanks * tier;

  const baseFormula = isParry
    ? (
        sheet._trackerDefend
          ?.strikeFormula ||
        "1d10"
      )
    : (
        sheet._trackerDefend
          ?.woundFormula ||
        "1d10"
      );

  let formula = String(baseFormula);

  if (penalty > 0) {
    formula = `(${formula})-${penalty}`;
  }

  if (!isParry && wager > 0) {
    formula = `(${formula})+${wager}`;
  }

  const cyberParry = Number(
    defender.system._cyberParryStrike
    ?? defender.system._cyberParryStrikeBonus
    ?? 0
  );

  const fierceCounter = Number(
    defender.system.aptitudes
      ?.fierceCounterStrike
    ?? defender.system.aptitudes
      ?.fierceCounterStrikeBonus
    ?? 0
  );

  const parryBonus = isParry
    ? cyberParry + fierceCounter
    : 0;

  if (parryBonus) {
    formula = `(${formula})+${parryBonus}`;
  }

  const counterNum = await dbuRecordDefend(
    defender,
    type,
    {
      penaltyRanks,
      wager,
      incomingEC: attack.energyCharges
    }
  );

  const roll = new Roll(formula);
  await roll.evaluate();

  const natural = Number(
    roll.dice?.[0]
      ?.results?.[0]
      ?.result || 0
  );

  const critical = natural >= rollCT;
  const botch = natural === 1;

  let critRoll = null;

  if (critical) {
    critRoll = await dbuCritRoll(
      defender,
      sheet
    );
  }

  const total =
    Number(roll.total || 0)
    + Number(critRoll?.total || 0)
    - (botch ? 2 * baseTier : 0);

  const name = isParry
    ? "Parry"
    : "Power Flare";

  if (!silent) await roll.toMessage({
    speaker: ChatMessage.getSpeaker({
      actor: defender
    }),

    flavor: `
      <div class="dbu-attack-roll dbu-defend-card">
        <h3 class="dbu-attack-title">
          <span class="dbu-card-title-text">
            ${dbuEsc(defender.name)} — ${name}
          </span>

          <span class="dbu-action-count">
            CTR ${counterNum}
          </span>
        </h3>

        <div class="dbu-card-body">
          <div class="dbu-roll-row">
            <span class="dbu-roll-label">
              ${name}
            </span>

            <span class="dbu-roll-main">
              <code class="dbu-roll-formula">
                ${dbuEsc(formula)}
              </code>

              <span class="dbu-roll-sub">
                Nat ${natural} · CT ${rollCT}+
              </span>
            </span>

            <span class="dbu-roll-total">
              ${total}
            </span>
          </div>
        </div>
      </div>
    `
  });

  return {
    total,
    counterNum,
    penaltyRanks
  };
}

// ============================================================
// DAMAGE
// ============================================================

async function dbuApplyDamage(
  defender,
  attack,
  defense = "none"
) {
  const sheet = defender.sheet;

  if (!sheet) {
    throw new Error(
      "Ficha do defensor não encontrada."
    );
  }

  const rawCategory = String(
    attack.damageCategory
    || attack.damageCat
    || "standard"
  ).toLowerCase();

  let category = "standard";

  if (rawCategory.includes("direct")) {
    category = "direct";
  } else if (rawCategory.includes("lethal")) {
    category = "lethal";
  }

  // Terrain Lift 0.9.2 — Shielding é automático quando o personagem é atingido.
  // A redução altera o Dice Score do Wound ANTES do cálculo nativo de Damage.
  const terrainShield = prepareTerrainShield(
    defender,
    Math.max(0, Number(attack.woundTotal || 0))
  );
  const woundForDamage = terrainShield
    ? terrainShield.reducedWound
    : Math.max(0, Number(attack.woundTotal || 0));
  const lifeBefore = Math.max(0, Number(defender.system.lifePoints?.value || 0));

  await defender.update({
    "system.damageCalc.source": "wound",

    "system.damageCalc.woundRoll":
      woundForDamage,

    "system.damageCalc.category":
      category,

    "system.damageCalc.defense":
      defense,

    "system.damageCalc.incomingEC":
      Math.max(
        0,
        Number(attack.energyCharges || 0)
      ),

    "system.damageCalc.guardPaidViaCard":
      defense === "guard",

    "system.damageCalc.isRanged":
      String(attack.foundation || "")
        .toLowerCase() !== "physical"
  });

  if (
    typeof sheet._onApplyDamage !== "function"
  ) {
    throw new Error(
      "_onApplyDamage não encontrada."
    );
  }

  await sheet._onApplyDamage({
    preventDefault() {},
    stopPropagation() {}
  });

  // v1.8.0 — Throw / Collision. O DBU 0.9.2 adiciona ao Damage do
  // Throw a redução típica de LP de uma Collision com a Hardness do objeto.
  // Essa parcela acontece DEPOIS do cálculo normal de Wound/Soak e respeita
  // a aptidão nativa collisionDamageMultiplier (ex.: Android / Custom Species).
  const rawFlatDamage = Math.max(0, Math.trunc(Number(attack.flatDamageBonus || 0)));
  let appliedFlatDamage = 0;
  if (rawFlatDamage > 0) {
    const multRaw = Number(defender.system?.aptitudes?.collisionDamageMultiplier);
    const multiplier = Number.isFinite(multRaw) ? Math.max(0, multRaw) : 1;
    appliedFlatDamage = Math.max(0, Math.floor(rawFlatDamage * multiplier));
    if (appliedFlatDamage > 0) {
      const currentLife = Math.max(0, Number(defender.system.lifePoints?.value || 0));
      const afterCollision = Math.max(0, currentLife - appliedFlatDamage);
      const actualCollision = Math.max(0, currentLife - afterCollision);
      appliedFlatDamage = actualCollision;
      await defender.update({ "system.lifePoints.value": afterCollision });
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: defender }),
        content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>${String(attack.flatDamageLabel || "Collision")}</b>: ${defender.name} perde <b>${actualCollision} LP</b>${multiplier !== 1 ? ` (multiplicador de Collision ×${multiplier})` : ""}.</div></div></div>`
      });
    }
  }

  // O Terrain Shield precisa avaliar somente o Damage causado pelo Attacking
  // Maneuver/Collision. A perda posterior de LP recuperados pelo Combat Recovery
  // é uma consequência do Exploit e não deve destruir/desgastar a Feature.
  if (terrainShield) {
    const lifeAfterAttack = Math.max(0, Number(defender.system.lifePoints?.value || 0));
    const damageTaken = Math.max(0, lifeBefore - lifeAfterAttack);
    await resolveTerrainShield(defender, terrainShield, damageTaken);
  }

  // v1.8.5 TEST — Exploit provocado por Combat Recovery. Pela DBU 0.9.2,
  // se o personagem for atingido pelo Attacking Maneuver usado através desse
  // Exploit, perde os LP que recuperou com Combat Recovery neste Round.
  if (
    String(attack.attackMode || "") === "exploit"
    && String(attack.exploitRecoveryActorId || "") === String(defender.id)
  ) {
    const standardState = defender.getFlag?.(MODULE_ID, "standardManeuverState") || {};
    const recovery = standardState?.combatRecovery || null;
    const recoveredLp = Math.max(0, Number(recovery?.recoveredLp || 0));
    if (recovery?.active && recoveredLp > 0 && !recovery?.exploitLpLost) {
      const beforeLoss = Math.max(0, Number(defender.system.lifePoints?.value || 0));
      const afterLoss = Math.max(0, beforeLoss - recoveredLp);
      const actualLoss = Math.max(0, beforeLoss - afterLoss);
      await defender.update({ "system.lifePoints.value": afterLoss });
      await defender.setFlag(MODULE_ID, "standardManeuverState.combatRecovery", {
        ...recovery,
        recoveredLp: 0,
        exploitLpLost: true,
        exploitLpLostAmount: actualLoss,
        exploitHitAt: Date.now(),
        exploitAttackMessageId: attack.messageId || null
      });
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: defender }),
        content: `<div class="dbu-attack-roll"><div class="dbu-card-body"><div class="dbu-defend-guide"><b>Combat Recovery — Exploit:</b> ${dbuEsc(defender.name)} foi atingido pelo Basic Attack do Exploit e perde <b>${actualLoss} LP</b> recuperados pelo Combat Recovery deste Round.</div></div></div>`
      });
    }
  }
}

// ============================================================
// RESULTADO DA DEFESA + GIF PERSONALIZADO
// ============================================================

async function dbuDefenseResult(
  defender,
  defenseType,
  name,
  total,
  targetLabel,
  target,
  success,
  extra = ""
) {
  const defenseGif = dbuGetDefenseGif(
    defender,
    defenseType
  );

  const defenseGifHTML = dbuDefenseGifHTML(
    defenseGif,
    name
  );

  console.log(
    "DBU | Defense GIF",
    {
      actor: defender.name,
      defenseType,
      gif: defenseGif || "Nenhum"
    }
  );

  await dbuRunDefenseVisual(defender, defenseType, {
    name, total, targetLabel, target, success, extra
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({
      actor: defender
    }),

    content: `
      <div class="dbu-attack-roll dbu-defend-card">
        <h3 class="dbu-attack-title">
          <span class="dbu-card-title-text">
            ${dbuEsc(defender.name)} — ${dbuEsc(name)}
          </span>
        </h3>

        <div class="dbu-card-body">
          ${defenseGifHTML}

          ${
            total !== null
              ? `
                <div class="dbu-roll-row">
                  <span class="dbu-roll-label">
                    ${dbuEsc(name)}
                  </span>

                  <span class="dbu-roll-main">
                    vs ${dbuEsc(targetLabel)}
                  </span>

                  <span class="dbu-roll-total">
                    ${total} / ${target}
                  </span>
                </div>
              `
              : ""
          }

          ${
            extra
              ? `
                <div class="dbu-attack-meta">
                  <span class="dbu-meta-chip">
                    ${dbuEsc(extra)}
                  </span>
                </div>
              `
              : ""
          }

          <div class="dbu-attack-buffs">
            <strong>
              ${
                success
                  ? "✅ DEFESA BEM-SUCEDIDA"
                  : name === "Guard"
                    ? "🛡 GUARD"
                    : name === "Direct Hit"
                      ? "🎯 DIRECT HIT"
                      : "❌ DEFESA FALHOU"
              }
            </strong>
          </div>
        </div>
      </div>
    `
  });
}

// ============================================================
// RESOLVER DEFESA
// ============================================================

async function dbuResolveDefense(
  defender,
  attack,
  defenseType,
  context = {}
) {
  const deferReveal = !!context?.deferReveal;

  const strike = Number(
    attack.strikeTotal || 0
  );

  const wound = Number(
    attack.woundTotal || 0
  );

  // DUEL CLASH — v6.5
  if (defenseType === "duelClash") {
    if (!context.message) {
      throw new Error(
        "ChatMessage do ataque é necessária para iniciar o Duel Clash."
      );
    }

    return dbuInitiateDuelClash(
      defender,
      attack,
      context.message
    );
  }

  // DODGE
  if (defenseType === "dodge") {
    const roll = await dbuRollDodge(defender, { silent: deferReveal });
    const success = roll.total >= strike;

    if (!deferReveal) {
      await dbuDefenseResult(
        defender,
        "dodge",
        "Dodge",
        roll.total,
        "Strike",
        strike,
        success
      );

      if (!success) {
        await dbuApplyDamage(defender, attack, "none");
      }
    }

    return {
      status: success ? "defended" : "hit",
      text: success
        ? `✅ Dodge — ${roll.total} vs ${strike}`
        : `❌ Dodge — ${roll.total} vs ${strike}`,
      hiddenOutcome: deferReveal ? {
        defenseType: "dodge", name: "Dodge", total: roll.total,
        targetLabel: "Strike", target: strike, success, extra: "",
        damageDefense: success ? null : "none"
      } : null
    };
  }

  // PARRY
  if (defenseType === "parry") {
    const roll = await dbuRollDefend(
      defender,
      "parry",
      attack,
      0,
      { silent: deferReveal }
    );

    const success = roll.total >= strike;

    if (!deferReveal) {
      await dbuDefenseResult(
        defender,
        "parry",
        "Parry",
        roll.total,
        "Strike",
        strike,
        success
      );

      if (!success) {
        await dbuApplyDamage(defender, attack, "none");
      }
    }

    return {
      status: success ? "defended" : "hit",
      text: success
        ? `✅ Parry — ${roll.total} vs ${strike}`
        : `❌ Parry — ${roll.total} vs ${strike}`,
      hiddenOutcome: deferReveal ? {
        defenseType: "parry", name: "Parry", total: roll.total,
        targetLabel: "Strike", target: strike, success, extra: "",
        damageDefense: success ? null : "none"
      } : null
    };
  }

  // DIRECT HIT
  if (defenseType === "directHit") {
    await dbuRecordDefend(
      defender,
      "directHit",
      {
        incomingEC: attack.energyCharges
      }
    );

    if (!deferReveal) {
      await dbuDefenseResult(
        defender,
        "directHit",
        "Direct Hit",
        null,
        "Wound",
        wound,
        false,
        `Wound ${wound}`
      );

      await dbuApplyDamage(defender, attack, "directHit");
    }

    return {
      status: "hit",
      text: `🎯 Direct Hit — Wound ${wound}`,
      hiddenOutcome: deferReveal ? {
        defenseType: "directHit", name: "Direct Hit", total: null,
        targetLabel: "Wound", target: wound, success: false,
        extra: `Wound ${wound}`, damageDefense: "directHit"
      } : null
    };
  }

  // POWER FLARE
  if (defenseType === "powerFlare") {
    const sheet = await dbuPrepareSheet(defender);

    const fallbackMaxWager = Math.floor(
      Number(
        defender.system.status?.maxCapacity || 0
      ) / 5
    );

    const maxWager = Number(
      sheet._trackerDefend?.maxFlareWager
      ?? fallbackMaxWager
      ?? 0
    );

    const wager = await Dialog.wait({
      title: `${defender.name} — Power Flare`,

      content: `
        <div>
          <p>
            Wound recebido: <b>${deferReveal ? "🔒 oculto" : wound}</b>
          </p>

          <p>
            Wager máximo: <b>${maxWager}</b>
          </p>

          <input
            id="dbu-flare-wager"
            type="number"
            min="0"
            max="${maxWager}"
            value="0"
            step="1"
            style="width:100%;"
          >
        </div>
      `,

      buttons: {
        roll: {
          label: "Power Flare",
          callback: html =>
            Math.max(
              0,
              Math.min(
                maxWager,
                Number(
                  html
                    .find("#dbu-flare-wager")
                    .val()
                ) || 0
              )
            )
        },

        cancel: {
          label: "Cancelar",
          callback: () => null
        }
      },

      default: "roll",
      close: () => null
    });

    if (wager === null) {
      return {
        cancelled: true
      };
    }

    const tier = Number(
      defender.system.tier || 1
    );

    const cost = 2 * tier + wager;

    const payment = await dbuPayKiAndCapacity(
      defender,
      cost,
      "Power Flare"
    );

    if (!payment.ok) {
      return {
        cancelled: true
      };
    }

    const roll = await dbuRollDefend(
      defender,
      "powerFlare",
      attack,
      wager,
      { silent: deferReveal }
    );

    const success = roll.total >= wound;

    if (!deferReveal) {
      await dbuDefenseResult(
        defender,
        "powerFlare",
        "Power Flare",
        roll.total,
        "Wound",
        wound,
        success,
        `Cost ${cost} KP / Capacity`
      );

      if (!success) {
        await dbuApplyDamage(defender, attack, "none");
      }
    }

    return {
      status: success ? "defended" : "hit",
      text: success
        ? `✅ Power Flare — ${roll.total} vs ${wound}`
        : `❌ Power Flare — ${roll.total} vs ${wound}`,
      hiddenOutcome: deferReveal ? {
        defenseType: "powerFlare", name: "Power Flare", total: roll.total,
        targetLabel: "Wound", target: wound, success,
        extra: `Cost ${cost} KP / Capacity`,
        damageDefense: success ? null : "none"
      } : null
    };
  }

  // CROSS COUNTER
  if (defenseType === "crossCounter") {
    const tier = Number(
      defender.system.tier || 1
    );

    const cost = 2 * tier;

    const payment = await dbuPayKiAndCapacity(
      defender,
      cost,
      "Cross Counter"
    );

    if (!payment.ok) {
      return {
        cancelled: true
      };
    }

    await dbuRecordDefend(
      defender,
      "crossCounter",
      {
        incomingEC: attack.energyCharges
      }
    );

    const defenseValue = Number(
      defender.system.aptitudes?.defenseValue || 0
    );

    const halfDefense = Math.floor(
      defenseValue / 2
    );

    const success = strike < halfDefense;

    if (!deferReveal) {
      await dbuDefenseResult(
        defender,
        "crossCounter",
        "Cross Counter",
        halfDefense,
        "Strike",
        strike,
        success,
        `Cost ${cost} KP / Capacity`
      );

      if (!success) {
        await dbuApplyDamage(defender, attack, "none");
      }
    }

    return {
      status: success ? "defended" : "hit",
      text: success
        ? `✅ Cross Counter — ${halfDefense} vs ${strike}`
        : `❌ Cross Counter — ${halfDefense} vs ${strike}`,
      hiddenOutcome: deferReveal ? {
        defenseType: "crossCounter", name: "Cross Counter", total: halfDefense,
        targetLabel: "Strike", target: strike, success,
        extra: `Cost ${cost} KP / Capacity`,
        damageDefense: success ? null : "none"
      } : null
    };
  }

  // GUARD
  if (defenseType === "guard") {
    await dbuPrepareSheet(defender);

    const tier = Number(
      defender.system.tier || 1
    );

    const ec = Math.min(
      4,
      Math.max(
        0,
        Number(attack.energyCharges || 0)
      )
    );

    let cost = (8 + ec) * tier;

    if (
      defender._isConditionActive?.(
        defender.system,
        "guardDown"
      )
    ) {
      cost = Math.ceil(cost * 1.5);
    }

    const reduction = Number(
      defender.system.aptitudes
        ?.guardKPReduction || 0
    );

    cost = Math.max(
      0,
      cost - reduction
    );

    const payment = await dbuPayKiAndCapacity(
      defender,
      cost,
      "Guard"
    );

    if (!payment.ok) {
      return {
        cancelled: true
      };
    }

    await dbuRecordDefend(
      defender,
      "guard",
      {
        incomingEC: attack.energyCharges
      }
    );

    if (!deferReveal) {
      await dbuDefenseResult(
        defender,
        "guard",
        "Guard",
        null,
        "Wound",
        wound,
        false,
        `Cost ${cost} KP / Capacity · EC ${ec}`
      );

      await dbuApplyDamage(defender, attack, "guard");
    }

    return {
      status: "guard",
      text: `🛡 Guard — Wound ${wound} · Cost ${cost}`,
      hiddenOutcome: deferReveal ? {
        defenseType: "guard", name: "Guard", total: null,
        targetLabel: "Wound", target: wound, success: false,
        extra: `Cost ${cost} KP / Capacity · EC ${ec}`,
        damageDefense: "guard"
      } : null
    };
  }

  throw new Error(
    `Defesa desconhecida: ${defenseType}`
  );
}

// ============================================================
// ESTADO DA DEFESA NO ACTOR
// ============================================================


  return {
    dbuCritRoll,
    dbuRollDodge,
    dbuRollDefend,
    dbuApplyDamage,
    dbuDefenseResult,
    dbuResolveDefense
  };
}
