// DBU Automation 0.9.2 — shared visual shell, independent Maneuver dialogs.
// Rendering only: actual costs and effects remain in each action handler.
const escape = v => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
  .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
function item(row){
  const label=escape(row.label);
  const value=row.valueHTML ?? escape(row.value);
  const hint=row.hint? `<small>${escape(row.hint)}</small>`:"";
  return `<div class="dbua-aw-row"><span class="dbua-aw-label">${row.icon?`<i class="${escape(row.icon)}"></i>`:""}${label}</span>
    <span class="dbua-aw-value ${row.tone==="orange"?"accent":row.tone==="green"?"positive":""}">${value}</span>${hint}</div>`;
}
function panel(heading,rows,variant=""){
  return `<section class="dbua-aw-panel ${variant}"><h4>${escape(heading)}</h4>
    <div class="dbua-aw-rows">${(rows||[]).map(item).join("")}</div></section>`;
}
export function renderActionWindow({
  actorName,actionName,type="STANDARD MANEUVER",icon="fas fa-fire",description="",
  status="",statusTone="neutral",cost="",usage="",conditions="",
  currentTitle="SITUAÇÃO ATUAL",current=[],effectTitle="EFEITOS DESTE USO",effects=[],
  preview=[],notes=[],extra="",help="",portrait=""
}={}){
  return `<div class="dbua-action-window">
    <header class="dbua-aw-hero">
      <div class="dbua-aw-hero-copy">
        <div class="dbua-aw-character">${escape(actorName)}</div>
        <div class="dbua-aw-title"><i class="${escape(icon)}"></i><span>${escape(actionName)}</span></div>
        <div class="dbua-aw-type">${escape(type)}</div>
      </div>
      ${portrait?`<img class="dbua-aw-portrait" src="${escape(portrait)}" alt="" />`:""}
    </header>
    <div class="dbua-aw-description">
      <p>${escape(description)}</p><span class="dbua-aw-status ${escape(statusTone)}">${escape(status)}</span>
    </div>
    <div class="dbua-aw-metrics">
      <div><small>CUSTO</small><strong>${escape(cost)}</strong></div>
      <div><small>USOS</small><strong>${escape(usage)}</strong></div>
      <div><small>REQUISITOS</small><strong>${escape(conditions||"Conforme a ação")}</strong></div>
    </div>
    <div class="dbua-aw-columns">${panel(currentTitle,current,"current")}${panel(effectTitle,effects,"effects")}</div>
    ${preview.length?`<section class="dbua-aw-preview"><h4><i class="fas fa-angle-double-right"></i> PRÉVIA DO RESULTADO</h4>
      ${preview.map(item).join("")}</section>`:""}
    ${extra?`<div class="dbua-aw-extra">${extra}</div>`:""}
    ${notes.length?`<section class="dbua-aw-notes"><h4><i class="fas fa-info-circle"></i> REGRAS IMPORTANTES</h4>
      <ul>${notes.map(x=>`<li>${escape(x)}</li>`).join("")}</ul></section>`:""}
    ${help?`<p class="dbua-aw-help">${escape(help)}</p>`:""}
  </div>`;
}
export const ACTION_WINDOW_DIALOG_OPTIONS={
  width:720,
  classes:["dbu-old","sheet","dbua-system-dialog","dbua-action-window-dialog"]
};
