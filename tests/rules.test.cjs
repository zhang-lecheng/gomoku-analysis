// Rules, ladder and rating maths. Run: node tests/rules.test.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const R = require(path.join(__dirname, '../rules.js'));

const at = (b, list, color) => { for (const s of list) { const p = R.pos(s); b[R.idx(p.x, p.y)] = color; } return b; };

// --- five in a row, both directions, and the line that produced it ----------
{
  const b = at(R.newBoard(), ['C3', 'D3', 'E3', 'F3', 'G3'], R.BLACK);
  const line = R.winLine(b, R.pos('E3').x, R.pos('E3').y);
  assert.ok(line && line.length === 5, 'horizontal five detected');
  assert.equal(line.map(p => R.name(p.x, p.y)).join(' '), 'C3 D3 E3 F3 G3');
}
{
  const b = at(R.newBoard(), ['H6', 'H7', 'H8', 'H9', 'H10'], R.WHITE);
  assert.ok(R.winLine(b, R.pos('H8').x, R.pos('H8').y), 'vertical five detected');
}
{
  const b = at(R.newBoard(), ['C3', 'D4', 'E5', 'F6', 'G7'], R.BLACK);
  assert.ok(R.winLine(b, R.pos('E5').x, R.pos('E5').y), 'diagonal five detected');
}
{
  const b = at(R.newBoard(), ['C3', 'D3', 'E3', 'F3'], R.BLACK);
  assert.equal(R.winLine(b, R.pos('E3').x, R.pos('E3').y), null, 'four is not a win');
}
{
  const b = at(R.newBoard(), ['C3', 'D3', 'E3', 'F3', 'G3', 'H3'], R.BLACK);
  assert.ok(R.winLine(b, R.pos('E3').x, R.pos('E3').y).length >= 6, 'overline still counts as five in freestyle');
}
{
  const b = at(R.newBoard(), ['C3', 'D3', 'E3', 'F3', 'G3'], R.BLACK);
  const h3 = R.pos('H3');
  assert.equal(R.winLine(b, h3.x, h3.y), null, 'an empty point is not a win');
}

// --- ladder ---------------------------------------------------------------
assert.deepEqual(R.LEVELS.map(l => l.depth), [6, 10, 14, 20, 26]);
assert.deepEqual(R.LEVELS.map(l => l.moveMs), [3000, 5000, 8000, 12000, 18000]);
assert.ok(R.LEVELS.every((l, i, a) => i === 0 || l.moveMs > a[i - 1].moveMs), 'per-move caps grow with level');
assert.equal(R.levelInfo(0).level, 1, 'clamps low');
assert.equal(R.levelInfo(99).level, 5, 'clamps high');
{
  const mk = (i, score) => ({ index: i, score, scoreType: 'eval', pv: [{ x: i, y: i }] });
  const near = [mk(1, 300), mk(2, 280), mk(3, 260)];   // all within the margin
  const far = [mk(1, 300), mk(2, 40), mk(3, -100)];    // rank 2 already loses 260
  assert.equal(R.chooseMove(near, 5, () => 0).index, 1, 'strongest level always plays the top move');
  let calls = 0;
  const rng = () => (calls++ === 0 ? 0.1 : 0.0);
  assert.equal(R.chooseMove(near, 1, rng).index, 2, 'a slip inside the margin takes the runner-up');
  assert.ok([2, 3].includes(R.chooseMove(near, 1, () => 0.2).index), 'the third move is reachable inside the margin');
  assert.equal(R.chooseMove(far, 1, () => 0.1).index, 1, 'never slips to a move outside the margin');
  // mate rows only compete with mate rows
  const mixed = [{ index: 1, score: 30000 - 35, scoreType: 'mate', pv: [{}] }, { index: 2, score: 500, scoreType: 'eval', pv: [{}] }];
  assert.equal(R.chooseMove(mixed, 1, () => 0.1).index, 1, 'a forced mate is never traded for an eval move');
  // losing by force: no slipping, always the longest resistance
  const losing = [
    { index: 1, score: -(30000 - 4), scoreType: 'mate', pv: [{}] },
    { index: 2, score: -(30000 - 2), scoreType: 'mate', pv: [{}] },
  ];
  assert.equal(R.chooseMove(losing, 1, () => 0.1).index, 1, 'when mated, play the most stubborn move');
  assert.equal(R.chooseMove([], 3), null, 'no rows, no move');
}

