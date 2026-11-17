/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const preset = {black:['F10','H8','I8','J8','H7','J6','H5'],white:['K8','I7','J7','K7','G6','H6','I6'],side:'black'};
  let board = Array(225).fill(0), side = 1, mode = 'black', history = [], worker, ready = false, searching = false, generation = 0, activeId = null, pvs = new Map(), preview = null, logs = [], renderTimer = null;
  const idx = (x,y) => y*15+x;
  const name = (x,y) => String.fromCharCode(65+x)+(15-y);
  function parsePoint(s){if(typeof s !== 'string'|| !/^[A-O](?:[1-9]|1[0-5])$/i.test(s)) throw Error('无效坐标：'+s);const x=s.toUpperCase().charCodeAt(0)-65,y=15-Number(s.slice(1));return {x,y};}
  function toast(msg){const e=$('toast');e.textContent=msg;e.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>e.classList.remove('show'),2600);}
  function snapshot(){return {board:board.slice(),side};}
  function remember(){history.push(snapshot());if(history.length>300)history.shift();}
  function stopSearch(){if(searching && worker){worker.terminate();worker=null;ready=false;searching=false;activeId=null;$('engine-dot').className='status-dot';$('engine-status').textContent='正在重新准备引擎';updateButtons();$('search-state').textContent='已停止';startWorker();}}
  function invalidate(){stopSearch();generation++;pvs.clear();preview=null;clearTimeout(renderTimer);renderTimer=null;renderResults();$('metric-depth').textContent='—';$('metric-nodes').textContent='—';$('metric-time').textContent='—';$('metric-speed').textContent='—';$('search-state').textContent='等待分析';}
  function changed(){invalidate();renderBoard();}
  function renderBoard(){const grid=$('board');grid.replaceChildren();for(const x of [3,7,11])for(const y of [3,7,11]){const s=document.createElement('i');s.className='star';s.style.left=(6.25+x*6.25)+'%';s.style.top=(6.25+y*6.25)+'%';grid.append(s);}for(let n=0;n<15;n++){for(const [x,y,t] of [[n,14.8,String.fromCharCode(65+n)],[-.55,14-n,String(n+1)]]){const c=document.createElement('span');c.className='coord';c.style.left=(6.25+x*6.25)+'%';c.style.top=(6.25+y*6.25)+'%';c.textContent=t;grid.append(c);}}
    const ghost=new Map();if(preview){for(let i=0;i<preview.step;i++){const p=preview.pv[i];if(p && !board[idx(p.x,p.y)])ghost.set(idx(p.x,p.y),{color:i%2?3-side:side,number:i+1});}}
    for(let y=0;y<15;y++)for(let x=0;x<15;x++){const i=idx(x,y),b=document.createElement('button');b.className='intersection';b.style.left=(6.25+x*6.25)+'%';b.style.top=(6.25+y*6.25)+'%';b.setAttribute('role','gridcell');b.setAttribute('aria-label',name(x,y)+(board[i]?(board[i]===1?' 黑棋':' 白棋'):' 空'));const g=ghost.get(i);if(board[i]||g){const piece=document.createElement('span');piece.className='piece '+((board[i]||g.color)===1?'black':'white')+(g?' ghost':'');if(g){const em=document.createElement('em');em.textContent=g.number;piece.append(em);}b.append(piece);}b.addEventListener('click',()=>place(x,y));grid.append(b);}
    const black=board.filter(v=>v===1).length,white=board.filter(v=>v===2).length;$('black-count').textContent=black;$('white-count').textContent=white;$('stone-count').textContent=(black+white)+' 子';$('side').value=side===1?'black':'white';$('undo').disabled=!history.length;
  }
  function place(x,y){const i=idx(x,y);if(mode==='erase'){if(!board[i])return;remember();board[i]=0;}else{const color=mode==='alternate'?side:mode==='black'?1:2;if(board[i]===color)return;remember();board[i]=color;if(mode==='alternate')side=3-side;}changed();}
  function setPosition(data,save=true){if(!data||!Array.isArray(data.black)||!Array.isArray(data.white)||!['black','white'].includes(data.side))throw Error('需要 black、white 坐标数组和 side 行棋方');const next=Array(225).fill(0);for(const [list,color] of [[data.black,1],[data.white,2]])for(const item of list){const {x,y}=parsePoint(item);if(next[idx(x,y)])throw Error('坐标重复：'+item);next[idx(x,y)]=color;}if(save)remember();board=next;side=data.side==='black'?1:2;changed();}
  function position(){const out={version:1,black:[],white:[],side:side===1?'black':'white'};board.forEach((v,i)=>{if(v)out[v===1?'black':'white'].push(name(i%15,Math.floor(i/15)));});return out;}
  function updateButtons(){$('analyze').disabled=!ready||searching;$('stop').disabled=!searching;}
  const REASON_TEXT={depth:'已达目标深度',mate:'已确定胜负距离',time:'被时间截断，结果可能因设备不同'};
  function reasonText(r){return REASON_TEXT[r]||'分析完成';}
  function syncHints(){const t=Number($('time').value),d=Number($('maxdepth').value)||0,th=Number($('threads').value)||1;
    $('thread-hint').hidden=th<=1;
    let msg=d>0?`达到目标深度 ${d} 层即停；时间上限只作保险。`:'不限深度，按时间上限截止，结果会随设备速度变化。';
    if(t===15)msg+=' 15 秒属快速浏览：冷启动（哈希已清）时示例局面只到约 54 万节点，给 +577 而非胜负距离。';
    if(t===5)msg+=' 5 秒只够粗看。';
    $('budget-hint').textContent=msg;}
  function scoreText(v){if(v.scoreType==='mate')return 'M'+(Number(v.score)>0?'+':'')+v.score;if(v.scoreType && v.scoreType!=='cp' && v.scoreType!=='value' && v.scoreType!=='eval')return String(v.scoreType)+' '+v.score;return (Number(v.score)>0?'+':'')+v.score;}
  function renderResults(){const container=$('results');container.replaceChildren();const entries=[...pvs.values()].sort((a,b)=>a.index-b.index);if(!entries.length){const e=document.createElement('div');e.className='empty';e.innerHTML='<span>✳</span><b>等待第一个落点</b><p>设置局面后开始分析，候选变化将在这里显示。</p>';container.append(e);}for(const p of entries){if(!p.pv?.length)continue;const row=document.createElement('button');row.className='result'+(preview?.index===p.index?' selected':'');const rank=document.createElement('span');rank.className='rank';rank.textContent=String(p.index).padStart(2,'0');const point=document.createElement('span');point.className='point';point.textContent=name(p.pv[0].x,p.pv[0].y);const score=document.createElement('span');score.className='score';score.textContent=scoreText(p);const line=document.createElement('span');line.className='line';const path=document.createElement('span');path.textContent=p.pv.map(q=>name(q.x,q.y)).join('  ·  ');const meta=document.createElement('small');meta.textContent='深度 '+(p.depth??'—')+' · '+Number(p.nodes??0).toLocaleString()+' 节点 · '+((p.timeMs??0)/1000).toFixed(1)+' 秒';line.append(path,meta);row.append(rank,point,score,line);row.title='点击预览变化 · 深度 '+(p.depth??'—')+' · '+(p.nodes??'—')+' 节点 · '+((p.timeMs??0)/1000).toFixed(1)+' 秒'+(p.scoreType==='mate'?' · M 值为半手数（ply），约 '+Math.ceil(Math.abs(p.score)/2)+' 手；引擎裁定，非穷举证明':'');row.onclick=()=>{preview={index:p.index,pv:p.pv.slice(),step:Math.min(1,p.pv.length)};renderResults();renderBoard();};container.append(row);}
    $('variation').hidden=!preview;if(preview){$('variation-label').textContent='候选 '+preview.index;$('pv-step').textContent=preview.step+' / '+preview.pv.length;$('pv-prev').disabled=preview.step<=0;$('pv-next').disabled=preview.step>=preview.pv.length;}}
  function scheduleRender(){if(!renderTimer)renderTimer=setTimeout(()=>{renderTimer=null;renderResults();},120);}
  function metric(data){if(data.depth!=null)$('metric-depth').textContent=data.depth;if(data.nodes!=null)$('metric-nodes').textContent=Number(data.nodes).toLocaleString();if(data.timeMs!=null)$('metric-time').textContent=(data.timeMs/1000).toFixed(1)+'s';if(data.nps!=null)$('metric-speed').textContent=Number(data.nps).toLocaleString();else if(data.nodes!=null&&data.timeMs>0)$('metric-speed').textContent=Math.round(data.nodes*1000/data.timeMs).toLocaleString();}
  let packCache=null, packLoading=null;
  // Fetch the 10 MB weight package once and keep it in the page. Every worker restart
  // (stop, thread switch) then only pays for a copy instead of a fetch plus unpack.
  function loadPack(){
    if(packCache) return Promise.resolve(packCache);
    if(packLoading) return packLoading;
    packLoading=(async()=>{
      const url=new URL('./engine/rapfi-single-simd128.data',location.href).href;
      const res=await fetch(url);
      if(!res.ok) throw new Error('无法加载神经网络：HTTP '+res.status);
      const total=Number(res.headers.get('content-length'))||10062586;
      const mb=v=>Math.round(v/1048576*10)/10;
      let buf;
      if(!res.body||!res.body.getReader){buf=await res.arrayBuffer();}
      else{
        const reader=res.body.getReader(), chunks=[]; let loaded=0, reported=0;
        while(true){const {done,value}=await reader.read(); if(done)break; chunks.push(value); loaded+=value.length;
          if(loaded-reported>=1048576||loaded===total){reported=loaded;$('engine-status').textContent='正在加载神经网络 '+mb(loaded)+' / '+mb(total)+' MB';}}
        const out=new Uint8Array(loaded); let off=0; for(const c of chunks){out.set(c,off);off+=c.length;}
        buf=out.buffer;
      }
      if(buf.byteLength!==10062586) throw new Error('神经网络数据不完整。');
      packCache=buf; return packCache;
    })().finally(()=>{packLoading=null;});
    return packLoading;
  }
  async function startWorker(){try{const w=new Worker('./engine-worker.js');worker=w;worker.onmessage=({data:d})=>{if(d.type==='log'){logs.push(d.message);if(logs.length>20000)logs.shift();return;}if(d.type==='status'){$('engine-status').textContent=d.message;return;}if(d.type==='ready'){ready=true;$('engine-dot').className='status-dot ready';$('engine-status').textContent='引擎已就绪';$('engine-detail').textContent=`${d.version||'Rapfi'} · ${d.model||'本地网络权重'} · ${d.simd?'SIMD · ':''}${d.mode||'single'} · ${d.threads||1} 线程 · ${crossOriginIsolated?'跨源隔离已启用':'未跨源隔离'}`;updateButtons();return;}if(d.type==='error'){logs.push('ERROR: '+d.message);if(!ready){$('engine-dot').className='status-dot error';$('engine-status').textContent='引擎加载失败';$('engine-detail').textContent=d.message;}else if(d.id==null||d.id===activeId){searching=false;activeId=null;updateButtons();$('search-state').textContent='分析出错';toast(d.message);}return;}if(!searching||(d.id!=null&&d.id!==activeId))return;if(d.type==='pv'){pvs.set(d.index,d);metric(d);scheduleRender();}else if(d.type==='stats')metric(d);else if(d.type==='done'){searching=false;activeId=null;updateButtons();$('search-state').textContent=reasonText(d.reason);clearTimeout(renderTimer);renderTimer=null;renderResults();}};worker.onerror=e=>{ready=false;searching=false;updateButtons();$('engine-dot').className='status-dot error';$('engine-status').textContent='引擎加载失败';$('engine-detail').textContent=e.message;};const threads=Number($('threads').value)||1;
    const data=(await loadPack()).slice(0);
    // A newer start (double stop, thread switch) may have replaced this worker already.
    if(worker!==w){try{w.terminate();}catch(_){}return;}
    w.postMessage({type:'init',mode:threads>1?'multi':'single',threads,data},[data]);}catch(e){$('engine-status').textContent='引擎加载失败';$('engine-detail').textContent=e.message;}}
  const threadSelect=$('threads');if(crossOriginIsolated && typeof SharedArrayBuffer!=='undefined'){const max=Math.min(8,Math.max(1,navigator.hardwareConcurrency||2));for(let n=2;n<=max;n++){const option=document.createElement('option');option.value=n;option.textContent=n+' 线程';threadSelect.append(option);}}else threadSelect.disabled=true;threadSelect.onchange=()=>{syncHints();if(searching){stopSearch();}else{if(worker)worker.terminate();ready=false;$('engine-dot').className='status-dot';$('engine-status').textContent='正在重新准备引擎';updateButtons();startWorker();}};
  $('analyze').onclick=()=>{invalidate();activeId=++generation;searching=true;updateButtons();$('search-state').textContent='正在搜索…';const moves=[];board.forEach((v,i)=>{if(v)moves.push({x:i%15,y:Math.floor(i/15),color:v});});worker.postMessage({type:'analyze',id:activeId,moves,side,timeMs:Number($('time').value)*1000,multiPV:Number($('multipv').value),hashMB:64,maxDepth:Number($('maxdepth').value)||0});};$('stop').onclick=stopSearch;
  $('modes').onclick=e=>{const b=e.target.closest('button');if(!b)return;mode=b.dataset.mode;document.querySelectorAll('#modes button').forEach(x=>x.classList.toggle('active',x===b));};$('side').onchange=e=>{const v=e.target.value==='black'?1:2;if(v!==side){remember();side=v;changed();}};
  $('time').onchange=syncHints;$('maxdepth').onchange=syncHints;syncHints();
  $('undo').onclick=()=>{const s=history.pop();if(s){board=s.board;side=s.side;changed();}};$('clear').onclick=()=>{remember();board=Array(225).fill(0);side=1;changed();};$('preset').onclick=()=>setPosition(preset);
  $('pv-prev').onclick=()=>{if(preview&&preview.step>0){preview.step--;renderBoard();renderResults();}};$('pv-next').onclick=()=>{if(preview&&preview.step<preview.pv.length){preview.step++;renderBoard();renderResults();}};$('pv-close').onclick=()=>{preview=null;renderBoard();renderResults();};
  function download(filename,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('copy').onclick=async()=>{const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('position',JSON.stringify(position()));try{await navigator.clipboard.writeText(url.href);toast('分享链接已复制');}catch{prompt('复制分享链接',url.href);}};$('export').onclick=()=>download('gomoku-position.json',JSON.stringify(position(),null,2),'application/json');$('import').onclick=()=>$('file').click();$('file').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{setPosition(JSON.parse(await f.text()));toast('局面已导入');}catch(err){toast('导入失败：'+err.message);}e.target.value='';};$('logs').onclick=()=>download('rapfi-log.txt',logs.join('\n')+'\n','text/plain');$('help-btn').onclick=()=>$('help').showModal();$('help-close').onclick=()=>$('help').close();
  try{const data=new URL(location.href).searchParams.get('position');setPosition(data?JSON.parse(data):preset,false);}catch(e){setPosition(preset,false);toast('分享链接无效，已恢复示例');}startWorker();
})();
