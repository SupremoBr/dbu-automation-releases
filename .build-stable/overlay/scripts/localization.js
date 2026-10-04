// DBU Automation — client-side localization layer (pt-BR / en)
// v1.9.4: broad coverage for module-owned HUDs, dialogs, chat cards and notices.

import { MODULE_ID } from "./core/module-id.js";

const SETTING = "uiLanguage";
let settingsPrepared = false;
let observer = null;

const EN_REPLACEMENTS = [
  // Long / specific phrases first.
  ["A mesma defesa continua disponível no card do chat.", "The same defense remains available on the chat card."],
  ["Economia permissiva: o contador é informativo e não bloqueia Actions extras ou custos removidos por Traits/Characteristics.", "Permissive action economy: the counter is informational and does not block extra Actions or costs removed by Traits/Characteristics."],
  ["Use STANDARD, INSTANT e COUNTER pela HUD. Instant reaproveita funções já existentes; Counter mostra somente oportunidades válidas e encaminha para as Pendências.", "Use STANDARD, INSTANT and COUNTER from the HUD. Instant reuses existing automation; Counter shows only valid opportunities and routes them to Pending Actions."],
  ["A ativação liga a Signature Aura configurada na ficha; os efeitos mecânicos continuam sendo calculados pelo DBU.", "Activation enables the Signature Aura configured on the sheet; mechanical effects continue to be calculated by DBU."],
  ["Pague a manutenção para manter a Aura ativa neste turno.", "Pay maintenance to keep the Aura active this turn."],
  ["A condição continua como lembrete manual, igual ao macro anterior.", "The condition remains a manual reminder, as in the previous macro."],
  ["Se a desativação ficar em “padrão” e a ativação usar um macro personalizado, o módulo reutiliza o mesmo macro com phase: \"deactivate\" para facilitar a limpeza de efeitos persistentes.", "If deactivation stays on “default” and activation uses a custom macro, the module reuses the same macro with phase: \"deactivate\" to help clean up persistent effects."],
  ["Isto altera apenas aparência. Os bônus, Traits, custos e limites da Transformation continuam vindo da ficha/DBU.", "This changes appearance only. Transformation bonuses, Traits, costs, and limits still come from the sheet/DBU."],
  ["O jogador escolhe um macro já existente; o código JavaScript do macro não é editado por este painel.", "The player chooses an existing macro; this panel does not edit the macro's JavaScript code."],
  ["Você também pode arrastar o bloco de HP/Ki/Capacidade pela alça; a nova posição é salva automaticamente só para você.", "You can also drag the HP/Ki/Capacity block by its handle; the new position is saved automatically for you."],
  ["Todas essas escolhas usam configurações de cliente: cada jogador pode montar sua própria HUD sem mudar a dos demais.", "All these choices use client settings: each player can configure their own HUD without changing anyone else's."],
  ["Os aliados ficam em formato compacto: foto, nome e barra de LP. Passe o mouse sobre um aliado para ver o LP atual/máximo. O conjunto também pode ser arrastado.", "Allies use a compact layout: portrait, name, and LP bar. Hover an ally to see current/max LP. The group can also be dragged."],
  ["Cone e Line sempre começam na Square do usuário; você escolhe apenas a direção no mapa.", "Cone and Line always start in the user's Square; you only choose the direction on the map."],
  ["Preenchida pela técnica. Altere somente quando uma habilidade, recurso ou efeito mudar a categoria deste ataque.", "Filled from the technique. Change it only when an ability, resource, or effect changes this attack's category."],
  ["O uso da Counter Action é apenas registrado; o módulo não bloqueia por economia de Actions.", "The Counter Action use is only recorded; the module does not block it based on Action economy."],
  ["Somente o ataque carregado está disponível", "Only the charged attack is available"],
  ["Liberando o ataque carregado", "Releasing the charged attack"],
  ["Declare o ataque que será carregado. Depois do primeiro Energy Charge, os próximos usos ficam presos a esse mesmo ataque até ele ser liberado ou o Charge ser cancelado.", "Declare the attack to charge. After the first Energy Charge, subsequent uses remain locked to that attack until it is released or the Charge is cancelled."],
  ["Escolha qual Surge usar. O DBU Automation chama o mesmo handler nativo da ficha; recursos que concedem Surges extras continuam sendo resolvidos pelo sistema DBU 0.9.2.", "Choose which Surge to use. DBU Automation calls the same native sheet handler; resources that grant extra Surges are still resolved by DBU 0.9.2."],
  ["Ao ser atingido por uma Attacking Maneuver, o Shield reduz automaticamente o Dice Score do Wound.", "When hit by an Attacking Maneuver, the Shield automatically reduces the Wound Dice Score."],
  ["Se ainda houver Damage, a Feature é destruída.", "If Damage remains, the Feature is destroyed."],
  ["Se o Damage chegar a 0, a redução perde", "If Damage reaches 0, the reduction loses"],
  ["Nenhum ataque registrado neste combate.", "No attacks recorded in this combat."],
  ["Nenhum Attack Reference ou Signature Technique disponível.", "No Attack Reference or Signature Technique available."],
  ["Nenhum aliado na cena", "No allies in the scene"],
  ["Nenhuma ação pendente.", "No pending actions."],
  ["nenhuma defesa pendente.", "no pending defense."],
  ["nenhum ataque pendente atende aos requisitos do Duel.", "no pending attack meets the Duel requirements."],
  ["nenhuma oportunidade válida de Intervene.", "no valid Intervene opportunity."],
  ["nenhuma oportunidade válida de Reflect.", "no valid Reflect opportunity."],
  ["nenhuma oportunidade de Exploit.", "no Exploit opportunity."],
  ["Nenhuma Feature do Terrain Lift está sendo carregada.", "No Terrain Lift Feature is currently being carried."],
  ["Nenhum Launch aguardando conclusão.", "No Launch is awaiting resolution."],
  ["Nenhum GM ativo para validar esta atualização.", "No active GM is available to validate this update."],
  ["O GM não confirmou a atualização dentro do tempo limite.", "The GM did not confirm the update before the timeout."],
  ["O GM não confirmou o Grapple Check.", "The GM did not confirm the Grapple Check."],
  ["O GM não confirmou o Empower.", "The GM did not confirm Empower."],
  ["Você venceu o Grapple Check contra", "You won the Grapple Check against"],
  ["Responda como Grappler; empate mantém o Grapple.", "Respond as the Grappler; a tie keeps the Grapple."],
  ["A resposta do Grapple exige controle do Grappler.", "The Grapple response requires control of the Grappler."],
  ["A resposta exige controle do personagem.", "The response requires control of the character."],
  ["Esta tentativa de escape não está mais pendente.", "This escape attempt is no longer pending."],
  ["Este Grapple Check não está mais pendente.", "This Grapple Check is no longer pending."],
  ["O Grapple desta pendência não está mais ativo.", "The Grapple for this pending action is no longer active."],
  ["Grappler não encontrado.", "Grappler not found."],
  ["Grappled não encontrado.", "Grappled not found."],
  ["A pendência de escape não foi encontrada.", "The escape pending action was not found."],
  ["O Grapple Check pendente não foi encontrado.", "The pending Grapple Check was not found."],
  ["selecione um token ou configure um personagem para o usuário.", "select a token or configure a character for the user."],
  ["selecione um token ou vincule um personagem ao usuário.", "select a token or link a character to the user."],
  ["selecione somente um token.", "select only one token."],
  ["selecione seu personagem.", "select your character."],
  ["selecione o personagem que recebeu a oportunidade.", "select the character who received the opportunity."],
  ["marque exatamente 1 alvo.", "target exactly 1 token."],
  ["marque um aliado como Target ou tenha outro aliado na cena.", "target an ally or have another ally in the scene."],
  ["não está identificado como Ally na cena.", "is not identified as an Ally in the scene."],
  ["não foi encontrado na cena.", "was not found in the scene."],
  ["não foi encontrado.", "was not found."],
  ["não foi encontrada.", "was not found."],
  ["não está mais pendente.", "is no longer pending."],
  ["não está disponível neste estado.", "is not available in this state."],
  ["não está disponível.", "is not available."],
  ["não possui Attack References ou Signature Techniques.", "has no Attack References or Signature Techniques."],
  ["não possui Transformations.", "has no Transformations."],
  ["não possui Signature Auras configuradas.", "has no configured Signature Auras."],
  ["só pode ser usado durante um Encounter ativo.", "can only be used during an active Encounter."],
  ["só pode ser usada durante um Encounter ativo.", "can only be used during an active Encounter."],
  ["já foi usado neste Round", "has already been used this Round"],
  ["já foi usada neste Round", "has already been used this Round"],
  ["já usado neste Round.", "already used this Round."],
  ["já usada neste Round.", "already used this Round."],
  ["já está ativa.", "is already active."],
  ["fora do Melee Range.", "is outside Melee Range."],
  ["fora da iniciativa", "outside initiative"],
  ["Fora de Encounter · limite/Round livre", "Outside Encounter · Round limit ignored"],
  ["Fora de Encounter", "Outside Encounter"],
  ["Fora de combate", "Outside combat"],
  ["neste Encounter", "this Encounter"],
  ["neste encounter", "this Encounter"],
  ["neste Round", "this Round"],
  ["neste turno", "this turn"],
  ["até o início do próximo turno", "until the start of the next turn"],
  ["até o fim do seu próximo turno.", "until the end of your next turn."],
  ["próximo turno", "next turn"],
  ["Time deste combatente somente no Encounter atual", "This combatant's Team for the current Encounter only"],
  ["Limpar estados temporários deste encontro", "Clear temporary states from this Encounter"],
  ["Arrastar e salvar posição do HP, Ki e Capacidade", "Drag and save HP, Ki and Capacity position"],
  ["Arrastar e salvar posição dos aliados", "Drag and save allies position"],
  ["Abrir ficha de", "Open sheet for"],
  ["Abrir HUD de Combate DBU", "Open DBU Combat HUD"],
  ["Ativar HUD de Combate", "Enable Combat HUD"],
  ["Abrir ao selecionar meu token", "Open when selecting my token"],
  ["Ocultar hotbar padrão enquanto o HUD estiver aberto", "Hide the default hotbar while the HUD is open"],
  ["Mostrar painel de aliados presentes na cena", "Show allies present in the scene"],
  ["HP, Ki e Capacidade", "HP, Ki and Capacity"],
  ["Posição base", "Base position"],
  ["Distância horizontal", "Horizontal distance"],
  ["Distância vertical", "Vertical distance"],
  ["Transparência / visibilidade", "Transparency / visibility"],
  ["Preferências do HUD", "HUD Preferences"],
  ["Configurar animações e efeitos", "Configure animations and effects"],
  ["Configurar visuais", "Configure visuals"],
  ["Limpar alvos marcados", "Clear targeted tokens"],
  ["Nenhum alvo marcado", "No targets selected"],
  ["Estado atual", "Current state"],
  ["HUD próprio · sem dependência externa", "Native HUD · no external dependency"],
  ["HUD por jogador", "Per-player HUD"],
  ["Abrir Standard Maneuvers", "Open Standard Maneuvers"],
  ["Standard Maneuvers e favoritos", "Standard Maneuvers and favorites"],
  ["Instant Maneuvers · reutiliza automações existentes", "Instant Maneuvers · reuses existing automation"],
  ["Counter Maneuvers · mostra apenas oportunidades contextuais", "Counter Maneuvers · shows only contextual opportunities"],
  ["Configuração antiga/padrão", "Legacy/default configuration"],
  ["Usar configuração antiga/padrão", "Use legacy/default configuration"],
  ["Nenhum / desativar", "None / disable"],
  ["Voltar ao padrão", "Restore default"],
  ["Configuração personalizada removida.", "Custom configuration removed."],
  ["configuração personalizada removida.", "custom configuration removed."],
  ["Configuração antiga:", "Legacy configuration:"],
  ["Procurar arquivo", "Browse file"],
  ["Testar macro visual", "Test visual macro"],
  ["Testar visual", "Test visual"],
  ["Testar token", "Test token"],
  ["Testar macro", "Test macro"],
  ["Testar ativação", "Test activation"],
  ["Testar desativação", "Test deactivation"],
  ["Troca de imagem do token", "Token image swap"],
  ["Tamanho no grid", "Grid size"],
  ["Macro visual da transformação", "Transformation visual macro"],
  ["Macro visual da defesa", "Defense visual macro"],
  ["Macro visual", "Visual macro"],
  ["Macro ao ativar", "Activation macro"],
  ["Macro ao desativar", "Deactivation macro"],
  ["GIF da carta", "Card GIF"],
  ["Escolha a imagem do token.", "Choose the token image."],
  ["Selecione o macro visual.", "Select the visual macro."],
  ["Selecione um macro visual primeiro.", "Select a visual macro first."],
  ["Selecione o macro de ativação.", "Select the activation macro."],
  ["Selecione o macro de desativação.", "Select the deactivation macro."],
  ["Macro visual não encontrado:", "Visual macro not found:"],
  ["FilePicker não está disponível nesta versão do Foundry.", "FilePicker is not available in this Foundry version."],
  ["Não foi possível abrir o seletor de arquivos.", "Could not open the file picker."],
  ["Coloque ou selecione o token do personagem na cena para testar.", "Place or select the character token in the scene to test."],
  ["Nenhuma imagem ou tamanho de grid configurado para testar.", "No image or grid size configured for testing."],
  ["Ativar / Trocar Aura", "Activate / Switch Aura"],
  ["Desativar Atual", "Deactivate Current"],
  ["Desativar Aura", "Deactivate Aura"],
  ["Aura desativada.", "Aura deactivated."],
  ["Aura encerrada por não ser mantida.", "Aura ended because maintenance was not paid."],
  ["Aura não encontrada em system.signatureAuras.", "Aura not found in system.signatureAuras."],
  ["nenhuma Aura ativa.", "no active Aura."],
  ["opção selecionada não encontrada.", "selected option was not found."],
  ["não conseguiu pagar a manutenção de", "could not pay the maintenance of"],
  ["a Aura será desativada.", "the Aura will be deactivated."],
  ["ao sair desta Aura, você ganha a condição", "when leaving this Aura, you gain the condition"],
  ["Manutenção de Aura", "Aura Maintenance"],
  ["Aura ativa", "Active Aura"],
  ["Signature Aura ativa", "Active Signature Aura"],
  ["Transformation ativa", "Active Transformation"],
  ["Energy Charge ativo", "Active Energy Charge"],
  ["Energy Charge está preso a outro ataque", "Energy Charge is locked to another attack"],
  ["Ataque declarado", "Declared attack"],
  ["EC reunidos", "Gathered EC"],
  ["Usos", "Uses"],
  ["Ganho deste uso", "Gain from this use"],
  ["Por Action", "Per Action"],
  ["Por stack", "Per stack"],
  ["Power atual", "Current Power"],
  ["Power Stacks", "Power Stacks"],
  ["Feature carregada", "Carried Feature"],
  ["Terrain Shield automático", "Automatic Terrain Shield"],
  ["terreno colocado.", "terrain placed."],
  ["foi destruído pelo Terrain Shield.", "was destroyed by Terrain Shield."],
  ["foi colocado em um Square dentro do Melee Range.", "was placed in a Square within Melee Range."],
  ["foi destruído porque o ataque ainda causou", "was destroyed because the attack still dealt"],
  ["bloqueou o Damage. A redução do Shield diminui de", "blocked the Damage. Shield reduction decreases from"],
  ["Escolha qual Surge usar.", "Choose which Surge to use."],
  ["Surge só pode ser usado durante um Encounter ativo.", "Surge can only be used during an active Encounter."],
  ["Terrain Lift já foi usado neste Round", "Terrain Lift has already been used this Round"],
  ["o alvo está a", "the target is"],
  ["e precisa estar em", "and must be within"],
  ["Chão", "Ground"],
  ["Automático", "Automatic"],
  ["Necessário", "Required"],
  ["Restante", "Remaining"],
  ["Ki insuficiente.", "Insufficient Ki."],
  ["Capacity insuficiente.", "Insufficient Capacity."],
  ["Necessário:", "Required:"],
  ["Restante:", "Remaining:"],
  ["Custo", "Cost"],
  ["Custos", "Costs"],
  ["Categoria de Dano", "Damage Category"],
  ["Categoria do Dano", "Damage Category"],
  ["Tem Área de Ataque?", "Has Area Attack?"],
  ["Tipo da Área", "Area Type"],
  ["Posição da Sphere", "Sphere Position"],
  ["Manter o template no mapa", "Keep the template on the map"],
  ["Detectar alvos", "Detect targets"],
  ["Selecionar alvos", "Select targets"],
  ["Ataque declarado:", "Declared attack:"],
  ["Alvo travado:", "Locked target:"],
  ["Strike Botch até", "Strike Botch up to"],
  ["Wound Botch até", "Wound Botch up to"],
  ["Strike Extra", "Strike Extra"],
  ["Wound Extra", "Wound Extra"],
  ["Modificador de CT", "CT Modifier"],
  ["Margem de Crítico", "Critical Margin"],
  ["Margem de Critico", "Critical Margin"],
  ["Diminishing Offense", "Diminishing Offense"],
  ["1 = padrão; 0 = desliga; 2 = natural 1-2.", "1 = default; 0 = disabled; 2 = natural 1-2."],
  ["-1 facilita crítico; +1 dificulta.", "-1 makes critical easier; +1 makes it harder."],
  ["Ataque bloqueado por recursos insuficientes", "Attack blocked by insufficient resources"],
  ["Erro executando a rolagem original do DBU.", "Error executing the original DBU roll."],
  ["Macro visual não encontrada:", "Visual macro not found:"],
  ["Erro executando visual:", "Error executing visual:"],
  ["Fórmula inválida", "Invalid formula"],
  ["inválido:", "invalid:"],
  ["Defesa pendente", "Pending Defense"],
  ["Intervene disponível", "Intervene available"],
  ["Exploit disponível", "Exploit available"],
  ["Reflect disponível", "Reflect available"],
  ["Grapple Check pendente", "Pending Grapple Check"],
  ["Defesa", "Defense"],
  ["Escolha a mesma defesa que aparece no card do chat.", "Choose the same defense shown on the chat card."],
  ["Duel só aparece quando o ataque atende aos requisitos da 0.9.2.", "Duel only appears when the attack meets the 0.9.2 requirements."],
  ["Escolha a oportunidade", "Choose the opportunity"],
  ["pendências", "pending actions"],
  ["ação pendente", "pending action"],
  ["oportunidade válida", "valid opportunity"],
  ["oportunidade", "opportunity"],
  ["Atacante", "Attacker"],
  ["atacante original", "original attacker"],
  ["Defensor", "Defender"],
  ["jogador", "player"],
  ["mestre", "GM"],
  ["personagem", "character"],
  ["Personagem", "Character"],
  ["aliado", "ally"],
  ["Aliado", "Ally"],
  ["aliados", "allies"],
  ["Alvo", "Target"],
  ["Alvos", "Targets"],
  ["Ataque", "Attack"],
  ["Ataques", "Attacks"],
  ["Defesas", "Defenses"],
  ["Técnicas", "Techniques"],
  ["Transformação", "Transformation"],
  ["Transformações", "Transformations"],
  ["Ações", "Actions"],
  ["Ação", "Action"],
  ["Itens", "Items"],
  ["Pendências", "Pending Actions"],
  ["Pendência", "Pending Action"],
  ["Manutenção", "Maintenance"],
  ["Ativação", "Activation"],
  ["Desativação", "Deactivation"],
  ["Ativar", "Activate"],
  ["Desativar", "Deactivate"],
  ["Manter", "Maintain"],
  ["Disponível", "Available"],
  ["Indisponível", "Unavailable"],
  ["Ativa", "Active"],
  ["Ativo", "Active"],
  ["Desativada", "Deactivated"],
  ["Desativado", "Deactivated"],
  ["Nenhuma", "None"],
  ["Nenhum", "None"],
  ["Escolha", "Choose"],
  ["Selecione", "Select"],
  ["selecione", "select"],
  ["Configurar", "Configure"],
  ["Salvar", "Save"],
  ["Aplicar", "Apply"],
  ["Limpar", "Clear"],
  ["Fechar HUD", "Close HUD"],
  ["Fechar", "Close"],
  ["Cancelar", "Cancel"],
  ["Confirmar", "Confirm"],
  ["Ignorar", "Ignore"],
  ["Expandir HUD", "Expand HUD"],
  ["Recolher HUD", "Collapse HUD"],
  ["CAPACIDADE", "CAPACITY"],
  ["VIDA", "LIFE"],
  ["SEU TURNO", "YOUR TURN"],
  ["TURNO ATUAL", "CURRENT TURN"],
  ["FIM DO TURNO", "END TURN"],
  ["ALIADOS", "ALLIES"],
  ["AÇÕES", "ACTIONS"],
  ["FAVORITOS", "FAVORITES"],
  ["Forma base", "Base Form"],
  ["Sem aura", "No Aura"],
  ["Sem Energy Charge", "No Energy Charge"],
  ["Novo Round", "New Round"],
  ["pronta", "ready"],
  ["pronto", "ready"]
]
  .sort((a, b) => b[0].length - a[0].length);

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
    if (!parent || parent.closest("script,style,textarea,code")) continue;
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

