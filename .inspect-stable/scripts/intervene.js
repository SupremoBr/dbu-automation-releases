import { getCombatVisualSettings } from "./visual-config.js";
import { prepareTerrainShield, resolveTerrainShield } from "./maneuvers.js";
import { areAllies as areTeamAllies } from "./combat-teams.js";
const MODULE_ID = "dbu-automation-dev";
const DBU_SOCKET = "module.dbu-automation-dev";
const DBU_SYSTEM_ID = "DBU-MRR-OLD";
const VERSION = "1.8.12 DEV";

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

function isPrimaryGM() {
  const active = game.users
    .filter(user => user.active && user.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return active[0]?.id === game.user.id;
}

function attackData(message) {
  return message?.getFlag("world", "dbuAttackData") || null;
}

function defenseStates(message) {
  return foundry.utils.deepClone(
    message?.getFlag("world", "dbuDefenseStates") || {}
  );
}

function isEnergyOrMagic(attack) {
  const f = String(attack?.foundation || "").toLowerCase();
  return f === "energy" || f === "magic";
}

function canReflect(attack) {
  if (!attack || !isEnergyOrMagic(attack)) return false;
  if (attack.reflectBlocked) return false;
  if (attack.hasAoE) return false;
  // Compatibilidade com cartas v1.3, que ainda usavam isAreaAttack como proxy.
  if (attack.hasAoE == null && attack.isAreaAttack) return false;
  return true;
}

function getTokenForActor(actorId) {
  return canvas?.tokens?.placeables?.find(token => token.actor?.id === actorId) || null;
}

async function runCombatVisual(actor, reactionType, phase, payload = {}) {
  try {
    const settings = getCombatVisualSettings(actor, reactionType);
    if (settings?.mode !== "custom" || !settings?.macro) return false;
    const macro = game.macros?.getName?.(settings.macro);
    if (!macro) { console.warn(`DBU Visual | Macro não encontrado para ${reactionType}: ${settings.macro}`); return false; }
    const token = getTokenForActor(actor.id);
    await macro.execute({ actor, token, reactionType, combatReaction: reactionType, phase, action: reactionType, ...payload });
    return true;
  } catch (error) { console.warn(`DBU Visual | ${reactionType}/${phase}:`, error); return false; }
}

function tokenDistanceSquares(a, b) {
  if (!a || !b || !canvas?.grid) return null;
  try {
    if (typeof canvas.grid.measurePath === "function") {
      const result = canvas.grid.measurePath([a.center, b.center]);
      const distance = Number(result?.distance);
      if (Number.isFinite(distance)) return distance;
    }
  } catch {}

  const gridSize = Number(canvas.grid.size || canvas.dimensions?.size || 1) || 1;
  const dx = Math.abs(Number(a.center?.x || 0) - Number(b.center?.x || 0));
  const dy = Math.abs(Number(a.center?.y || 0) - Number(b.center?.y || 0));
  return Math.max(dx, dy) / gridSize;
}

function sameSide(candidateToken, targetToken) {
  if (!candidateToken || !targetToken) return true;
  return areTeamAllies(candidateToken, targetToken, game.combat);
}

function eligibleInterveners(message, targetActor) {
  const attack = attackData(message);
  if (!attack || !targetActor) return [];

  const targetIds = new Set(attack.targetActorIds || []);
  const targetToken = getTokenForActor(targetActor.id);

  return game.actors
    .filter(actor => {
      if (!actor || actor.type !== "character") return false;
      if (!game.user.isGM && !actor.isOwner) return false;
      if (actor.id === targetActor.id) return false;
      if (actor.id === attack.attackerId) return false;
      if (targetIds.has(actor.id)) return false; // Intervene: ataque não pode também ter o interventor como alvo.

      const token = getTokenForActor(actor.id);
      if (!token) return false;
      if (!sameSide(token, targetToken)) return false;

      if (targetToken) {
        const distance = tokenDistanceSquares(token, targetToken);
        // DBU 0.9.2 Intervene: o Ally atingido deve estar em até 8 Squares.
        if (Number.isFinite(distance) && distance > 8.001) return false;
      }

      return true;
    })
    .map(actor => {
      const token = getTokenForActor(actor.id);
      const distance = tokenDistanceSquares(token, targetToken);
      return { actor, token, distance };
    });
}

function currentRound(cts) {
  cts.rounds ??= [];
  if (!cts.rounds.length) cts.rounds.push({ roundNumber: 1, actions: [] });
  const round = cts.rounds[cts.rounds.length - 1];
  round.actions ??= [];
  round.roundNumber ??= cts.rounds.length;
  cts.currentRound = round.roundNumber;
  return round;
}

async function recordIntervene(actor, option, { freeCounter = false } = {}) {
  const cts = foundry.utils.deepClone(actor.system.combatTabState || {});
  const round = currentRound(cts);

  if (!freeCounter) {
    cts.roundCounterCount = (Number(cts.roundCounterCount) || 0) + 1;
  }

  round.actions.push({
    type: "defend",
    source: "intervene",
    kiCost: 0, // DBU 0.9.2: Deflect/Distant Deflect had no KP Cost after 0.9.1 fixes.
    dkpCost: 0,
    kiWager: 0,
    description: `Intervene: ${option}${freeCounter ? " (free Counter)" : ""}`,
    defendOption: "intervene",
    interveneOption: option,
    freeCounter: !!freeCounter
  });

  await actor.update({ "system.combatTabState": cts });
}

async function recordReflect(actor, attackName, cost) {
  const cts = foundry.utils.deepClone(actor.system.combatTabState || {});
  const round = currentRound(cts);
  round.actions.push({
    type: "attack",
    source: "reflect",
    kiCost: Number(cost || 0),
    dkpCost: 0,
    kiWager: 0,
    description: `Reflect: ${attackName || "Attack"}`,
    outOfSequence: true,
    dbuReflect: true
  });
  await actor.update({ "system.combatTabState": cts });
}

async function critExtra(actor) {
  const sheet = actor?.sheet;
  if (!sheet || typeof sheet._critExtraFormula !== "function") return null;
  const tier = Number(actor.system.tier || 1);
  let formula = null;
  try { formula = sheet._critExtraFormula(tier); }
  catch {
    try { formula = sheet._critExtraFormula(); }
    catch { formula = null; }
  }
  if (!formula) return null;
  const roll = new Roll(formula);
  await roll.evaluate();
  return roll;
}

async function rollWithCrit(actor, formula, {
  ct = 10,
  botchThreshold = 1,
  label = "Roll"
} = {}) {
  const roll = new Roll(String(formula || "1d10"));
  await roll.evaluate();

  const natural = Number(roll.dice?.[0]?.results?.[0]?.result || 0);
  const critical = natural >= Number(ct || 10);
  const botch = Number(botchThreshold || 0) > 0 && natural <= Number(botchThreshold || 1);
  const extra = critical ? await critExtra(actor) : null;
  const baseTier = Number(actor.system.baseTier || actor.system.tier || 1);

  const total = Number(roll.total || 0)
    + Number(extra?.total || 0)
    - (botch ? 2 * baseTier : 0);

  return {
    label,
    formula: String(formula || "1d10"),
    roll,
    natural,
    ct: Number(ct || 10),
    botchThreshold: Number(botchThreshold || 0),
    critical,
    botch,
    critTotal: Number(extra?.total || 0),
    total
  };
}

async function rollMightClash(intervener, attacker, attack) {
  const tier = Number(intervener.system.tier || 1);
  const penaltyRanks = Math.max(0, Number(attack?.energyCharges || 0))
    + Math.max(0, Number(attack?.powerShot || 0));
  const penalty = penaltyRanks * tier;

  const intMight = Number(
    intervener.system.status?.mightForClashes
    ?? intervener.system.status?.might
    ?? 0
  );
  const attMight = Number(
    attacker.system.status?.mightForClashes
    ?? attacker.system.status?.might
    ?? 0
  );

  const intFormula = penalty > 0
    ? `1d10+${intMight}-${penalty}`
    : `1d10+${intMight}`;
  const attFormula = `1d10+${attMight}`;

  const intRoll = await rollWithCrit(intervener, intFormula, { ct: 10, label: "Intervene Might" });
  const attRoll = await rollWithCrit(attacker, attFormula, { ct: 10, label: "Attacker Might" });

  // Defender wins ties. In this Clash the attacking Opponent is defending
  // against the Intervene attempt, so the intervener needs a strict win.
  const success = intRoll.total > attRoll.total;

  return { success, intervener: intRoll, attacker: attRoll, penaltyRanks, penalty };
}

async function postInterveneClashCard(intervener, attacker, attack, option, clash) {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: intervener }),
    content: `
      <div class="dbu-attack-roll dbu-defend-card dbu-intervene-card">
        <h3 class="dbu-attack-title">
          <span class="dbu-card-title-text"><i class="fas fa-people-arrows"></i> ${esc(option)} — ${esc(intervener.name)}</span>
        </h3>
        <div class="dbu-card-body">
          <div class="dbu-attack-meta">
            <span class="dbu-meta-chip">vs ${esc(attacker.name)}</span>
            <span class="dbu-meta-chip">${esc(attack.attackName || "Attack")}</span>
            ${clash.penalty ? `<span class="dbu-meta-chip">Penalty −${clash.penalty} (${clash.penaltyRanks}×1(T))</span>` : ""}
          </div>
          <div class="dbu-roll-row">
            <span class="dbu-roll-label">${esc(intervener.name)}</span>
            <span class="dbu-roll-main"><code class="dbu-roll-formula">${esc(clash.intervener.formula)}</code><span class="dbu-roll-sub">Nat ${clash.intervener.natural}</span></span>
            <span class="dbu-roll-total">${clash.intervener.total}</span>
          </div>
          <div class="dbu-roll-row">
            <span class="dbu-roll-label">${esc(attacker.name)}</span>
            <span class="dbu-roll-main"><code class="dbu-roll-formula">${esc(clash.attacker.formula)}</code><span class="dbu-roll-sub">Nat ${clash.attacker.natural}</span></span>
            <span class="dbu-roll-total">${clash.attacker.total}</span>
          </div>
          <div class="dbu-attack-buffs"><strong>${clash.success ? "✅ DEFLECT BEM-SUCEDIDO" : "❌ DEFLECT FALHOU"}</strong></div>
        </div>
      </div>
    `
  });
}

