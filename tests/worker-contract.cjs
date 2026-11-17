// Fast protocol adapter checks. Run: node tests/worker-contract.cjs
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../engine-worker.js'),'utf8');
const events=[], commands=[]; let opts;
const bytes = new ArrayBuffer(10062586);
const context={console, URL, Uint8Array, ArrayBuffer, Math, Number, Set, String,
  self:{location:{href:'https://example.test/repo/engine-worker.js'},crossOriginIsolated:false},
  postMessage:m=>events.push(m),
  fetch:async()=>({ok:true,headers:{get:()=>String(bytes.byteLength)},arrayBuffer:async()=>bytes}),
  importScripts:()=>{},
  Rapfi:async o=>{opts=o;return {sendCommand:c=>commands.push(c)}}};
vm.createContext(context); vm.runInContext(source,context);
(async()=>{
 await context.self.onmessage({data:{type:'init'}});
 assert.equal(events.at(-1).type,'ready');
 await context.self.onmessage({data:{type:'analyze',id:7,side:2,timeMs:1000,multiPV:2,moves:[{x:5,y:4,color:1},{x:6,y:4,color:2}]}});
 const board=commands.find(c=>c.startsWith('YXBOARD'));
 assert.equal(board,'YXBOARD\n5,4,2\n6,4,1\n-1,-1,2\nDONE');
 for (const score of ['+M1','-M26']) {
  for (const line of ['INFO PV 0','INFO EVAL '+score,'INFO BESTLINE 4,14','INFO PV DONE']) opts.onReceiveStdout(line);
  const pv=events.filter(e=>e.type==='pv').at(-1);
  assert.equal(pv.scoreType,'mate');assert.equal(pv.score,score==='+M1'?1:-26);assert.equal(pv.id,7);
 }
 opts.onReceiveStdout('4,14');assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).move.y,14);
 console.log('Worker contract: white-to-move, passes, numeric coordinates and signed mates passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