const DBU_SELECTOR = [
  ".dbu-attack-roll",
  ".dbu-aura-manager",
  ".dbu-aura-maintenance",
  ".dbu-combat-hud",
  "#dbu-combat-hud",
  ".dbua-system-dialog-content",
  ".dbua-system-status-table",
  ".combat-conditions-panel",
  ".dbu-gm-panel",
  ".dbu-combat-panel",
  ".dbu-auto-panel",
  ".dbu-auto-window",
  ".dbu-visual-config",
  "[class*='dbu-']",
  "[class*='dbua-']"
].join(",");

const DBU_TITLE_PATTERN = /DBU|Ataque|Attack|Defesa|Defense|Aura|Transform|Power Up|Combat Recovery|Grapple|Empower|Surge|Terrain Lift|Energy Charge|Intervene|Reflect|Duel|Maneuver|Manobra|Visual|Visuais|Recovery|Recupera|HUD|Combat|Combate/i;

function looksLikeDBU(root) {
  if (!root) return false;
  return root.matches?.(DBU_SELECTOR) || !!root.querySelector?.(DBU_SELECTOR);
}

function looksLikeDBUApplication(app, root) {
  if (looksLikeDBU(root)) return true;
  const title = String(app?.title || root?.querySelector?.(".window-title")?.textContent || "");
  return DBU_TITLE_PATTERN.test(title);
}