function interventionStatusText(state) {
  const st = state?.intervention || {};
  switch (st.status) {
    case "declined": return "Sem Intervene confirmado — aguardando os demais impactos.";
    case "wall": return `Defense Wall por ${st.intervenerName || "aliado"} — aguardando os demais impactos.`;
    case "deflectFailed": return `Deflect de ${st.intervenerName || "aliado"} falhou — aguardando os demais impactos.`;
    case "distantDeflectFailed": return `Distant Deflect de ${st.intervenerName || "aliado"} falhou — aguardando os demais impactos.`;
    case "deflected": return `Ataque desviado por ${st.intervenerName || "aliado"}.`;
    default: return "Aguardando Intervene.";
  }
}

function unresolvedDamageStates(states) {
  return Object.entries(states).filter(([, state]) => state?.damagePending && !state?.damageResolved);
}

function isInterventionChoiceLocked(state) {
  return state?.intervention?.status && state.intervention.status !== "pending";
}

async function requestGM(payload) {
  if (game.user.isGM && isPrimaryGM()) {
    return handleGMRequest({ ...payload, userId: game.user.id });
  }
  game.socket.emit(DBU_SOCKET, { ...payload, userId: game.user.id });
  return true;
}

async function chooseIntervene(message, targetActor) {
  const candidates = eligibleInterveners(message, targetActor);
  if (!candidates.length) {
    ui.notifications.warn(
      "Nenhum personagem seu elegível para Intervene. O interventor não pode ser alvo do mesmo ataque e não pode estar em Long Range."
    );
    return null;
  }

  const options = candidates.map(({ actor, distance }) => {
    const d = Number.isFinite(distance) ? ` · ${distance.toFixed(1)} sq` : "";
    return `<option value="${actor.id}">${esc(actor.name)}${d}</option>`;
  }).join("");

  return Dialog.wait({
    title: `${targetActor.name} — Intervene`,
    content: `
      <div class="dbu-auto-window"><div class="dbu-card-body">
        <p><b>Escolha quem vai intervir e a opção.</b></p>
        <p style="font-size:.85em;opacity:.85;">DBU 0.9.2: Deflect e Distant Deflect não possuem KP Cost. A manobra usa 1 Counter Action, salvo efeito que a torne gratuita.</p>
        <div class="form-group"><label>Interventor</label><select id="dbu-int-actor" style="width:100%">${options}</select></div>
        <div class="form-group"><label>Opção</label>
          <select id="dbu-int-option" style="width:100%">
            <option value="wall">Defense Wall [0 KP]</option>
            <option value="deflect">Deflect [0 KP — 0.9.2]</option>
            <option value="distant">Distant Deflect [0 KP — 0.9.2]</option>
          </select>
        </div>
        <label style="display:flex;gap:6px;align-items:center;margin-top:8px;"><input id="dbu-int-free-counter" type="checkbox"> Não gastar Counter Action (Trait/Talent/efeito)</label>
        <p style="font-size:.8em;opacity:.75;margin-top:8px;">Defense Wall/Deflect exigem o movimento descrito pela manobra. O módulo valida Long Range, mas o posicionamento do token deve ser conferido no mapa.</p>
      </div></div>
    `,
    buttons: {
      ok: {
        label: "Intervir",
        callback: html => ({
          actorId: String(html.find("#dbu-int-actor").val() || ""),
          option: String(html.find("#dbu-int-option").val() || "wall"),
          freeCounter: !!html.find("#dbu-int-free-counter").prop("checked")
        })
      },
      cancel: { label: "Cancelar", callback: () => null }
    },
    default: "ok",
    close: () => null
  });
}

