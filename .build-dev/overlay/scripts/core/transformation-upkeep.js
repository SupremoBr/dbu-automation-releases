// DBU 0.9.2 — per-turn Transformation upkeep.
// Uses the native system's already-derived Draining calculation. A reduction
// in Ki is NOT a Maneuver Ki Point Cost, so it does not spend Capacity.
export function drainingForActor(actor) {
  const system = actor?.system || {};
  const active = (system.transformations || []).some(t => t?.active)
    || (system._gainedActiveTransformations || []).some(t => t?.active);
  if (!active) return 0;
  return Math.max(0, Math.trunc(Number(system.aspectEffects?.drainingKiPerTurn) || 0));
}

export function upkeepTurnKey(combat, combatant) {
  return `${combat?.id || ""}:${combat?.round ?? 0}:${combatant?.id || ""}`;
}

export async function applyTransformationTurnUpkeep(combat, combatant) {
  const actor = combatant?.actor;
  if (!actor || !combat?.id || !combatant?.id) return null;

  const key = upkeepTurnKey(combat, combatant);
  if (actor.getFlag?.("world", "dbuaDrainingTurn")?.key === key) return null;

  // Stress Exhaustion from a previous No Energy exit ends after the
  // character's following turn; its next round+2 start is a safe cleanup.
  const expires = actor.getFlag?.("world", "dbuaNoEnergyStressExpiry");
  if (expires?.combatId === combat.id && Number(combat.round) >= Number(expires.clearRound)) {
    const conditions = foundry.utils.deepClone(actor.system.conditions || []);
    const state = conditions.find(c => c?.id === "stressExhaustion");
    if (state) {
      state.active = false;
      state.stacks = 0;
    }
    await actor.update({
      "system.conditions": conditions,
      "flags.world.dbuaNoEnergyStressExpiry": null
    });
  }

  // Explicitly check that combatant still owns this actor, not its base.
  if (combatant.tokenId && actor.token?.id && actor.token.id !== combatant.tokenId) {
    console.error("DBU | Draining recusado: Combatant e Synthetic Actor divergentes.", {key});
    return null;
  }

  const cost = drainingForActor(actor);
  if (cost <= 0) return null;

  const before = Math.max(0, Number(actor.system.kiPool?.value) || 0);
  const after = Math.max(0, before - cost);
  const godKi = actor.system.godKi?.active === true;
  const beforeDKP = Math.max(0, Number(actor.system.divineKiPoints?.value) || 0);
  const dkCost = godKi ? Math.ceil(cost / 2) : 0;
  const afterDKP = Math.max(0, beforeDKP - dkCost);
  const update = {
    "system.kiPool.value": after,
    "flags.world.dbuaDrainingTurn": { key, cost, paid: before - after, combatantId: combatant.id }
  };
  if (godKi && dkCost > 0) update["system.divineKiPoints.value"] = afterDKP;
  await actor.update(update);

  const message = `${actor.name}: Draining no início do turno — ${before} → ${after} Ki (−${before - after})`
    + (dkCost ? `; DKP ${beforeDKP} → ${afterDKP} (−${beforeDKP - afterDKP})` : "");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({actor, token: combatant.token?.object || combatant.token}),
    content: `<div class="dbu-attack-roll dbu-draining-card"><b>🔥 Draining automático</b><p>${message}</p><small>Cálculo nativo: ${cost} KP · Capacity não é consumida.</small></div>`,
    flags: {world: {dbuaAutomaticDraining: {key, cost, actorId: actor.id, tokenId: combatant.tokenId || null}}}
  });

  if (after === 0 && (!godKi || afterDKP === 0)) {
    // Do not silently leave the Form active after No Energy.
    const active = actor.system.transformations || [];
    if (active.some(t => t?.active)) {
      const transformations = foundry.utils.deepClone(active);
      for (const trans of transformations) {
        if (trans?.active && !/^(manifested_power|awakening)/i.test(String(trans.transformationType || ""))) {
          trans.active = false;
        }
      }
      const conditions = foundry.utils.deepClone(actor.system.conditions || []);
      const stress = conditions.find(c => c?.id === "stressExhaustion");
      if (stress) {
        stress.active = true;
        stress.stacks = Math.max(1, Number(stress.stacks || 0));
      } else conditions.push({id:"stressExhaustion", active:true, stacks:1});
      await actor.update({
        "system.transformations": transformations,
        "system.conditions": conditions,
        "flags.world.dbuaNoEnergyStressExpiry": {
          combatId: combat.id,
          combatantId: combatant.id,
          clearRound: Number(combat.round) + 2
        }
      });
      const sheet = actor.sheet;
      await sheet?._syncPersistentTransformationCombatStates?.(transformations);
      await sheet?._syncPersistentTransformationResources?.(transformations);
      await sheet?._syncPersistentTransformationFlags?.(transformations);
      ui.notifications.warn(`${actor.name}: sem energia — transformações encerradas (DBU 0.9.2).`);
    }
  }
  return {key, actor, cost, before, after, dkCost, beforeDKP, afterDKP};
}
