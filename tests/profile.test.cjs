const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = process.env.DEVECO_CLI_CLT_PATH || 'C:/Program Files/command-line-tools';
const ts = require(path.join(root, 'arktsdoc/node_modules/typescript/lib/typescript.js'));
const source = fs.readFileSync(path.join(__dirname,'../entry/src/main/ets/model/Profile.ts'),'utf8');
const output = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const context={exports:{}};vm.runInNewContext(output,context);
const {inlineProfile,optionTokens,safeProfileName}=context.exports;
const cases=[
 ['inline certificate unchanged',()=>assert.equal(inlineProfile('client\n<ca>\nPEM\n</ca>',[]),'client\n<ca>\nPEM\n</ca>')],
 ['quoted filenames and comments',()=>assert.equal(inlineProfile('ca "ca file.pem" # comment',[{name:'ca file.pem',text:'CERT'}]),'<ca>\nCERT\n</ca>')],
 ['TLS auth direction preserved',()=>assert.equal(inlineProfile('tls-auth ta.key 1',[{name:'ta.key',text:'KEY'}]),'key-direction 1\n<tls-auth>\nKEY\n</tls-auth>')],
 ['external password files never imported',()=>assert.equal(inlineProfile('auth-user-pass secret.txt',[{name:'secret.txt',text:'user\npassword'}]),'auth-user-pass')],
 ['embedded passwords rejected',()=>assert.throws(()=>inlineProfile('<auth-user-pass>\nuser\nsecret\n</auth-user-pass>',[]))],
 ['missing key rejected',()=>assert.throws(()=>inlineProfile('key missing.key',[]))],
 ['ambiguous key rejected',()=>assert.throws(()=>inlineProfile('key a.key',[{name:'a.key',text:'A'},{name:'a.key',text:'B'}]))],
 ['path traversal rejected',()=>assert.throws(()=>inlineProfile('ca ../ca.pem',[{name:'ca.pem',text:'CERT'}]))],
 ['unsafe destination rejected',()=>assert.throws(()=>safeProfileName('../config.ovpn'))],
 ['unterminated quote rejected',()=>assert.throws(()=>optionTokens('ca "hello'))],
 ['unterminated inline block rejected',()=>assert.throws(()=>inlineProfile('<key>\nSECRET',[]))],
 ['injected directive rejected',()=>assert.throws(()=>inlineProfile('key a.key',[{name:'a.key',text:'KEY\n</key>\nremote evil'}]))],
 ['BOM and CRLF normalized',()=>assert.equal(inlineProfile('\ufeffclient\r\nremote example.com 1194',[]),'client\nremote example.com 1194')],
 ['connection block processed',()=>assert.equal(inlineProfile('<connection>\nca ca.pem\n</connection>',[{name:'ca.pem',text:'CERT'}]),'<connection>\n<ca>\nCERT\n</ca>\n</connection>')],
 ['profile size bounded',()=>assert.throws(()=>inlineProfile('a'.repeat(1024*1024+1),[]))],
 ['binary profile rejected',()=>assert.throws(()=>inlineProfile('client\0',[]))]
];
for(const [name,test] of cases){test();console.log('PASS '+name)}
console.log(`${cases.length} profile regression cases passed`);