async function startIntervene(message, targetId) {
  const attack = attackData(message);
  const target = game.actors.get(targetId);
  const states = defenseStates(message);
  const state = states[targetId];

  if (!attack || !target || !state?.damagePending || state?.damageResolved) {
    return ui.notifications.warn("Esse impacto não está mais aguardando Intervene.");
  }
  if (isInterventionChoiceLocked(state)) {
    return ui.notifications.warn("A decisão de Intervene para este alvo já foi registrada.");
  }

  const choice = await chooseIntervene(message, target);
  if (!choice) return;

  const intervener = game.actors.get(choice.actorId);
  if (!intervener) return ui.notifications.error("Interventor não encontrado.");

  // Revalida no momento da confirmação.
  const valid = eligibleInterveners(message, target).some(entry => entry.actor.id === intervener.id);
  if (!valid && !game.user.isGM) {
    return ui.notifications.warn("Esse personagem deixou de ser elegível para Intervene.");
  }

  const reactionType = choice.option === "wall" ? "defenseWall" : (choice.option === "distant" ? "distantDeflect" : "deflect");
  await runCombatVisual(intervener, reactionType, "start", {
    message, attack, target, targetToken: getTokenForActor(target.id),
    attacker: game.actors.get(attack.attackerId), attackerToken: getTokenForActor(attack.attackerId)
  });

  await recordIntervene(intervener, choice.option, { freeCounter: choice.freeCounter });

  let clash = null;
  if (choice.option === "deflect" || choice.option === "distant") {
    const attacker = game.actors.get(attack.attackerId);
    if (!attacker) return ui.notifications.error("Atacante não encontrado para o Might Clash.");
    clash = await rollMightClash(intervener, attacker, attack);
    await postInterveneClashCard(
      intervener,
      attacker,
      attack,
      choice.option === "deflect" ? "Deflect" : "Distant Deflect",
      clash
    );
    await runCombatVisual(intervener, reactionType, clash.success ? "success" : "fail", {
      message, attack, target, clash, attacker, attackerToken: getTokenForActor(attacker.id),
      targetToken: getTokenForActor(target.id), success: !!clash.success
    });
  } else {
    await runCombatVisual(intervener, reactionType, "impact", {
      message, attack, target, targetToken: getTokenForActor(target.id), success: true
    });
  }

  await requestGM({
    type: "dbuInterveneResolveV14",
    messageId: message.id,
    targetId,
    intervenerId: intervener.id,
    option: choice.option,
    freeCounter: choice.freeCounter,
    clash: clash ? {
      success: !!clash.success,
      intervenerTotal: clash.intervener.total,
      attackerTotal: clash.attacker.total,
      penaltyRanks: clash.penaltyRanks,
      penalty: clash.penalty
    } : null
  });

  if (clash?.success && canReflect(attack)) {
    await sleep(150);
    const useReflect = await Dialog.confirm({
      title: `${intervener.name} — Reflect`,
      content: `<div class="dbu-auto-window"><p>O ${choice.option === "deflect" ? "Deflect" : "Distant Deflect"} foi bem-sucedido.</p><p>Deseja usar <b>Reflect</b> contra este ataque?</p><p>Reflect custa <b>5(T)</b> KP, salvo efeito que reduza ou remova o custo.</p></div>`,
      yes: () => true,
      no: () => false,
      defaultYes: false
    });
    if (useReflect) await startReflect(message, intervener.id);
  }
}

async function declineIntervene(message, targetId) {
  const target = game.actors.get(targetId);
  const state = defenseStates(message)[targetId];
  if (!target || !state?.damagePending || state?.damageResolved) return;
  if (!game.user.isGM && !target.isOwner) {
    return ui.notifications.warn("Somente o alvo (ou GM) pode encerrar a janela de Intervene.");
  }
  if (isInterventionChoiceLocked(state)) return;

  await requestGM({
    type: "dbuInterveneResolveV14",
    messageId: message.id,
    targetId,
    option: "decline",
    intervenerId: null
  });
}

function normalizeDamageCategory(value) {
  const v = String(value || "standard").toLowerCase();
  if (v.includes("lethal")) return "lethal";
  if (v.includes("direct")) return "direct";
  return "standard";
}

function upgradeDamageCategory(value) {
  const c = normalizeDamageCategory(value);
  if (c === "standard") return "direct";
  if (c === "direct") return "lethal";
  return "lethal";
}

function effectiveCategoryForActor(actor, category) {
  let c = normalizeDamageCategory(category);
  if (actor.system.aspectEffects?.armoredActive) {
    if (c === "lethal") c = "direct";
    else if (c === "direct") c = "standard";
  }
  const prone = (actor.system.conditions || []).some(cond => cond?.id === "prone" && cond?.active);
  if (prone) {
    if (c === "standard") c = "direct";
    else if (c === "direct") c = "lethal";
  }
  return c;
}

