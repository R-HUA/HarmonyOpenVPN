const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const ts=require(path.join(process.env.DEVECO_CLI_CLT_PATH||'C:/Program Files/command-line-tools','arktsdoc/node_modules/typescript/lib/typescript.js'));
const source=fs.readFileSync(path.join(__dirname,'../entry/src/main/ets/model/NetworkMonitor.ts'),'utf8');
const handlers={},timers=new Map(),changes=[];let next=0,id=11,unregistered=0,query;
const observer={register:cb=>cb(),unregister:cb=>{unregistered++;cb()},on:(event,cb)=>handlers[event]=cb};
const connection={NetCap:{NET_CAPABILITY_INTERNET:12,NET_CAPABILITY_NOT_VPN:15},createNetConnection:spec=>{
 assert.equal(JSON.stringify(spec.netCapabilities.networkCap),'[12,15]');return observer;
},getAppNet:async()=>({netId:0}),setAppNet:async net=>{},getDefaultNet:()=>query?query():Promise.resolve({netId:id})};
const ctx={exports:{},require:n=>n==='@kit.NetworkKit'?{connection}:n==='./Diagnostics'?{errorText:e=>e.message}:{},
 setTimeout:cb=>{timers.set(++next,cb);return next},clearTimeout:key=>timers.delete(key)};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,ctx);
async function flush(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(cb=>cb());for(let i=0;i<12;i++)await Promise.resolve();}
(async()=>{
 const monitor=new ctx.exports.NetworkMonitor(online=>changes.push(online),()=>{});
 await monitor.start();await flush();assert.deepEqual(changes,[]);
 console.log('PASS physical network startup baseline does not reconnect');
 id=12;handlers.netAvailable();handlers.netLost();handlers.netCapabilitiesChange();await flush();
 assert.deepEqual(changes,[true]);console.log('PASS Wi-Fi to cellular burst triggers one reconnect');
 handlers.netCapabilitiesChange();await flush();assert.equal(changes.length,1);
 console.log('PASS unchanged physical default ignores unrelated notifications');
 id=0;handlers.netLost();await flush();assert.deepEqual(changes,[true,false]);
 id=13;handlers.netAvailable();await flush();assert.deepEqual(changes,[true,false,true]);
 console.log('PASS offline pause then network restoration resumes');
 let stale;query=()=>new Promise(resolve=>stale=resolve);handlers.netLost();await flush();
 query=undefined;id=14;handlers.netAvailable();stale({netId:0});await flush();
 assert.deepEqual(changes,[true,false,true,true]);console.log('PASS stale offline query cannot override a newer network');
 let finishBind;const bindings=[];
 connection.setAppNet=net=>{bindings.push(net.netId);return net.netId===15?new Promise(resolve=>finishBind=resolve):Promise.resolve()};
 id=15;handlers.netAvailable();await flush();assert.equal(changes.length,4);
 handlers.netCapabilitiesChange();await flush();assert.equal(changes.length,4);
 id=16;handlers.netAvailable();await flush();assert.deepEqual(bindings,[15]);
 finishBind();await flush();assert.deepEqual(bindings,[15,16]);assert.equal(changes.length,5);
 console.log('PASS binding finishes before reconnect; superseded binding never resumes core');
 handlers.netLost();monitor.stop();await flush();assert.equal(changes.length,5);assert.equal(unregistered,1);
 handlers.netAvailable();await flush();assert.equal(changes.length,5);
 await monitor.release();assert.equal(bindings.at(-1),0);
 console.log('PASS process network restored after monitor shutdown');
 console.log('PASS shutdown cancels queued and late events');
})().catch(e=>{console.error(e);process.exitCode=1});
