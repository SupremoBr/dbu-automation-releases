const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");

async function main() {
  const toModule = async code => import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const upkeep = await toModule(readFileSync("/tmp/dbu-dev-package/scripts/core/transformation-upkeep.js","utf8"));
  globalThis.__dbuaTestUpkeep = upkeep;
  globalThis.__dbuaTestRevertAll = async actor => {
    for(const t of actor.system.transformations) t.active=false;
    return true;
  };
  const source=readFileSync("/tmp/dbu-dev-package/scripts/core/transformation-decision.js","utf8")
    .replace('import { MODULE_SOCKET } from "./module-id.js";','const MODULE_SOCKET="module.dbu-automation-dev";')
    .replace('import { drainingForActor, upkeepTurnKey, applyTransformationTurnUpkeep } from "./transformation-upkeep.js";',
      'const {drainingForActor,upkeepTurnKey,applyTransformationTurnUpkeep}=globalThis.__dbuaTestUpkeep;')
    .replace('import { revertAll } from "../transformations.js";',
      'const revertAll=globalThis.__dbuaTestRevertAll;');
  const mod=await toModule(source);
  let seq=0, continuation=0, emitHandler;
  const messages=new Map();
  const actor = tokenId => ({
    id:"shared",token:{id:tokenId},name:"Boneco",flags:{},
    system:{
      transformations:[{active:true,name:"Forma",transformationType:"form_alternate"}],
      aspectEffects:{drainingKiPerTurn:9},
      kiPool:{value:35},status:{maxCapacity:20,capacitySpent:5},conditions:[]
    },
    testUserPermission(user,permission){return user.id==="owner" && permission==="OWNER";},
    getFlag(_scope,key){return this.flags[key];},
    async setFlag(_scope,key,value){this.flags[key]=value;},
    async update(updates) {
      for(const [key,value] of Object.entries(updates)){
        if(key==="system.kiPool.value")this.system.kiPool.value=value;
        if(key==="system.conditions")this.system.conditions=value;
        if(key==="system.transformations")this.system.transformations=value;
        if(key.startsWith("flags.world."))this.flags[key.substring(12)]=value;
      }
    }
  });
  const first=actor("t1"), second=actor("t2");
  const one={id:"one",tokenId:"t1",actor:first};
  const two={id:"two",tokenId:"t2",actor:second};
  const combat={id:"comb",round:2,turn:0,combatant:one,combatants:{
    get:id=>id==="one"?one:id==="two"?two:undefined
  }};
  const users=new Map([
    ["owner",{id:"owner",active:true,isGM:false,character:null}],
    ["gm",{id:"gm",active:true,isGM:true,character:null}]
  ]);
  globalThis.game={
    user:users.get("gm"),
    users:{contents:[...users.values()],get:id=>users.get(id)},
    combats:{get:id=>id===combat.id?combat:null},
    combat,
    messages:{get:id=>messages.get(id)},
    socket:{on:(_channel,handler)=>{emitHandler=handler;},off:()=>{},emit:(_channel,data)=>emitHandler?.(data)}
  };
  globalThis.ChatMessage={
    getSpeaker:()=>({}),
    async create(data){
      const id="msg"+(++seq);
      const msg={
        id,content:data.content,whisper:data.whisper,flags:data.flags,
        getFlag(scope,key){return this.flags?.[scope]?.[key]},
        async update(changes){
          if(changes.content)this.content=changes.content;
          if(changes["flags.world.dbuaTransformationDecision"])
            this.flags.world.dbuaTransformationDecision=changes["flags.world.dbuaTransformationDecision"];
        }
      };
      messages.set(id,msg);
      return msg;
    }
  };
  globalThis.foundry={utils:{deepClone:v=>structuredClone(v)}};
  globalThis.ui={notifications:{warn:()=>{},error:x=>{throw new Error("Unexpected upkeep error: "+x)}}};
  globalThis.document={addEventListener:()=>{},removeEventListener:()=>{}};
  globalThis.Hooks={on:()=>1,off:()=>{}};
  mod.initializeTransformationDecision({
    isPrimaryGM:()=>true,
    onContinue:async()=>{continuation++;}
  });
  assert.equal(await mod.requestTransformationDecision(combat,one),true);
  assert.equal(first.system.kiPool.value,35,"no automatic charge before answer");
  assert.equal(second.system.kiPool.value,35);
  assert.equal(seq,1);
  assert.deepEqual(messages.get("msg1").whisper,["owner"]);
  assert.equal(await mod.requestTransformationDecision(combat,one),true);
  assert.equal(seq,1,"no duplicate card for same turn");
  await emitHandler({type:"dbuaTransformationChoice",messageId:"msg1",choice:"keep",userId:"owner"});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(first.system.kiPool.value,26,"keeping transformation charges exactly 9 Ki");
  assert.equal(first.system.status.capacitySpent,5,"Draining is not a capacity spend");
  assert.equal(continuation,1,"native maintenance stress continues only after paying");
  assert.equal(messages.get("msg1").getFlag("world","dbuaTransformationDecision").status,"keep");
  await emitHandler({type:"dbuaTransformationChoice",messageId:"msg1",choice:"keep",userId:"owner"});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(first.system.kiPool.value,26,"a replay cannot charge a second time");

  combat.combatant=two;
  assert.equal(await mod.requestTransformationDecision(combat,two),true);
  assert.equal(seq,3,"second token also has a private decision card (plus upkeep confirmation)");
  const pending=[...messages.values()].filter(m=>m.getFlag("world","dbuaTransformationDecision")?.status==="pending");
  assert.equal(pending.length,1);
  const exitMessage=pending[0];
  assert.equal(second.system.kiPool.value,35);
  await emitHandler({type:"dbuaTransformationChoice",messageId:exitMessage.id,choice:"exit",userId:"owner"});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(second.system.kiPool.value,35,"leaving does not charge upkeep");
  assert.equal(second.system.transformations[0].active,false);
  assert.equal(continuation,1,"exiting skips maintenance stress");
  assert.equal(exitMessage.getFlag("world","dbuaTransformationDecision").status,"exit");
  console.log("Transformation upkeep owner decision tests: PASS");
}
main().catch(error=>{console.error(error);process.exitCode=1});