function wallExtraEffectiveSoak(actor, category) {
  const soak = Math.max(0, Number(actor.system.status?.soak || 0));
  const increase = Math.ceil(soak / 2);
  const boosted = soak + increase;
  const effectiveCategory = effectiveCategoryForActor(actor, category);

  const effective = (value) => {
    if (effectiveCategory === "lethal") return 0;
    if (effectiveCategory === "direct") return Math.floor(value / 2);
    return value;
  };

  return Math.max(0, effective(boosted) - effective(soak));
}

async function applyPreparedDamage(actor, attack, {
  defense = "none",
  categoryOverride = null,
  extraDamageReduction = 0
} = {}) {
  const sheet = actor?.sheet;
  if (!actor || !sheet || typeof sheet._onApplyDamage !== "function") {
    throw new Error(`Não foi possível aplicar dano em ${actor?.name || "Actor"}.`);
  }

  const previousExtraDR = Number(actor.system.damageCalc?.damageReduction || 0);
  const category = normalizeDamageCategory(categoryOverride || attack.damageCategory || attack.damageCat || "standard");
  const beforeLP = Number(actor.system.lifePoints?.value || 0);
  const terrainShield = prepareTerrainShield(actor, Math.max(0, Number(attack.woundTotal || 0)));
  const woundForDamage = terrainShield
    ? terrainShield.reducedWound
    : Math.max(0, Number(attack.woundTotal || 0));

  await actor.update({
    "system.damageCalc.source": "wound",
    "system.damageCalc.woundRoll": woundForDamage,
    "system.damageCalc.category": category,
    "system.damageCalc.defense": defense,
    "system.damageCalc.incomingEC": Math.max(0, Number(attack.energyCharges || 0)),
    "system.damageCalc.guardPaidViaCard": defense === "guard",
    "system.damageCalc.isRanged": String(attack.foundation || "").toLowerCase() !== "physical",
    "system.damageCalc.damageReduction": previousExtraDR + Math.max(0, Number(extraDamageReduction || 0))
  });

  const predicted = Math.max(0, Number(actor.system.damageCalc?.healthReduction || 0));

  try {
    await sheet._onApplyDamage({ preventDefault() {}, stopPropagation() {} });
  } finally {
    // Extra DR da Defense Wall vale somente para este Attacking Maneuver.
    try {
      await actor.update({ "system.damageCalc.damageReduction": previousExtraDR });
    } catch {}
  }

  const afterLP = Number(actor.system.lifePoints?.value || 0);
  const actual = Math.max(0, beforeLP - afterLP);
  if (terrainShield) await resolveTerrainShield(actor, terrainShield, actual);
  return { beforeLP, afterLP, predicted, actual };
}

async function applyDefenseWall(intervener, protectedActor, attack) {
  const category = normalizeDamageCategory(attack.damageCategory || attack.damageCat || "standard");
  const extraSoak = wallExtraEffectiveSoak(intervener, category);
  const result = await applyPreparedDamage(intervener, attack, {
    defense: "none",
    extraDamageReduction: extraSoak
  });

  let spill = 0;
  if (result.afterLP <= 0 && result.predicted > result.beforeLP) {
    spill = Math.max(0, result.predicted - result.beforeLP);
  }

  if (spill > 0 && protectedActor) {
    const spillAttack = foundry.utils.deepClone(attack);
    spillAttack.woundTotal = spill;
    spillAttack.baseWoundTotal = spill;
    await applyPreparedDamage(protectedActor, spillAttack, { defense: "none" });
  }

  return { ...result, spill, extraSoak };
}

async function finalizePendingDamageIfReady(message) {
  if (!game.user.isGM || !isPrimaryGM()) return;

  const attack = foundry.utils.deepClone(attackData(message) || {});
  const states = defenseStates(message);
  const unresolved = unresolvedDamageStates(states);
  if (!unresolved.length) return;

  // Um Deflect em qualquer co-target pode desviar o ataque de todos. Por isso
  // nenhum dano é aplicado enquanto houver uma janela de Intervene sem decisão.
  if (unresolved.some(([, state]) => !state?.intervention || state.intervention.status === "pending")) {
    return;
  }

  for (const [targetId, state] of unresolved) {
    const target = game.actors.get(targetId);
    const outcome = state.hiddenOutcome;
    const resolution = state.intervention || { status: "declined" };

    if (!target || !outcome?.damageDefense) {
      states[targetId] = { ...state, damagePending: false, damageResolved: true };
      continue;
    }

    try {
      if (resolution.status === "wall") {
        const intervener = game.actors.get(resolution.intervenerId);
        if (intervener) {
          const wall = await applyDefenseWall(intervener, target, attack);
          state.text = `🛡 Defense Wall — ${intervener.name} protege ${target.name}${wall.spill ? ` · excesso ${wall.spill} passou ao aliado` : ""}`;
        } else {
          await globalThis.DBU.applyDamage(target, attack, outcome.damageDefense);
        }
      } else if (resolution.status === "deflectFailed") {
        const intervener = game.actors.get(resolution.intervenerId);
        if (intervener) {
          const upgraded = upgradeDamageCategory(attack.damageCategory || attack.damageCat);
          await applyPreparedDamage(intervener, attack, { defense: "none", categoryOverride: upgraded });
          state.text = `❌ Deflect falhou — ${intervener.name} recebeu o ataque em ${upgraded.toUpperCase()}`;
        } else {
          await globalThis.DBU.applyDamage(target, attack, outcome.damageDefense);
        }
      } else {
        // Sem Intervene ou Distant Deflect falho: a defesa escolhida pelo alvo
        // continua valendo normalmente (Guard/Direct Hit/etc.).
        await globalThis.DBU.applyDamage(target, attack, outcome.damageDefense);
        if (resolution.status === "distantDeflectFailed") {
          state.text = `❌ Distant Deflect falhou — ${state.text || target.name}`;
        }
      }
    } catch (error) {
      console.error(`DBU | Intervene final damage ${target.name}:`, error);
      ui.notifications.error(`Erro aplicando dano após Intervene em ${target.name}.`);
    }

    states[targetId] = {
      ...state,
      damagePending: false,
      damageResolved: true,
      damageResolvedAt: Date.now(),
      intervention: { ...resolution, finalized: true }
    };

    await message.update({ "flags.world.dbuDefenseStates": states });
  }

  await message.update({
    "flags.world.dbuDefenseStates": states,
    "flags.world.dbuIntervenePhaseComplete": true
  });

  ui.notifications.info(`${attack.attackName || "Ataque"}: fase de Intervene concluída.`);
}

