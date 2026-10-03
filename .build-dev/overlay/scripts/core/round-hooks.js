// DBU Automation — integração de novo Round com o Combat Tracker

export function initializeRoundHooks({ dbuIsPrimaryGM } = {}) {
async function dbuNewRound(combat) {
  if (!dbuIsPrimaryGM()) return;

  const processed = new Set();

  for (const combatant of combat.combatants) {
    const actor = combatant.actor;

    if (
      !actor
      || processed.has(actor.id)
    ) {
      continue;
    }

    processed.add(actor.id);

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

// ============================================================
// HOOK DO COMBAT TRACKER
// ============================================================

const combatHookId = Hooks.on(
  "updateCombat",
  async (combat, changes) => {
    if (
      !Object.prototype
        .hasOwnProperty
        .call(changes, "round")
    ) {
      return;
    }

    const round = Number(
      combat.round || 0
    );

    if (round <= 0) return;

    const key = `${combat.id}:${round}`;

    if (
      globalThis.DBU_BOOTSTRAP.lastCombatRound === key
    ) {
      return;
    }

    globalThis.DBU_BOOTSTRAP.lastCombatRound = key;

    await dbuNewRound(combat);
  }
);

globalThis.DBU_BOOTSTRAP.combatHookId =
  combatHookId;

  return { dbuNewRound, combatHookId };
}
