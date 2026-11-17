/* SPDX-License-Identifier: GPL-3.0-or-later */
/*
 * 练棋 · 人机对弈 / 战术小测 / 个人记录
 * 经典脚本（非 ES module），依赖 window.GomokuRules 与 window.GOMOKU_PUZZLES。
 * 引擎通过 ./engine-worker.js 在 Worker 里跑，本文件只负责协议、状态与渲染。
 */
'use strict';

(function () {
  const R = window.GomokuRules;
  if (!R) {
    const status = document.getElementById('engine-status');
    if (status) status.textContent = '规则脚本未加载';
    return;
  }

  const SIZE = R.SIZE;
  const N = SIZE * SIZE;
  const BLACK = R.BLACK;
  const WHITE = R.WHITE;
  const $ = id => document.getElementById(id);

  const STORE_KEY = 'gomoku_trainer_v1';
  const TIME_LIMIT = 120000;   // 单步对局分析的时间上限（有 maxDepth，通常远早于此结束）
  const REVIEW_TIME = 20000;   // 复盘每一手的预算
  const REVIEW_DEPTH = 10;
  const REVIEW_PV = 5;      // 复盘时取前五候选，用来判断第几选
  const PUZZLE_TIME = 120000;
  const PUZZLES = Array.isArray(window.GOMOKU_PUZZLES) ? window.GOMOKU_PUZZLES : [];

  /* ------------------------------------------------------------------ *
   * 全局状态
   * ------------------------------------------------------------------ */

  // 对局状态
  const G = {
    board: R.newBoard(),
    turn: BLACK,
    playerColor: BLACK,
    level: 3,
    on: false,
    over: false,
    result: null,
    moves: [],            // {x,y,color,by:'player'|'engine'|'auto'}
    lastMove: null,
    winCells: new Set()
  };

  // 小测状态
  const P = {
    index: 0,
    board: R.newBoard(),
    side: BLACK,
    lastMove: null,
    done: false,
    loaded: false
  };

  const state = {
    tab: 'play',
    level: 3,
    adaptive: true,
    thinking: false,       // 引擎正在替对局思考
    judging: false,        // 小测正在判题
    reviewing: false,
    reviewToken: 0,
    gameToken: 0,
    stepId: 0,             // 每一次引擎落子的序号，用来作废被打断的旧步骤
    reviewView: null,      // {moves:[...]} 复盘时展示的旧局面
    bestPoints: [],        // [{x,y}] 需要打 .mark-best 的点
    candidates: [],        // [{move,winrate,depth}] 复盘/摆子时的候选点
    playedPoint: null,     // {x,y} 当前手，用于在覆盖层里标出来
    review: null           // {items,index,overlay,draft} 复盘数据
  };

  let store = null;
  let storageBroken = false;
  let toastTimer = null;
  let warnNode = null;
  let bestNodes = [];
  let candNodes = [];
  const cells = [];        // 225 个 button.intersection

  /* ------------------------------------------------------------------ *
   * 个人记录（localStorage）
   * ------------------------------------------------------------------ */

  function defaultStore() {
    return {
      v: 1,
      rating: R.START_RATING || 1000,
      level: 3,
      adaptive: true,
      games: [],
      puzzles: {}
    };
  }

  const clampInt = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };

  function loadStore() {
    const base = defaultStore();
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORE_KEY);
    } catch (err) {
      storageBroken = true;
      return base;
    }
    if (!raw) return base;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return base;
      base.rating = clampInt(data.rating, 300, 2400, base.rating);
      base.level = clampInt(data.level, 1, R.LEVELS.length, 3);
      base.adaptive = data.adaptive !== false;
      if (Array.isArray(data.games)) {
        base.games = data.games.filter(g => g && typeof g === 'object').map(g => ({
          ts: Number(g.ts) || 0,
          level: clampInt(g.level, 1, R.LEVELS.length, 3),
          side: g.side === 'white' ? 'white' : 'black',
          result: g.result === 'win' || g.result === 'loss' ? g.result : 'draw',
          plies: Math.max(0, Number(g.plies) || 0)
        })).slice(-200);
      }
      if (data.puzzles && typeof data.puzzles === 'object') {
        for (const key of Object.keys(data.puzzles)) {
          const rec = data.puzzles[key];
          if (!rec || typeof rec !== 'object') continue;
          base.puzzles[key] = {
            tries: Math.max(0, Number(rec.tries) || 0),
            ok: Math.max(0, Number(rec.ok) || 0),
            lastTs: Number(rec.lastTs) || 0
          };
        }
      }
      return base;
    } catch (err) {
      return base;
    }
  }

  function saveStore() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
      storageBroken = false;
    } catch (err) {
      storageBroken = true;
    }
  }

  /* ------------------------------------------------------------------ *
   * 引擎封装：analyze() 返回 Promise<{rows, reason, depth}>
   * ------------------------------------------------------------------ */

  const ENGINE = {
    worker: null,
    state: 'idle',       // idle | loading | ready | error
    info: null,
    waiters: [],
    seq: 0,
    jobs: new Map(),
    chain: Promise.resolve()
  };

  function settleReady(ok) {
    const list = ENGINE.waiters.splice(0);
    for (const fn of list) {
      try { fn(ok); } catch (err) { /* 忽略等待者自身异常 */ }
    }
  }

  function waitReady() {
    if (ENGINE.state === 'ready') return Promise.resolve(true);
    if (ENGINE.state === 'error') return Promise.resolve(false);
    return new Promise(resolve => ENGINE.waiters.push(resolve));
  }

  function engineInfoText(info) {
    if (!info) return '正在加载本地引擎与网络权重…';
    const parts = ['Rapfi'];
    if (info.version) parts[0] = 'Rapfi ' + info.version;
    if (info.simd) parts.push('SIMD');
    parts.push(info.mode === 'multi' ? 'multi' : 'single');
    parts.push((info.threads || 1) + ' 线程');
    return parts.join(' · ');
  }

  function engineFailed(message) {
    ENGINE.state = 'error';
    ENGINE.info = { error: message };
    const dot = $('engine-dot');
    if (dot) dot.className = 'status-dot error';
    const status = $('engine-status');
    if (status) status.textContent = '引擎加载失败';
    const detail = $('engine-detail');
    if (detail) detail.textContent = message || '未知错误';
    settleReady(false);
    updateControls();
  }

  function startEngine() {
    ENGINE.state = 'loading';
    try {
      ENGINE.worker = new Worker('./engine-worker.js');
      ENGINE.worker.onmessage = onWorkerMessage;
      ENGINE.worker.onerror = ev => {
        engineFailed((ev && ev.message) || '引擎脚本加载失败');
      };
      ENGINE.worker.postMessage({ type: 'init', mode: 'single', threads: 1 });
    } catch (err) {
      engineFailed((err && err.message) || '无法启动引擎');
    }
  }

  // 兜底：异步流程里任何意外异常都不许变成未捕获的 Promise 拒绝
  function guard(promise, what) {
    if (promise && typeof promise.catch === 'function') {
      promise.catch(err => {
        state.thinking = false;
        state.judging = false;
        state.reviewing = false;
        updateControls();
        if (window.console && window.console.error) window.console.error(what, err);
        toast(what + '失败：' + ((err && err.message) || '未知错误'));
      });
    }
  }

  function onWorkerMessage(ev) {
    try {
      handleWorkerMessage(ev);
    } catch (err) {
      if (window.console && window.console.error) window.console.error('处理引擎消息失败', err);
    }
  }

  function handleWorkerMessage(ev) {
    const data = (ev && ev.data) || {};
    if (data.type === 'log') return;

    if (data.type === 'ready') {
      ENGINE.state = 'ready';
      ENGINE.info = {
        version: data.version,
        model: data.model,
        mode: data.mode,
        threads: data.threads,
        simd: data.simd
      };
      const dot = $('engine-dot');
      if (dot) dot.className = 'status-dot ready';
      const status = $('engine-status');
      if (status) status.textContent = '引擎已就绪';
      const detail = $('engine-detail');
      if (detail) detail.textContent = engineInfoText(ENGINE.info);
      settleReady(true);
      updateControls();
      onEngineReady();
      return;
    }

    if (data.type === 'status') {
      if (ENGINE.state !== 'ready') {
        const status = $('engine-status');
        if (status) status.textContent = data.message;
        const detail = $('engine-detail');
        if (detail) detail.textContent = data.message;
      }
      return;
    }

    if (data.type === 'error') {
      if (ENGINE.state !== 'ready') {
        engineFailed(data.message || '引擎加载失败');
        return;
      }
      const job = data.id == null ? null : ENGINE.jobs.get(data.id);
      if (job) {
        failJob(job, data.message || '引擎报错');
      } else {
        toast('引擎报错：' + (data.message || '未知错误'));
      }
      return;
    }

    const job = data.id == null ? null : ENGINE.jobs.get(data.id);
    if (!job) return;

    if (data.type === 'pv') {
      const index = Number(data.index) || 1;
      job.rows.set(index, data);   // 同一 index 会被覆盖，取最后一版
      return;
    }

    if (data.type === 'done') {
      ENGINE.jobs.delete(data.id);
      if (job.timer) clearTimeout(job.timer);
      const rows = Array.from(job.rows.values())
        .sort((a, b) => (Number(a.index) || 1) - (Number(b.index) || 1));
      job.resolve({ rows, reason: data.reason, depth: data.depth, move: data.move });
    }
  }

  function failJob(job, message) {
    if (job.settled) return;
    job.settled = true;
    ENGINE.jobs.delete(job.id);
    if (job.timer) clearTimeout(job.timer);
    job.reject(new Error(message));
  }

  function runAnalysis(opts) {
    return new Promise((resolve, reject) => {
      waitReady().then(ok => {
        if (!ok) {
          reject(new Error('引擎尚未就绪'));
          return;
        }
        if (!ENGINE.worker) {
          reject(new Error('引擎连接已断开'));
          return;
        }
        const id = ++ENGINE.seq;
        const job = { id, rows: new Map(), resolve, reject, timer: null, settled: false };
        ENGINE.jobs.set(id, job);
        const budget = Number(opts.timeMs) || 60000;
        // 兜底：万一 done 没回来，也不能把界面永久锁住。
        job.timer = setTimeout(() => failJob(job, '分析超时'), budget + 30000);
        try {
          ENGINE.worker.postMessage({
            type: 'analyze',
            id: id,
            moves: opts.moves || [],
            side: opts.side,
            timeMs: budget,
            multiPV: opts.multiPV || 1,
            hashMB: 64,
            maxDepth: opts.maxDepth || 0
          });
        } catch (err) {
          failJob(job, (err && err.message) || '无法向引擎发送局面');
        }
      }, reject);
    });
  }

  // 同一时刻只允许一个分析在跑，其余排队。
  function analyze(opts) {
    const task = () => runAnalysis(opts);
    const next = ENGINE.chain.then(task, task);
    ENGINE.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  // 放弃所有在跑的分析：让当前 Promise 立刻失败，后续消息按 id 自然丢弃。
  function abortAnalysis() {
    for (const job of Array.from(ENGINE.jobs.values())) {
      job.settled = true;
      ENGINE.jobs.delete(job.id);
      if (job.timer) clearTimeout(job.timer);
      job.reject(new Error('cancelled'));
    }
  }

  function onEngineReady() {
    if (state.tab === 'puzzles' && !P.loaded) loadPuzzle(0);
    resumeEngineIfNeeded();
    updateControls();
  }

  /* ------------------------------------------------------------------ *
   * 棋盘渲染
   * ------------------------------------------------------------------ */

  function boardFrom(moves) {
    const board = R.newBoard();
    for (const m of moves) {
      if (!m || m.x < 0 || m.y < 0 || m.x >= SIZE || m.y >= SIZE) continue;
      if (m.color !== BLACK && m.color !== WHITE) continue;
      board[R.idx(m.x, m.y)] = m.color;
    }
    return board;
  }

  function movesOf(board) {
    const out = [];
    for (let i = 0; i < N; i++) {
      const v = board[i];
      if (v) out.push({ x: i % SIZE, y: Math.floor(i / SIZE), color: v });
    }
    return out;
  }

  function displayBoard() {
    if (state.reviewView) return boardFrom(state.reviewView.moves);
    return state.tab === 'puzzles' ? P.board : G.board;
  }

  function displayLastMove() {
    if (state.reviewView) return null;
    return state.tab === 'puzzles' ? P.lastMove : G.lastMove;
  }

  function displayWinCells() {
    if (state.reviewView || state.tab === 'puzzles') return null;
    return G.winCells;
  }

  function buildBoard() {
    const host = $('board');
    if (!host) return;
    host.replaceChildren();

    // 星位
    for (const x of [3, 7, 11]) {
      for (const y of [3, 7, 11]) {
        const star = document.createElement('i');
        star.className = 'star';
        star.style.left = (6.25 + x * 6.25) + '%';
        star.style.top = (6.25 + y * 6.25) + '%';
        host.append(star);
      }
    }
    // 坐标：底部字母、左侧数字
    for (let n = 0; n < SIZE; n++) {
      const letter = document.createElement('span');
      letter.className = 'coord';
      letter.style.left = (6.25 + n * 6.25) + '%';
      letter.style.top = (6.25 + 14.8 * 6.25) + '%';
      letter.textContent = String.fromCharCode(65 + n);
      host.append(letter);

      const number = document.createElement('span');
      number.className = 'coord';
      number.style.left = (6.25 - 0.55 * 6.25) + '%';
      number.style.top = (6.25 + (14 - n) * 6.25) + '%';
      number.textContent = String(n + 1);
      host.append(number);
    }
    // 交叉点
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'intersection';
        button.style.left = (6.25 + x * 6.25) + '%';
        button.style.top = (6.25 + y * 6.25) + '%';
        button.setAttribute('role', 'gridcell');
        button.dataset.x = String(x);
        button.dataset.y = String(y);
        button.addEventListener('click', () => onPoint(x, y));
        host.append(button);
        cells[R.idx(x, y)] = button;
      }
    }
  }

  function renderBoard() {
    const board = displayBoard();
    const last = displayLastMove();
    const winCells = displayWinCells();
    const lastIndex = last ? R.idx(last.x, last.y) : -1;

    let black = 0;
    let white = 0;

    for (let i = 0; i < N; i++) {
      const cell = cells[i];
      if (!cell) continue;
      const color = board[i];
      const x = i % SIZE;
      const y = Math.floor(i / SIZE);
      let piece = cell.firstElementChild;

      if (color === BLACK || color === WHITE) {
        if (color === BLACK) black++; else white++;
        if (!piece || !piece.classList.contains('piece')) {
          cell.replaceChildren();
          piece = document.createElement('span');
          cell.append(piece);
        }
        piece.className = 'piece ' + (color === BLACK ? 'black' : 'white');
        if (i === lastIndex) piece.classList.add('mark-last');
        if (winCells && winCells.has(i)) piece.classList.add('mark-win');
        cell.setAttribute('aria-label', R.name(x, y) + (color === BLACK ? ' 黑棋' : ' 白棋'));
      } else {
        if (piece) cell.replaceChildren();
        cell.setAttribute('aria-label', R.name(x, y) + ' 空');
      }
    }

    const blackCount = $('black-count');
    if (blackCount) blackCount.textContent = String(black);
    const whiteCount = $('white-count');
    if (whiteCount) whiteCount.textContent = String(white);

    renderBestPoints();
    renderCandidates();
  }

  function renderBestPoints() {
    for (const node of bestNodes) node.remove();
    bestNodes = [];
    const host = $('board');
    if (!host) return;
    for (const point of state.bestPoints) {
      const mark = document.createElement('span');
      mark.className = 'mark-best';
      mark.style.left = (6.25 + point.x * 6.25) + '%';
      mark.style.top = (6.25 + point.y * 6.25) + '%';
      host.append(mark);
      bestNodes.push(mark);
    }
  }

  // 复盘/摆子时的候选点覆盖层：名字里的胜率是该局面下行棋方的胜率
  function renderCandidates() {
    for (const node of candNodes) node.remove();
    candNodes = [];
    const host = $('board');
    if (!host || !state.review || !state.review.overlay) return;
    const list = (state.candidates || []).slice(0, 3);
    for (let i = 0; i < list.length; i++) {
      const cand = list[i];
      if (!cand || !cand.move) continue;
      const el = document.createElement('span');
      el.className = 'cand rank' + (i + 1);
      if (state.playedPoint && cand.move.x === state.playedPoint.x && cand.move.y === state.playedPoint.y) {
        el.classList.add('played');
      }
      el.style.left = (6.25 + cand.move.x * 6.25) + '%';
      el.style.top = (6.25 + cand.move.y * 6.25) + '%';
      const pct = document.createElement('b');
      pct.textContent = cand.winrate == null ? '—' : Math.round(cand.winrate * 100) + '%';
      const depth = document.createElement('small');
      depth.textContent = 'd' + (cand.depth == null ? '—' : cand.depth);
      el.append(pct, depth);
      host.append(el);
      candNodes.push(el);
    }
  }

  // 落点上的棋子闪一下（正确 / 不对）
  function flashPiece(x, y, cls) {
    const cell = cells[R.idx(x, y)];
    if (!cell) return;
    const piece = cell.firstElementChild;
    if (!piece || !piece.classList.contains('piece')) return;
    piece.classList.add(cls);
    setTimeout(() => piece.classList.remove(cls), 1200);
  }

  function onPoint(x, y) {
    if (state.tab === 'play' && state.review && state.reviewView) {
      guard(reviewDraft(x, y), '摆子');
      return;
    }
    if (state.tab === 'play') playClick(x, y);
    else if (state.tab === 'puzzles') guard(puzzleClick(x, y), '判题');
  }

  /* ------------------------------------------------------------------ *
   * 界面文字 / 按钮状态
   * ------------------------------------------------------------------ */

  function toast(message) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function setStatus(text) {
    const el = $('board-status');
    if (el) el.textContent = text;
  }

  function scoreText(score, scoreType) {
    const value = Number(score) || 0;
    if (scoreType === 'mate') return 'M' + (value > 0 ? '+' : '') + value;
    return (value > 0 ? '+' : '') + value;
  }

  function playStatus() {
    if (!G.on) return '等待开始';
    if (G.over) return G.result === 'win' ? '你赢了' : G.result === 'loss' ? '你输了' : '和棋';
    if (state.thinking) return '引擎思考中…';
    return G.turn === G.playerColor ? '轮到你落子' : '等待引擎';
  }

  function puzzleStatus() {
    if (!P.loaded) return '等待开始';
    if (state.judging) return '正在判题…';
    if (P.done) return '本题已完成';
    return '轮到你落子';
  }

  function isBoardLocked() {
    if (state.thinking || state.judging) return true;
    if (state.tab === 'play') return !G.on || G.over || !!state.reviewView;
    if (state.tab === 'puzzles') return !P.loaded || P.done;
    return true;
  }

  function hasPlayerMove() {
    return G.moves.some(m => m.color === G.playerColor && m.by === 'player');
  }

  function updateControls() {
    const ready = ENGINE.state === 'ready';
    const live = G.on && !G.over;

    const newGame = $('new-game');
    if (newGame) newGame.disabled = !ready;

    const undo = $('undo');
    if (undo) undo.disabled = !ready || !live || state.thinking || !hasPlayerMove();

    const pass = $('pass');
    if (pass) pass.disabled = !ready || !live || state.thinking;

    const reset = $('reset');
    if (reset) reset.disabled = !ready || state.thinking;

    const resign = $('resign');
    if (resign) resign.disabled = !ready || !live || state.thinking;

    const review = $('review-btn');
    if (review) review.disabled = !ready || !G.on || !G.over || state.reviewing || !hasPlayerMove();

    const puzzleNext = $('puzzle-next');
    if (puzzleNext) puzzleNext.disabled = state.judging || !PUZZLES.length;

    const puzzleShow = $('puzzle-show');
    if (puzzleShow) puzzleShow.disabled = state.judging || P.done || !PUZZLES.length;

    const board = $('board');
    if (board) board.classList.toggle('locked', isBoardLocked());
  }

  function updateKpis() {
    const moves = $('kpi-moves');
    if (moves) moves.textContent = String(G.moves.length);
    const level = $('kpi-level');
    if (level) level.textContent = R.levelInfo(G.level).label;
    const record = $('kpi-record');
    if (record) record.textContent = recordText();
  }

  function recordText() {
    const wins = store.games.filter(g => g.result === 'win').length;
    const losses = store.games.filter(g => g.result === 'loss').length;
    return wins + ' 胜 ' + losses + ' 负';
  }

  function updatePlayHint() {
    const hint = $('play-hint');
    if (!hint) return;
    const info = R.levelInfo(state.level);
    hint.textContent = info.label + '：' + info.blurb +
      '（目标深度 ' + info.depth + ' 层，单步上限 ' + Math.round(info.moveMs / 1000) + ' 秒' +
      (info.slip > 0 ? '，有 ' + Math.round(info.slip * 100) + '% 的概率走次优着' : '，不会故意让子') + '）';
  }

  function updateLevelSelect() {
    const select = $('level');
    if (!select) return;
    select.replaceChildren();
    for (const info of R.LEVELS) {
      const option = document.createElement('option');
      option.value = String(info.level);
      option.textContent = info.label + '（' + info.depth + ' 层）';
      select.append(option);
    }
    select.value = String(state.level);
  }

  /* ------------------------------------------------------------------ *
   * 页签
   * ------------------------------------------------------------------ */

  const TABS = {
    play: {
      eyebrow: 'PLAY ／ 01',
      title: '和引擎下一局',
      sub: '你执黑先行，点交叉点落子。',
      panelEyebrow: 'OPPONENT ／ 02',
      panelTitle: '对局设置'
    },
    puzzles: {
      eyebrow: 'PUZZLE ／ 02',
      title: '战术小测',
      sub: '找到唯一的胜着，或者唯一能挡住的那一手。',
      panelEyebrow: 'PUZZLE ／ 02',
      panelTitle: '题目'
    },
    records: {
      eyebrow: 'RECORD ／ 03',
      title: '你的训练记录',
      sub: '等级分、各难度胜率与能力项，全部只存在这台浏览器里。',
      panelEyebrow: 'PROFILE ／ 03',
      panelTitle: '总览'
    }
  };

  function switchTab(tab) {
    const meta = TABS[tab];
    if (!meta) return;

    // 切页签先停掉正在跑的分析
    if (state.reviewing) {
      state.reviewToken++;
      state.reviewing = false;
    }
    if (state.thinking) {
      state.thinking = false;
      abortAnalysis();
    }

    state.tab = tab;
    state.reviewView = null;
    state.bestPoints = [];

    const panels = { play: $('panel-play'), puzzles: $('panel-puzzles'), records: $('panel-records') };
    for (const key of Object.keys(panels)) {
      if (panels[key]) panels[key].hidden = key !== tab;
    }
    const tabbar = $('tabbar');
    if (tabbar) {
      for (const button of tabbar.querySelectorAll('button[data-tab]')) {
        button.classList.toggle('active', button.dataset.tab === tab);
      }
    }

    const eyebrow = $('board-eyebrow');
    if (eyebrow) eyebrow.textContent = meta.eyebrow;
    const title = $('board-title');
    if (title) title.textContent = meta.title;
    const sub = $('board-sub');
    if (sub) sub.textContent = meta.sub;
    const panelEyebrow = $('panel-eyebrow');
    if (panelEyebrow) panelEyebrow.textContent = meta.panelEyebrow;
    const panelTitle = $('panel-title');
    if (panelTitle) panelTitle.textContent = meta.panelTitle;

    if (tab === 'play') {
      setStatus(playStatus());
      updatePlaySub();
    } else if (tab === 'puzzles') {
      setStatus(puzzleStatus());
      if (!P.loaded) loadPuzzle(0);
    } else {
      setStatus('记录保存在本机');
      renderRecords();
    }

    renderBoard();
    updateControls();

    if (tab === 'play') resumeEngineIfNeeded();
  }

  // 回到对弈页时，如果轮到引擎而它没在思考（例如刚被切页签打断），补一手。
  function resumeEngineIfNeeded() {
    if (state.tab !== 'play') return;
    if (!G.on || G.over) return;
    if (state.thinking || state.judging || state.reviewing) return;
    if (G.turn === G.playerColor) return;
    if (ENGINE.state !== 'ready') return;
    guard(engineTurn(), '引擎走子');
  }

  function updatePlaySub() {
    if (state.tab !== 'play') return;
    const sub = $('board-sub');
    if (!sub) return;
    if (!G.on) {
      sub.textContent = G.playerColor === BLACK ? '你执黑先行，点交叉点落子。' : '你执白后行，点“开始新局”让引擎先走。';
      return;
    }
    sub.textContent = G.playerColor === BLACK ? '你执黑，先行。' : '你执白，后行。';
  }

  /* ------------------------------------------------------------------ *
   * 对局
   * ------------------------------------------------------------------ */

  function commitMove(x, y, color, by) {
    const index = R.idx(x, y);
    if (index < 0 || index >= N || G.board[index]) return null;
    G.board[index] = color;
    G.moves.push({ x: x, y: y, color: color, by: by });
    G.lastMove = { x: x, y: y };
    G.turn = color === BLACK ? WHITE : BLACK;
    const line = R.winLine(G.board, x, y);
    if (line && line.length) {
      G.winCells = new Set(line.map(p => R.idx(p.x, p.y)));
    }
    renderBoard();
    updateKpis();
    return line;
  }

  function startGame() {
    if (ENGINE.state !== 'ready') {
      toast('引擎还在加载，请稍候');
      return;
    }
    state.gameToken++;
    state.reviewToken++;
    state.reviewing = false;
    state.reviewView = null;
    state.bestPoints = [];
    state.candidates = [];
    state.playedPoint = null;
    state.review = null;
    state.thinking = false;
    const panel = $('mv-list');
    if (panel) panel.hidden = true;
    abortAnalysis();

    G.board = R.newBoard();
    G.turn = BLACK;
    G.moves = [];
    G.lastMove = null;
    G.winCells = new Set();
    G.on = true;
    G.over = false;
    G.result = null;
    G.playerColor = ($('side') && $('side').value === 'white') ? WHITE : BLACK;
    G.level = clampInt($('level') ? $('level').value : state.level, 1, R.LEVELS.length, 3);
    state.level = G.level;
    state.adaptive = !!($('adaptive') && $('adaptive').checked);

    store.level = G.level;
    store.adaptive = state.adaptive;
    saveStore();

    const mvList = $('mv-list');
    if (mvList) mvList.hidden = true;
    const mvRows = $('mv-rows');
    if (mvRows) mvRows.replaceChildren();
    const mvCount = $('mv-count');
    if (mvCount) mvCount.textContent = '';

    updatePlaySub();
    setStatus(G.playerColor === BLACK ? '轮到你落子' : '引擎思考中…');
    renderBoard();
    updateKpis();
    updateControls();

    if (G.playerColor === WHITE) guard(engineTurn(), '引擎走子');
  }

  function playClick(x, y) {
    if (!G.on) {
      toast('先点“开始新局”');
      return;
    }
    if (G.over) {
      toast('这一局已经结束，可以点“复盘”看失误');
      return;
    }
    if (state.reviewView) return;
    if (state.thinking) return;
    if (G.turn !== G.playerColor) return;
    if (G.board[R.idx(x, y)]) return;

    const line = commitMove(x, y, G.playerColor, 'player');
    if (line) {
      finishGame('win');
      return;
    }
    if (R.isFull(G.board)) {
      finishGame('draw');
      return;
    }
    setStatus('引擎思考中…');
    updateControls();
    guard(engineTurn(), '引擎走子');
  }

  // 引擎走一手（asSide 为当前行棋方，可以是玩家自己——用于「让对方走」）
  // 返回 'moved' | 'over' | 'fail' | 'stale'：stale 表示这一步已经被重开/切页签作废。
  async function engineStep(asSide, label) {
    const token = state.gameToken;
    const step = ++state.stepId;
    state.thinking = true;
    setStatus(label || '引擎思考中…');
    updateControls();
    renderBoard();

    const info = R.levelInfo(G.level);
    let result;
    try {
      result = await analyze({
        moves: movesOf(G.board),
        side: asSide,
        timeMs: info.moveMs || TIME_LIMIT,
        multiPV: info.slip > 0 ? 3 : 1,
        maxDepth: info.depth,
        hashMB: 64
      });
    } catch (err) {
      if (token !== state.gameToken || step !== state.stepId) return 'stale';
      state.thinking = false;
      updateControls();
      if (err && err.message === 'cancelled') return 'stale';
      setStatus('引擎出错');
      toast('引擎出错：' + ((err && err.message) || '未知错误'));
      return 'fail';
    }

    if (token !== state.gameToken || step !== state.stepId) return 'stale';
    state.thinking = false;

    if (!G.on || G.over) {
      updateControls();
      return 'over';
    }

    const usable = (result.rows || []).filter(row => {
      const pt = row && row.pv && row.pv[0];
      return pt && !G.board[R.idx(pt.x, pt.y)];
    });
    const row = R.chooseMove(usable, G.level);
    const point = row && row.pv && row.pv[0];

    if (!point) {
      finishGame('draw');   // 没有可下的点，视作棋盘已满
      return 'over';
    }

    const line = commitMove(point.x, point.y, asSide, asSide === G.playerColor ? 'auto' : 'engine');
    if (line) {
      finishGame(asSide === G.playerColor ? 'loss' : 'win');
      return 'over';
    }
    if (R.isFull(G.board)) {
      finishGame('draw');
      return 'over';
    }
    updateControls();
    return 'moved';
  }

  async function engineTurn() {
    if (!G.on || G.over || state.thinking) return;
    if (G.turn === G.playerColor) return;
    const token = state.gameToken;
    const outcome = await engineStep(G.turn, '引擎思考中…');
    if (token !== state.gameToken || outcome === 'stale') return;
    if (outcome === 'moved' && G.on && !G.over && G.turn === G.playerColor) {
      setStatus('轮到你落子');
    }
    updateControls();
  }

  async function passTurn() {
    if (!G.on || G.over || state.thinking) return;
    const token = state.gameToken;
    const side = G.turn;
    const mine = side === G.playerColor;
    const first = await engineStep(side, mine ? '引擎替你走一手…' : '引擎思考中…');
    if (token !== state.gameToken || first === 'stale') return;
    if (first === 'over') return;

    if (G.on && !G.over && G.turn !== G.playerColor) {
      const second = await engineStep(G.turn, '引擎应手中…');
      if (token !== state.gameToken || second === 'stale' || second === 'over') return;
    }
    if (G.on && !G.over) setStatus(G.turn === G.playerColor ? '轮到你落子' : '引擎思考中…');
    updateControls();
  }

  function undoMove() {
    if (!G.on || G.over || state.thinking) return;
    if (!G.moves.some(m => m.color === G.playerColor)) return;

    // 撤到玩家上一次落子之前：先撤掉引擎的应手，再撤玩家那一手
    while (G.moves.length) {
      const move = G.moves.pop();
      G.board[R.idx(move.x, move.y)] = 0;
      if (move.color === G.playerColor) break;
    }
    G.lastMove = G.moves.length ? { x: G.moves[G.moves.length - 1].x, y: G.moves[G.moves.length - 1].y } : null;
    G.turn = G.moves.length % 2 === 0 ? BLACK : WHITE;
    G.winCells = new Set();

    renderBoard();
    updateKpis();
    updateControls();
    setStatus(G.turn === G.playerColor ? '轮到你落子' : '已回退，可点“让对方走”让引擎继续');
  }

  function finishGame(result) {
    if (G.over) return;
    G.over = true;
    G.result = result;
    state.thinking = false;

    const text = result === 'win' ? '你赢了' : result === 'loss' ? '你输了' : '和棋';
    setStatus(text);

    const record = {
      ts: Date.now(),
      level: G.level,
      side: G.playerColor === BLACK ? 'black' : 'white',
      result: result,
      plies: G.moves.length
    };
    store.games.push(record);
    if (store.games.length > 200) store.games = store.games.slice(-200);

    const applied = R.applyRating(store.rating, G.level, result);
    store.rating = applied.rating;
    let message = text + ' · 等级分 ' + (applied.delta >= 0 ? '+' : '') + applied.delta;

    if (state.adaptive) {
      const recent = store.games.slice(-2).map(g => g.result);
      const next = R.nextLevel(G.level, recent);
      if (next !== G.level) {
        store.level = next;
        state.level = next;
        G.level = next;
        updateLevelSelect();
        updatePlayHint();
        message += ' · 难度调到' + R.levelInfo(next).label;
      }
    }

    saveStore();
    renderBoard();
    updateKpis();
    updateControls();
    renderRecords();
    toast(message);
  }

  /* ------------------------------------------------------------------ *
   * 复盘
   * ------------------------------------------------------------------ */

  function samePoint(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y; }

  // Rapfi reports the win rate for the side to move; the chart wants black's share.
  function toBlackWinrate(w, mover) {
    if (w == null) return null;
    const value = Number(w);
    if (Number.isNaN(value)) return null;
    return mover === BLACK ? value * 100 : (1 - value) * 100;
  }

  function collectPlies() {
    const out = [];
    for (let i = 0; i < G.moves.length; i++) {
      const m = G.moves[i];
      out.push({
        ply: i + 1,
        move: m,
        prior: G.moves.slice(0, i).map(x => ({ x: x.x, y: x.y, color: x.color }))
      });
    }
    return out;
  }

  const GRADE_TEXT = { ok: '好手', mistake: '小错', blunder: '失误', won: '胜势', lost: '已定局' };

  async function startReview() {
    if (state.reviewing) return;
    if (!G.on || !G.over) { toast('先下完一局再复盘'); return; }
    if (ENGINE.state !== 'ready') { toast('引擎还没准备好'); return; }

    const plies = collectPlies();
    if (!plies.length) { toast('这一局没有可复盘的着手'); return; }

    const token = ++state.reviewToken;
    state.reviewing = true;
    state.reviewView = null;
    state.bestPoints = [];
    state.candidates = [];
    state.playedPoint = null;
    state.review = { items: [], index: null, overlay: true, draft: 0 };

    const list = $('mv-list');
    if (list) list.hidden = false;
    const rows = $('mv-rows');
    if (rows) rows.replaceChildren();
    const count = $('mv-count');
    if (count) count.textContent = '共 ' + plies.length + ' 手';
    renderChart();
    updateControls();
    renderBoard();

    for (let i = 0; i < plies.length; i++) {
      if (token !== state.reviewToken) return;
      setStatus('复盘 ' + (i + 1) + ' / ' + plies.length);

      const p = plies[i];
      const item = {
        ply: p.ply,
        move: p.move,
        prior: p.prior,
        candidates: [],
        rank: null,
        best: null,
        bestScore: 0,
        playedScore: 0,
        loss: 0,
        grade: null,
        blackWin: null,
        skipped: false
      };

      try {
        const before = await analyze({
          moves: p.prior,
          side: p.move.color,
          timeMs: REVIEW_TIME,
          maxDepth: REVIEW_DEPTH,
          multiPV: REVIEW_PV,
          hashMB: 64
        });
        if (token !== state.reviewToken) return;
        if (!before.rows || !before.rows.length) {
          // An empty board is answered instantly with a bare move and no PV block, so the
          // opening move has nothing to be graded against.
          if (!p.prior.length) { item.first = true; item.skipped = true; item.error = 'first'; }
          throw new Error('没有可用候选');
        }

        item.candidates = before.rows.map(r => ({
          move: r.pv && r.pv[0] ? r.pv[0] : null,
          score: Number(r.score) || 0,
          scoreType: r.scoreType,
          winrate: r.winrate == null ? null : Number(r.winrate),
          depth: r.depth
        })).filter(c => c.move);

        const best = item.candidates[0];
        item.best = best.move;
        item.bestScore = best.score;

        const hit = item.candidates.findIndex(c => samePoint(c.move, p.move));
        if (hit >= 0) {
          item.rank = hit + 1;
          item.playedScore = item.candidates[hit].score;
          item.blackWin = toBlackWinrate(item.candidates[hit].winrate, p.move.color);
          item.grade = R.gradeMove(item.bestScore, item.playedScore,
            best.scoreType === 'mate', item.candidates[hit].scoreType === 'mate');
        } else {
          // Outside the searched candidates: value the move by searching the position it creates.
          const afterMoves = p.prior.concat([{ x: p.move.x, y: p.move.y, color: p.move.color }]);
          const after = await analyze({
            moves: afterMoves,
            side: R.opponent(p.move.color),
            timeMs: REVIEW_TIME,
            maxDepth: REVIEW_DEPTH,
            multiPV: 1,
            hashMB: 64
          });
          if (token !== state.reviewToken) return;
          const row = after.rows && after.rows[0];
          item.playedScore = row ? -(Number(row.score) || 0) : 0;
          if (row && row.winrate != null) {
            const whiteWin = Number(row.winrate);
            item.blackWin = (p.move.color === BLACK ? 1 - whiteWin : whiteWin) * 100;
          }
          item.grade = R.gradeMove(item.bestScore, item.playedScore,
            best.scoreType === 'mate', !!(row && row.scoreType === 'mate'));
        }
        item.loss = Math.round(Math.abs(item.playedScore - item.bestScore));
      } catch (err) {
        if (token !== state.reviewToken) return;
        item.skipped = true;
        item.error = String((err && err.message) || err);
      }

      if (token !== state.reviewToken) return;
      state.review.items.push(item);
      appendPlyRow(item, state.review.items.length - 1);
      renderChart();
    }

    if (token !== state.reviewToken) return;
    state.reviewing = false;
    setStatus('复盘完成');
    if (new URLSearchParams(location.search).has('debug')) window.__review = state.review;
    updateControls();
    renderChart();
    const first = state.review.items.findIndex(it => it.grade === 'blunder');
    const fallback = state.review.items.findIndex(it => it.grade === 'mistake');
    if (first >= 0) selectPly(first);
    else if (fallback >= 0) selectPly(fallback);
    const bad = state.review.items.filter(it => it.grade === 'blunder').length;
    toast('复盘完成：' + state.review.items.length + ' 手，失误 ' + bad + ' 处');
  }

  function appendPlyRow(item, at) {
    const host = $('mv-rows');
    if (!host) return;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ply-row';
    row.dataset.at = String(at);

    const no = document.createElement('span');
    no.className = 'ply-no';
    no.textContent = String(item.ply);

    const side = document.createElement('span');
    side.className = 'ply-side';
    const dot = document.createElement('i');
    dot.className = 'stone ' + (item.move.color === BLACK ? 'black' : 'white');
    side.append(dot);

    const move = document.createElement('span');
    move.className = 'ply-move';
    const b = document.createElement('b');
    b.textContent = R.name(item.move.x, item.move.y);
    move.append(b);

    const rank = document.createElement('span');
    rank.className = 'ply-rank' + (item.rank === 1 ? ' top' : (item.rank ? '' : ' out'));
    rank.textContent = item.first ? '首手' : (item.skipped ? '—' : (item.rank ? item.rank + '选' : '未进前' + REVIEW_PV));

    const loss = document.createElement('span');
    loss.className = 'ply-loss';
    loss.textContent = item.skipped ? '—' : 'Δ' + item.loss;

    const grade = document.createElement('span');
    grade.className = 'grade ' + (item.grade || '');
    grade.textContent = item.skipped ? '—' : (GRADE_TEXT[item.grade] || '—');

    row.append(no, side, move, rank, loss, grade);
    row.addEventListener('click', () => selectPly(at));
    host.append(row);
  }

  function markRow(at) {
    const host = $('mv-rows');
    if (!host) return;
    for (const el of host.querySelectorAll('.ply-row')) {
      el.classList.toggle('selected', Number(el.dataset.at) === at);
    }
  }

  function renderChart() {
    const host = $('wr-chart');
    if (!host) return;
    const items = (state.review && state.review.items) || [];
    if (!window.ReviewChart) { host.hidden = true; return; }
    host.hidden = false;
    const points = items.filter(it => it.blackWin != null).map(it => ({
      ply: it.ply,
      blackWinrate: it.blackWin,
      grade: it.grade
    }));
    ReviewChart.render(host, {
      points,
      current: state.review && state.review.index != null ? items[state.review.index].ply : null,
      onSeek: ply => {
        const at = items.findIndex(it => it.ply === ply);
        if (at >= 0) selectPly(at);
      }
    });
  }

  function selectPly(at) {
    if (!state.review || state.reviewing) return;
    const items = state.review.items;
    if (!items[at]) return;
    const item = items[at];
    state.review.index = at;
    state.review.draft = 0;
    state.reviewView = { moves: item.prior.map(m => ({ x: m.x, y: m.y, color: m.color })) };
    state.candidates = item.candidates.slice();
    state.playedPoint = { x: item.move.x, y: item.move.y };
    state.bestPoints = item.best ? [{ x: item.best.x, y: item.best.y }] : [];

    markRow(at);
    renderBoard();
    renderChart();

    const count = $('mv-count');
    if (count) {
      const who = item.move.color === BLACK ? '黑' : '白';
      const quality = item.first ? '开局首手，不评分'
        : item.skipped ? '没算完'
        : (item.rank ? '第 ' + item.rank + ' 选' : '未进前 ' + REVIEW_PV) + ' · ' + (GRADE_TEXT[item.grade] || '—');
      count.textContent = '第 ' + item.ply + ' 手 · ' + who + ' ' + R.name(item.move.x, item.move.y) + ' · ' + quality;
    }
    setStatus('第 ' + item.ply + ' 手之前' + (item.rank ? '（实战第 ' + item.rank + ' 选）' : ''));
    updateControls();
  }

  // Free placement inside the review: append a stone and let the engine judge the result.
  async function reviewDraft(x, y) {
    if (!state.review || !state.reviewView) return;
    const board = displayBoard();
    if (board[R.idx(x, y)]) return;
    const moves = state.reviewView.moves;
    const color = moves.length % 2 === 0 ? BLACK : WHITE;
    moves.push({ x: x, y: y, color: color });
    state.review.draft += 1;
    state.playedPoint = { x: x, y: y };
    state.bestPoints = [];
    state.candidates = [];
    renderBoard();
    setStatus('摆子中：引擎评估这个局面…');

    const token = state.reviewToken;
    try {
      const res = await analyze({
        moves: moves,
        side: R.opponent(color),
        timeMs: REVIEW_TIME,
        maxDepth: REVIEW_DEPTH,
        multiPV: 3,
        hashMB: 64
      });
      if (token !== state.reviewToken || !state.review || !state.reviewView) return;
      state.candidates = (res.rows || []).map(r => ({
        move: r.pv && r.pv[0] ? r.pv[0] : null,
        score: Number(r.score) || 0,
        scoreType: r.scoreType,
        winrate: r.winrate == null ? null : Number(r.winrate),
        depth: r.depth
      })).filter(c => c.move);
      const top = state.candidates[0];
      if (top && top.winrate != null) {
        const blackWin = color === WHITE ? (1 - top.winrate) * 100 : top.winrate * 100;
        setStatus('轮到' + (color === WHITE ? '黑' : '白') + '走 · 黑胜率 ' + Math.round(blackWin) + '%');
      } else {
        setStatus('摆子中：没有可用候选');
      }
      renderBoard();
    } catch (err) {
      setStatus('摆子评估失败');
    }
  }

  function reviewBack() {
    if (!state.review || state.review.index == null) return;
    selectPly(state.review.index);
  }

  function reviewUndoDraft() {
    if (!state.review || !state.reviewView || !state.review.draft) return;
    state.reviewView.moves.pop();
    state.review.draft -= 1;
    const last = state.reviewView.moves[state.reviewView.moves.length - 1];
    state.playedPoint = last ? { x: last.x, y: last.y } : null;
    state.candidates = [];
    state.bestPoints = [];
    renderBoard();
    setStatus('已撤销一手摆子');
  }

  /* ------------------------------------------------------------------ *
   * 战术小测
   * ------------------------------------------------------------------ */

  function loadPuzzle(index) {
    if (!PUZZLES.length) {
      const title = $('puzzle-title');
      if (title) title.textContent = '题库未加载';
      const hint = $('puzzle-hint');
      if (hint) hint.textContent = '没有找到题目，请检查 puzzles.js 是否正常加载。';
      P.loaded = false;
      updateControls();
      return;
    }

    const total = PUZZLES.length;
    P.index = ((index % total) + total) % total;
    const puzzle = PUZZLES[P.index];

    const board = R.newBoard();
    try {
      for (const key of (puzzle.black || [])) {
        const point = R.pos(key);
        board[R.idx(point.x, point.y)] = BLACK;
      }
      for (const key of (puzzle.white || [])) {
        const point = R.pos(key);
        board[R.idx(point.x, point.y)] = WHITE;
      }
    } catch (err) {
      toast('题目坐标有误，已跳过这一题');
    }

    P.board = board;
    P.side = puzzle.side === 'white' ? WHITE : BLACK;
    P.lastMove = null;
    P.done = false;
    P.loaded = true;
    state.bestPoints = [];
    state.reviewView = null;

    const cat = $('puzzle-cat');
    if (cat) cat.textContent = puzzle.category || '战术';
    const title = $('puzzle-title');
    if (title) title.textContent = puzzle.title || ('第 ' + (P.index + 1) + ' 题');
    const hint = $('puzzle-hint');
    if (hint) hint.textContent = puzzle.hint || '';

    const result = $('puzzle-result');
    if (result) {
      result.hidden = true;
      result.replaceChildren();
      result.className = 'puzzle-result';
    }
    const explain = $('puzzle-explain');
    if (explain) {
      explain.hidden = true;
      explain.replaceChildren();
    }

    if (state.tab === 'puzzles') setStatus('轮到你落子');
    renderBoard();
    updateControls();
  }

  async function puzzleClick(x, y) {
    const puzzle = PUZZLES[P.index];
    if (!P.loaded || !puzzle || P.done || state.judging) return;
    if (state.tab !== 'puzzles') return;
    if (P.board[R.idx(x, y)]) return;

    if (ENGINE.state !== 'ready') {
      toast('引擎还在加载，稍等再判题');
      return;
    }

    P.board[R.idx(x, y)] = P.side;
    P.lastMove = { x: x, y: y };
    state.judging = true;
    setStatus('正在判题…');
    updateControls();
    renderBoard();

    let verdict = null;
    try {
      const result = await analyze({
        moves: movesOf(P.board),
        side: R.opponent(P.side),
        timeMs: PUZZLE_TIME,
        maxDepth: puzzle.depth || 18,
        multiPV: 1,
        hashMB: 64
      });
      const top = result.rows && result.rows[0];
      if (!top || !top.pv || !top.pv.length) throw new Error('引擎没有给出变化');

      const mate = top.scoreType === 'mate';
      const score = Number(top.score) || 0;
      const good = puzzle.goal === 'win' ? (mate && score < 0) : !mate;
      verdict = {
        good: good,
        mate: mate,
        score: score,
        scoreType: top.scoreType || 'eval',
        pv: top.pv.slice(0, 6)
      };
    } catch (err) {
      state.judging = false;
      P.board[R.idx(x, y)] = 0;
      P.lastMove = null;
      setStatus('判题失败');
      toast('判题失败：' + ((err && err.message) || '引擎没有响应'));
      renderBoard();
      updateControls();
      return;
    }

    state.judging = false;
    P.done = true;
    recordPuzzle(puzzle.id, verdict.good);
    showPuzzleResult(puzzle, verdict);      // 内部会重绘棋盘（可能带 mark-best）
    flashPiece(x, y, verdict.good ? 'puzzle-ok' : 'puzzle-bad');
    updateControls();
    setStatus(verdict.good ? '答对了' : '这一手不对');
  }

  function showPuzzleResult(puzzle, verdict) {
    const box = $('puzzle-result');
    if (box) {
      box.hidden = false;
      box.replaceChildren();
      box.className = 'puzzle-result ' + (verdict.good ? 'ok' : 'bad');

      const headline = document.createElement('b');
      headline.textContent = verdict.good ? '正确' : '不对';

      const detail = document.createElement('span');
      let reason;
      if (puzzle.goal === 'win') {
        reason = verdict.good
          ? '引擎在落子后的局面里算出对手被将死，这一手是必胜。'
          : (verdict.mate
            ? '引擎看到的还是对手的胜势，这一手不成杀。'
            : '对手没有被将死，这一手不是必胜。');
      } else {
        reason = verdict.good
          ? '对手在落子后的局面里拿不到必胜，防住了。'
          : (verdict.mate
            ? '对手仍有必胜线，这个点挡不住。'
            : '这一手没能解围，对手还有更好的下法。');
      }
      detail.textContent = reason + '（引擎评分 ' + scoreText(verdict.score, verdict.scoreType) + '）';

      box.append(headline, document.createElement('br'), detail);
    }

    if (!verdict.good) {
      const points = [];
      for (const key of (puzzle.solution || [])) {
        try {
          const point = R.pos(key);
          points.push({ x: point.x, y: point.y });
        } catch (err) { /* 坐标异常就跳过 */ }
      }
      state.bestPoints = points;
    }

    const explain = $('puzzle-explain');
    if (explain) {
      explain.hidden = false;
      explain.replaceChildren();
      const text = document.createElement('p');
      text.textContent = puzzle.explain || '';
      const line = document.createElement('p');
      const pvText = verdict.pv && verdict.pv.length
        ? verdict.pv.map(p => R.name(p.x, p.y)).join(' → ')
        : '（没有可用变化）';
      line.textContent = '引擎给出的后续：' + pvText;
      explain.append(text, line);
    }

    renderBoard();
  }

  function recordPuzzle(id, good) {
    if (!id) return;
    const rec = store.puzzles[id] || { tries: 0, ok: 0, lastTs: 0 };
    rec.tries = (Number(rec.tries) || 0) + 1;
    if (good) rec.ok = (Number(rec.ok) || 0) + 1;
    rec.lastTs = Date.now();
    store.puzzles[id] = rec;

    const delta = good ? 6 : -3;
    store.rating = Math.max(300, Math.min(2400, store.rating + delta));
    saveStore();
    renderRecords();
  }

  function revealPuzzle() {
    const puzzle = PUZZLES[P.index];
    if (!puzzle || !P.loaded || P.done) return;

    P.done = true;
    recordPuzzle(puzzle.id, false);

    const points = [];
    for (const key of (puzzle.solution || [])) {
      try {
        const point = R.pos(key);
        points.push({ x: point.x, y: point.y });
      } catch (err) { /* 忽略 */ }
    }
    state.bestPoints = points;

    const box = $('puzzle-result');
    if (box) {
      box.hidden = false;
      box.replaceChildren();
      box.className = 'puzzle-result bad';
      const headline = document.createElement('b');
      headline.textContent = '已揭示答案';
      const detail = document.createElement('span');
      const names = (puzzle.solution || []).join('、');
      detail.textContent = names ? '参考点：' + names + '（记为未通过）' : '这题没有记录参考点（记为未通过）';
      box.append(headline, document.createElement('br'), detail);
    }

    const explain = $('puzzle-explain');
    if (explain) {
      explain.hidden = false;
      explain.replaceChildren();
      const text = document.createElement('p');
      text.textContent = puzzle.explain || '';
      explain.append(text);
    }

    renderBoard();
    updateControls();
    setStatus('已看答案');
  }

  /* ------------------------------------------------------------------ *
   * 记录页
   * ------------------------------------------------------------------ */

  function ensureStorageWarning() {
    const panel = $('panel-records');
    if (!panel) return;
    if (!storageBroken) {
      if (warnNode) {
        warnNode.remove();
        warnNode = null;
      }
      return;
    }
    if (warnNode) return;
    warnNode = document.createElement('p');
    warnNode.className = 'hint rec-warn';
    warnNode.textContent = '浏览器阻止了本地存储，这一页的记录不会保存；下棋和做题不受影响。';
    const kpis = panel.querySelector('.kpis');
    if (kpis && kpis.nextSibling) panel.insertBefore(warnNode, kpis.nextSibling);
    else panel.insertBefore(warnNode, panel.firstChild);
  }

  function puzzleRate(categories) {
    let tries = 0;
    let ok = 0;
    for (const puzzle of PUZZLES) {
      if (categories.indexOf(puzzle.category) < 0) continue;
      const rec = store.puzzles[puzzle.id];
      if (!rec) continue;
      tries += Number(rec.tries) || 0;
      ok += Number(rec.ok) || 0;
    }
    if (!tries) return null;
    return { tries: tries, ok: ok, rate: Math.max(0, Math.min(1, ok / tries)) };
  }

  function gameStats() {
    const games = store.games;
    const total = games.length;
    if (!total) return null;
    const wins = games.filter(g => g.result === 'win').length;
    const losses = games.filter(g => g.result === 'loss').length;
    return { total: total, wins: wins, losses: losses, winRate: wins / total, notLostRate: (total - losses) / total };
  }

  function combine(parts) {
    const valid = parts.filter(v => typeof v === 'number' && isFinite(v));
    if (!valid.length) return null;
    const sum = valid.reduce((a, b) => a + b, 0);
    return sum / valid.length;
  }

  function skillValue(kind) {
    const games = gameStats();
    if (kind === 'attack') {
      const puzzles = puzzleRate(['双威胁', '连续进攻']);
      return combine([puzzles ? puzzles.rate : null, games ? games.winRate : null]);
    }
    if (kind === 'defense') {
      const puzzles = puzzleRate(['防守']);
      return combine([puzzles ? puzzles.rate : null, games ? games.notLostRate : null]);
    }
    const puzzles = puzzleRate(['连续进攻']);
    return puzzles ? puzzles.rate : null;
  }

  // 一行：标签 + 进度条 + 右边一个短数值，结构对齐 .bars / .bar
  function barRow(label, rate, note) {
    const row = document.createElement('div');

    const name = document.createElement('span');
    name.textContent = label;
    name.title = label;

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = rate == null ? '0%' : Math.round(rate * 100) + '%';
    bar.append(fill);

    const value = document.createElement('b');
    value.textContent = note;

    row.append(name, bar, value);
    return row;
  }

  // 能力项：标签 + 右侧数值，结构对齐 .skill
  function skillItem(label, value) {
    const row = document.createElement('div');
    row.className = 'skill';
    const name = document.createElement('span');
    name.textContent = label;
    const number = document.createElement('b');
    number.textContent = value == null ? '—' : Math.round(value * 100) + '%';
    row.append(name, number);
    return row;
  }

  function renderRecords() {
    ensureStorageWarning();

    const rating = $('rec-rating');
    if (rating) rating.textContent = String(Math.round(store.rating));
    const rank = $('rec-rank');
    if (rank) rank.textContent = R.rankLabel(store.rating);

    const wins = store.games.filter(g => g.result === 'win').length;
    const losses = store.games.filter(g => g.result === 'loss').length;
    const draws = store.games.filter(g => g.result === 'draw').length;

    const record = $('rec-record');
    if (record) {
      record.textContent = wins + ' 胜 ' + losses + ' 负' + (draws ? ' · ' + draws + ' 和' : '');
    }
    const rate = $('rec-rate');
    if (rate) {
      rate.textContent = store.games.length
        ? '胜率 ' + Math.round(wins / store.games.length * 100) + '%'
        : '还没有对局';
    }

    const levels = $('rec-levels');
    if (levels) {
      levels.replaceChildren();
      for (const info of R.LEVELS) {
        const list = store.games.filter(g => g.level === info.level);
        const w = list.filter(g => g.result === 'win').length;
        const l = list.filter(g => g.result === 'loss').length;
        const ratio = list.length ? w / list.length : null;
        const note = list.length ? w + '胜' + l + '负' : '未下过';
        levels.append(barRow(info.label, ratio, note));
      }
    }

    const skills = $('rec-skills');
    if (skills) {
      skills.replaceChildren();
      const items = [
        { key: 'attack', label: '进攻' },
        { key: 'defense', label: '防守' },
        { key: 'calc', label: '算路' }
      ];
      for (const item of items) {
        skills.append(skillItem(item.label, skillValue(item.key)));
      }
    }

    const table = $('rec-games');
    if (table) {
      const body = table.querySelector('tbody');
      if (body) {
        body.replaceChildren();
        const recent = store.games.slice(-10).reverse();
        if (!recent.length) {
          const tr = document.createElement('tr');
          const td = document.createElement('td');
          td.colSpan = 5;
          td.className = 'empty-cell';
          td.textContent = '还没有对局记录';
          tr.append(td);
          body.append(tr);
        }
        for (const game of recent) {
          const tr = document.createElement('tr');

          const time = document.createElement('td');
          let timeText = '';
          try {
            timeText = new Date(game.ts).toLocaleString('zh-CN');
          } catch (err) {
            timeText = '—';
          }
          time.textContent = timeText;

          const level = document.createElement('td');
          level.textContent = R.levelInfo(game.level).label;

          const side = document.createElement('td');
          side.textContent = game.side === 'white' ? '白' : '黑';

          const result = document.createElement('td');
          result.textContent = game.result === 'win' ? '胜' : game.result === 'loss' ? '负' : '和';
          result.className = 'result-' + game.result;

          const plies = document.createElement('td');
          plies.textContent = String(game.plies);

          tr.append(time, level, side, result, plies);
          body.append(tr);
        }
      }
    }
  }

  function resetRecords() {
    let ok = true;
    try {
      ok = window.confirm('清空全部对局记录、小测成绩和等级分？此操作无法撤销。');
    } catch (err) {
      ok = true;
    }
    if (!ok) return;
    store = defaultStore();
    saveStore();
    state.level = store.level;
    state.adaptive = store.adaptive;
    G.level = store.level;
    const levelSelect = $('level');
    if (levelSelect) levelSelect.value = String(store.level);
    const adaptive = $('adaptive');
    if (adaptive) adaptive.checked = store.adaptive;
    updatePlayHint();
    updateKpis();
    renderRecords();
    toast('记录已清空');
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定与启动
   * ------------------------------------------------------------------ */

  function bindEvents() {
    const tabbar = $('tabbar');
    if (tabbar) {
      tabbar.addEventListener('click', ev => {
        const button = ev.target.closest ? ev.target.closest('button[data-tab]') : null;
        if (!button) return;
        switchTab(button.dataset.tab);
      });
    }

    const newGame = $('new-game');
    if (newGame) newGame.addEventListener('click', startGame);

    const undo = $('undo');
    if (undo) undo.addEventListener('click', undoMove);

    const pass = $('pass');
    if (pass) pass.addEventListener('click', () => { guard(passTurn(), '让子'); });

    const resign = $('resign');
    if (resign) resign.addEventListener('click', () => {
      if (!G.on || G.over || state.thinking) return;
      if (!window.confirm('认输并结束这一局？')) return;
      finishGame('loss');
    });

    const reset = $('reset');
    if (reset) reset.addEventListener('click', () => {
      startGame();
      toast('已按当前设置重开');
    });

    const review = $('review-btn');
    if (review) review.addEventListener('click', () => { guard(startReview(), '复盘'); });

    const overlay = $('review-overlay');
    if (overlay) overlay.addEventListener('change', () => {
      if (!state.review) return;
      state.review.overlay = overlay.checked;
      renderBoard();
    });

    const exportGame = $('export-game');
    if (exportGame) exportGame.addEventListener('click', () => {
      if (!G.moves.length) { toast('还没有落子'); return; }
      const data = {
        v: 1,
        level: G.level,
        playerSide: G.playerColor === BLACK ? 'black' : 'white',
        result: G.result || null,
        plies: G.moves.length,
        moves: G.moves.map(m => ({ x: m.x, y: m.y, color: m.color, by: m.by || null }))
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'gomoku-game.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出 ' + data.plies + ' 手');
    });

    const undoDraft = $('review-undo');
    if (undoDraft) undoDraft.addEventListener('click', reviewUndoDraft);

    const backLine = $('review-back');
    if (backLine) backLine.addEventListener('click', reviewBack);

    const side = $('side');
    if (side) side.addEventListener('change', updatePlaySub);

    const level = $('level');
    if (level) level.addEventListener('change', () => {
      state.level = clampInt(level.value, 1, R.LEVELS.length, 3);
      store.level = state.level;
      G.level = state.level;
      saveStore();
      updatePlayHint();
      updateKpis();
    });

    const adaptive = $('adaptive');
    if (adaptive) adaptive.addEventListener('change', () => {
      state.adaptive = adaptive.checked;
      store.adaptive = state.adaptive;
      saveStore();
    });

    const puzzleNext = $('puzzle-next');
    if (puzzleNext) puzzleNext.addEventListener('click', () => loadPuzzle(P.index + 1));

    const puzzleShow = $('puzzle-show');
    if (puzzleShow) puzzleShow.addEventListener('click', revealPuzzle);

    const recReset = $('rec-reset');
    if (recReset) recReset.addEventListener('click', resetRecords);

    const helpBtn = $('help-btn');
    if (helpBtn) helpBtn.addEventListener('click', () => {
      const dialog = $('help');
      if (!dialog) return;
      try {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      } catch (err) { /* 老浏览器忽略 */ }
    });

    const helpClose = $('help-close');
    if (helpClose) helpClose.addEventListener('click', () => {
      const dialog = $('help');
      if (!dialog) return;
      try {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      } catch (err) { /* 忽略 */ }
    });
  }

  function init() {
    store = loadStore();
    state.level = store.level;
    state.adaptive = store.adaptive;
    G.level = store.level;

    buildBoard();
    updateLevelSelect();
    const adaptive = $('adaptive');
    if (adaptive) adaptive.checked = store.adaptive;
    updatePlayHint();
    updateKpis();
    bindEvents();
    loadPuzzle(0);          // 先把第一题摆好，切过去就能看到
    switchTab('play');
    renderRecords();
    renderBoard();
    updateControls();
    startEngine();
  }

  try {
    init();
  } catch (err) {
    const status = $('engine-status');
    if (status) status.textContent = '页面初始化失败';
    try { toast('页面初始化失败：' + ((err && err.message) || '未知错误')); } catch (e2) { /* 忽略 */ }
  }
})();