async function handleGMRequest(data) {
  if (!game.user.isGM || !isPrimaryGM()) return;

  if (data.type === "dbuInterveneResolveV14") {
    const message = game.messages.get(data.messageId);
    const target = game.actors.get(data.targetId);
    if (!message || !target) return;

    const attack = attackData(message);
    const states = defenseStates(message);
    const state = states[data.targetId];
    if (!attack || !state?.damagePending || state?.damageResolved) return;
    if (state.intervention?.status && state.intervention.status !== "pending") return;

    const requester = game.users.get(data.userId);
    if (!requester) return;

    if (data.option === "decline") {
      const allowed = requester.isGM || target.testUserPermission(requester, "OWNER");
      if (!allowed) return;
      states[data.targetId] = {
        ...state,
        intervention: {
          status: "declined",
          decidedBy: data.userId,
          decidedAt: Date.now()
        }
      };
      await message.update({ "flags.world.dbuDefenseStates": states });
      await finalizePendingDamageIfReady(message);
      return;
    }

    const intervener = game.actors.get(data.intervenerId);
    if (!intervener) return;
    const allowed = requester.isGM || intervener.testUserPermission(requester, "OWNER");
    if (!allowed) return;
    if ((attack.targetActorIds || []).includes(intervener.id)) return;
    if (intervener.id === target.id || intervener.id === attack.attackerId) return;

    const base = {
      intervenerId: intervener.id,
      intervenerName: intervener.name,
      option: data.option,
      decidedBy: data.userId,
      decidedAt: Date.now(),
      clash: data.clash || null
    };

    if ((data.option === "deflect" || data.option === "distant") && data.clash?.success) {
      // Deflect/Distant Deflect bem-sucedido remove o ataque de TODOS os alvos.
      for (const [actorId, st] of Object.entries(states)) {
        if (!st?.damagePending || st?.damageResolved) continue;
        states[actorId] = {
          ...st,
          damagePending: false,
          damageResolved: true,
          damageResolvedAt: Date.now(),
          text: `↪ Ataque desviado por ${intervener.name}`,
          intervention: {
            ...base,
            status: "deflected",
            success: true,
            finalized: true
          }
        };
      }

      await message.update({
        "flags.world.dbuDefenseStates": states,
        "flags.world.dbuAttackDeflected": true,
        "flags.world.dbuAttackDeflectedBy": intervener.id,
        "flags.world.dbuIntervenePhaseComplete": true,
        "flags.world.dbuDeflectReflectOpportunity": canReflect(attack)
          ? { reflectorId: intervener.id, createdAt: Date.now(), source: data.option }
          : null
      });

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: intervener }),
        content: `<div class="dbu-attack-roll dbu-defend-card dbu-intervene-card"><h3 class="dbu-attack-title"><span class="dbu-card-title-text">↪ ${esc(intervener.name)} — ${data.option === "deflect" ? "Deflect" : "Distant Deflect"}</span></h3><div class="dbu-card-body"><div class="dbu-attack-buffs"><strong>✅ ${esc(attack.attackName || "Ataque")} foi desviado de TODOS os alvos.</strong></div></div></div>`
      });
      return;
    }

    let status = "wall";
    if (data.option === "deflect") status = "deflectFailed";
    if (data.option === "distant") status = "distantDeflectFailed";

    states[data.targetId] = {
      ...state,
      intervention: {
        ...base,
        status,
        success: data.option === "wall" ? true : false
      }
    };

    await message.update({ "flags.world.dbuDefenseStates": states });
    await finalizePendingDamageIfReady(message);
    return;
  }

  if (data.type === "dbuReflectUsedV14") {
    const message = game.messages.get(data.messageId);
    const reflector = game.actors.get(data.reflectorId);
    const requester = game.users.get(data.userId);
    if (!message || !reflector || !requester) return;
    if (!requester.isGM && !reflector.testUserPermission(requester, "OWNER")) return;

    const uses = foundry.utils.deepClone(message.getFlag("world", "dbuReflectUses") || {});
    uses[reflector.id] = {
      used: true,
      targetId: data.targetId || null,
      usedAt: Date.now(),
      source: data.source || "reflect"
    };
    await message.update({ "flags.world.dbuReflectUses": uses });
  }
}

function availableReflectTargets(reflector, attack) {
  const tokens = canvas?.tokens?.placeables || [];
  const entries = [];
  const seen = new Set();

  for (const token of tokens) {
    const actor = token.actor;
    if (!actor || actor.id === reflector.id || seen.has(actor.id)) continue;
    seen.add(actor.id);
    entries.push({ actor, token });
  }

  entries.sort((a, b) => {
    if (a.actor.id === attack.attackerId) return -1;
    if (b.actor.id === attack.attackerId) return 1;
    return a.actor.name.localeCompare(b.actor.name);
  });
  return entries;
}

async function reflectStrikeFormula(reflector, attack) {
  const sheet = reflector.sheet;
  if (!sheet) throw new Error("Ficha do personagem não encontrada.");
  await sheet.getData();

  const tier = Number(reflector.system.tier || 1);
  let formula = sheet._trackerDefend?.strikeFormula || "1d10";

  if (typeof sheet._calcTechStrike === "function") {
    try {
      const synthetic = {
        name: `Reflect — ${attack.attackName || "Attack"}`,
        foundation: attack.foundation || "Energy",
        profile: attack.profile || "Sphere",
        advantages: [],
        disadvantages: [],
        isWeapon: false
      };
      formula = sheet._calcTechStrike(synthetic, reflector.system, tier)?.formula || formula;
    } catch (error) {
      console.warn("DBU | Reflect synthetic Strike fallback:", error);
    }
  }

  const reflectBonus = Number(reflector.system.aptitudes?.reflectStrikeBonus || 0);
  if (reflectBonus) formula = `(${formula})+${reflectBonus}`;

  let ct = 10;
  try {
    if (typeof sheet._calcCombatCTs === "function") {
      ct = Number(sheet._calcCombatCTs(reflector.system, { foundation: attack.foundation })?.strikeCT || 10);
    }
  } catch {}

  return { formula, ct };
}

