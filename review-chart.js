/* SPDX-License-Identifier: GPL-3.0-or-later */
/* review-chart.js — 零依赖胜率曲线组件，经典脚本，暴露 window.ReviewChart
 *
 *   ReviewChart.render(host, {
 *     points: [{ ply: 1, blackWinrate: 52.3, grade: 'ok' | 'mistake' | 'blunder' | null }],
 *     current: 12,            // 1 基手数，null 表示不高亮
 *     onSeek: function (ply) {},
 *     height: 132
 *   });
 *
 * 结构与配色沿用 style.css / play.css：
 *   深绿 #3c5a46 画线，琥珀 #caa96b 失误，砖红 #c2705f 败着，灰绿 #93a292 普通点。
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var MAX_TITLES = 80;          // 超过就不逐点挂 <title>（性能）
  var DEFAULT_HEIGHT = 132;

  var C = {
    line: '#3c5a46',
    grid: '#dfe5d9',
    mid: '#aebda8',
    axis: '#a3b0a2',
    ok: '#93a292',
    mistake: '#caa96b',
    blunder: '#c2705f',
    labelBg: '#f3f2eb',
    labelLine: '#dbe3d4',
    paper: '#f7f8f2'
  };

  var seq = 0;

  function num(v, dflt) {
    var x = Number(v);
    return isFinite(x) ? x : dflt;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function r2(v) {
    return Math.round(v * 100) / 100;
  }

  function pct(v) {
    return Math.round(v) + '%';
  }

  function mk(name, attrs) {
    var node = document.createElementNS(NS, name);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
      }
    }
    return node;
  }

  function gradeOf(g) {
    return g === 'mistake' || g === 'blunder' ? g : null;
  }

  function dotColor(g) {
    return g === 'mistake' ? C.mistake : (g === 'blunder' ? C.blunder : C.ok);
  }

  function gradeText(g) {
    return g === 'mistake' ? ' · 失误' : (g === 'blunder' ? ' · 败着' : '');
  }

  /* SVG 里无法测量前先按字符宽度估算标签宽度（中文 1em、数字 0.56em）。 */
  function textWidth(str, size) {
    var w = 0;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      if (ch === 32) w += 0.32;
      else if (str.charAt(i) === '·' || str.charAt(i) === ':') w += 0.45;
      else if (ch > 0x2e80) w += 1;
      else if (ch >= 48 && ch <= 57) w += 0.56;
      else w += 0.58;
    }
    return w * size;
  }

  function normalize(list) {
    var rows = [];
    var i, p, ply, wr;
    list = list || [];
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (!p) continue;
      ply = num(p.ply, NaN);
      wr = num(p.blackWinrate, NaN);
      if (!isFinite(ply) || !isFinite(wr)) continue;
      ply = Math.round(ply);
      if (ply < 1) continue;
      rows.push({ ply: ply, rate: clamp(wr, 0, 100), grade: gradeOf(p.grade) });
    }
    rows.sort(function (a, b) { return a.ply - b.ply; });
    var out = [];
    for (i = 0; i < rows.length; i++) {
      if (i > 0 && rows[i].ply === rows[i - 1].ply) out[out.length - 1] = rows[i];
      else out.push(rows[i]);
    }
    return out;
  }

  function render(host, options) {
    if (!host || !host.nodeType) return null;
    var opts = options || {};
    var pts = normalize(opts.points);
    var onSeek = typeof opts.onSeek === 'function' ? opts.onSeek : null;
    var wantH = clamp(num(opts.height, DEFAULT_HEIGHT), 80, 600);

    var cur = null;
    if (opts.current !== null && opts.current !== undefined && opts.current !== '') {
      var c = num(opts.current, NaN);
      if (isFinite(c)) cur = Math.round(c);
    }

    /* 幂等：先拆掉上一次的观察者、监听与 DOM */
    if (host.__wrRO) {
      try { host.__wrRO.disconnect(); } catch (e) {}
      host.__wrRO = null;
    }
    if (host.__wrRAF) {
      try { cancelAnimationFrame(host.__wrRAF); } catch (e) {}
      host.__wrRAF = 0;
    }
    if (host.__wrResize) {
      try { global.removeEventListener('resize', host.__wrResize); } catch (e) {}
      host.__wrResize = null;
    }
    while (host.firstChild) host.removeChild(host.firstChild);

    host.classList.add('wr-chart');
    host.style.setProperty('--wr-height', wantH + 'px');

    if (!pts.length) {
      var empty = document.createElement('div');
      empty.className = 'wr-empty';
      empty.textContent = '还没有曲线数据';
      host.appendChild(empty);
      return null;
    }

    var padL = 26, padR = 10, padT = 20, padB = 13;
    var gid = 'wr-grad-' + (++seq);

    var svg = mk('svg', { role: 'img', 'aria-label': '黑方胜率曲线' });
    svg.style.display = 'block';
    svg.style.cursor = 'crosshair';

    var defs = mk('defs');
    var grad = mk('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(mk('stop', { offset: '0', 'stop-color': C.line, 'stop-opacity': '0.20' }));
    grad.appendChild(mk('stop', { offset: '1', 'stop-color': C.line, 'stop-opacity': '0.02' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    var gGrid = mk('g');
    var gArea = mk('g');
    var gLine = mk('g');
    var gDots = mk('g');
    var gMarker = mk('g');
    var gHover = mk('g', { opacity: '0', 'pointer-events': 'none' });

    svg.appendChild(gGrid);
    svg.appendChild(gArea);
    svg.appendChild(gLine);
    svg.appendChild(gDots);
    svg.appendChild(gMarker);
    svg.appendChild(gHover);

    var hLine = mk('line', { stroke: C.mid, 'stroke-width': 1 });
    var hDot = mk('circle', { r: 3.4, fill: 'none', stroke: C.line, 'stroke-width': 1.2 });
    gHover.appendChild(hLine);
    gHover.appendChild(hDot);

    var dense = pts.length > MAX_TITLES;
    var hText = null;
    if (dense) {
      hText = mk('text', {
        'font-size': 9.5,
        fill: '#43564a',
        'font-family': 'inherit',
        'paint-order': 'stroke',
        stroke: '#f3f2eb',
        'stroke-width': 3,
        'stroke-linejoin': 'round'
      });
      gHover.appendChild(hText);
    }

    var geo = {
      W: 0, H: 0, padT: padT, base: 0,
      x: function () { return padL; },
      y: function () { return 0; }
    };

    function clearGroup(g) {
      while (g.firstChild) g.removeChild(g.firstChild);
    }

    function measure() {
      var w = host.clientWidth;
      var h = host.clientHeight;
      try {
        var cs = global.getComputedStyle(host);
        w -= parseFloat(cs.paddingLeft) || 0;
        w -= parseFloat(cs.paddingRight) || 0;
        h -= parseFloat(cs.paddingTop) || 0;
        h -= parseFloat(cs.paddingBottom) || 0;
      } catch (e) {}
      if (!(w > 0)) w = 320;
      if (!(h > 0)) h = wantH - 14;
      return { w: Math.max(80, Math.round(w)), h: Math.max(60, Math.round(h)) };
    }

    function nearestIndexToPly(ply) {
      var best = 0, bd = Infinity, i, d;
      for (i = 0; i < pts.length; i++) {
        d = Math.abs(pts[i].ply - ply);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }

    function build() {
      var m = measure();
      var W = m.w, H = m.h;
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);

      var plotW = Math.max(1, W - padL - padR);
      var plotH = Math.max(1, H - padT - padB);
      var base = padT + plotH;
      var p0 = pts[0].ply;
      var pLast = pts[pts.length - 1].ply;
      var span = Math.max(1, pLast - p0);

      geo.W = W;
      geo.H = H;
      geo.padT = padT;
      geo.base = base;
      geo.x = pts.length === 1
        ? function () { return padL + plotW / 2; }
        : function (ply) { return padL + ((ply - p0) / span) * plotW; };
      geo.y = function (rate) { return padT + (1 - clamp(rate, 0, 100) / 100) * plotH; };

      gHover.setAttribute('opacity', '0');

      /* 网格：0 / 50 / 100，50 为虚线 */
      clearGroup(gGrid);
      var marks = [0, 50, 100];
      for (var gi = 0; gi < marks.length; gi++) {
        var v = marks[gi];
        var gy = r2(geo.y(v));
        gGrid.appendChild(mk('line', {
          x1: padL, x2: W - padR, y1: gy, y2: gy,
          stroke: v === 50 ? C.mid : C.grid,
          'stroke-width': 1,
          'stroke-dasharray': v === 50 ? '3 3' : 'none'
        }));
        var lb = mk('text', {
          x: padL - 5, y: r2(gy + 3),
          'text-anchor': 'end',
          'font-size': 8.5,
          fill: C.axis,
          'font-family': 'inherit',
          'font-variant-numeric': 'tabular-nums'
        });
        lb.textContent = String(v);
        gGrid.appendChild(lb);
      }

      /* 面积 + 折线 */
      clearGroup(gArea);
      clearGroup(gLine);
      if (pts.length > 1) {
        var line = '';
        var area = 'M' + r2(geo.x(pts[0].ply)) + ',' + r2(base);
        var i, X, Y;
        for (i = 0; i < pts.length; i++) {
          X = r2(geo.x(pts[i].ply));
          Y = r2(geo.y(pts[i].rate));
          line += (i ? 'L' : 'M') + X + ',' + Y;
          area += 'L' + X + ',' + Y;
        }
        area += 'L' + r2(geo.x(pts[pts.length - 1].ply)) + ',' + r2(base) + 'Z';
        gArea.appendChild(mk('path', { d: area, fill: 'url(#' + gid + ')' }));
        gLine.appendChild(mk('path', {
          d: line,
          fill: 'none',
          stroke: C.line,
          'stroke-width': 1.6,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round'
        }));
      }

      /* 采样点 */
      clearGroup(gDots);
      var dotR = dense ? 2 : 2.2;
      for (i = 0; i < pts.length; i++) {
        var p = pts[i];
        var dot = mk('circle', {
          cx: r2(geo.x(p.ply)),
          cy: r2(geo.y(p.rate)),
          r: dotR,
          fill: dotColor(p.grade)
        });
        if (!dense) {
          var tip = mk('title');
          tip.textContent = '第 ' + p.ply + ' 手 · 黑 ' + pct(p.rate) + gradeText(p.grade);
          dot.appendChild(tip);
        }
        gDots.appendChild(dot);
      }

      /* 当前手：竖虚线 + 大圆点 + 右上角标签 */
      clearGroup(gMarker);
      if (cur !== null) {
        var hit = pts[nearestIndexToPly(cur)];
        var cx = geo.x(clamp(cur, p0, pLast));
        var cy = geo.y(hit.rate);
        gMarker.appendChild(mk('line', {
          x1: r2(cx), x2: r2(cx), y1: padT - 2, y2: r2(base),
          stroke: C.line, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: '0.5'
        }));
        gMarker.appendChild(mk('circle', {
          cx: r2(cx), cy: r2(cy), r: 4,
          fill: C.paper, stroke: C.line, 'stroke-width': 2
        }));

        var label = '第 ' + cur + ' 手 · 黑 ' + pct(hit.rate);
        var fs = 10;
        var tw = r2(textWidth(label, fs) + 12);
        var tx = Math.max(padL, W - padR - tw);
        var ty = 2;
        gMarker.appendChild(mk('rect', {
          x: r2(tx), y: ty, width: Math.min(tw, W - padL - padR), height: 15,
          rx: 3, fill: C.labelBg, stroke: C.labelLine, 'stroke-width': 1
        }));
        var lt = mk('text', {
          x: r2(tx + tw / 2), y: ty + 10.5,
          'text-anchor': 'middle',
          'font-size': fs,
          fill: C.line,
          'font-family': 'inherit',
          'font-variant-numeric': 'tabular-nums'
        });
        lt.textContent = label;
        gMarker.appendChild(lt);
      }
    }

    function showHover(p, X, Y) {
      hLine.setAttribute('x1', X);
      hLine.setAttribute('x2', X);
      hLine.setAttribute('y1', geo.padT - 2);
      hLine.setAttribute('y2', r2(geo.base));
      hDot.setAttribute('cx', X);
      hDot.setAttribute('cy', Y);
      if (hText) {
        hText.textContent = p.ply + ' 手 · ' + pct(p.rate);
        hText.setAttribute('x', r2(X + (X > geo.W / 2 ? -6 : 6)));
        hText.setAttribute('y', r2(clamp(Y - 7, 12, geo.H - 4)));
        hText.setAttribute('text-anchor', X > geo.W / 2 ? 'end' : 'start');
        hText.setAttribute('display', 'inline');
      }
      gHover.setAttribute('opacity', '1');
    }

    function hideHover() {
      gHover.setAttribute('opacity', '0');
    }

    function locate(ev) {
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return null;
      var x = (ev.clientX - rect.left) * (geo.W / rect.width);
      var idx = 0, bd = Infinity, i, d;
      for (i = 0; i < pts.length; i++) {
        d = Math.abs(geo.x(pts[i].ply) - x);
        if (d < bd) { bd = d; idx = i; }
      }
      return {
        p: pts[idx],
        x: r2(geo.x(pts[idx].ply)),
        y: r2(geo.y(pts[idx].rate))
      };
    }

    var lastFirePly = null;
    var lastFireAt = 0;

    function fire(ply) {
      if (!onSeek) return;
      var now = Date.now();
      if (ply === lastFirePly && now - lastFireAt < 500) return;
      lastFirePly = ply;
      lastFireAt = now;
      onSeek(ply);
    }

    function seek(ev, withCallback) {
      var hit = locate(ev);
      if (!hit) return;
      showHover(hit.p, hit.x, hit.y);
      if (withCallback) fire(hit.p.ply);
    }

    var dragging = false;

    function onDown(ev) {
      dragging = true;
      try {
        if (svg.setPointerCapture) svg.setPointerCapture(ev.pointerId);
      } catch (e) {}
      seek(ev, true);
      if (ev.cancelable) ev.preventDefault();
    }

    function onMove(ev) {
      seek(ev, dragging);
    }

    function onUp(ev) {
      dragging = false;
      try {
        if (svg.releasePointerCapture) svg.releasePointerCapture(ev.pointerId);
      } catch (e) {}
    }

    function onLeave() {
      if (!dragging) hideHover();
    }

    function onClick(ev) {
      seek(ev, true);
    }

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('pointerleave', onLeave);
    svg.addEventListener('click', onClick);

    host.appendChild(svg);
    build();

    if (typeof global.ResizeObserver === 'function') {
      var ro = new global.ResizeObserver(function () {
        if (host.__wrRAF) return;
        host.__wrRAF = global.requestAnimationFrame(function () {
          host.__wrRAF = 0;
          build();
        });
      });
      ro.observe(host);
      host.__wrRO = ro;
    } else {
      var onResize = function () { build(); };
      global.addEventListener('resize', onResize);
      host.__wrResize = onResize;
    }

    return svg;
  }

  global.ReviewChart = {
    render: render,
    colors: C
  };
})(window);
