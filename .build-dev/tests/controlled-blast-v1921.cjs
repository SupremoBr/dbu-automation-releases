// DBU 0.9.2 snapshot — Controlled Blast: Blast Profile, 5 TP, origin before Long Range (9+ Squares).
// Run: DBUA_TEST_ROOT=<package-root> node tests/controlled-blast-v1921.cjs
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {EventEmitter}=require("node:events");
const root=process.env.DBUA_TEST_ROOT || path.join(__dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const source=read("scripts/area-attack.js");
const previewCode=read("scripts/area-preview.js");
const manifest=JSON.parse(read("module.json"));
assert.equal(manifest.version,"1.9.21");
assert(source.includes("Controlled Blast: origem livre até 8 Squares"));
assert(source.includes('mode = remoteCone ? "origin-aim"'));
assert(source.includes("originAllowed: remoteCone ? point => controlledBlastOriginAllowed(attackerToken, point)"));
assert(source.indexOf("await previewMeasuredTemplate") < source.indexOf("template = await createTemplate"));

const emitter=()=>new EventEmitter();
const stage=emitter(); stage.toLocal=p=>p;
const keys=emitter(); const canvasView=emitter();
const hooks=emitter(); const drawings=[];
const preview={objects:[],addChild(o){o.parent=this;this.objects.push(o);},removeChild(o){this.objects=this.objects.filter(x=>x!==o);o.parent=null;}};
globalThis.window={addEventListener:(e,f)=>keys.on(e,f),removeEventListener:(e,f)=>keys.off(e,f)};
globalThis.Hooks={on:(e,f)=>{hooks.on(e,f);return f;},off:(e,f)=>hooks.off(e,f)};
class Document {constructor(data,{parent}){this.data={...data};this.parent=parent;}updateSource(value){Object.assign(this.data,value);}}
class Placeable {constructor(document){this.document=document;this.renderFlags={set(){}};}async draw(){drawings.push(this);}destroy(){this.destroyed=true;}}
globalThis.CONFIG={DBU:{profileData:{}},MeasuredTemplate:{documentClass:Document,objectClass:Placeable}};
globalThis.canvas={scene:{id:"test-scene",grid:{type:1}},stage,templates:{preview},grid:{getCenterPoint:p=>({x:Math.floor(p.x/100)*100+50,y:Math.floor(p.y/100)*100+50})},dimensions:{size:100,sceneRect:{contains:(x,y)=>x>=0&&y>=0&&x<=2000&&y<=2000}},app:{view:{addEventListener:(e,f)=>canvasView.on(e,f),removeEventListener:(e,f)=>canvasView.off(e,f)}}};
let warnings=0;
globalThis.ui={notifications:{info(){},warn(){warnings++;},error(message){throw Error(message);}}};
const evt=(x,y,button=0)=>({data:{global:{x,y}},button,stopPropagation(){}});
const ready=()=>new Promise(r=>setImmediate(r));
const importModule=s=>import("data:text/javascript;base64,"+Buffer.from(s).toString("base64"));
(async()=>{
  const uiModule=await importModule(previewCode);
  globalThis.__DBUPreview=uiModule;
  const area=await importModule(source.replace('import { previewMeasuredTemplate } from "./area-preview.js";','const { previewMeasuredTemplate } = globalThis.__DBUPreview;'));
  const blast={profile:"Blast",advantages:[{name:"Controlled Blast",ranks:1}]};
  const normal={profile:"Blast",advantages:[]};
  const withNoBlast={profile:"Explosion",advantages:[{name:"Controlled Blast"}]};
  assert.equal(area.getAreaSpec(blast).controlledBlast,true);
  assert.equal(area.getAreaSpec(normal).controlledBlast,undefined);
  assert.equal(area.getAreaSpec(withNoBlast).controlledBlast,undefined);
  assert.equal(area.normalizeAreaConfig({shape:"cone"},blast).controlledBlast,true);
  assert.equal(area.normalizeAreaConfig({shape:"ray"},blast).controlledBlast,false);
  const token={document:{x:100,y:100,width:1,height:1}};
  assert.equal(area.controlledBlastOriginAllowed(token,{x:950,y:150}),true,"8 Squares");
  assert.equal(area.controlledBlastOriginAllowed(token,{x:1050,y:150}),false,"9 Squares is Long Range");
  assert.equal(area.controlledBlastOriginAllowed({document:{x:100,y:100,width:2,height:2}},{x:1050,y:150}),true,"large token closest Square");
  assert.equal(area.controlledBlastOriginAllowed({document:{x:100,y:100,width:2,height:2}},{x:1150,y:150}),false);
  // First click fixes a valid Square, second click fixes direction.
  let p=uiModule.previewMeasuredTemplate({
    data:{t:"cone",x:150,y:150,direction:0,angle:90},
    mode:"origin-aim",originAllowed:point=>area.controlledBlastOriginAllowed(token,point)
  });
  await ready();
  stage.emit("pointermove",evt(1050,150));
  stage.emit("pointerdown",evt(1050,150)); // invalid at Long Range
  assert.equal(preview.objects[0].document.data.x,150,"invalid location cannot move origin");
  assert(warnings>=1);
  stage.emit("pointermove",evt(325,270));
  assert.equal(preview.objects[0].document.data.x,350);
  assert.equal(preview.objects[0].document.data.y,250);
  stage.emit("pointerdown",evt(325,270)); // locks origin
  stage.emit("pointermove",evt(350,550));
  assert.equal(preview.objects[0].document.data.x,350,"direction does not displace origin");
  assert.equal(preview.objects[0].document.data.direction,90);
  stage.emit("pointerdown",evt(350,550));
  const result=await p;
  assert.equal(result.confirmed,true);
  assert.equal(result.data.x,350);
  assert.equal(result.data.y,250);
  assert.equal(result.data.direction,90);
  assert.equal(preview.objects.length,0);
  // Esc after choosing origin: no Scene template created.
  p=uiModule.previewMeasuredTemplate({data:{t:"cone",x:150,y:150,direction:0},mode:"origin-aim",originAllowed:()=>true});
  await ready();
  stage.emit("pointermove",evt(250,150));
  stage.emit("pointerdown",evt(250,150));
  keys.emit("keydown",{key:"Escape",preventDefault(){},stopImmediatePropagation(){}});
  assert.equal((await p).confirmed,false);
  assert.equal(preview.objects.length,0);
  assert.equal(stage.listenerCount("pointerdown"),0);
  assert.equal(stage.listenerCount("pointermove"),0);
  assert.equal(keys.listenerCount("keydown"),0);
  assert(drawings.every(d=>d.destroyed),"no stray preview placeables");
  console.log("DBU Controlled Blast v1.9.21 tests: PASS (profile gate, 8-Square range, 2-stage Cone, cancel, cleanup)");
})().catch(e=>{console.error(e);process.exitCode=1;});