function urgentWoundFormulaFromAttack(attack) {
  if (attack?.urgentWoundFormula) return String(attack.urgentWoundFormula);

  let formula = "";
  const original = attack?.originalAttackMessageId
    ? game.messages.get(attack.originalAttackMessageId)
    : null;
  const reveal = original?.getFlag(DBU_SYSTEM_ID, "attackReveal") || null;

  try {
    const rollData = reveal?.woundRollData;
    if (rollData) formula = String(Roll.fromData(rollData).formula || rollData.formula || "");
  } catch {
    formula = String(reveal?.woundRollData?.formula || "");
  }

  if (!formula) {
    // Fallback para cartas criadas diretamente pelo Reflect.
    formula = String(attack?.woundBaseFormula || attack?.woundFormula || "1d10");
  }

  if (attack?.manualWoundTranslated) {
    formula = `(${formula})+(${attack.manualWoundTranslated})`;
  }

  const united = Number(attack?.unitedAttackBonus || 0);
  if (united) formula = `(${formula})+${united}`;

  return formula;
}

function reflectTargetRow(target) {
  const safeId = String(target.id).replace(/[^a-zA-Z0-9_-]/g, "");
  return `
    <div class="dbu-area-target" data-target-row="${safeId}" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.18);">
      <div class="dbu-attack-meta"><span class="dbu-meta-chip"><i class="fas fa-crosshairs"></i> ${esc(target.name)}</span></div>
      <div class="dbu-attack-actions" style="display:flex;flex-wrap:wrap;gap:4px;">
        <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="dodge" data-defender-id="${target.id}"><i class="fas fa-running"></i> Dodge</button>
        <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="parry" data-defender-id="${target.id}"><i class="fas fa-shield-alt"></i> Parry</button>
        <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="directHit" data-defender-id="${target.id}"><i class="fas fa-bullseye"></i> Direct Hit</button>
        <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="powerFlare" data-defender-id="${target.id}"><i class="fas fa-fire"></i> Power Flare</button>
        <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="crossCounter" data-defender-id="${target.id}"><i class="fas fa-fist-raised"></i> Cross Counter</button>
        <button type="button" class="dbu-pay-btn" data-dbu-defense-v5="guard" data-defender-id="${target.id}"><i class="fas fa-shield-alt"></i> Guard</button>
      </div>
    </div>
  `;
}

async function createReflectAttackCard({ sourceMessage, reflector, target, attack, strike, wound, urgentFormula, reflectCost }) {
  const woundSourceId = attack.woundSourceActorId || attack.originalWoundSourceActorId || attack.attackerId;
  const reflectAttack = {
    version: `Reflect-${VERSION}`,
    attackerId: reflector.id,
    attackerTokenId: getTokenForActor(reflector.id)?.id || null,
    attackerName: reflector.name,
    woundSourceActorId: woundSourceId,
    originalWoundSourceActorId: woundSourceId,
    attackName: `Reflect — ${attack.attackName || "Attack"}`,
    sourceKey: `reflect:${sourceMessage.id}:${reflector.id}:${Date.now()}`,
    sourceGroup: "Reflect",
    strikeTotal: strike.total,
    baseWoundTotal: wound.total,
    woundTotal: wound.total,
    unitedAttackBonus: 0,
    unitedAttackContributions: [],
    unitedAttackLocked: true,
    originalAttackMessageId: null,
    strikeNatural: strike.natural,
    woundNatural: wound.natural,
    foundation: attack.foundation || "Energy",
    profile: attack.profile || "",
    damageCategory: attack.damageCategory || attack.damageCat || "Standard",
    damageCat: attack.damageCategory || attack.damageCat || "Standard",
    energyCharges: Number(attack.energyCharges || 0),
    powerShot: Number(attack.powerShot || 0),
    kiCost: reflectCost,
    wager: Number(attack.wager || 0),
    strikeDisplayFormula: strike.formula,
    woundDisplayFormula: `Urgent: ${urgentFormula}`,
    urgentWoundFormula: urgentFormula,
    strikeCT: strike.ct,
    woundCT: wound.ct,
    strikeBotchThreshold: strike.botchThreshold,
    woundBotchThreshold: wound.botchThreshold,
    strikeCritical: strike.critical,
    woundCritical: wound.critical,
    strikeBotch: strike.botch,
    woundBotch: wound.botch,
    secretCombat: true,
    isReflect: true,
    reflectedFromMessageId: sourceMessage.id,
    hasAoE: false,
    isAreaAttack: false,
    reflectBlocked: false,
    targetActorIds: [target.id]
  };

  const states = {
    [target.id]: { resolved: false, pending: false }
  };

  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: reflector }),
    flags: {
      world: {
        dbuAttackData: reflectAttack,
        dbuDefenseStates: states,
        dbuUnitedAttackLocked: true,
        dbuUnitedAttackContributions: [],
        dbuCombatSecretMode: true,
        dbuCombatRevealed: false,
        dbuCombatRevealInProgress: false,
        dbuReflectCard: true
      }
    },
    content: `
      <div class="dbu-attack-roll dbu-defend-card" data-actor-id="${reflector.id}">
        <h3 class="dbu-attack-title">
          <span class="dbu-card-title-text"><i class="fas fa-reply"></i> ${esc(reflector.name)} — REFLECT</span>
          <span class="dbu-action-count">OOS</span>
        </h3>
        <div class="dbu-card-body">
          <div class="dbu-attack-meta">
            <span class="dbu-meta-chip">${esc(attack.foundation || "")} / ${esc(attack.profile || "")}</span>
            <span class="dbu-meta-chip">Wound por ${esc(game.actors.get(woundSourceId)?.name || attack.attackerName || "atacante original")}</span>
            <span class="dbu-meta-chip">Reflect ${reflectCost} KP</span>
          </div>
          <div data-dbu-secret-attack-results>
            <div class="dbu-roll-row"><span class="dbu-roll-label">Strike</span><span class="dbu-roll-main"><code class="dbu-roll-formula">🔒 Resultado oculto</code><span class="dbu-roll-sub">Reflect usa o Profile do ataque inicial.</span></span><span class="dbu-roll-total">?</span></div>
            <div class="dbu-roll-row"><span class="dbu-roll-label">Wound</span><span class="dbu-roll-main"><code class="dbu-roll-formula">🔒 Urgent Wound</code><span class="dbu-roll-sub">Rolado pelo atacante que gerou a energia original.</span></span><span class="dbu-roll-total" data-dbu-wound-total>?</span></div>
          </div>
          <div class="dbu-attack-buffs" data-dbu-secret-wait-status><strong>🔒 Aguardando ${esc(target.name)} escolher a defesa.</strong></div>
          ${reflectTargetRow(target)}
        </div>
      </div>
    `
  });
}

