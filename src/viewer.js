/* SPDX-License-Identifier: Apache-2.0 */
/* The page: loads traces, draws them on a shared time axis, compares two. See trace.js for the format. */
(function () {
  'use strict';
  var T = window.RigTrace;
  var PALETTE = ['#e06c24', '#3987e5', '#2da44e', '#bf3989', '#8250df', '#b08800', '#1b9aaa', '#cf222e'];
  var PLOT_H = 170;
  var STRIP_H = 20;
  var M = { left: 64, right: 12, top: 8, bottom: 20 };

  var state = {
    a: null, b: null, layoutRaw: null,
    layout: null, hidden: {}, view: null, full: null, cursor: null, offsetB: 0, plots: [], strips: null
  };

  function $(id) { return document.getElementById(id); }

  function message(text, isError) {
    var el = $('message');
    el.textContent = text || '';
    el.hidden = !text;
    el.className = 'message' + (isError ? ' error' : '');
  }

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  /* ------------------------------------------------------------ loading */

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('could not read ' + file.name)); };
      r.readAsText(file);
    });
  }

  function setTrace(slot, text, name) {
    var loaded = T.load(text);
    if (loaded.error) {
      message(name + ': ' + loaded.error, true);
      return false;
    }
    loaded.name = name;
    state[slot] = loaded;
    var hint = $('name-' + slot);
    hint.textContent = name + ' · ' + loaded.table.length + ' rows · ' + loaded.table.columns.length + ' columns';
    $('drop-' + slot).classList.add('loaded');
    return true;
  }

  function setLayout(text, name) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { message(name + ' is not valid JSON: ' + e.message, true); return false; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { message(name + ': the layout must be a JSON object', true); return false; }
    state.layoutRaw = parsed;
    $('name-l').textContent = name;
    $('drop-l').classList.add('loaded');
    return true;
  }

  function loadFiles(slot, files) {
    if (!files || files.length === 0) { return; }
    var file = files[0];
    readFile(file).then(function (text) {
      var ok = slot === 'l' ? setLayout(text, file.name) : setTrace(slot, text, file.name);
      if (ok) { message(''); rebuild(); }
    }).catch(function (e) { message(e.message, true); });
  }

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) { throw new Error(url + ': HTTP ' + r.status); }
      return r.text();
    });
  }

  function loadUrls(spec) {
    var jobs = [];
    ['a', 'b', 'l'].forEach(function (slot) {
      if (!spec[slot]) { return; }
      var name = spec[slot].split('/').pop();
      jobs.push(fetchText(spec[slot]).then(function (text) {
        return slot === 'l' ? setLayout(text, name) : setTrace(slot, text, name);
      }));
    });
    return Promise.all(jobs).then(function (results) {
      /* a trace that failed to read has already said why; keep that message */
      if (results.every(function (ok) { return ok; })) { message(''); }
      rebuild();
    }).catch(function (e) {
      message('Could not load the example (' + e.message + '). From a file:// page the browser blocks this; serve the folder, for example with "python3 -m http.server", or choose the files by hand.', true);
    });
  }

  function clearAll() {
    state.a = null; state.b = null; state.layoutRaw = null;
    ['a', 'b', 'l'].forEach(function (s) { $('drop-' + s).classList.remove('loaded'); });
    $('name-a').textContent = 'drop a .csv here or click to choose';
    $('name-b').textContent = 'to compare with A, for example a board against the simulator';
    $('name-l').textContent = 'a .json that says which columns go in which panel';
  }

  /* ------------------------------------------------------------ model */

  function allNames(table) { return table.columns.map(function (c) { return c.name; }); }

  function computeLayout() {
    var a = state.a;
    var base;
    var warnings = [];
    if (state.layoutRaw) {
      var applied = T.applyLayout(a.table, state.layoutRaw, a.timeName);
      base = applied.layout;
      warnings = applied.warnings;
      if (base.panels.length === 0 && base.states.length === 0) {
        warnings.push('nothing in the layout matches this trace; showing the default panels');
        base = T.defaultLayout(a.table, a.timeName);
      }
    } else {
      base = T.defaultLayout(a.table, a.timeName);
    }
    state.layout = base;
    return warnings;
  }

  function fullRange() {
    var lo = state.a.times[0];
    var hi = state.a.times[state.a.times.length - 1];
    if (state.b) {
      lo = Math.min(lo, state.b.times[0] + state.offsetB);
      hi = Math.max(hi, state.b.times[state.b.times.length - 1] + state.offsetB);
    }
    if (hi <= lo) { hi = lo + 1; }
    return [lo, hi];
  }

  function colorOf(name) {
    var i = 0;
    var seen = state.colorIndex;
    if (seen[name] === undefined) { seen[name] = Object.keys(seen).length; }
    i = seen[name];
    return PALETTE[i % PALETTE.length];
  }

  function bTimes() {
    var out = new Float64Array(state.b.times.length);
    for (var i = 0; i < out.length; i++) { out[i] = state.b.times[i] + state.offsetB; }
    return out;
  }

  /* ------------------------------------------------------------ DOM */

  function rebuild() {
    if (!state.a) { $('view').hidden = true; return; }
    state.colorIndex = {};
    var warnings = computeLayout();
    state.full = fullRange();
    state.view = state.full.slice();
    state.cursor = null;
    state.hidden = {};
    state.layout.panels.forEach(function (p) {
      if (p.columns.length > 6) { p.columns.slice(4).forEach(function (n) { state.hidden[n] = true; }); }
    });

    $('view').hidden = false;
    $('reset').hidden = false;
    $('offset-wrap').hidden = !state.b;

    var host = $('panels');
    host.textContent = '';
    state.plots = [];
    state.layout.panels.forEach(function (p, i) { host.appendChild(buildPanel(p, i)); });
    if (state.layout.states.length > 0) { host.appendChild(buildStrips()); }
    buildCompare();
    if (warnings.length > 0) { message('Layout: ' + warnings.join('; '), false); }
    draw();
  }

  function buildPanel(p, index) {
    var box = document.createElement('div');
    box.className = 'panel';
    var h = document.createElement('h3');
    var title = p.title || 'Panel ' + (index + 1);
    h.textContent = title + (p.unit && p.unit !== title ? ' (' + p.unit + ')' : '');
    box.appendChild(h);
    var ul = document.createElement('ul');
    ul.className = 'legend';
    var plot = { panel: p, vals: {}, canvas: document.createElement('canvas') };
    p.columns.forEach(function (name) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', state.hidden[name] ? 'false' : 'true');
      var sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = colorOf(name);
      var label = document.createElement('span');
      label.textContent = name;
      var val = document.createElement('span');
      val.className = 'val';
      plot.vals[name] = val;
      btn.appendChild(sw); btn.appendChild(label); btn.appendChild(val);
      btn.addEventListener('click', function () {
        state.hidden[name] = !state.hidden[name];
        btn.setAttribute('aria-pressed', state.hidden[name] ? 'false' : 'true');
        draw();
      });
      li.appendChild(btn);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    plot.canvas.setAttribute('role', 'img');
    plot.canvas.setAttribute('aria-label', (p.title || 'Panel') + ': ' + p.columns.join(', '));
    attachPointer(plot.canvas);
    box.appendChild(plot.canvas);
    state.plots.push(plot);
    return box;
  }

  function buildStrips() {
    var box = document.createElement('div');
    box.className = 'panel';
    var h = document.createElement('h3');
    h.textContent = 'States';
    box.appendChild(h);
    var c = document.createElement('canvas');
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'States: ' + state.layout.states.join(', '));
    attachPointer(c);
    box.appendChild(c);
    state.strips = { canvas: c };
    return box;
  }

  function fmt(v) {
    if (v === undefined || isNaN(v)) { return '–'; }
    var a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
  }

  function buildCompare() {
    var wrap = $('compare-wrap');
    var table = $('compare');
    table.textContent = '';
    if (!state.b) { wrap.hidden = true; return; }
    var names = allNames(state.a.table).filter(function (n) { return n !== state.a.timeName; });
    var rows = T.compare(state.a, state.b, names, state.offsetB).filter(function (r) { return !T.isFlag(T.column(state.a.table, r.name)); });
    var head = table.createTHead().insertRow();
    ['Signal', 'max |A − B|', 'at t (s)', 'rms', 'samples'].forEach(function (t) {
      var th = document.createElement('th');
      th.textContent = t;
      head.appendChild(th);
    });
    var body = table.createTBody();
    rows.forEach(function (r) {
      var tr = body.insertRow();
      [r.name, fmt(r.max), r.at.toFixed(3), fmt(r.rms), String(r.samples)].forEach(function (t) {
        tr.insertCell().textContent = t;
      });
    });
    var onlyA = names.filter(function (n) { return !T.column(state.b.table, n); });
    var onlyB = allNames(state.b.table).filter(function (n) { return n !== state.b.timeName && !T.column(state.a.table, n); });
    if (rows.length === 0) { message('A and B have no number column in common, so there is nothing to compare.', true); }
    else if (onlyA.length + onlyB.length > 0) {
      message('Not compared: ' + (onlyA.length ? 'only in A: ' + onlyA.join(', ') + '. ' : '') + (onlyB.length ? 'only in B: ' + onlyB.join(', ') + '.' : ''), false);
    }
    wrap.hidden = false;
  }

  /* ------------------------------------------------------------ drawing */

  function setupCanvas(c, h) {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(240, c.clientWidth || c.parentNode.clientWidth - 16);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.height = h + 'px';
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function xOf(t, w) { return M.left + ((t - state.view[0]) / (state.view[1] - state.view[0])) * (w - M.left - M.right); }
  function tOf(x, w) { return state.view[0] + ((x - M.left) / (w - M.left - M.right)) * (state.view[1] - state.view[0]); }

  function niceStep(span, n) {
    var raw = span / n;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  function drawAxes(ctx, w, h, y0, y1, showY) {
    var muted = css('--muted');
    var hair = css('--hairline');
    ctx.font = '11px ' + css('--mono');
    ctx.fillStyle = muted;
    ctx.strokeStyle = hair;
    ctx.lineWidth = 1;
    var xs = niceStep(state.view[1] - state.view[0], Math.max(2, Math.floor(w / 110)));
    ctx.textAlign = 'center';
    for (var t = Math.ceil(state.view[0] / xs) * xs; t <= state.view[1] + 1e-9; t += xs) {
      var x = Math.round(xOf(t, w)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, M.top); ctx.lineTo(x, h - M.bottom); ctx.stroke();
      ctx.fillText(+t.toFixed(6) + '', x, h - 5);
    }
    if (showY) {
      var ys = niceStep(y1 - y0, 4);
      ctx.textAlign = 'right';
      for (var v = Math.ceil(y0 / ys) * ys; v <= y1 + 1e-9; v += ys) {
        var y = Math.round(yOf(v, y0, y1, h)) + 0.5;
        ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(w - M.right, y); ctx.stroke();
        ctx.fillText(+v.toPrecision(6) + '', M.left - 6, y + 4);
      }
    }
  }

  function yOf(v, y0, y1, h) { return M.top + (1 - (v - y0) / (y1 - y0)) * (h - M.top - M.bottom); }

  function seriesOf(plot, name) {
    var out = [];
    var ca = T.column(state.a.table, name);
    if (ca && ca.kind === 'real') { out.push({ times: state.a.times, values: ca.values, dashed: false, key: 'A' }); }
    if (state.b) {
      var cb = T.column(state.b.table, name);
      if (cb && cb.kind === 'real') { out.push({ times: state.bShift, values: cb.values, dashed: true, key: 'B' }); }
    }
    return out;
  }

  function rangeOf(plot) {
    var lo = Infinity;
    var hi = -Infinity;
    plot.panel.columns.forEach(function (name) {
      if (state.hidden[name]) { return; }
      seriesOf(plot, name).forEach(function (s) {
        var i0 = Math.max(0, T.indexAt(s.times, state.view[0]));
        var i1 = Math.min(s.times.length - 1, T.indexAt(s.times, state.view[1]) + 1);
        for (var i = i0; i <= i1; i++) {
          var v = s.values[i];
          if (!isNaN(v)) { if (v < lo) { lo = v; } if (v > hi) { hi = v; } }
        }
      });
    });
    if (!isFinite(lo)) { return [0, 1]; }
    if (hi === lo) { return [lo - 1, hi + 1]; }
    var pad = (hi - lo) * 0.06;
    return [lo - pad, hi + pad];
  }

  function drawSeries(ctx, s, color, w, h, y0, y1) {
    var plotW = w - M.left - M.right;
    var i0 = Math.max(0, T.indexAt(s.times, state.view[0]));
    var i1 = Math.min(s.times.length - 1, T.indexAt(s.times, state.view[1]) + 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(s.dashed ? [6, 4] : []);
    ctx.save();
    ctx.beginPath();
    ctx.rect(M.left, M.top, plotW, h - M.top - M.bottom);
    ctx.clip();
    ctx.beginPath();
    var dense = (i1 - i0) > plotW * 2;
    if (!dense) {
      var pen = false;
      for (var i = i0; i <= i1; i++) {
        var v = s.values[i];
        if (isNaN(v)) { pen = false; continue; }
        var x = xOf(s.times[i], w);
        var y = yOf(v, y0, y1, h);
        if (pen) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); pen = true; }
      }
    } else {
      /* per pixel column: first, lowest, highest and last value, in one connected path, so spikes stay visible */
      var bx = null; var first = 0; var last = 0; var mn = 0; var mx = 0; var started = false;
      var flush = function () {
        if (bx === null) { return; }
        var x = bx + 0.5;
        var pts = [first, mn, mx, last];
        for (var q = 0; q < 4; q++) {
          var yy = yOf(pts[q], y0, y1, h);
          if (started) { ctx.lineTo(x, yy); } else { ctx.moveTo(x, yy); started = true; }
        }
      };
      for (var k = i0; k <= i1; k++) {
        var val = s.values[k];
        if (isNaN(val)) { flush(); bx = null; started = false; continue; }
        var px = Math.floor(xOf(s.times[k], w));
        if (px !== bx) { flush(); bx = px; first = val; mn = val; mx = val; }
        else if (val < mn) { mn = val; }
        else if (val > mx) { mx = val; }
        last = val;
      }
      flush();
    }
    ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);
  }

  function drawCursor(ctx, w, h) {
    if (state.cursor === null || state.cursor < state.view[0] || state.cursor > state.view[1]) { return; }
    var x = Math.round(xOf(state.cursor, w)) + 0.5;
    ctx.strokeStyle = css('--muted');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, M.top); ctx.lineTo(x, h - M.bottom); ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawPlot(plot) {
    var g = setupCanvas(plot.canvas, PLOT_H);
    var r = rangeOf(plot);
    drawAxes(g.ctx, g.w, g.h, r[0], r[1], true);
    plot.panel.columns.forEach(function (name) {
      if (state.hidden[name]) { return; }
      seriesOf(plot, name).forEach(function (s) { drawSeries(g.ctx, s, colorOf(name), g.w, g.h, r[0], r[1]); });
    });
    drawCursor(g.ctx, g.w, g.h);
    plot.w = g.w;
  }

  function colorOfText(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return PALETTE[h % PALETTE.length];
  }

  function drawStrips() {
    var rows = [];
    state.layout.states.forEach(function (name) {
      rows.push({ name: name, trace: state.a, tag: state.b ? 'A' : '', times: state.a.times });
      if (state.b && T.column(state.b.table, name)) { rows.push({ name: name, trace: state.b, tag: 'B', times: state.bShift }); }
    });
    var h = M.top + rows.length * (STRIP_H + 16) + M.bottom;
    var g = setupCanvas(state.strips.canvas, h);
    var ctx = g.ctx;
    drawAxes(ctx, g.w, g.h, 0, 1, false);
    ctx.font = '11px ' + css('--mono');
    rows.forEach(function (row, i) {
      var col = T.column(row.trace.table, row.name);
      var y = M.top + 12 + i * (STRIP_H + 16);
      ctx.fillStyle = css('--muted');
      ctx.textAlign = 'left';
      ctx.fillText((row.tag ? row.tag + ' · ' : '') + row.name, M.left, y - 3);
      if (!col || col.kind === 'empty') { return; }
      var times = row.times;
      var n = times.length;
      var start = 0;
      for (var k = 1; k <= n; k++) {
        var same = k < n && String(col.values[k]) === String(col.values[start]) ;
        if (same) { continue; }
        var label = String(col.values[start]);
        var x0 = xOf(times[start], g.w);
        var x1 = k < n ? xOf(times[k], g.w) : xOf(times[n - 1], g.w);
        var cx0 = Math.max(M.left, x0);
        var cx1 = Math.min(g.w - M.right, x1);
        if (cx1 > cx0 && label !== '') {
          var on = col.kind === 'real' ? label === '1' : true;
          ctx.globalAlpha = col.kind === 'real' && !on ? 0.12 : 0.4;
          ctx.fillStyle = col.kind === 'real' ? css('--accent') : colorOfText(label);
          ctx.fillRect(cx0, y, cx1 - cx0, STRIP_H);
          ctx.globalAlpha = 1;
          if (cx1 - cx0 > label.length * 7 + 6 && (col.kind === 'text' || on)) {
            ctx.fillStyle = css('--text');
            ctx.textAlign = 'left';
            ctx.fillText(label, cx0 + 4, y + STRIP_H - 6);
          }
        }
        start = k;
      }
    });
    drawCursor(ctx, g.w, g.h);
    state.strips.w = g.w;
  }

  function updateReadouts() {
    state.plots.forEach(function (plot) {
      plot.panel.columns.forEach(function (name) {
        var el = plot.vals[name];
        if (state.cursor === null) { el.textContent = ''; return; }
        var txt = '';
        var ca = T.column(state.a.table, name);
        if (ca && ca.kind === 'real') { txt = fmt(T.valueAt(state.a.times, ca.values, state.cursor)); }
        if (state.b) {
          var cb = T.column(state.b.table, name);
          if (cb && cb.kind === 'real') { txt += ' / ' + fmt(T.valueAt(state.bShift, cb.values, state.cursor)); }
        }
        el.textContent = txt;
      });
    });
  }

  function draw() {
    if (!state.a) { return; }
    state.bShift = state.b ? bTimes() : null;
    state.plots.forEach(drawPlot);
    if (state.strips) { drawStrips(); }
    updateReadouts();
  }

  var raf = 0;
  function schedule() { if (!raf) { raf = requestAnimationFrame(function () { raf = 0; draw(); }); } }

  /* ------------------------------------------------------------ interaction */

  function clampView(lo, hi) {
    var span = hi - lo;
    var full = state.full[1] - state.full[0];
    var min = full / 5000;
    if (span < min) { var mid = (lo + hi) / 2; lo = mid - min / 2; hi = mid + min / 2; span = min; }
    if (span > full) { lo = state.full[0]; hi = state.full[1]; }
    if (lo < state.full[0]) { hi += state.full[0] - lo; lo = state.full[0]; }
    if (hi > state.full[1]) { lo -= hi - state.full[1]; hi = state.full[1]; }
    state.view = [Math.max(lo, state.full[0]), Math.min(hi, state.full[1])];
  }

  function zoom(factor, atT) {
    var lo = atT - (atT - state.view[0]) * factor;
    var hi = atT + (state.view[1] - atT) * factor;
    clampView(lo, hi);
  }

  function pan(dt) { clampView(state.view[0] + dt, state.view[1] + dt); }

  function attachPointer(c) {
    var drag = null;
    function tAt(ev) {
      var rect = c.getBoundingClientRect();
      return tOf(ev.clientX - rect.left, rect.width);
    }
    c.addEventListener('pointermove', function (ev) {
      var t = tAt(ev);
      if (drag) {
        pan(drag.t - t);
        t = tAt(ev);
      }
      state.cursor = t;
      schedule();
    });
    c.addEventListener('pointerdown', function (ev) {
      drag = { t: tAt(ev) };
      c.setPointerCapture(ev.pointerId);
    });
    function end() { drag = null; }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', function () { if (!drag) { state.cursor = null; schedule(); } });
    c.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      zoom(ev.deltaY < 0 ? 0.8 : 1.25, tAt(ev));
      schedule();
    }, { passive: false });
    c.addEventListener('dblclick', function () { state.view = state.full.slice(); schedule(); });
  }

  function onKey(ev) {
    var span = state.view[1] - state.view[0];
    var mid = (state.view[0] + state.view[1]) / 2;
    if (ev.key === 'ArrowLeft') { pan(-span * 0.1); }
    else if (ev.key === 'ArrowRight') { pan(span * 0.1); }
    else if (ev.key === '+' || ev.key === '=') { zoom(0.8, state.cursor === null ? mid : state.cursor); }
    else if (ev.key === '-') { zoom(1.25, state.cursor === null ? mid : state.cursor); }
    else if (ev.key === '0' || ev.key === 'Home') { state.view = state.full.slice(); }
    else { return; }
    ev.preventDefault();
    schedule();
  }

  /* ------------------------------------------------------------ wiring */

  function wire() {
    ['a', 'b', 'l'].forEach(function (slot) {
      $('file-' + slot).addEventListener('change', function (ev) { loadFiles(slot, ev.target.files); ev.target.value = ''; });
      var zone = $('drop-' + slot);
      zone.addEventListener('dragover', function (ev) { ev.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
      zone.addEventListener('drop', function (ev) {
        ev.preventDefault(); ev.stopPropagation(); zone.classList.remove('over');
        loadFiles(slot, ev.dataTransfer.files);
      });
    });
    /* a file dropped anywhere else goes to A, or to the layout if it is JSON */
    document.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    document.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) { loadFiles(/\.json$/i.test(f.name) ? 'l' : (state.a ? 'b' : 'a'), [f]); }
    });
    $('offset').addEventListener('input', function (ev) {
      var v = Number(ev.target.value);
      state.offsetB = isFinite(v) ? v : 0;
      state.full = fullRange();
      state.view = state.full.slice();
      buildCompare();
      draw();
    });
    $('reset').addEventListener('click', function () { if (state.full) { state.view = state.full.slice(); draw(); } });
    $('panels').addEventListener('keydown', onKey);
    window.addEventListener('resize', schedule);
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (dark && dark.addEventListener) { dark.addEventListener('change', schedule); }

    function example(spec) {
      return function () { clearAll(); state.offsetB = 0; $('offset').value = '0'; loadUrls(spec); };
    }
    $('ex-flywheel').addEventListener('click', example({ a: 'examples/flywheel.csv' }));
    $('ex-hoist').addEventListener('click', example({ a: 'examples/hoist_step.csv', l: 'examples/hoist_step.layout.json' }));
    $('ex-compare').addEventListener('click', example({ a: 'examples/flywheel.csv', b: 'examples/flywheel-heavier-load.csv' }));

    var q = new URLSearchParams(location.search);
    if (q.get('a') || q.get('b') || q.get('layout')) {
      loadUrls({ a: q.get('a'), b: q.get('b'), l: q.get('layout') });
    }
  }

  wire();
}());
