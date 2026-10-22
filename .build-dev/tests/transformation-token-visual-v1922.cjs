// DBU Automation DEV v1.9.22: real TokenDocument lookup, snapshot and restoration.
// Run: DBUA_TEST_ROOT=/tmp/dbu-dev-package node .build-dev/tests/transformation-token-visual-v1922.cjs
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=process.env.DBUA_TEST_ROOT || path.join(__dirname,"..");
const read=f=>fs.readFileSync(path.join(root,f),"utf8");
const js=read("scripts/transformations/token-visual.js");
const transformations=read("scripts/transformations.js");
const visual=read("scripts/visual-config.js");
const events=read("scripts/transformations/events.js");
const main=read("scripts/main.js");
const manifest=JSON.parse(read("module.json"));
assert.equal(manifest.version,"1.9.22");
assert(main.includes('const VERSION = "1.9.22"'));
assert(transformations.includes('from "./transformations/token-visual.js"'));
assert(transformations.includes("for (const doc of transformationTokenDocuments(actor))"));
assert(transformations.includes("if (!actor.isToken)"));
assert(transformations.includes('base.tokenSnapshots?.[transformationTokenKey(doc)]'));
assert(transformations.includes("const appearance = transformationVisualConfig(actor, activePrepared)"));
assert(visual.indexOf("const exact = tokenFromContext(context") < visual.indexOf("const direct = context?.actor;"));
assert(visual.includes("if (direct?.actor === actor"));
assert(events.includes('String(actor?.uuid || actor?.id || "")'));

(async()=>{
  const visualModule=await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));
  const { transformationTokenDocuments:tokens, transformationTokenKey:key, transformationTokenSnapshot:snapshot, transformationTokenUpdate:update }=visualModule;
  const makeToken=(id,actor,src,width=1)=> {
    const doc={id,documentName:"Token",texture:{src,scaleX:1,scaleY:1},width,height:1,
      parent:{id:"S1"},updates:[],async update(changes){
        this.updates.push({...changes});
        if(changes["texture.src"])this.texture.src=changes["texture.src"];
        if(changes["texture.scaleX"]!=null)this.texture.scaleX=changes["texture.scaleX"];
        if(changes["texture.scaleY"]!=null)this.texture.scaleY=changes["texture.scaleY"];
        if(changes.width!=null)this.width=changes.width;
        if(changes.height!=null)this.height=changes.height;
      }};
    const token={id,actor,document:doc,controlled:true};
    doc.object=token;return token;
  };
  const shared={id:"base",uuid:"Actor.base",isToken:false};
  const a={id:"base",uuid:"Scene.S1.Token.A.Actor.base",isToken:true};
  const b={id:"base",uuid:"Scene.S1.Token.B.Actor.base",isToken:true};
  const tokA=makeToken("A",a,"token-a.webp");
  const tokB=makeToken("B",b,"token-b.webp");
  a.token=tokA.document;b.token=tokB.document;
  a.getActiveTokens=()=>[]; b.getActiveTokens=()=>[];
  assert.deepEqual(tokens(a),[tokA.document]);
  assert.deepEqual(tokens(b),[tokB.document]);
  assert.notEqual(key(tokA.document),key(tokB.document));
  const originalA=snapshot(tokA.document),originalB=snapshot(tokB.document);
  await tokA.document.update(update({token:"form-a.webp",gridScale:2},originalA));
  assert.equal(tokA.document.texture.src,"form-a.webp");
  assert.equal(tokA.document.width,2);
  assert.equal(tokB.document.texture.src,"token-b.webp");
  await tokA.document.update(update(null,originalA,{restoring:true}));
  assert.equal(tokA.document.texture.src,"token-a.webp");
  assert.equal(tokA.document.width,1);
  assert.equal(tokB.document.texture.src,originalB.src);
  assert(!tokens(a).includes(tokB.document));
  const linked={id:"linked",uuid:"Actor.linked",isToken:false};
  const t1=makeToken("C",linked,"custom-c.webp");
  const t2=makeToken("D",linked,"custom-d.webp",2);
  linked.getActiveTokens=()=>[t1,t2];
  assert.equal(tokens(linked).length,2);
  const originals=new Map(tokens(linked).map(d=>[key(d),snapshot(d)]));
  for(const doc of tokens(linked))await doc.update(update({token:"linked-form.webp",gridScale:2},originals.get(key(doc))));
  assert.equal(t1.document.width,2);
  assert.equal(t2.document.width,4);
  for(const doc of tokens(linked))await doc.update(update(null,originals.get(key(doc)),{restoring:true}));
  assert.equal(t1.document.texture.src,"custom-c.webp");
  assert.equal(t2.document.texture.src,"custom-d.webp");
  assert.equal(t2.document.width,2);
  console.log("DBU Transformation token visual v1.9.22 PASS: synthetic isolation, real TokenDocuments, linked updates, original image and footprint restore");
})().catch(e=>{console.error(e);process.exitCode=1;});