async function getReflectUsage(actor, sourceMessageId) {
  const map = actor.getFlag(MODULE_ID, "reflectUsage") || {};
  return map[sourceMessageId] || null;
}

async function setReflectUsage(actor, sourceMessageId, data) {
  const map = foundry.utils.deepClone(actor.getFlag(MODULE_ID, "reflectUsage") || {});
  map[sourceMessageId] = data;
  await actor.setFlag(MODULE_ID, "reflectUsage", map);
}

async function startReflect(message, reflectorId) {
  const attack = attackData(message);
  const reflector = game.actors.get(reflectorId);
  if (!attack || !reflector) return;

  if (!canReflect(attack)) {
    return ui.notifications.warn(
      attack?.reflectBlockedReason
        ? `Reflect não pode ser usado: ${attack.reflectBlockedReason}.`
        : "Reflect só pode ser usado contra ataques Energy/Magic sem AoE."
    );
  }
  if (!game.user.isGM && !reflector.isOwner) {
    return ui.notifications.warn("Você não controla o personagem que vai usar Reflect.");
  }

  const prior = await getReflectUsage(reflector, message.id);
  if (prior?.used) return ui.notifications.warn(`${reflector.name} já usou Reflect neste ataque.`);

  const targets = availableReflectTargets(reflector, attack);
  if (!targets.length) return ui.notifications.warn("Nenhum alvo disponível no mapa para Reflect.");

  const tier = Number(reflector.system.tier || 1);
  const normalCost = 5 * tier;
  const options = targets.map(({ actor }) =>
    `<option value="${actor.id}" ${actor.id === attack.attackerId ? "selected" : ""}>${esc(actor.name)}${actor.id === attack.attackerId ? " (atacante original)" : ""}</option>`
  ).join("");

  const choice = await Dialog.wait({
    title: `${reflector.name} — Reflect`,
    content: `
      <div class="dbu-auto-window"><div class="dbu-card-body">
        <p><b>Reflect</b> — Out-of-Sequence Maneuver</p>
        <div class="form-group"><label>Alvo</label><select id="dbu-reflect-target" style="width:100%">${options}</select></div>
        <p>Custo normal: <b>5(T) = ${normalCost} KP / Capacity</b></p>
        <label style="display:flex;gap:6px;align-items:center"><input id="dbu-reflect-free" type="checkbox"> Reflect gratuito (ex.: Reflective Coating)</label>
        <label style="display:flex;gap:6px;align-items:center;margin-top:5px"><input id="dbu-reflect-half" type="checkbox"> Metade do custo por Trait/efeito</label>
      </div></div>
    `,
    buttons: {
      ok: {
        label: "REFLECT",
        callback: html => ({
          targetId: String(html.find("#dbu-reflect-target").val() || ""),
          free: !!html.find("#dbu-reflect-free").prop("checked"),
          half: !!html.find("#dbu-reflect-half").prop("checked")
        })
      },
      cancel: { label: "Cancelar", callback: () => null }
    },
    default: "ok",
    close: () => null
  });
  if (!choice) return;

  const target = game.actors.get(choice.targetId);
  if (!target) return ui.notifications.error("Alvo do Reflect não encontrado.");

  const cost = choice.free ? 0 : (choice.half ? Math.ceil(normalCost / 2) : normalCost);
  await runCombatVisual(reflector, "reflect", "start", {
    message, attack, target, targetToken: getTokenForActor(target.id), reflectCost: cost
  });
  if (cost > 0) {
    const payHelper = globalThis.DBU?.payKiAndCapacity;
    if (typeof payHelper !== "function") {
      return ui.notifications.error("DBU Reflect: helper de pagamento Ki/Capacity não está disponível. Reinicie o Foundry e rode o Diagnóstico.");
    }
    const payment = await payHelper(reflector, cost, "Reflect");
    if (!payment?.ok) return;
  }

  const strikeInfo = await reflectStrikeFormula(reflector, attack);
  const strike = await rollWithCrit(reflector, strikeInfo.formula, {
    ct: strikeInfo.ct,
    botchThreshold: 1,
    label: "Reflect Strike"
  });

  const woundSource = game.actors.get(
    attack.woundSourceActorId || attack.originalWoundSourceActorId || attack.attackerId
  );
  if (!woundSource) return ui.notifications.error("Atacante original não encontrado para o Urgent Wound.");

  const urgentFormula = urgentWoundFormulaFromAttack(attack);
  const wound = await rollWithCrit(woundSource, urgentFormula, {
    ct: Number(attack.woundCT || 10),
    botchThreshold: Number(attack.woundBotchThreshold ?? 1),
    label: "Urgent Wound"
  });

  await recordReflect(reflector, attack.attackName, cost);
  await setReflectUsage(reflector, message.id, {
    used: true,
    usedAt: Date.now(),
    targetId: target.id,
    cost
  });

  await createReflectAttackCard({
    sourceMessage: message,
    reflector,
    target,
    attack,
    strike,
    wound,
    urgentFormula,
    reflectCost: cost
  });

  await runCombatVisual(reflector, "reflect", "launch", {
    message, attack, target, targetToken: getTokenForActor(target.id),
    strike, wound, urgentFormula, reflectCost: cost, success: true
  });

  await requestGM({
    type: "dbuReflectUsedV14",
    messageId: message.id,
    reflectorId: reflector.id,
    targetId: target.id,
    source: "reflect"
  });

  ui.notifications.info(`${reflector.name} refletiu ${attack.attackName || "o ataque"} contra ${target.name}.`);
}

