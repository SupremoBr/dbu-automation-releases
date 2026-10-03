// ============================================================
// DBU Automation v1.8.17 DEV — Battle Born owner router
// ============================================================
// Mantém a regra nativa do DBU 0.9.2. O GM continua responsável pelo avanço
// de Round, mas o Dialog de alocação do Battle Born é executado no cliente do
// player OWNER do Actor sempre que houver um OWNER ativo.
// ============================================================

function moduleIdFromUrl() {
  try {
    const pathname = new URL(import.meta.url).pathname;
    const match = pathname.match(/\/modules\/([^/]+)\//);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

const MODULE_ID = moduleIdFromUrl()
  || (globalThis.game?.modules?.get?.("dbu-automation-dev")?.active ? "dbu-automation-dev" : null)
  || (globalThis.game?.modules?.get?.("dbu-automation")?.active ? "dbu-automation" : null)
  || "dbu-automation";

const VERSION = "1.8.17 DEV";
const SOCKET = `module.${MODULE_ID}`;
let hookId = null;
let socketHandler = null;

function isPrimaryGM() {
  const active = (game.users?.contents || [...(game.users || [])])
    .filter(user => user?.active && user?.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return active[0]?.id === game.user?.id;
}

function isBattleBornMessage(message) {
  if (!message) return false;
  if (message.getFlag?.(MODULE_ID, "battleBornForwarded")) return false;
  const text = `${message.content || ""}\n${message.flavor || ""}`
    .replace(/<[^>]+>/g, " ")
    .toLowerCase();
  return /battle\s*[-_ ]?born/.test(text);
}

function actorFromMessage(message) {
  const actorId = message?.speaker?.actor || message?.getFlag?.("world", "actorId") || null;
  if (actorId) {
    const actor = game.actors?.get?.(actorId) || null;
    if (actor) return actor;
  }
  const tokenId = message?.speaker?.token || null;
  if (tokenId) {
    const live = canvas?.tokens?.get?.(tokenId)?.actor || null;
    if (live) return live;
    const scene = message?.speaker?.scene ? game.scenes?.get?.(message.speaker.scene) : null;
    const tokenDoc = scene?.tokens?.get?.(tokenId) || null;
    if (tokenDoc?.actor) return tokenDoc.actor;
    if (tokenDoc?.actorId) return game.actors?.get?.(tokenDoc.actorId) || null;
  }
  return null;
}

function playerOwners(actor, { activeOnly = true } = {}) {
  if (!actor) return [];
  return (game.users?.contents || [...(game.users || [])]).filter(user => {
    if (user?.isGM) return false;
    if (activeOnly && !user?.active) return false;
    try {
      return user.character?.id === actor.id || !!actor.testUserPermission?.(user, "OWNER");
    } catch {
      return user.character?.id === actor.id;
    }
  });
}

function preferredPlayerOwner(actor) {
  const owners = playerOwners(actor, { activeOnly: true });
  if (!owners.length) return null;
  return [...owners].sort((a, b) => {
    const aCharacter = a.character?.id === actor.id ? 0 : 1;
    const bCharacter = b.character?.id === actor.id ? 0 : 1;
    if (aCharacter !== bCharacter) return aCharacter - bCharacter;
    return String(a.id).localeCompare(String(b.id));
  })[0] || null;
}

function userOwnsActor(user, actor) {
  if (!user || !actor || user.isGM) return false;
  try {
    return user.character?.id === actor.id || !!actor.testUserPermission?.(user, "OWNER");
  } catch {
    return user.character?.id === actor.id;
  }
}

async function runNativeBattleBornDialog(actor, source) {
  if (!actor) return false;
  const sheet = actor.sheet;
  const nativeGrant = sheet?._battleBornGrantStack;
  if (typeof nativeGrant !== "function") {
    console.warn("DBU Battle Born | _battleBornGrantStack nativo não encontrado.", actor);
    return false;
  }
  await nativeGrant.call(sheet, String(source || "Battle Born"));
  return true;
}

/**
 * Chamado pelo Round Hook no cliente do GM.
 * Retorna true quando a responsabilidade do Dialog foi entregue a um player.
 * Retorna false quando não existe OWNER ativo e o caller deve usar o fallback
 * nativo local do GM para não perder a resolução da regra.
 */
export async function routeBattleBornRoundGrant(actor, source) {
  if (!actor || !game.user?.isGM) return false;

  const owner = preferredPlayerOwner(actor);
  if (!owner) return false;

  game.socket.emit(SOCKET, {
    type: "dbuaBattleBornAllocate",
    targetUserId: owner.id,
    actorId: actor.id,
    source: String(source || "Battle Born")
  });

  console.log(`DBU Battle Born | alocação de ${actor.name} enviada para ${owner.name}`);
  return true;
}

async function battleBornSocketHandler(data) {
  if (!data || data.type !== "dbuaBattleBornAllocate") return;
  if (data.targetUserId !== game.user?.id || game.user?.isGM) return;

  const actor = game.actors?.get?.(data.actorId) || null;
  if (!actor) {
    console.warn("DBU Battle Born | Actor não encontrado no cliente alvo:", data.actorId);
    return;
  }
  if (!userOwnsActor(game.user, actor)) {
    console.warn("DBU Battle Born | usuário alvo não possui OWNER do Actor:", actor.name);
    return;
  }

  try {
    await runNativeBattleBornDialog(actor, data.source);
  } catch (error) {
    console.error("DBU Battle Born | Dialog no player:", error);
    ui.notifications?.error?.("Battle Born: não foi possível abrir a alocação.");
  }
}

async function forwardBattleBorn(message) {
  if (!isPrimaryGM() || !isBattleBornMessage(message)) return;
  const actor = actorFromMessage(message);
  if (!actor) return;
  const owners = playerOwners(actor, { activeOnly: true });
  if (!owners.length) return;
  // Mensagem pública já é visível ao player; não duplicar.
  if (!(message.whisper || []).length) return;

  const existingWhisper = new Set((message.whisper || []).map(String));
  const missing = owners.filter(user => !existingWhisper.has(String(user.id)));
  if (!missing.length && (message.whisper || []).length) return;

  await ChatMessage.create({
    speaker: foundry.utils.deepClone(message.speaker || ChatMessage.getSpeaker({ actor })),
    content: message.content || `<div><b>Battle Born — ${actor.name}</b></div>`,
    flavor: message.flavor || undefined,
    whisper: missing.length ? missing.map(user => user.id) : owners.map(user => user.id),
    flags: {
      [MODULE_ID]: {
        battleBornForwarded: true,
        battleBornSourceMessageId: message.id
      }
    }
  });
}

export function initializeBattleBornRouter() {
  if (hookId) {
    try { Hooks.off("createChatMessage", hookId); } catch {}
  }
  if (socketHandler) {
    try { game.socket?.off?.(SOCKET, socketHandler); } catch {}
  }

  hookId = Hooks.on("createChatMessage", message => {
    forwardBattleBorn(message).catch(error => console.warn("DBU Battle Born router:", error));
  });

  socketHandler = battleBornSocketHandler;
  game.socket?.on?.(SOCKET, socketHandler);

  const state = {
    initialized: true,
    version: VERSION,
    hookId,
    socketHandler,
    routeGrant: routeBattleBornRoundGrant
  };
  globalThis.DBU_BATTLE_BORN_ROUTER = state;
  console.log(`DBU Automation ${VERSION} | Battle Born owner router pronto`);
  return state;
}

export const BattleBornRouter = {
  initialize: initializeBattleBornRouter,
  routeGrant: routeBattleBornRoundGrant
};
