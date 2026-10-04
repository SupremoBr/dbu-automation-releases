// DBU Automation — client-side localization layer (pt-BR / en)

const MODULE_ID =
  (globalThis.game?.modules?.get?.("dbu-automation-dev")?.active ? "dbu-automation-dev" : null)
  || (globalThis.game?.modules?.get?.("dbu-automation")?.active ? "dbu-automation" : null)
  || "dbu-automation";

const SETTING = "uiLanguage";
let settingsPrepared = false;
let observer = null;

const EN_REPLACEMENTS = [
  ["SEU TURNO", "YOUR TURN"],
  ["TURNO ATUAL", "CURRENT TURN"],
  ["FIM DO TURNO", "END TURN"],
  ["AÇÕES", "ACTIONS"],
  ["Ações", "Actions"],
  ["Ação", "Action"],
  ["ALIADOS", "ALLIES"],
  ["Aliados", "Allies"],
  ["Ataques", "Attacks"],
  ["Ataque", "Attack"],
  ["Defesas", "Defenses"],
  ["Defesa", "Defense"],
  ["Técnicas", "Techniques"],
  ["Transformações", "Transformations"],
  ["Transformação", "Transformation"],
  ["Auras", "Auras"],
  ["Itens", "Items"],
  ["Pendências", "Pending"],
  ["Pendência", "Pending"],
  ["Alvos", "Targets"],
  ["Alvo", "Target"],
  ["Preferências do HUD", "HUD Preferences"],
  ["Configurar animações e efeitos", "Configure animations and effects"],
  ["Limpar alvos marcados", "Clear targeted tokens"],
  ["Fechar HUD", "Close HUD"],
  ["Fechar", "Close"],
  ["Cancelar", "Cancel"],
  ["Confirmar", "Confirm"],
  ["Ignorar", "Ignore"],
  ["Nenhuma", "None"],
  ["Nenhum", "None"],
  ["Disponível", "Available"],
  ["Indisponível", "Unavailable"],
  ["Ativa", "Active"],
  ["Ativo", "Active"],
  ["Desativada", "Deactivated"],
  ["Desativado", "Deactivated"],
  ["Ativar / Trocar Aura", "Activate / Switch Aura"],
  ["Desativar Atual", "Deactivate Current"],
  ["Desativar Aura", "Deactivate Aura"],
  ["Manter", "Maintain"],
  ["Manutenção de Aura", "Aura Maintenance"],
  ["Manutenção", "Maintenance"],
  ["Ativação", "Activation"],
  ["Aura ativa", "Active Aura"],
  ["Aura desativada.", "Aura deactivated."],
  ["Aura encerrada por não ser mantida.", "Aura ended because maintenance was not paid."],
  ["A mesma defesa continua disponível no card do chat.", "The same defense remains available on the chat card."],
  ["Defesa pendente", "Pending Defense"],
  ["Intervene disponível", "Intervene available"],
  ["Exploit disponível", "Exploit available"],
  ["Reflect disponível", "Reflect available"],
  ["Responda como Grappler; empate mantém o Grapple.", "Respond as the Grappler; a tie keeps the Grapple."],
  ["Nenhum ataque registrado neste combate.", "No attacks recorded in this combat."],
  ["Time deste combatente somente no Encounter atual", "This combatant's Team for the current Encounter only"],
  ["Limpar estados temporários deste encontro", "Clear temporary states from this Encounter"],
  ["Arrastar e salvar posição do HP, Ki e Capacidade", "Drag and save HP, Ki and Capacity position"],
  ["selecione seu personagem.", "select your character."],
  ["selecione um token ou vincule um personagem ao usuário.", "select a token or link a character to the user."],
  ["selecione somente um token.", "select only one token."],
  ["Você não controla", "You do not control"],
  ["já está ativa.", "is already active."],
  ["já usado neste Round.", "has already been used this Round."],
  ["já usada neste Round.", "has already been used this Round."],
  ["só pode ser usado durante um Encounter ativo.", "can only be used during an active Encounter."],
  ["só pode ser usada durante um Encounter ativo.", "can only be used during an active Encounter."],
  ["fora do Melee Range.", "is outside Melee Range."],
  ["não foi encontrado.", "was not found."],
  ["não foi encontrada.", "was not found."],
  ["não está mais pendente.", "is no longer pending."],
  ["Nenhum GM ativo para validar esta atualização.", "No active GM is available to validate this update."],
  ["O GM não confirmou a atualização dentro do tempo limite.", "The GM did not confirm the update before the timeout."],
  ["O GM não confirmou o Grapple Check.", "The GM did not confirm the Grapple Check."],
  ["O GM não confirmou o Empower.", "The GM did not confirm Empower."],
  ["não está identificado como Ally na cena.", "is not identified as an Ally in the scene."],
  ["Ki insuficiente.", "Insufficient Ki."],
  ["Capacity insuficiente.", "Insufficient Capacity."],
  ["Necessário", "Required"],
  ["Restante", "Remaining"],
  ["Aura não encontrada em system.signatureAuras.", "Aura not found in system.signatureAuras."],
  ["nenhuma Aura ativa.", "no active Aura."],
  ["opção selecionada não encontrada.", "selected option was not found."],
  ["A condição continua como lembrete manual, igual ao macro anterior.", "The condition remains a manual reminder, as in the previous macro."],
  ["ao sair desta Aura, você ganha a condição", "when leaving this Aura, you gain the condition"],
  ["até o fim do seu próximo turno.", "until the end of your next turn."],
  ["Pague a manutenção para manter a Aura ativa neste turno.", "Pay maintenance to keep the Aura active this turn."],
  ["não conseguiu pagar a manutenção de", "could not pay the maintenance of"],
  ["a Aura será desativada.", "the Aura will be deactivated."],
  ["A ativação liga a Signature Aura configurada na ficha; os efeitos mecânicos continuam sendo calculados pelo DBU.", "Activation enables the Signature Aura configured on the sheet; mechanical effects continue to be calculated by DBU."],
  ["Descrição:", "Description:"],
  ["Fora de Encounter", "Outside Encounter"],
  ["neste Round", "this Round"],
  ["neste encounter", "this Encounter"],
  ["neste Encounter", "this Encounter"],
  ["próximo turno", "next turn"],
  ["até o início do próximo turno", "until the start of the next turn"],
  ["Por Action", "Per Action"],
  ["Por stack", "Per stack"],
  ["Ganho deste uso", "Gain from this use"],
  ["Power atual", "Current Power"],
  ["Fora de Encounter · limite/Round livre", "Outside Encounter · Round limit ignored"],
  ["Economia permissiva", "Permissive action economy"],
  ["o módulo não bloqueia", "the module does not block"],
  ["Posicione o token manualmente", "Position the token manually"],
  ["Lançar e encerrar Grapple", "Throw and end Grapple"],
  ["continuação", "continuation"],
  ["Você venceu o Grapple Check contra", "You won the Grapple Check against"],
  ["Grappler não encontrado.", "Grappler not found."],
  ["Grappled não encontrado.", "Grappled not found."],
  ["Nenhum Launch aguardando conclusão.", "No Launch is awaiting resolution."],
  ["Nenhuma Feature do Terrain Lift está sendo carregada.", "No Terrain Lift Feature is currently being carried."],
  ["Novo Round", "New Round"],
  ["pronta", "ready"],
  ["pronto", "ready"]
];