function renderIntervene(message, html) {
  const attack = attackData(message);
  if (!attack || !message.getFlag("world", "dbuCombatRevealed")) return;

  const states = message.getFlag("world", "dbuDefenseStates") || {};
  const reflectUses = message.getFlag("world", "dbuReflectUses") || {};
  const root = html instanceof HTMLElement ? html : (html?.[0] || html);
  if (!root?.querySelector) return;

  let pendingCount = 0;

  for (const [targetId, state] of Object.entries(states)) {
    const target = game.actors.get(targetId);
    if (!target) continue;
    const safeId = String(targetId).replace(/[^a-zA-Z0-9_-]/g, "");
    const row = root.querySelector(`[data-target-row="${safeId}"]`);
    if (!row) continue;

    row.querySelectorAll(".dbu-intervene-v14-panel").forEach(el => el.remove());

    const panel = document.createElement("div");
    panel.className = "dbu-intervene-v14-panel";
    panel.style.marginTop = "7px";

    if (state?.damagePending && !state?.damageResolved) {
      pendingCount++;
      const status = state?.intervention?.status || "pending";

      if (status === "pending") {
        const candidates = eligibleInterveners(message, target);
        const canDecline = game.user.isGM || target.isOwner;
        const actions = [];

        if (candidates.length) {
          actions.push(`<button type="button" class="dbu-pay-btn" data-dbu-intervene-v14="1" data-message-id="${message.id}" data-target-id="${targetId}"><i class="fas fa-people-arrows"></i> Intervene</button>`);
        }
        if (canDecline) {
          actions.push(`<button type="button" class="dbu-pay-btn" data-dbu-no-intervene-v14="1" data-message-id="${message.id}" data-target-id="${targetId}"><i class="fas fa-forward"></i> Sem Intervene</button>`);
        }

        panel.innerHTML = `
          <div class="dbu-attack-buffs"><strong>⚠ HIT — dano pendente para Intervene</strong></div>
          ${actions.length ? `<div class="dbu-attack-actions" style="display:flex;flex-wrap:wrap;gap:4px">${actions.join("")}</div>` : ""}
        `;
      } else {
        panel.innerHTML = `<div class="dbu-attack-buffs"><strong>⏳ ${esc(interventionStatusText(state))}</strong></div>`;
      }
    }

    const parryReflect = state?.hiddenOutcome?.defenseType === "parry"
      && !!state.hiddenOutcome?.success
      && canReflect(attack)
      && !reflectUses?.[targetId]?.used;

    if (parryReflect && (game.user.isGM || target.isOwner)) {
      panel.innerHTML += `
        <div class="dbu-attack-actions" style="margin-top:5px">
          <button type="button" class="dbu-pay-btn" data-dbu-reflect-v14="1" data-message-id="${message.id}" data-reflector-id="${targetId}"><i class="fas fa-reply"></i> Reflect</button>
        </div>
        <div class="dbu-penalty-why">Parry bem-sucedido: ataque Energy/Magic sem AoE pode ser refletido.</div>
      `;
    }

    if (panel.innerHTML.trim()) row.appendChild(panel);
  }

  root.querySelectorAll(".dbu-deflect-reflect-v14-panel").forEach(el => el.remove());
  const deflectReflect = message.getFlag("world", "dbuDeflectReflectOpportunity") || null;
  if (deflectReflect?.reflectorId && !reflectUses?.[deflectReflect.reflectorId]?.used) {
    const reflector = game.actors.get(deflectReflect.reflectorId);
    if (reflector && (game.user.isGM || reflector.isOwner)) {
      const body = root.querySelector(".dbu-card-body") || root;
      const panel = document.createElement("div");
      panel.className = "dbu-deflect-reflect-v14-panel dbu-attack-actions";
      panel.style.marginTop = "8px";
      panel.innerHTML = `<button type="button" class="dbu-pay-btn" data-dbu-reflect-v14="1" data-message-id="${message.id}" data-reflector-id="${reflector.id}"><i class="fas fa-reply"></i> Reflect após Deflect</button>`;
      body.appendChild(panel);
    }
  }

  const statusNode = root.querySelector("[data-dbu-secret-wait-status]");
  if (statusNode && pendingCount > 0) {
    statusNode.innerHTML = `<strong>⚠ Resultados revelados — ${pendingCount} impacto(s) aguardando Intervene antes do dano.</strong>`;
  } else if (statusNode && message.getFlag("world", "dbuIntervenePhaseComplete")) {
    statusNode.innerHTML = `<strong>✅ Resultados revelados — fase de Intervene concluída.</strong>`;
  }
}

async function clickHandler(event) {
  const interveneButton = event.target.closest?.("[data-dbu-intervene-v14]");
  const declineButton = event.target.closest?.("[data-dbu-no-intervene-v14]");
  const reflectButton = event.target.closest?.("[data-dbu-reflect-v14]");
  const button = interveneButton || declineButton || reflectButton;
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const messageId = button.dataset.messageId
    || button.closest?.("[data-message-id]")?.dataset?.messageId;
  const message = messageId ? game.messages.get(messageId) : null;
  if (!message) return ui.notifications.error("Mensagem de ataque não encontrada.");

  button.disabled = true;
  try {
    if (interveneButton) {
      await startIntervene(message, button.dataset.targetId);
    } else if (declineButton) {
      await declineIntervene(message, button.dataset.targetId);
    } else if (reflectButton) {
      await startReflect(message, button.dataset.reflectorId);
    }
  } catch (error) {
    console.error("DBU | Intervene/Reflect click:", error);
    ui.notifications.error(error?.message || "Erro executando Intervene/Reflect.");
  } finally {
    // Se a carta não foi atualizada (cancelamento), libera novamente.
    if (button.isConnected) button.disabled = false;
  }
}

export function initializeInterveneAutomation() {
  const old = globalThis.DBU_INTERVENE_AUTOMATION;
  if (old?.clickHandler) {
    try { document.removeEventListener("click", old.clickHandler, true); } catch {}
  }
  if (old?.renderHookId) {
    try { Hooks.off("renderChatMessage", old.renderHookId); } catch {}
  }
  if (old?.socketHandler) {
    try { game.socket.off(DBU_SOCKET, old.socketHandler); } catch {}
  }

  const renderHookId = Hooks.on("renderChatMessage", (message, html) => {
    try { renderIntervene(message, html); }
    catch (error) { console.error("DBU | Intervene render:", error); }
  });

  const socketHandler = async data => {
    if (!data || !["dbuInterveneResolveV14", "dbuReflectUsedV14"].includes(data.type)) return;
    if (!isPrimaryGM()) return;
    try { await handleGMRequest(data); }
    catch (error) { console.error("DBU | Intervene socket:", error); }
  };

  game.socket.on(DBU_SOCKET, socketHandler);
  document.addEventListener("click", clickHandler, true);

  globalThis.DBU_INTERVENE_AUTOMATION = {
    version: VERSION,
    initialized: true,
    clickHandler,
    renderHookId,
    socketHandler
  };

  console.log(`DBU Automation v${VERSION} | Intervene + Reflect ativo`);
}

export { startIntervene, startReflect, eligibleInterveners, canReflect };
