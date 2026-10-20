// DBU Automation — integração de novo Round com o Combat Tracker
import { actorIdentity } from "./token-identity.js";
import { applyTransformationTurnUpkeep } from "./transformation-upkeep.js";

export function initializeRoundHooks({ dbuIsPrimaryGM } = {}) {
async function dbuNewRound(combat) {
  if (!dbuIsPrimaryGM()) return;

  const processed = new Set();

  for (const combatant of combat.combatants) {
    const actor = combatant.actor;

    if (
      !actor
      || processed.has(actorIdentity(actor, combatant.token))
    ) {
      continue;
    }

    processed.add(actorIdentity(actor, combatant.token));

    try {
      const sheet = actor.sheet;

      if (
        typeof sheet?._onCombatNewRound === "function"
      ) {
        // DBU 0.9.2 executa _battleBornGrantStack() dentro de
        // _onCombatNewRound(). Como este Round Hook roda no GM primário,
        // sem esta ponte o Dialog nativo abre no cliente do mestre.
        //
        // Interceptamos SOMENTE essa chamada durante o avanço automático:
        // - com OWNER ativo: roteia a função nativa para o cliente do player;
        // - sem OWNER ativo: mantém o comportamento nativo local do GM.
        const hadOwnBattleBorn = Object.prototype.hasOwnProperty.call(sheet, "_battleBornGrantStack");
        const ownBattleBorn = hadOwnBattleBorn ? sheet._battleBornGrantStack : undefined;
        const nativeBattleBorn = sheet._battleBornGrantStack;
        // The native new-round routine rolls Turbulent Power for EVERY
        // combatant before its turn. The DEV reroutes it to each turn.
        const hadOwnTurbulent = Object.prototype.hasOwnProperty.call(sheet, "_onTfTurbulentRoll");
        const ownTurbulent = hadOwnTurbulent ? sheet._onTfTurbulentRoll : undefined;
        const nativeTurbulent = sheet._onTfTurbulentRoll;
        if (typeof nativeTurbulent === "function") sheet._onTfTurbulentRoll = async () => null;

        if (typeof nativeBattleBorn === "function") {
          sheet._battleBornGrantStack = async source => {
            const router = globalThis.DBU_BATTLE_BORN_ROUTER;
            if (typeof router?.routeGrant === "function") {
              const routed = await router.routeGrant(actor, source);
              if (routed) return "routed-to-owner";
            }
            return nativeBattleBorn.call(sheet, source);
          };
        }

        try {
          await sheet._onCombatNewRound({
            preventDefault() {},
            stopPropagation() {}
          });
        } finally {
          if (typeof nativeBattleBorn === "function") {
            if (hadOwnBattleBorn) sheet._battleBornGrantStack = ownBattleBorn;
            else delete sheet._battleBornGrantStack;
          }
          if (typeof nativeTurbulent === "function") {
            if (hadOwnTurbulent) sheet._onTfTurbulentRoll = ownTurbulent;
            else delete sheet._onTfTurbulentRoll;
          }
        }

        console.log(
          `DBU | Novo Round -> ${actor.name}`
        );
      } else {
        console.warn(
          `DBU | _onCombatNewRound não encontrada para ${actor.name}`
        );
      }
    } catch (error) {
      console.error(
        `DBU | Novo Round ${actor.name}:`,
        error
      );
    }
  }
}

async function dbuStartCombatantTurn(combat) {
  if (!dbuIsPrimaryGM()) return;
  const combatant = combat.combatant;
  if (!combatant?.actor) return;
  try {
    // Draining uses only the native derived cost and never spends Capacity.
    // A durable Actor flag prevents duplicate payments if hooks are re-fired.
    await applyTransformationTurnUpkeep(combat, combatant);
  } catch (error) {
    console.error("DBU | Upkeep de transformação:", error);
    ui.notifications.error(`Falha na manutenção da transformação de ${combatant.actor.name}.`);
    return;
  }

  // DBU 0.9.2 native Stress Test; previously fired for all combatants at
  // the beginning of the round rather than the relevant turn.
  const actor = combatant.actor;
  const nativeStress = actor.sheet?._onTfTurbulentRoll;
  if (actor.system.transformationRules?.turbulentPowerActive
    && Number(actor.system.transformationRules?.combinedStressTest || 0) > 0
    && typeof nativeStress === "function") {
    const key = `${combat.id}:${combat.round}:${combatant.id}`;
    if (actor.getFlag?.("world", "dbuaTurbulentTurn")?.key !== key) {
      try {
        // Mark before the roll so two updateCombat notifications cannot prompt
        // the same player twice. The Actor is the exact Combatant's synthetic.
        await actor.setFlag("world", "dbuaTurbulentTurn", {key});
        await nativeStress.call(actor.sheet, { preventDefault() {}, stopPropagation() {} });
      } catch (error) {
        console.error("DBU | Stress Test de manutenção:", error);
      }
    }
  }
}

// ============================================================
// HOOK DO COMBAT TRACKER
// ============================================================

const combatHookId = Hooks.on(
  "updateCombat",
  async (combat, changes) => {
    if (!dbuIsPrimaryGM()) return;
    const roundChanged = Object.prototype.hasOwnProperty.call(changes, "round");
    const turnChanged = Object.prototype.hasOwnProperty.call(changes, "turn");
    if (!roundChanged && !turnChanged) return;
    const round = Number(combat.round || 0);
    if (round <= 0) return;

    if (roundChanged) {
      const roundKey = `${combat.id}:${round}`;
      if (globalThis.DBU_BOOTSTRAP.lastCombatRound !== roundKey) {
        globalThis.DBU_BOOTSTRAP.lastCombatRound = roundKey;
        await dbuNewRound(combat);
      }
    }
    // Also run on a round transition to include the first combatant, even
    // when Foundry leaves changes.turn absent or sets the same turn index.
    await dbuStartCombatantTurn(combat);
  }
);

globalThis.DBU_BOOTSTRAP.combatHookId =
  combatHookId;

  return { dbuNewRound, combatHookId };
}
