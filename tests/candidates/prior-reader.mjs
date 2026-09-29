import {pathToFileURL} from 'node:url';import {join} from 'node:path';
const [checkout,root,mode]=process.argv.slice(2),load=path=>import(pathToFileURL(join(checkout,path)).href);
const {openWriter}=await load('dist/local/server/storage/writer.js'),{command,encode,EMPTY_EXPECTED_VERSIONS,prepare,enqueue,auth}=await load('tests/queue/helpers.mjs');
const w=await openWriter({root});try{if(mode==='create'){await w.protocolDefaults();await w.rememberClient(auth().sessionHash,'client_1',Date.now()+3600000);await w.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{}, {width:1024,height:1024})),w.epoch);await enqueue(w,(await prepare(w)).body);}console.log(JSON.stringify({document:await w.document('document_1'),queue:await w.queueView()}));}finally{await w.close();}