function settingLanguage() {
  try {
    return String(game.settings?.get?.(MODULE_ID, SETTING) || "auto");
  } catch {
    return "auto";
  }
}

export function currentLanguage() {
  const selected = settingLanguage();
  if (selected && selected !== "auto") return selected;
  return String(game.i18n?.lang || navigator.language || "pt-BR");
}

export function isEnglish() {
  return /^en(?:-|$)/i.test(currentLanguage());
}

export function tr(value) {
  const source = String(value ?? "");
  if (!isEnglish() || !source) return source;
  let out = source;
  for (const [pt, en] of EN_REPLACEMENTS) {
    if (out.includes(pt)) out = out.split(pt).join(en);
  }
  return out;
}

function rootElement(value) {
  if (!value) return null;
  if (value instanceof HTMLElement) return value;
  if (value?.[0] instanceof HTMLElement) return value[0];
  if (value?.element instanceof HTMLElement) return value.element;
  if (value?.element?.[0] instanceof HTMLElement) return value.element[0];
  return null;
}

export function translateElement(value) {
  if (!isEnglish()) return false;
  const root = rootElement(value);
  if (!root) return false;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest("script,style,textarea")) continue;
    const next = tr(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }

  const attrs = ["title", "placeholder", "aria-label", "data-tooltip"];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of attrs) {
      if (!el.hasAttribute?.(attr)) continue;
      const before = el.getAttribute(attr);
      const after = tr(before);
      if (after !== before) el.setAttribute(attr, after);
    }
  }
  return true;
}

