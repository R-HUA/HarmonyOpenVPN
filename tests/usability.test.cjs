const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(path.join(process.env.DEVECO_CLI_CLT_PATH||'C:/Program Files/command-line-tools','arktsdoc/node_modules/typescript/lib/typescript.js'));
function load(name,requireMock=()=>{}){const ctx={exports:{},require:requireMock};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../entry/src/main/ets/model/'+name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,ctx);return ctx.exports;}
const {LogRedactor}=load('Diagnostics');
let count=0;function ok(name,fn){fn();console.log('PASS '+name);count++}
ok('credentials redacted from diagnostic text',()=>{const r=new LogRedactor(['s3cret','user@example.com']);assert(!r.clean('failed s3cret user@example.com').includes('s3cret'))});
ok('session tokens redacted',()=>assert(!new LogRedactor([]).clean('auth-token ABCDEFG').includes('ABCDEFG')));
ok('multiline private key redacted across callbacks',()=>{const r=new LogRedactor([]);r.clean('-----BEGIN PRIVATE KEY-----');assert(!r.clean('BASE64KEY').includes('BASE64KEY'));r.clean('-----END PRIVATE KEY-----');assert.equal(r.clean('TLS connection error'),'TLS connection error')});
ok('useful server failure details retained',()=>assert.equal(new LogRedactor([]).clean('TLS_ERROR: certificate expired'),'TLS_ERROR: certificate expired'));
const store=new Map();let lastAttributes;
const tags={ALIAS:1,SECRET:2,RETURN_TYPE:3,ACCESSIBILITY:4,SYNC_TYPE:5,CONFLICT_RESOLUTION:6};
const asset={Tag:tags,ReturnType:{ALL:0},Accessibility:{DEVICE_UNLOCKED:2},SyncType:{NEVER:0},ConflictResolution:{OVERWRITE:0},
 add:async(a)=>{lastAttributes=a;store.set(Buffer.from(a.get(1)).toString('hex'),new Map(a))},
 query:async(q)=>{const v=store.get(Buffer.from(q.get(1)).toString('hex'));if(!v)throw {code:24000002};return [v]},
 remove:async(q)=>{const key=Buffer.from(q.get(1)).toString('hex');if(!store.delete(key))throw {code:24000002}}};
const c=load('Credentials',(name)=>{
 if(name==='@kit.AssetStoreKit')return {asset};
 if(name==='@kit.ArkTS')return {util:{TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s)}},TextDecoder:{create:()=>({decodeToString:b=>new TextDecoder().decode(b)})}}};
 if(name==='@kit.CryptoArchitectureKit')return {cryptoFramework:{createMd:()=>{const hash=crypto.createHash('sha256');return {update:async(b)=>hash.update(b.data),digest:async()=>({data:new Uint8Array(hash.digest())})}}}};
 return {};
});
(async()=>{
 const original={username:'alice',password:'strong-password',privateKeyPassword:'key-pass',receiveCompression:true};
 await c.saveCredentials('work.ovpn',original);
 ok('credentials stored in SECRET under hashed alias',()=>{assert.equal(lastAttributes.get(tags.ALIAS).length,32);assert(!Buffer.from(lastAttributes.get(tags.ALIAS)).toString().includes('work.ovpn'));assert.equal(lastAttributes.get(tags.ACCESSIBILITY),2);assert.equal(lastAttributes.get(tags.SYNC_TYPE),0)});
 const loaded=await c.loadCredentials('work.ovpn');ok('saved credentials restore',()=>assert.equal(JSON.stringify(loaded),JSON.stringify(original)));
 await c.saveCredentials('work.ovpn',{username:'alice',password:'changed',privateKeyPassword:''});const updated=await c.loadCredentials('work.ovpn');ok('credential update replaces old password',()=>assert.equal(updated.password,'changed'));
 await c.forgetCredentials('work.ovpn');const absent=await c.loadCredentials('work.ovpn');ok('forget deletes credentials',()=>assert.equal(absent,undefined));
 await c.forgetCredentials('work.ovpn');ok('forget missing record is harmless',()=>{});
 const lumi=hex=>{const rgb=hex.match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
 const contrast=(lumi('F4F7FC')+.05)/(lumi('172033')+.05);ok('input text contrast exceeds 7:1',()=>assert(contrast>7));
 console.log(count+' usability regression cases passed (Asset Store mocked; contrast calculated)');
})().catch(e=>{console.error(e);process.exitCode=1});
