/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Rapfi worker adapter; see LICENSE and engine/COPYING.txt. */
'use strict';
let engine = null, activeId, currentPV = null, bestMove = null, mode = 'single', threads = 1;
// Per-analysis bookkeeping for the `reason` field on `done`.
let lastDepth = 0, mateSeen = false, targetDepth = 0;
const emit = (type, fields = {}) => postMessage({type, ...fields});
function output(line) {
  if (!line) return;
  if (line.startsWith('INFO ')) emit('log', {id:activeId, message:line});
  if (line.startsWith('ERROR')) { emit('error', {id:activeId, message:line}); return; }
  if (line.startsWith('INFO ')) {
    const [, key, ...parts] = line.split(' '), value = parts.join(' ');
    if (key === 'PV' && value !== 'DONE') currentPV = {index:Number(value)+1, pv:[]};
    else if (key === 'PV' && value === 'DONE' && currentPV) {
      const p = currentPV;
      currentPV = null;
      // A block without a best line is an iteration the timeout interrupted: it has no move
      // to show and its depth/nodes would advance the metric strip past the last complete
      // iteration, so rows and metrics would disagree. Drop it at the source.
      if (!p.pv || !p.pv.length) return;
      if (p.depth != null) lastDepth = p.depth;
      if (p.scoreType === 'mate') mateSeen = true;
      emit('pv', {id:activeId, ...p, scoreType:p.scoreType || 'eval'});
      emit('stats', {id:activeId, depth:p.depth, nodes:p.nodes, timeMs:p.timeMs, nps:p.nps});
    } else if (currentPV) {
      const keys = {DEPTH:'depth', SELDEPTH:'selDepth', EVAL:'score', WINRATE:'winrate', TOTALNODES:'nodes', TOTALTIME:'timeMs', SPEED:'nps'};
      if (key === 'EVAL' && /^[+-]?M\d+$/.test(value)) { currentPV.scoreType='mate'; currentPV.score=Number(value.replace('M','')); }
      else if (keys[key]) currentPV[keys[key]] = Number(value);
      if (key === 'BESTLINE') currentPV.pv = parts.map(s => {let [x,y]=s.split(',').map(Number); return {x,y};}).filter(p=>Number.isInteger(p.x)&&Number.isInteger(p.y)&&p.x>=0&&p.y>=0);
    }
    return;
  }
  const m = /^(\d+),(\d+)$/.exec(line.trim());
  if (m) {
    bestMove={x:+m[1],y:+m[2]};
    // depth: the iteration budget was the limiting factor; mate: the engine stopped on its
    // own because a mate distance is settled; time: the wall-clock cap cut the search short.
    const reason = targetDepth > 0 && lastDepth >= targetDepth ? 'depth' : (mateSeen ? 'mate' : 'time');
    emit('done',{id:activeId,move:bestMove,reason,depth:lastDepth});
    return;
  }
  emit('log', {id:activeId, message:line});
}
async function init(d) {
  mode = d.mode === 'multi' && self.crossOriginIsolated ? 'multi' : 'single';
  threads = mode === 'multi' ? Math.max(2,Math.min(8,Math.floor(Number(d.threads)||2))) : 1;
  if (engine) { emit('ready',{mode,threads,version:'0.44.1 (1387d113)',model:'mix9svqfreestyle_bsmix.bin.lz4',simd:true}); return; }
  // The page hands over the weight package when it already has it, so restarting a
  // worker (stop / thread switch) does not fetch and unpack 10 MB again.
  const dataURL = new URL('./engine/rapfi-single-simd128.data', self.location.href).href;
  if (d.data instanceof ArrayBuffer && d.data.byteLength > 0) {
    emit('status', {message:'正在初始化引擎…'});
    return finishInit(d.data, dataURL);
  }
  emit('status', {message:'正在加载 Rapfi 和神经网络…'});
  const response = await fetch(dataURL);
  if (!response.ok) throw new Error('无法加载神经网络：HTTP ' + response.status);
  const total = Number(response.headers.get('content-length')) || 10062586;
  let data;
  if (response.body && response.body.getReader) {
    const reader=response.body.getReader(), chunks=[]; let loaded=0, reported=0;
    while (true) { const {done,value}=await reader.read(); if(done) break; chunks.push(value); loaded+=value.length;
      if (loaded-reported >= 524288 || loaded===total) { reported=loaded; emit('status',{message:`正在加载神经网络 ${loaded.toLocaleString()} / ${total.toLocaleString()} 字节`,loaded,total}); }
    }
    data = new Uint8Array(loaded); let offset=0; for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
    data=data.buffer;
  } else data=await response.arrayBuffer();
  if (data.byteLength !== 10062586) throw new Error('神经网络数据不完整。');
  return finishInit(data, dataURL);
}
// Instantiate Rapfi with an already-loaded weight package. Split out so a restart can
// reuse the bytes the page cached instead of going back through fetch().
async function finishInit(data, dataURL) {
  const script = new URL('./engine/rapfi-' + mode + '-simd128.js', self.location.href).href;
  importScripts(script);
  engine = await Rapfi({arguments:[], getPreloadedPackage:()=>data, mainScriptUrlOrBlob:script, locateFile: path => new URL('./engine/' + path.replace('rapfi-multi-simd128.data','rapfi-single-simd128.data'), self.location.href).href,
    onReceiveStdout:output, onReceiveStderr:line=>emit('log',{id:activeId,message:line}),
    onAbort:reason=>emit('error',{id:activeId,message:String(reason)})});
  engine.sendCommand('START 15');
  engine.sendCommand('INFO rule 0');
  engine.sendCommand('INFO thread_num '+threads);
  engine.sendCommand('INFO show_detail 2');
  emit('ready',{mode,threads,version:'0.44.1 (1387d113)',model:'mix9svqfreestyle_bsmix.bin.lz4',simd:true});
}
function analyze(d) {
  if (!engine) throw new Error('Engine is not ready.');
  const side = Number(d.sideToMove ?? d.side);
  if (![1,2].includes(side)) throw new Error('Specify side to move as 1 (black) or 2 (white).');
  if (!Array.isArray(d.moves)) throw new Error('moves must be an array.');
  const stones = [[],[]], occupied = new Set();
  for (const m of d.moves) {
    if (![1,2].includes(m.color) || !Number.isInteger(m.x)||!Number.isInteger(m.y)||m.x<0||m.x>14||m.y<0||m.y>14) throw new Error('Invalid stone.');
    const k=m.x+','+m.y; if (occupied.has(k)) throw new Error('Two stones occupy the same point.'); occupied.add(k);
    stones[m.color-1].push(m);
  }
  // Arrange physical black first and alternate when possible. Rapfi's BOARD protocol
  // interprets its first listed move as physical black and inserts passes as needed.
  const seq=[]; let i=0,j=0;
  if (!stones[0].length && stones[1].length) seq.push({x:-1,y:-1,color:1});
  while(i<stones[0].length || j<stones[1].length) {
    if(i<stones[0].length) seq.push(stones[0][i++]);
    if(j<stones[1].length) seq.push(stones[1][j++]);
  }
  const next = seq.length ? 3-seq[seq.length-1].color : 1;
  if (next !== side) seq.push({x:-1,y:-1,color:next});
  activeId=d.id; currentPV=null; bestMove=null;
  const time = Number(d.timeMs); const limit = time>0 ? Math.max(100,Math.min(86400000,Math.floor(time))) : 86400000;
  const multipv = Math.max(1,Math.min(20,Math.floor(Number(d.multiPV)||1)));
  const hash = Math.max(16,Math.min(1024,Math.floor(Number(d.hashMB)||64)));
  // 0/absent means "no depth target". INFO options persist inside the worker, so the
  // value has to be written on every analysis or a previous target would leak into the
  // next one. 99 is the engine's own search ceiling (max_search_depth in config.toml).
  const reqDepth = Math.floor(Number(d.maxDepth)||0);
  targetDepth = reqDepth>0 ? Math.max(2,Math.min(99,reqDepth)) : 0;
  lastDepth = 0; mateSeen = false;
  engine.sendCommand('INFO timeout_turn '+limit);
  engine.sendCommand('INFO timeout_match 2000000000');
  engine.sendCommand('INFO max_memory '+(hash*1024*1024));
  engine.sendCommand('INFO max_depth '+(targetDepth||99));
  // YXBOARD rebuilds the position but leaves the transposition table intact, so a
  // repeated analysis of the same position would silently start from the previous
  // search's hash and report a different score for identical settings. Clear it.
  engine.sendCommand('YXHASHCLEAR');
  engine.sendCommand('YXBOARD\n'+seq.map(m=>`${m.x},${m.y},${m.color===side?1:2}`).join('\n')+'\nDONE');
  engine.sendCommand('YXNBEST '+multipv);
}
self.onmessage = async ({data:d}) => { try {
  if (d.type==='init') await init(d);
  else if (d.type==='analyze') analyze(d);
  else if (d.type==='stop') emit('status',{message:'Stop by terminating this worker.'});
} catch(e) { emit('error',{id:d?.id,message:e?.message || String(e)}); } };