function translateRendered(app, html) {
  if (!isEnglish()) return;
  const root = rootElement(html) || rootElement(app);
  if (!root || !looksLikeDBUApplication(app, root)) return;
  const container = root.closest?.(".window-app,.application,.dialog") || root;
  translateElement(container);
}

function installHooks() {
  Hooks.on("renderDialog", translateRendered);
  Hooks.on("renderApplication", translateRendered);
  Hooks.on("renderApplicationV2", translateRendered);

  const translateChat = (_message, html) => {
    const root = rootElement(html);
    if (root && looksLikeDBU(root)) translateElement(root);
  };
  Hooks.on("renderChatMessage", translateChat);
  Hooks.on("renderChatMessageHTML", translateChat);
}

function installObserver() {
  if (observer || !document?.body) return;

  observer = new MutationObserver(mutations => {
    if (!isEnglish()) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (!(node instanceof HTMLElement)) continue;

        // Foundry notifications are plain DOM, not Applications.
        if (node.closest?.("#notifications") || node.matches?.(".notification")) {
          translateElement(node);
          continue;
        }

        const app = node.closest?.(".window-app,.application,.dialog") || (node.matches?.(".window-app,.application,.dialog") ? node : null);
        if (app) {
          const title = String(app.querySelector?.(".window-title")?.textContent || "");
          if (looksLikeDBU(app) || DBU_TITLE_PATTERN.test(title)) {
            translateElement(app);
            continue;
          }
        }

        if (looksLikeDBU(node)) {
          translateElement(node.closest?.(".window-app,.application,.dialog") || node);
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
      for (const el of document.querySelectorAll(DBU_SELECTOR)) {
        translateElement(el.closest?.(".window-app,.application,.dialog") || el);
      }
    });
  }

  globalThis.DBU_LOCALIZATION = {
    version: "1.9.4",
    currentLanguage,
    isEnglish,
    tr,
    translateElement
  };
  return globalThis.DBU_LOCALIZATION;
}