// --- rating ---------------------------------------------------------------
assert.equal(R.applyRating(1000, 3, 'win').delta, 36);
assert.equal(R.applyRating(1000, 3, 'loss').delta, -26);
assert.equal(R.applyRating(300, 1, 'loss').rating, 300, 'rating floor');
assert.equal(R.applyRating(2400, 5, 'win').rating, 2400, 'rating ceiling');
assert.equal(R.applyRating(1000, 2, 'draw').delta, 0);
assert.equal(R.rankLabel(1000), '初级');
assert.equal(R.rankLabel(1449), '高级');
assert.equal(R.rankLabel(1450), '强手');

// --- adaptive ladder ------------------------------------------------------
assert.equal(R.nextLevel(3, ['win', 'win']), 4);
assert.equal(R.nextLevel(3, ['loss', 'loss']), 2);
assert.equal(R.nextLevel(3, ['win', 'loss']), 3);
assert.equal(R.nextLevel(5, ['win', 'win']), 5, 'ceiling');
assert.equal(R.nextLevel(1, ['loss', 'loss']), 1, 'floor');
assert.equal(R.nextLevel(3, ['win']), 3, 'one game is not enough');

// --- who made five decides the result -------------------------------------
assert.equal(R.resultForWin(R.WHITE, R.BLACK), 'loss', 'engine wins as white, player is black');
assert.equal(R.resultForWin(R.BLACK, R.BLACK), 'win', 'player completes five');
assert.equal(R.resultForWin(R.WHITE, R.WHITE), 'win', 'player is white and wins');
assert.equal(R.resultForWin(R.BLACK, R.WHITE), 'loss', 'engine wins as black, player is white');

// --- review grading -------------------------------------------------------
assert.equal(R.gradeMove(500, 100, false, false), 'blunder');
assert.equal(R.gradeMove(500, 300, false, false), 'mistake');
assert.equal(R.gradeMove(500, 450, false, false), 'ok');
assert.equal(R.gradeMove(30000 - 35, 600, true, false), 'blunder', 'missing a forced win is a blunder');
assert.equal(R.gradeMove(600, 30000 - 35, false, true), 'blunder', 'walking into a mate is a blunder');
// decided positions are labelled, not praised
assert.equal(R.gradeMove(-(30000 - 4), -(30000 - 4), true, true), 'lost', 'already mated either way');
assert.equal(R.gradeMove(30000 - 35, 30000 - 40, true, true), 'won', 'winning either way');


// --- PV blocks arrive in search order, not rank order ---------------------
{
  const rows = [
    { index: 1, score: -463, scoreType: 'eval' },
    { index: 2, score: -486, scoreType: 'eval' },
    { index: 3, score: -452, scoreType: 'eval' },
    { index: 4, score: -529, scoreType: 'eval' },
    { index: 5, score: -566, scoreType: 'eval' },
  ];
  const sorted = R.orderCandidates(rows);
  assert.equal(sorted[0].index, 3, 'the highest score leads, not the first printed block');
  assert.deepEqual(sorted.map(r => r.index), [3, 1, 2, 4, 5]);
}
{
  const mate = (i, score) => ({ index: i, score, scoreType: 'mate' });
  const rows = [mate(1, 9), mate(2, 5), mate(3, 35)];
  assert.equal(R.orderCandidates(rows)[0].index, 2, 'shorter mate wins');
  const losing = [mate(1, -5), mate(2, -9), mate(3, -35)];
  assert.equal(R.orderCandidates(losing)[0].index, 3, 'when losing, the longest resistance wins');
  assert.ok(R.scoreValue(mate(1, 5)) > R.scoreValue({ score: 900, scoreType: 'eval' }), 'a mate beats any eval');
}

console.log('Rules: wins in four directions, ladder, slip, rating and review grading passed.');
