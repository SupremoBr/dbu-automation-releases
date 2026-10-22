export const HUD_V2_TABS=[
  {id:"standard",label:"PADRÃO",icon:"fas fa-fist-raised"},
  {id:"counter",label:"COUNTER",icon:"fas fa-shield-alt"},
  {id:"instant",label:"INSTANT",icon:"fas fa-bolt"},
  {id:"favorites",label:"FAVORITOS",icon:"fas fa-star"}
];
export const HUD_V2_ACTIONS=[
  {id:"attack",tab:"standard",label:"Ataque",icon:"fas fa-crosshairs",cost:"1 Action · Ki variável",mode:"automática",method:"attack",detail:"Attack Core existente. Escolha ataque e alvo; o Ki e a Capacity são resolvidos pela automação."},
  {id:"power",tab:"standard",label:"Power Up",icon:"fas fa-fire",cost:"1 Action",mode:"automática",maneuver:"powerUp",detail:"Usa o registro Standard Maneuvers e seus limites de Power Stacks."},
  {id:"energy",tab:"standard",label:"Energy Charge",icon:"fas fa-bolt",cost:"1 Action · 2(bT) Ki",mode:"automática",maneuver:"energyCharge",detail:"Automação existente de Energy Charge com tipos permitidos."},
  {id:"grapple",tab:"standard",label:"Grapple",icon:"fas fa-hand-rock",cost:"1 Action",mode:"automática",maneuver:"grapple",detail:"Grapple e Clash pelo fluxo integrado."},
  {id:"movement",tab:"standard",label:"Movement",icon:"fas fa-running",cost:"1 Action",mode:"assistida",maneuver:"movement",detail:"Registra a manobra; o deslocamento do token é manual."},
  {id:"recovery",tab:"standard",label:"Combat Recovery",icon:"fas fa-heart",cost:"mínimo 2 Actions",mode:"automática",maneuver:"combatRecovery",detail:"Recuperação de combate existente, com as condições e limites do sistema."},
  {id:"standard-all",tab:"standard",label:"Outras manobras",icon:"fas fa-th-large",cost:"Catálogo completo",mode:"integrada",method:"standard",detail:"Abre o menu completo, incluindo as manobras assistidas."},
  {id:"defend",tab:"counter",label:"Defend / Dodge / Guard",icon:"fas fa-shield-alt",cost:"Counter · contextual",mode:"contextual",method:"panel",detail:"Mostra defesas pendentes e permite selecionar as opções válidas."},
  {id:"intervene",tab:"counter",label:"Intervene / Reflect",icon:"fas fa-people-arrows",cost:"Counter · contextual",mode:"contextual",method:"panel",detail:"Encaminha para oportunidades de intervenção e reflexão existentes."},
  {id:"duel",tab:"counter",label:"Duel / Exploit",icon:"fas fa-bolt",cost:"Reação · contextual",mode:"contextual",method:"counter-preview",detail:"Reações disponíveis apenas quando o gatilho for válido."},
  {id:"transform",tab:"standard",label:"Transformação",icon:"fas fa-dragon",cost:"1 Action · regra DBU 0.9.2",mode:"integrada",method:"transform",detail:"Transformation Maneuver é Standard. A manutenção e a saída da forma usam o fluxo de transformações já implementado."},
  {id:"aura",tab:"instant",label:"Signature Aura",icon:"fas fa-sun",cost:"Ki conforme Aura",mode:"integrada",method:"aura",detail:"Ativação e desativação pela automação existente."},
  {id:"surge",tab:"instant",label:"Surge",icon:"fas fa-meteor",cost:"Instant · limitado",mode:"integrada",method:"surge",detail:"Executa a função Surge existente."},
  {id:"terrain",tab:"instant",label:"Terrain Lift",icon:"fas fa-mountain",cost:"Instant · contextual",mode:"integrada",method:"terrainLift",detail:"Abre o Terrain Lift já implementado."},
  {id:"instant-all",tab:"instant",label:"Outras Instant",icon:"fas fa-th-large",cost:"Catálogo completo",mode:"integrada",method:"instant-preview",detail:"Mostra opções disponíveis e suas instruções assistidas."}
];
const byId=new Map(HUD_V2_ACTIONS.map(x=>[x.id,x]));
export const hudV2Action=id=>byId.get(String(id||""))||null;
export function hudV2Actions(tab,favorites=[]){
  if(tab==="favorites")return favorites.map(id=>byId.get(id)).filter(Boolean);
  return HUD_V2_ACTIONS.filter(a=>a.tab===tab);
}
const esc=x=>String(x??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
export function hudV2Panel({tab,selected,favorites=[],pending=0}={}){
  if(!tab)return "";
  const actions=hudV2Actions(tab,favorites);
  const active=actions.find(x=>x.id===selected)||actions[0]||null;
  const name=HUD_V2_TABS.find(x=>x.id===tab)?.label||"";
  const items=actions.map(a=>{
    const current=active?.id===a.id;
    const favorite=favorites.includes(a.id);
    return `<div class="dbua-v2-entry${current?" selected":""}">
      <button type="button" class="dbua-v2-action-choice" data-dbu-hud-action="hud-select" data-hud-id="${esc(a.id)}">
        <i class="${esc(a.icon)}"></i><span><b>${esc(a.label)}</b><small>${esc(a.cost)}</small></span>
      </button>
      <button type="button" class="dbua-v2-star${favorite?" on":""}" data-dbu-hud-action="hud-favorite" data-hud-id="${esc(a.id)}"
       aria-label="${favorite?"Remover dos":"Adicionar aos"} favoritos">${favorite?"★":"☆"}</button>
    </div>`;
  }).join("");
  return `<section class="dbua-v2-panel" aria-label="${esc(name)}" id="dbua-v2-action-panel">
    <div class="dbua-v2-panel-head"><strong>${esc(name)}</strong><span>${actions.length} opções${tab==="counter"&&pending?` · ${pending} pendência(s)`:""}</span>
      <button type="button" data-dbu-hud-action="hud-tab-close" title="Fechar menu"><i class="fas fa-times"></i></button></div>
    <div class="dbua-v2-panel-body">
      <div class="dbua-v2-list">${items||'<div class="dbua-v2-empty">Nenhum favorito. Marque ☆ em outra aba.</div>'}</div>
      <aside class="dbua-v2-detail">${active?`
        <div class="dbua-v2-detail-heading"><i class="${esc(active.icon)}"></i><div><b>${esc(active.label)}</b>
        <small>${esc(active.mode)} · ${esc(active.cost)}</small></div></div>
        <p>${esc(active.detail)}</p>
        <button type="button" class="dbua-v2-execute" data-dbu-hud-action="hud-run" data-hud-id="${esc(active.id)}">
        <i class="fas fa-play"></i> ${active.mode==="assistida"?"ABRIR RESOLUÇÃO":"EXECUTAR / ABRIR"}</button>`:
        '<p>Selecione uma ação para ver a descrição.</p>'}</aside>
    </div>
  </section>`;
}
export function hudV2Tabs(activeTab,pending=0){
  return HUD_V2_TABS.map(t=>`<button type="button" class="dbua-v2-tab${activeTab===t.id?" active":""}${t.id==="counter"&&pending?" attention":""}"
    data-dbu-hud-action="hud-tab" data-hud-tab="${t.id}" aria-expanded="${activeTab===t.id}" aria-controls="dbua-v2-action-panel">
    <i class="${t.icon}"></i><span>${t.label}</span>${t.id==="counter"&&pending?`<b>${pending}</b>`:""}</button>`).join("");
}
