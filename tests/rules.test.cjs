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
  const rows = [{ index: 1, pv: [{ x: 1, y: 1 }] }, { index: 2, pv: [{ x: 2, y: 2 }] }, { index: 3, pv: [{ x: 3, y: 3 }] }];
  assert.equal(R.chooseMove(rows, 5, () => 0).index, 1, 'strongest level always plays the top move');
  let calls = 0;
  const rng = () => (calls++ === 0 ? 0.1 : 0.9); // first call slips, second keeps the runner-up
  assert.equal(R.chooseMove(rows, 1, rng).index, 2, 'level 1 slips to the runner-up');
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

// --- review grading -------------------------------------------------------
assert.equal(R.gradeMove(500, 100, false, false), 'blunder');
assert.equal(R.gradeMove(500, 300, false, false), 'mistake');
assert.equal(R.gradeMove(500, 450, false, false), 'ok');
assert.equal(R.gradeMove(30000 - 35, 600, true, false), 'blunder', 'missing a forced win is a blunder');
assert.equal(R.gradeMove(600, 30000 - 35, false, true), 'blunder', 'walking into a mate is a blunder');

console.log('Rules: wins in four directions, ladder, slip, rating and review grading passed.');