function looksLikeDBU(root) {
  if (!root) return false;
  const selector = [
    ".dbu-attack-roll",
    ".dbu-aura-manager",
    ".dbu-aura-maintenance",
    ".dbu-combat-hud",
    "#dbu-combat-hud",
    ".dbua-system-dialog-content",
    ".dbua-system-status-table",
    ".combat-conditions-panel",
    ".dbu-gm-panel",
    ".dbu-combat-panel"
  ].join(",");
  return root.matches?.(selector) || !!root.querySelector?.(selector);
}

function translateRendered(app, html) {
  if (!isEnglish()) return;
  const root = rootElement(html) || rootElement(app);
  if (!root) return;
  if (!looksLikeDBU(root) && !/DBU|Aura|Power Up|Combat Recovery|Grapple|Transform/i.test(String(app?.title || ""))) return;
  const container = root.closest?.(".window-app,.application,.dialog") || root;
  translateElement(container);
}

function installHooks() {
  Hooks.on("renderDialog", translateRendered);
  Hooks.on("renderApplicationV2", translateRendered);
  Hooks.on("renderChatMessage", (_message, html) => {
    const root = rootElement(html);
    if (root && looksLikeDBU(root)) translateElement(root);
  });
  Hooks.on("renderChatMessageHTML", (_message, html) => {
    const root = rootElement(html);
    if (root && looksLikeDBU(root)) translateElement(root);
  });
}

function installObserver() {
  if (observer || !document?.body) return;
  observer = new MutationObserver(mutations => {
    if (!isEnglish()) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.closest?.("#notifications") || node.matches?.(".notification")) {
          translateElement(node);
          continue;
        }
        if (looksLikeDBU(node)) {
          const container = node.closest?.(".window-app,.application,.dialog") || node;
          translateElement(container);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function registerLocalizationSettings() {
  if (settingsPrepared) return;
  settingsPrepared = true;
  Hooks.once("init", () => {
    const key = `${MODULE_ID}.${SETTING}`;
    if (game.settings?.settings?.has?.(key)) return;
    game.settings.register(MODULE_ID, SETTING, {
      name: "DBU Automation — Idioma / Language",
      hint: "Escolha o idioma da interface do módulo. Auto usa o idioma do Foundry. / Choose the module UI language. Auto follows Foundry.",
      scope: "client",
      config: true,
      type: String,
      choices: {
        auto: "Automático / Automatic",
        "pt-BR": "Português (Brasil)",
        en: "English"
      },
      default: "auto",
      onChange: () => window.location.reload()
    });
  });
}

export function initializeLocalization() {
  installHooks();
  installObserver();
  if (isEnglish()) {
    requestAnimationFrame(() => {
      for (const el of document.querySelectorAll(".dbu-attack-roll,.dbu-combat-hud,#dbu-combat-hud,.dbua-system-dialog-content")) {
        translateElement(el.closest?.(".window-app,.application,.dialog") || el);
      }
    });
  }
  globalThis.DBU_LOCALIZATION = {
    version: "1.9.0",
    currentLanguage,
    isEnglish,
    tr,
    translateElement
  };
  return globalThis.DBU_LOCALIZATION;
}
