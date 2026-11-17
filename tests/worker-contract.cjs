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
 // The hash must be cleared for every analysis, before the board is rebuilt:
 // Rapfi keeps the transposition table across YXBOARD, so a warm hash would make a
 // repeated analysis of the same settings report a different score.
 {
  const firstClear=commands.indexOf('YXHASHCLEAR');
  const firstBoard=commands.findIndex(c=>c.startsWith('YXBOARD'));
  assert.ok(firstClear>=0,'analyze must send YXHASHCLEAR');
  assert.ok(firstClear<firstBoard,'YXHASHCLEAR must precede YXBOARD');
  await context.self.onmessage({data:{type:'analyze',id:7,side:2,timeMs:1000,multiPV:1,moves:[{x:5,y:4,color:1}]}});
  assert.equal(commands.filter(c=>c==='YXHASHCLEAR').length,2,'one YXHASHCLEAR per analyze');
  const lastClear=commands.lastIndexOf('YXHASHCLEAR');
  let lastBoard=-1;
  for(let i=commands.length-1;i>=0;i--) if(commands[i].startsWith('YXBOARD')){lastBoard=i;break;}
  assert.ok(lastClear<lastBoard,'YXHASHCLEAR must precede YXBOARD on repeat analysis');
 }
 for (const score of ['+M1','-M26']) {
  for (const line of ['INFO PV 0','INFO EVAL '+score,'INFO BESTLINE 4,14','INFO PV DONE']) opts.onReceiveStdout(line);
  const pv=events.filter(e=>e.type==='pv').at(-1);
  assert.equal(pv.scoreType,'mate');assert.equal(pv.score,score==='+M1'?1:-26);assert.equal(pv.id,7);
 }
 opts.onReceiveStdout('4,14');assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).move.y,14);
 assert.equal(events.at(-1).reason,'mate','a settled mate distance stops the search by itself');
 assert.equal(events.at(-1).depth,0,'no DEPTH line was reported in this stub');

 // Depth budget: INFO max_depth is written on every analysis, and omitting maxDepth
 // must restore the engine's own ceiling instead of inheriting the previous target.
 {
  const lastCommands=n=>commands.slice(-n);
  await context.self.onmessage({data:{type:'analyze',id:9,side:1,timeMs:1000,multiPV:1,maxDepth:24,moves:[{x:5,y:4,color:1}]}});
  assert.equal(commands.filter(c=>c==='INFO max_depth 24').length,1,'INFO max_depth carries the requested target');
  await context.self.onmessage({data:{type:'analyze',id:9,side:1,timeMs:1000,multiPV:1,moves:[{x:5,y:4,color:1}]}});
  assert.ok(lastCommands(8).includes('INFO max_depth 99'),'omitting maxDepth restores the ceiling');
  const reasons=[];
  // reached the target depth
  await context.self.onmessage({data:{type:'analyze',id:9,side:1,timeMs:1000,multiPV:1,maxDepth:30,moves:[{x:5,y:4,color:1}]}});
  for (const line of ['INFO PV 0','INFO DEPTH 30','INFO TOTALNODES 4387942','INFO EVAL 577','INFO BESTLINE 5,4','INFO PV DONE']) opts.onReceiveStdout(line);
  opts.onReceiveStdout('5,4'); reasons.push([events.at(-1).reason,events.at(-1).depth]);
  // cut short by the clock
  await context.self.onmessage({data:{type:'analyze',id:9,side:1,timeMs:1000,multiPV:1,maxDepth:30,moves:[{x:5,y:4,color:1}]}});
  for (const line of ['INFO PV 0','INFO DEPTH 12','INFO TOTALNODES 1000','INFO EVAL 20','INFO BESTLINE 5,4','INFO PV DONE']) opts.onReceiveStdout(line);
  opts.onReceiveStdout('5,4'); reasons.push([events.at(-1).reason,events.at(-1).depth]);
  assert.deepEqual(reasons,[['depth',30],['time',12]],'done.reason distinguishes depth from time');
 }
 console.log('Worker contract: white-to-move, passes, numeric coordinates, signed mates, hash clear, depth budget and stop reasons passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
