// Run: node tests/area-preview-v1920.cjs
// Behaviour test using mocked Foundry canvas APIs; Foundry 12/13 table check remains required.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const root = process.env.DBUA_TEST_ROOT || path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "scripts/area-preview.js"), "utf8");
const area = fs.readFileSync(path.join(root, "scripts/area-attack.js"), "utf8");
const attack = fs.readFileSync(path.join(root, "scripts/attack.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8"));
assert(["1.9.20","1.9.21"].includes(manifest.version));
assert(area.includes('import { previewMeasuredTemplate } from "./area-preview.js";'));
assert(area.includes('const mode = forceAttackerOrigin ? "aim" : fixed ? "center" : "place";'));
assert(area.indexOf("if (cfg.useSelected)") < area.indexOf("await previewMeasuredTemplate"));
assert(area.indexOf("if (geo.cataclysmic)") < area.indexOf("await previewMeasuredTemplate"));
assert(area.indexOf("await previewMeasuredTemplate") < area.indexOf("template = await createTemplate"));
assert(!area.includes("waitCanvasClick("));
assert(area.includes("if (!cfg.keep)"));
assert(area.includes("targetsInTemplate(template, attackerToken, cfg)"));
assert(attack.includes("if (areaResolution?.cancelled) return null;"));

let created=0, destroyed=0, drawn=0;
const stage = new EventEmitter();
stage.toLocal = p => p;
const viewListeners = new EventEmitter();
const hooks = new EventEmitter();
const windowListeners = new EventEmitter();
globalThis.window = {addEventListener: (name,fn) => windowListeners.on(name,fn),removeEventListener:(name,fn) => windowListeners.off(name,fn)};
globalThis.Hooks = {on:(name,fn)=>{hooks.on(name,fn);return fn;},off:(name,fn)=>hooks.off(name,fn)};
class Doc {
  constructor(data, options) {this.data={...data};this.parent=options.parent;}
  updateSource(update){Object.assign(this.data,update);}
}
class Placeable {
  constructor(document){this.document=document;this.renderFlags={set() {}};}
  async draw(){drawn++;}
  destroy(){destroyed++;this.destroyed=true;}
}
const preview = {
  objects:[],
  addChild(obj){obj.parent=this;this.objects.push(obj);},
  removeChild(obj){this.objects=this.objects.filter(x=>x!==obj);obj.parent=null;}
};
globalThis.CONFIG={MeasuredTemplate:{documentClass:Doc,objectClass:Placeable}};
globalThis.canvas={
  scene:{id:"test-scene",grid:{type:1}},
  stage,
  templates:{preview},
  grid:{getCenterPoint:p=>({x:Math.floor(p.x/100)*100+50,y:Math.floor(p.y/100)*100+50})},
  dimensions:{size:100,sceneRect:{contains:(x,y)=>x>=0&&y>=0&&x<=1000&&y<=1000}},
  app:{view:{addEventListener:(name,fn)=>viewListeners.on(name,fn),removeEventListener:(name,fn)=>viewListeners.off(name,fn)}}
};
globalThis.ui={notifications:{info(){},error(m){throw Error(m)}}};
const imported='data:text/javascript;base64,'+Buffer.from(source).toString("base64");
const evt=(x,y,button=0)=>({
  data:{global:{x,y}},button,
  stopPropagation(){},
});
const ready = async () => new Promise(resolve => setImmediate(resolve));
(async()=>{
  const api=await import(imported);
  assert.deepEqual(api.snapTargetSquare({x:122,y:269},canvas.grid,canvas.dimensions,canvas.scene),{x:150,y:250});
  // Target Square follows the pointer and creates no persistent document.
  let p=api.previewMeasuredTemplate({data:{x:50,y:50,t:"circle",direction:0},mode:"place"});
  await ready();
  assert.equal(preview.objects.length,1);
  stage.emit("pointermove",evt(250,160));
  assert.deepEqual({x:preview.objects[0].document.data.x,y:preview.objects[0].document.data.y},{x:250,y:150});
  assert.equal(created,0);
  stage.emit("pointerdown",evt(250,160));
  let r=await p;
  assert.equal(r.confirmed,true);
  assert.equal(r.data.x,250);
  assert.equal(r.data.y,150);
  assert.equal(preview.objects.length,0);
  // Attacker-origin Line: location stays fixed, direction changes.
  p=api.previewMeasuredTemplate({data:{x:100,y:100,t:"ray",direction:0},mode:"aim"});
  await ready();
  stage.emit("pointermove",evt(100,300));
  assert.equal(preview.objects[0].document.data.x,100);
  assert(Math.abs(preview.objects[0].document.data.direction-90)<1e-6);
  stage.emit("pointerdown",evt(100,300));
  r=await p;
  assert.equal(r.confirmed,true);
  assert.equal(r.data.x,100);
  // Attacker centered Sphere can be confirmed without moving the cursor.
  p=api.previewMeasuredTemplate({data:{x:400,y:500,t:"circle"},mode:"center"});
  await ready();
  stage.emit("pointerdown",evt(710,810));
  r=await p;
  assert.equal(r.confirmed,true);
  assert.equal(r.data.x,400);
  assert.equal(r.data.y,500);
  // Escape has no scene write, removes preview/listeners.
  p=api.previewMeasuredTemplate({data:{x:50,y:50,t:"circle"},mode:"place"});
  await ready();
  windowListeners.emit("keydown",{key:"Escape",preventDefault(){},stopImmediatePropagation(){}});
  r=await p;
  assert.equal(r.confirmed,false);
  assert.equal(preview.objects.length,0);
  assert.equal(stage.listenerCount("pointerdown"),0);
  // Right click cancels, including when the previous template was confirmed.
  p=api.previewMeasuredTemplate({data:{x:50,y:50,t:"cone"},mode:"aim"});
  await ready();
  stage.emit("rightdown",evt(400,300,2));
  r=await p;
  assert.equal(r.confirmed,false);
  assert.equal(stage.listenerCount("pointermove"),0);
  // Scene change cancels and never commits.
  p=api.previewMeasuredTemplate({data:{x:50,y:50,t:"circle"},mode:"place"});
  await ready();
  hooks.emit("canvasTearDown");
  r=await p;
  assert.equal(r.confirmed,false);
  // Launching another placement safely supersedes the old one.
  p=api.previewMeasuredTemplate({data:{x:50,y:50,t:"circle"},mode:"place"});
  await ready();
  const next=api.previewMeasuredTemplate({data:{x:300,y:300,t:"circle"},mode:"center"});
  const prev=await p;
  assert.equal(prev.confirmed,false);
  await ready();
  stage.emit("pointerdown",evt(400,400));
  r=await next;
  assert.equal(r.confirmed,true);
  assert.equal(r.data.x,300);
  assert.equal(preview.objects.length,0);
  assert.equal(stage.listenerCount("pointerdown"),0);
  assert.equal(stage.listenerCount("pointermove"),0);
  assert.equal(windowListeners.listenerCount("keydown"),0);
  assert.equal(drawn,destroyed);
  console.log("DBU Area mouse preview v1.9.20: PASS (placement, direction, fixed, Esc, right click, scene, cleanup)");
})().catch(e=>{console.error(e);process.exitCode=1});
