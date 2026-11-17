/* SPDX-License-Identifier: GPL-3.0-or-later */
// Pure gomoku rules, difficulty ladder and rating maths. No DOM, no engine:
// usable from the browser (window.GomokuRules) and from node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GomokuRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SIZE = 15;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  const idx = (x, y) => y * SIZE + x;
  const inside = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  const name = (x, y) => String.fromCharCode(65 + x) + (SIZE - y);
  const pos = s => ({ x: s.toUpperCase().charCodeAt(0) - 65, y: SIZE - Number(s.slice(1)) });
  const newBoard = () => new Uint8Array(SIZE * SIZE);

  // Returns the winning line (array of {x,y}) that runs through x,y, or null.
  function winLine(board, x, y) {
    const color = board[idx(x, y)];
    if (!color) return null;
    for (const [dx, dy] of DIRS) {
      const line = [{ x, y }];
      for (const sign of [1, -1]) {
        let cx = x + dx * sign, cy = y + dy * sign;
        while (inside(cx, cy) && board[idx(cx, cy)] === color) {
          if (sign > 0) line.push({ x: cx, y: cy }); else line.unshift({ x: cx, y: cy });
          cx += dx * sign; cy += dy * sign;
        }
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  const isFull = board => !board.includes(EMPTY);

  function apply(board, moves) {
    const b = newBoard();
    for (const m of moves) b[idx(m.x, m.y)] = m.color;
    return b;
  }

  // Rapfi prints its YXNBEST blocks in search order, not in rank order, so rows[0] is not
  // necessarily the best move. Rank them by score before anything reads the first row.
  function scoreValue(row) {
    const score = Number(row && row.score) || 0;
    if (row && row.scoreType === 'mate') return score > 0 ? 100000 - score : -100000 - score;
    return score;
  }
  function orderCandidates(rows) {
    return (rows || []).slice().sort((a, b) => {
      const diff = scoreValue(b) - scoreValue(a);
      if (diff) return diff;
      return (Number(a.index) || 0) - (Number(b.index) || 0);
    });
  }

  // Difficulty ladder. Depth is the engine's stop condition, so a level plays the
  // same strength on any machine; `slip` is the chance of taking the 2nd/3rd best
  // root move instead of the best one, which keeps the low levels beatable.
  // `moveMs` caps a single move so the opening cannot turn into a multi-minute wait
  // on a wide board; when it binds, the move is slightly weaker than the level claims.
  const LEVELS = [
    { level: 1, label: '入门', depth: 6, slip: 0.4, moveMs: 3000, blurb: '只看眼前一两步，经常漏防' },
    { level: 2, label: '初级', depth: 10, slip: 0.25, moveMs: 5000, blurb: '会挡活三，算不到连续进攻' },
    { level: 3, label: '中级', depth: 14, slip: 0.12, moveMs: 8000, blurb: '能看四五步，偶尔漏掉双威胁' },
    { level: 4, label: '高级', depth: 20, slip: 0.05, moveMs: 12000, blurb: '会算连续冲四，收官很稳' },
    { level: 5, label: '最强', depth: 26, slip: 0, moveMs: 18000, blurb: '不犯错，单机浏览器里已够用' },
  ];
  const levelInfo = level => LEVELS[Math.max(0, Math.min(LEVELS.length - 1, level - 1))];

  // With multiPV rows in score order, pick the root move to actually play.
  // A slip is only allowed inside `margin` score points of the best move: two moves can
  // be a few points apart and still differ on whether they block a three, and a level
  // that "forgets" to block a live three is not a weaker opponent, it is a broken one.
  function chooseMove(rows, level, rng, margin) {
    if (!rows || !rows.length) return null;
    const info = levelInfo(level);
    const rand = rng || Math.random;
    const best = rows[0];
    if (info.slip <= 0 || rows.length === 1 || rand() >= info.slip) return best;
    // Once a mate is on the board every move is a mate score, so the distance gap is a
    // couple of points and the margin below would let a slip drop the most stubborn
    // defence - which reads to a human as "it refused to block". Don't slip at all here.
    if (best.scoreType === 'mate') return best;
    const limit = margin == null ? 60 : margin;
    const bestScore = Number(best.score);
    const pool = rows.filter((row, i) => {
      if (i === 0) return true;
      if ((row.scoreType === 'mate') !== (best.scoreType === 'mate')) return false;
      const score = Number(row.score);
      if (!Number.isFinite(score) || !Number.isFinite(bestScore)) return false;
      return Math.abs(score - bestScore) <= limit;
    });
    if (pool.length <= 1) return best;
    return pool[1 + Math.floor(rand() * (pool.length - 1))];
  }

  // Result from the player's point of view: 'win' | 'loss' | 'draw'.
  function opponent(color) { return color === BLACK ? WHITE : BLACK; }

  // Who completed the five decides the result. Kept in one place because getting it
  // backwards reports a won game as lost and vice versa.
  function resultForWin(winner, playerColor) {
    return winner === playerColor ? 'win' : 'loss';
  }

  // Provisional rating: starts at 1000, moves by the level beaten or lost to.
  const START_RATING = 1000;
  function ratingDelta(level, result) {
    const base = result === 'win' ? 18 + level * 6 : result === 'loss' ? -(14 + level * 4) : 0;
    return Math.round(base);
  }
  function applyRating(rating, level, result) {
    const next = Math.max(300, Math.min(2400, rating + ratingDelta(level, result)));
    return { rating: next, delta: next - rating };
  }
  const RANKS = [
    { min: 0, label: '未定级' },
    { min: 850, label: '见习' },
    { min: 1000, label: '初级' },
    { min: 1150, label: '中级' },
    { min: 1300, label: '高级' },
    { min: 1450, label: '强手' },
  ];
  function rankLabel(rating) {
    let out = RANKS[0].label;
    for (const r of RANKS) if (rating >= r.min) out = r.label;
    return out;
  }

  // Adaptive ladder: two wins in a row promotes, two losses demote.
  function nextLevel(level, recent) {
    const last = recent.slice(-2);
    if (last.length === 2 && last.every(r => r === 'win')) return Math.min(LEVELS.length, level + 1);
    if (last.length === 2 && last.every(r => r === 'loss')) return Math.max(1, level - 1);
    return level;
  }

  // Review grading: how much a move gave up, in Rapfi score units.
  const BLUNDER = 300, MISTAKE = 120;
  function gradeMove(bestScore, playedScore, mateBest, matePlayed) {
    // Both moves end in mate: the position is decided, scoring the difference is noise.
    // Saying "好手" here is what made a lost game look mistake-free.
    if (mateBest && matePlayed) {
      if (bestScore < 0 && playedScore < 0) return 'lost';
      if (bestScore > 0 && playedScore > 0) return 'won';
    }
    if (mateBest && !matePlayed) return 'blunder';       // missed a forced win / walk into a mate
    if (!mateBest && matePlayed) return 'blunder';       // walked into a mate
    const loss = Math.abs(playedScore - bestScore);
    if (loss >= BLUNDER) return 'blunder';
    if (loss >= MISTAKE) return 'mistake';
    return 'ok';
  }

  return {
    SIZE, BLACK, WHITE, EMPTY, DIRS, idx, inside, name, pos, newBoard, apply,
    winLine, isFull, LEVELS, levelInfo, chooseMove, opponent, resultForWin, scoreValue, orderCandidates,
    START_RATING, ratingDelta, applyRating, rankLabel, RANKS, nextLevel,
    BLUNDER, MISTAKE, gradeMove,
  };
});
