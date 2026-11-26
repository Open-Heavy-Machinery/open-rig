/* SPDX-License-Identifier: Apache-2.0 */
/* The page: loads traces, draws them on a shared time axis, compares two, draws the oracle's verdicts, and shows the bus (a frame log, decoded with a DBC). See trace.js, framelog.js, dbc.js and j1939.js for the formats. */
(function () {
  'use strict';
  var T = window.RigTrace;
  var FR = window.RigFrames;
  var DB = window.RigDbc;
  var J = window.RigJ1939;
  var LANE_H = 26;
  var LAT_H = 64;
  var TO_DUT_COLOR = '#3987e5';
  var FROM_DUT_COLOR = '#8250df';
  var PALETTE = ['#e06c24', '#3987e5', '#2da44e', '#bf3989', '#8250df', '#b08800', '#1b9aaa', '#cf222e'];
  var PLOT_H = 170;
  var STRIP_H = 20;
  var CRIT_H = 18;
  var PASS_COLOR = '#2da44e';
  var FAIL_COLOR = '#cf222e';
  var M = { left: 64, right: 12, top: 8, bottom: 20 };

  var state = {
    a: null, b: null, layoutRaw: null, verdicts: null, verdictsName: '', selected: null, crit: null,
    layout: null, hidden: {}, view: null, full: null, cursor: null, offsetB: 0, plots: [], strips: null,
    frames: null, framesName: '', dbc: null, dbcName: '', bus: null, lanes: null, analysis: null, selFrame: null,
    showLatency: false
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

  function setVerdicts(text, name) {
    var parsed = T.parseVerdicts(text);
    if (parsed.error) {
      message(name + ': line ' + parsed.error.line + ': ' + parsed.error.message, true);
      return false;
    }
    state.verdicts = parsed.criteria;
    state.verdictsName = name;
    state.selected = null;
    var failed = parsed.criteria.filter(function (c) { return c.verdict === 'FAIL'; }).length;
    $('name-v').textContent = name + ' · ' + parsed.criteria.length + ' criteria · ' + (failed ? failed + ' FAIL' : 'all PASS');
    $('drop-v').classList.add('loaded');
    return true;
  }

  function setFrames(text, name) {
    var parsed = FR.parseFrameLog(text);
    if (parsed.error) {
      message(name + ': line ' + parsed.error.line + ': ' + parsed.error.message, true);
      return false;
    }
    state.frames = parsed;
    state.framesName = name;
    state.selFrame = null;
    var lost = parsed.frames.filter(function (f) { return f.lost; }).length;
    $('name-f').textContent = name + ' · ' + parsed.frames.length + ' frames · bus_clock=' + parsed.meta.busClock +
      (lost ? ' · ' + lost + ' lost' : '');
    $('drop-f').classList.add('loaded');
    return true;
  }

  function setDbc(text, name) {
    var db = DB.parseDbc(text);
    if (db.error) {
      message(name + ': line ' + db.error.line + ': ' + db.error.message, true);
      return false;
    }
    state.dbc = db;
    state.dbcName = name;
    $('name-d').textContent = name + ' · ' + db.messages.length + ' messages · ' + (db.j1939 ? 'J1939' : 'CAN') +
      (db.warnings.length ? ' · ' + db.warnings.length + ' warnings' : '');
    $('drop-d').classList.add('loaded');
    if (db.warnings.length) { message(name + ': ' + db.warnings.join('; '), false); }
    return true;
  }

  function setSlot(slot, text, name) {
    if (slot === 'f') { return setFrames(text, name); }
    if (slot === 'd') { return setDbc(text, name); }
    if (slot === 'l') { return setLayout(text, name); }
    if (slot === 'v') { return setVerdicts(text, name); }
    return setTrace(slot, text, name);
  }

  function loadFiles(slot, files) {
    if (!files || files.length === 0) { return; }
    var file = files[0];
    readFile(file).then(function (text) {
      var ok = setSlot(slot, text, file.name);
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
    ['a', 'b', 'l', 'v', 'f', 'd'].forEach(function (slot) {
      if (!spec[slot]) { return; }
      var name = spec[slot].split('/').pop();
      jobs.push(fetchText(spec[slot]).then(function (text) {
        return setSlot(slot, text, name);
      }));
    });
    return Promise.all(jobs).then(function (results) {
      /* a file that failed to read has already said why; keep that message (and the DBC's warnings) */
      if (results.every(function (ok) { return ok; }) && !(state.dbc && state.dbc.warnings.length)) { message(''); }
      rebuild();
    }).catch(function (e) {
      message('Could not load the example (' + e.message + '). From a file:// page the browser blocks this; serve the folder, for example with "python3 -m http.server", or choose the files by hand.', true);
    });
  }

  function clearAll() {
    state.a = null; state.b = null; state.layoutRaw = null; state.verdicts = null; state.selected = null;
    state.frames = null; state.dbc = null; state.selFrame = null;
    ['a', 'b', 'l', 'v', 'f', 'd'].forEach(function (s) { $('drop-' + s).classList.remove('loaded'); });
    $('name-f').textContent = 'the .frames.csv of the same run: every frame on the bus, with its two times';
    $('name-d').textContent = 'a .dbc that names the frames and their signals';
    $('name-a').textContent = 'drop a .csv here or click to choose';
    $('name-b').textContent = 'to compare with A, for example a board against the simulator';
    $('name-l').textContent = 'a .json that says which columns go in which panel';
    $('name-v').textContent = 'the oracle\'s .verdicts.csv for trace A: windows, reactions and failures over the plots';
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
    var lo = Infinity;
    var hi = -Infinity;
    if (state.a) {
      lo = state.a.times[0];
      hi = state.a.times[state.a.times.length - 1];
    }
    if (state.frames && state.frames.sorted.length > 0) {
      lo = Math.min(lo, state.frames.sorted[0].t);
      hi = Math.max(hi, state.frames.sorted[state.frames.sorted.length - 1].t);
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
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
    if (!state.a && !state.frames) { $('view').hidden = true; return; }
    state.colorIndex = {};
    var warnings = state.a ? computeLayout() : [];
    if (!state.a) { state.layout = { panels: [], states: [] }; }
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
    state.crit = null;
    if (state.verdicts) { host.appendChild(buildCriteria()); }
    /* the bus right under the criteria: a fault and the controller's reaction to it are read there first */
    state.bus = null;
    if (state.frames) { host.appendChild(buildBus()); }
    state.layout.panels.forEach(function (p, i) { host.appendChild(buildPanel(p, i)); });
    state.strips = null;
    if (state.layout.states.length > 0) { host.appendChild(buildStrips()); }
    buildCompare();
    buildVerdictList();
    if (warnings.length > 0) { message('Layout: ' + warnings.join('; '), false); }
    draw();
  }

  /* ------------------------------------------------------------ verdicts */

  function buildCriteria() {
    var box = document.createElement('div');
    box.className = 'panel';
    var h = document.createElement('h3');
    h.textContent = 'Criteria (' + state.verdictsName + ')';
    box.appendChild(h);
    var c = document.createElement('canvas');
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'Acceptance criteria windows: ' + state.verdicts.map(function (v) { return v.id + ' ' + v.verdict; }).join(', '));
    attachPointer(c);
    box.appendChild(c);
    state.crit = { canvas: c };
    return box;
  }

  function describe(c) {
    var parts = ['[' + c.from.toFixed(2) + ' s .. ' + c.until.toFixed(2) + ' s]'];
    if (c.reaction === 'measured') { parts.push('reaction ' + c.reactionMs + ' ms after ' + c.event); }
    else if (c.reaction === 'not_holding') { parts.push('not holding at ' + c.from.toFixed(2) + ' s'); }
    else if (c.reaction === 'not_measured') { parts.push('reaction not measured'); }
    if (c.status === 'violated') { parts.push('first violation at ' + c.failT.toFixed(2) + ' s'); }
    else if (c.status === 'not_evaluated') { parts.push('not evaluated: no step in the window'); }
    else if (c.status === 'not_covered') { parts.push('the run ended before the window did'); }
    return parts.join(' · ');
  }

  function buildVerdictList() {
    var wrap = $('verdicts-wrap');
    var list = $('verdict-list');
    list.textContent = '';
    if (!state.verdicts) { wrap.hidden = true; return; }
    state.verdicts.forEach(function (c, i) {
      var li = document.createElement('li');
      li.className = 'crit ' + (c.verdict === 'PASS' ? 'pass' : 'fail');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      var mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = (c.verdict === 'PASS' ? '✓ ' : '✗ ') + c.id;
      var what = document.createElement('span');
      what.className = 'what';
      what.textContent = c.text;
      var detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = describe(c);
      btn.appendChild(mark); btn.appendChild(what); btn.appendChild(detail);
      btn.addEventListener('click', function () { select(state.selected === i ? null : i); });
      li.appendChild(btn);
      list.appendChild(li);
    });
    wrap.hidden = false;
  }

  /* Selects criterion i (or none): zooms to its window, with its event, and draws it over the plots. */
  function select(i) {
    state.selected = i;
    Array.prototype.forEach.call($('verdict-list').querySelectorAll('button'), function (b, j) {
      b.setAttribute('aria-pressed', state.selected === j ? 'true' : 'false');
    });
    if (i !== null) {
      var c = state.verdicts[i];
      var lo = c.eventT === null ? c.from : Math.min(c.from, c.eventT);
      var span = Math.max(c.until - lo, (state.full[1] - state.full[0]) / 100);
      clampView(lo - span * 0.15, c.until + span * 0.15);
    }
    draw();
  }

  function selectById(id) {
    if (!state.verdicts || !state.a) { return; }
    for (var i = 0; i < state.verdicts.length; i++) {
      if (state.verdicts[i].id === id) { select(i); return; }
    }
    message('No criterion "' + id + '" in ' + state.verdictsName, true);
  }

  /* The marks of one criterion in a band from `top` to `bottom`: ▼ event, ● end of the reaction, ✕ first violation. */
  function drawMarks(ctx, c, w, top, bottom) {
    var mid = (top + bottom) / 2;
    if (c.eventT !== null && c.eventT >= state.view[0] && c.eventT <= state.view[1]) {
      var xe = xOf(c.eventT, w);
      ctx.fillStyle = css('--text');
      ctx.beginPath(); ctx.moveTo(xe - 5, top); ctx.lineTo(xe + 5, top); ctx.lineTo(xe, top + 7); ctx.closePath(); ctx.fill();
    }
    if (c.reactionEnd !== null && c.reactionEnd >= state.view[0] && c.reactionEnd <= state.view[1]) {
      ctx.fillStyle = PASS_COLOR;
      ctx.beginPath(); ctx.arc(xOf(c.reactionEnd, w), mid, 4, 0, 2 * Math.PI); ctx.fill();
    }
    if (c.failT !== null && c.failT >= state.view[0] && c.failT <= state.view[1]) {
      var xf = xOf(c.failT, w);
      ctx.strokeStyle = FAIL_COLOR;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xf - 4, mid - 4); ctx.lineTo(xf + 4, mid + 4); ctx.moveTo(xf + 4, mid - 4); ctx.lineTo(xf - 4, mid + 4); ctx.stroke();
    }
  }

  function drawCriteria() {
    var list = state.verdicts;
    var h = M.top + list.length * (CRIT_H + 6) + M.bottom;
    var g = setupCanvas(state.crit.canvas, h);
    var ctx = g.ctx;
    drawAxes(ctx, g.w, g.h, 0, 1, false);
    ctx.font = '11px ' + css('--mono');
    list.forEach(function (c, i) {
      var y = M.top + i * (CRIT_H + 6);
      ctx.fillStyle = c.verdict === 'PASS' ? PASS_COLOR : FAIL_COLOR;
      ctx.textAlign = 'right';
      ctx.fillText(c.id, M.left - 6, y + CRIT_H - 5);
      var x0 = Math.max(M.left, xOf(c.from, g.w));
      var x1 = Math.min(g.w - M.right, xOf(c.until, g.w));
      if (x1 >= x0) {
        ctx.globalAlpha = state.selected === null || state.selected === i ? 0.35 : 0.15;
        ctx.fillRect(x0, y, Math.max(1, x1 - x0), CRIT_H);
        ctx.globalAlpha = 1;
        if (state.selected === i) {
          ctx.strokeStyle = css('--focus');
          ctx.lineWidth = 2;
          ctx.strokeRect(x0, y, Math.max(1, x1 - x0), CRIT_H);
        }
      }
      drawMarks(ctx, c, g.w, y, y + CRIT_H);
    });
    drawCursor(ctx, g.w, g.h);
    state.crit.w = g.w;
  }

  /* The selected criterion over a plot: its window shaded, and lines at its event, reaction end and first violation. */
  function drawSelectedOver(ctx, w, h) {
    if (!state.verdicts || state.selected === null) { return; }
    var c = state.verdicts[state.selected];
    var top = M.top;
    var bottom = h - M.bottom;
    var x0 = Math.max(M.left, xOf(c.from, w));
    var x1 = Math.min(w - M.right, xOf(c.until, w));
    if (x1 >= x0) {
      ctx.fillStyle = c.verdict === 'PASS' ? PASS_COLOR : FAIL_COLOR;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(x0, top, Math.max(1, x1 - x0), bottom - top);
      ctx.globalAlpha = 1;
    }
    [[c.eventT, css('--muted')], [c.reactionEnd, PASS_COLOR], [c.failT, FAIL_COLOR]].forEach(function (m) {
      if (m[0] === null || m[0] < state.view[0] || m[0] > state.view[1]) { return; }
      var x = Math.round(xOf(m[0], w)) + 0.5;
      ctx.strokeStyle = m[1];
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.setLineDash([]);
    });
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
    if (!state.b || !state.a) { wrap.hidden = true; return; }
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

  /* ------------------------------------------------------------ bus view */

  function hex2(v, n) { return ('00000000' + v.toString(16).toUpperCase()).slice(-n); }

  /* One lane per message (or identifier) × source address × direction, in time order. */
  function computeLanes() {
    var db = state.dbc;
    var byKey = {};
    var lanes = [];
    state.frames.sorted.forEach(function (f) {
      var msg = db ? J.messageFor(db, f) : null;
      f.message = msg;
      var j = db && db.j1939 && f.ext;
      var src = j ? J.parts(f.id).source : null;
      var name = msg ? msg.name : (f.ext ? hex2(f.id, 8) : hex2(f.id, 3));
      var key = name + '|' + (src === null ? '' : src) + '|' + f.dir;
      var lane = byKey[key];
      if (!lane) {
        lane = byKey[key] = {
          name: name, source: src, dir: f.dir, frames: [], cycleMs: msg ? msg.cycleMs : null,
          label: name + (src === null ? '' : ' · 0x' + hex2(src, 2)) + (f.dir === 'to_dut' ? ' → DUT' : ' ← DUT')
        };
        lanes.push(lane);
      }
      f.lane = lane;
      lane.frames.push(f);
    });
    lanes.sort(function (a, b) {
      if (a.dir !== b.dir) { return a.dir === 'to_dut' ? -1 : 1; }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : (a.source || 0) - (b.source || 0);
    });
    state.lanes = lanes;
    state.analysis = (db && db.j1939) ? J.analyse(state.frames.sorted) : { bam: {}, tsc1: {} };
  }

  function busHeight() {
    return M.top + state.lanes.length * LANE_H + (state.showLatency ? LAT_H + 18 : 0) + M.bottom;
  }

  function buildBus() {
    computeLanes();
    var box = document.createElement('div');
    box.className = 'panel bus';
    var h = document.createElement('h3');
    var meta = state.frames.meta;
    h.textContent = 'Bus (' + state.framesName + (state.dbc ? ', ' + state.dbcName : ', no dictionary') + ')';
    box.appendChild(h);
    var tools = document.createElement('div');
    tools.className = 'bus-tools';
    var lat = document.createElement('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.showLatency;
    cb.addEventListener('change', function () { state.showLatency = cb.checked; draw(); });
    lat.appendChild(cb);
    lat.appendChild(document.createTextNode(' t_bus − t_s (bus_clock=' + meta.busClock +
      (meta.busClockErrNs === null ? '' : ', ±' + meta.busClockErrNs + ' ns') + ')'));
    tools.appendChild(lat);
    var key = document.createElement('span');
    key.className = 'bus-key';
    key.textContent = '| frame   ▯ lost (never reached its receiver)   red: corrupted, or a TSC1 that is not intact   — gap: more than twice the period without a frame   shade: a link fault';
    tools.appendChild(key);
    box.appendChild(tools);
    var c = document.createElement('canvas');
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'Bus: ' + state.frames.frames.length + ' frames in ' + state.lanes.length + ' lanes: ' +
      state.lanes.map(function (l) { return l.label + ' (' + l.frames.length + ')'; }).join(', ') + '. Choose a frame to decode it below.');
    attachPointer(c);
    attachBusClick(c);
    box.appendChild(c);
    var detail = document.createElement('div');
    detail.className = 'frame-detail';
    detail.id = 'frame-detail';
    detail.setAttribute('aria-live', 'polite');
    box.appendChild(detail);
    state.bus = { canvas: c, detail: detail };
    renderDetail();
    return box;
  }

  function isBad(f) {
    if (f.fault === 'corrupt') { return true; }
    var t = state.analysis.tsc1[f.index];
    return !!(t && !t.intact);
  }

  /* Frames of a lane inside the view, by binary search on t. */
  function laneRange(lane) {
    return [Math.max(0, FR.indexAtTime(lane.frames, state.view[0]) ), FR.indexAtTime(lane.frames, state.view[1])];
  }

  function drawBus() {
    var g = setupCanvas(state.bus.canvas, busHeight());
    var ctx = g.ctx;
    var w = g.w;
    drawAxes(ctx, w, g.h, 0, 1, false);
    var stepS = state.frames.meta.stepNs / 1e9;
    ctx.font = '11px ' + css('--mono');
    state.lanes.forEach(function (lane, li) {
      var y = M.top + li * LANE_H;
      var tickTop = y + 13;
      var tickBottom = y + LANE_H - 3;
      ctx.fillStyle = css('--muted');
      ctx.textAlign = 'left';
      ctx.fillText(lane.label + '  ' + lane.frames.length, M.left + 2, y + 10);
      var r = laneRange(lane);
      if (r[1] < 0) { return; }
      var color = lane.dir === 'to_dut' ? TO_DUT_COLOR : FROM_DUT_COLOR;
      var lastPx = { normal: -1, lost: -1, bad: -1 };
      var prevOk = null;
      for (var i = Math.max(0, r[0] - 1); i <= Math.min(lane.frames.length - 1, r[1] + 1); i++) {
        var f = lane.frames[i];
        var x = xOf(f.t, w);
        /* a link fault: the step it happened in, shaded */
        if (f.fault !== '' && x >= M.left - 2 && x <= w - M.right) {
          var x1 = xOf(f.t + stepS, w);
          ctx.fillStyle = FAIL_COLOR;
          ctx.globalAlpha = 0.12;
          ctx.fillRect(Math.max(M.left, x), y + 11, Math.max(1, Math.min(w - M.right, x1) - Math.max(M.left, x)), LANE_H - 12);
          ctx.globalAlpha = 1;
        }
        /* a gap: longer than twice the period with no frame that got through */
        if (!f.lost) {
          if (prevOk && lane.cycleMs && (f.t - prevOk.t) * 1000 > 2 * lane.cycleMs) {
            var gx0 = Math.max(M.left, xOf(prevOk.t, w));
            var gx1 = Math.min(w - M.right, x);
            if (gx1 > gx0) {
              ctx.strokeStyle = FAIL_COLOR;
              ctx.lineWidth = 2;
              ctx.beginPath(); ctx.moveTo(gx0, tickBottom + 1); ctx.lineTo(gx1, tickBottom + 1); ctx.stroke();
            }
          }
          prevOk = f;
        }
        if (x < M.left - 1 || x > w - M.right + 1) { continue; }
        var px = Math.round(x);
        var kind = f.lost ? 'lost' : isBad(f) ? 'bad' : 'normal';
        if (lastPx[kind] === px) { continue; }
        lastPx[kind] = px;
        if (kind === 'lost') {
          ctx.strokeStyle = FAIL_COLOR;
          ctx.lineWidth = 1;
          ctx.strokeRect(px - 2.5, tickTop + 0.5, 5, tickBottom - tickTop - 1);
        } else {
          ctx.strokeStyle = kind === 'bad' ? FAIL_COLOR : color;
          ctx.lineWidth = kind === 'bad' ? 2 : 1;
          ctx.beginPath(); ctx.moveTo(px + 0.5, tickTop); ctx.lineTo(px + 0.5, tickBottom); ctx.stroke();
        }
      }
      if (state.selFrame && state.selFrame.lane === lane) {
        var sx = xOf(state.selFrame.t, w);
        if (sx >= M.left && sx <= w - M.right) {
          ctx.strokeStyle = css('--focus');
          ctx.lineWidth = 2;
          ctx.strokeRect(Math.round(sx) - 4.5, tickTop - 2.5, 9, tickBottom - tickTop + 5);
        }
      }
    });
    if (state.showLatency) { drawLatency(ctx, w, M.top + state.lanes.length * LANE_H + 14); }
    drawCursor(ctx, w, g.h);
    state.bus.w = w;
  }

  /* t_bus − t_s of every frame with a bus time, as dots, in ms. */
  function drawLatency(ctx, w, top) {
    var pts = [];
    var lo = Infinity;
    var hi = -Infinity;
    var s = state.frames.sorted;
    var i0 = Math.max(0, FR.indexAtTime(s, state.view[0]));
    var i1 = FR.indexAtTime(s, state.view[1]);
    for (var i = i0; i <= i1; i++) {
      var ms = FR.latencyMs(s[i]);
      if (ms === null) { continue; }
      pts.push([s[i], ms]);
      if (ms < lo) { lo = ms; }
      if (ms > hi) { hi = ms; }
    }
    ctx.fillStyle = css('--muted');
    ctx.textAlign = 'left';
    ctx.fillText('t_bus − t_s (ms)' + (pts.length ? '' : ': no bus times in view'), M.left + 2, top - 3);
    if (!pts.length) { return; }
    if (hi === lo) { lo -= 1; hi += 1; }
    var bottom = top + LAT_H;
    var yOfMs = function (v) { return bottom - ((v - lo) / (hi - lo)) * LAT_H; };
    ctx.textAlign = 'right';
    ctx.fillText(+hi.toPrecision(4) + '', M.left - 6, top + 8);
    ctx.fillText(+lo.toPrecision(4) + '', M.left - 6, bottom);
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = css('--hairline');
      ctx.beginPath(); ctx.moveTo(M.left, yOfMs(0) + 0.5); ctx.lineTo(w - M.right, yOfMs(0) + 0.5); ctx.stroke();
    }
    var seen = {};
    pts.forEach(function (p) {
      var x = Math.round(xOf(p[0].t, w));
      var y = Math.round(yOfMs(p[1]));
      var k = x + ':' + y;
      if (seen[k]) { return; }
      seen[k] = true;
      ctx.fillStyle = p[0].dir === 'to_dut' ? TO_DUT_COLOR : FROM_DUT_COLOR;
      ctx.fillRect(x - 1, y - 1, 2, 2);
    });
  }

  /* A click (not a drag) on a lane chooses the frame nearest to it, within 8 px. */
  function attachBusClick(c) {
    var down = null;
    c.addEventListener('pointerdown', function (ev) { down = { x: ev.clientX, y: ev.clientY }; });
    c.addEventListener('pointerup', function (ev) {
      if (!down || Math.abs(ev.clientX - down.x) > 3 || Math.abs(ev.clientY - down.y) > 3) { down = null; return; }
      down = null;
      var rect = c.getBoundingClientRect();
      var li = Math.floor((ev.clientY - rect.top - M.top) / LANE_H);
      if (li < 0 || li >= state.lanes.length) { return; }
      var lane = state.lanes[li];
      var t = tOf(ev.clientX - rect.left, rect.width);
      var k = FR.indexAtTime(lane.frames, t);
      var best = null;
      [k, k + 1].forEach(function (j) {
        var f = lane.frames[j];
        if (f && (!best || Math.abs(f.t - t) < Math.abs(best.t - t))) { best = f; }
      });
      if (best && Math.abs(xOf(best.t, rect.width) - (ev.clientX - rect.left)) <= 8) { selectFrame(best); }
    });
  }

  /* The latency checkbox reflects state.showLatency only when built: rebuild the panel's controls. */
  function buildBusAgain() {
    var old = state.bus.canvas.parentNode;
    var sel = state.selFrame;
    old.parentNode.replaceChild(buildBus(), old);
    state.selFrame = sel;
    renderDetail();
    draw();
  }

  function selectFrame(f) {
    state.selFrame = f;
    renderDetail();
    draw();
  }

  function selectFrameByLine(line) {
    if (!state.frames) { return; }
    var f = state.frames.frames.filter(function (x) { return x.line === line; })[0];
    if (!f) { message('No frame on line ' + line + ' of ' + state.framesName, true); return; }
    var span = Math.max((state.full[1] - state.full[0]) / 50, 0.1);
    clampView(f.t - span / 2, f.t + span / 2);
    selectFrame(f);
  }

  function fmtValue(v) {
    if (v === null || v === undefined) { return '–'; }
    return Number.isInteger(v) ? String(v) : (+v.toPrecision(10)).toString();
  }

  function row(table, cells, cls) {
    var tr = table.insertRow();
    if (cls) { tr.className = cls; }
    cells.forEach(function (t) { tr.insertCell().textContent = t; });
    return tr;
  }

  function section(host, title) {
    var h = document.createElement('h4');
    h.textContent = title;
    host.appendChild(h);
    var table = document.createElement('table');
    host.appendChild(table);
    return table;
  }

  function dm1Rows(table, d) {
    row(table, ['lamps', 'red stop ' + d.redStop + ', amber warning ' + d.amberWarning + ', MIL ' + d.mil + ', protect ' + d.protect]);
    if (d.dtcs.length === 0) { row(table, ['trouble codes', 'none active']); }
    d.dtcs.forEach(function (c, i) {
      row(table, ['code ' + (i + 1), 'SPN ' + c.spn + ', FMI ' + c.fmi + ' (' + c.fmiText + '), occurrences ' + c.oc]);
    });
  }

  function renderDetail() {
    var host = state.bus && state.bus.detail;
    if (!host) { return; }
    host.textContent = '';
    var f = state.selFrame;
    if (!f) {
      var p = document.createElement('p');
      p.className = 'help';
      p.textContent = 'Choose a frame in a lane to decode it here. Its place on the axis is t_s, the step it crossed the machine\'s side in; t_bus is when it was on the bus, measured.';
      host.appendChild(p);
      return;
    }
    var nav = document.createElement('div');
    nav.className = 'frame-nav';
    var i = f.lane.frames.indexOf(f);
    [['← previous in this lane', i - 1], ['next in this lane →', i + 1]].forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b[0];
      btn.disabled = !f.lane.frames[b[1]];
      btn.addEventListener('click', function () {
        var g = f.lane.frames[b[1]];
        if (!g) { return; }
        if (g.t < state.view[0] || g.t > state.view[1]) { var span = state.view[1] - state.view[0]; clampView(g.t - span / 2, g.t + span / 2); }
        selectFrame(g);
      });
      nav.appendChild(btn);
    });
    host.appendChild(nav);

    var t = section(host, 'Frame (line ' + f.line + ' of ' + state.framesName + ')');
    var lat = FR.latencyMs(f);
    row(t, ['t_s', f.t.toFixed(9) + ' s (logical: the step)']);
    row(t, ['t_bus', f.tBus === null ? (f.lost && f.dir === 'to_dut' ? 'never on the bus' : 'not measured') : f.tBus.toFixed(9) + ' s (' + state.frames.meta.busClock + ')']);
    if (lat !== null) { row(t, ['t_bus − t_s', fmtValue(lat) + ' ms']); }
    row(t, ['direction', f.dir === 'to_dut' ? 'to the device under test' : 'from the device under test']);
    row(t, ['link', f.link || '(none)']);
    row(t, ['fault', f.fault || 'none'], f.fault ? 'bad' : '');
    row(t, ['identifier', (f.ext ? hex2(f.id, 8) + ' (29-bit)' : hex2(f.id, 3) + ' (11-bit)') + (f.fd ? ', CAN FD' + (f.brs ? ', BRS' : '') : '')]);
    row(t, ['data', f.len + ' bytes: ' + (f.hex.replace(/(..)/g, '$1 ').trim() || '(none)')]);
    var j1939 = state.dbc && state.dbc.j1939 && f.ext;
    if (j1939) {
      var p1 = J.parts(f.id);
      row(t, ['J1939', 'PGN ' + p1.pgn + ' (0x' + hex2(p1.pgn, 4) + '), priority ' + p1.priority + ', from 0x' + hex2(p1.source, 2) +
        ' to ' + (p1.dest === 0xFF ? 'all (0xFF)' : '0x' + hex2(p1.dest, 2))]);
    }

    var msg = f.message;
    if (!state.dbc) { return; }
    if (!msg) {
      var none = document.createElement('p');
      none.className = 'help';
      none.textContent = state.dbcName + ' has no message for this frame.';
      host.appendChild(none);
      return;
    }
    var st = section(host, msg.name + (msg.comment ? ': ' + msg.comment : ''));
    var head = st.createTHead().insertRow();
    ['signal', 'value', 'raw', 'meaning'].forEach(function (h) { var th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
    DB.decodeSignals(msg, f.data).forEach(function (s) {
      var meaning = s.choice || '';
      var special = false;
      if (s.raw !== null && !s.choice) {
        var allOnes = !s.signal.signed && s.signal.size >= 2 && s.raw === (1n << BigInt(s.signal.size)) - 1n;
        if (j1939 && allOnes) { meaning = 'not available (J1939: all ones)'; special = true; }
        else if (s.signal.min !== s.signal.max && (s.value < s.signal.min || s.value > s.signal.max)) {
          meaning = 'outside the DBC range [' + s.signal.min + ' .. ' + s.signal.max + ']'; special = true;
        }
      }
      row(st, [s.name, s.value === null ? '–' : (special ? '(' : '') + fmtValue(s.value) + (s.unit ? ' ' + s.unit : '') + (special ? ')' : ''),
        s.raw === null ? 'outside the data' : '0x' + s.raw.toString(16).toUpperCase(), meaning]);
    });

    if (!j1939) { return; }
    var tsc = state.analysis.tsc1[f.index];
    if (tsc) {
      var it = section(host, 'TSC1 integrity (J1939-71 byte 8)');
      row(it, ['checksum (SPN 4207)', tsc.checksum + (tsc.checksumOk ? ', right' : ', wrong: J1939-71 gives ' + tsc.expected)], tsc.checksumOk ? '' : 'bad');
      row(it, ['counter (SPN 4206)', tsc.counter + (tsc.step === null ? ', the first from this sender' :
        tsc.step === 1 ? ', +1 since the last TSC1' : tsc.step === 0 ? ', repeated' : ', jumped by ' + tsc.step)], tsc.step === null || tsc.step === 1 ? '' : 'bad');
      row(it, ['intact', tsc.intact ? 'yes' : 'no: a receiver that checks would refuse it'], tsc.intact ? '' : 'bad');
    }
    var bam = state.analysis.bam[f.index];
    if (bam) {
      var bt = section(host, 'BAM (J1939-21 transport)');
      row(bt, ['carries', 'PGN ' + bam.pgn + ' (0x' + hex2(bam.pgn, 4) + '), ' + bam.size + ' bytes in ' + bam.packets + ' packets']);
      row(bt, ['state', bam.complete ? 'complete' : 'incomplete: ' + bam.why], bam.complete ? '' : 'bad');
      if (bam.dm1) { dm1Rows(section(host, 'DM1, reassembled'), bam.dm1); }
    } else if (J.parts(f.id).pgn === J.PGN_DM1 && f.len >= 6) {
      var d = J.decodeDm1(f.data);
      if (d) { dm1Rows(section(host, 'DM1'), d); }
    }
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
    drawSelectedOver(g.ctx, g.w, g.h);
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
    if (!state.a && !state.frames) { return; }
    state.bShift = state.b ? bTimes() : null;
    if (state.crit) { drawCriteria(); }
    state.plots.forEach(drawPlot);
    if (state.strips) { drawStrips(); }
    if (state.bus) { drawBus(); }
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
    ['a', 'b', 'l', 'v', 'f', 'd'].forEach(function (slot) {
      $('file-' + slot).addEventListener('change', function (ev) { loadFiles(slot, ev.target.files); ev.target.value = ''; });
      var zone = $('drop-' + slot);
      zone.addEventListener('dragover', function (ev) { ev.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
      zone.addEventListener('drop', function (ev) {
        ev.preventDefault(); ev.stopPropagation(); zone.classList.remove('over');
        loadFiles(slot, ev.dataTransfer.files);
      });
    });
    /* a file dropped anywhere else goes to A (then B), to the layout if it is JSON, to the verdicts if it ends in
     * verdicts.csv, to the frames if it ends in frames.csv, to the dictionary if it is a .dbc */
    document.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    document.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) {
        loadFiles(/\.json$/i.test(f.name) ? 'l' : /verdicts\.csv$/i.test(f.name) ? 'v' : /frames\.csv$/i.test(f.name) ? 'f' :
          /\.dbc$/i.test(f.name) ? 'd' : (state.a ? 'b' : 'a'), [f]);
      }
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
    $('ex-graded').addEventListener('click', example({ a: 'examples/flywheel.csv', v: 'examples/flywheel.verdicts.csv' }));
    $('ex-failing').addEventListener('click', example({ a: 'examples/flywheel.csv', v: 'examples/flywheel-strict.verdicts.csv' }));
    $('ex-bus').addEventListener('click', example({
      a: 'examples/hoist_step.csv', l: 'examples/hoist_step.layout.json', v: 'examples/hoist_step.verdicts.csv',
      f: 'examples/hoist_step.frames.csv', d: 'examples/open-crank.dbc'
    }));
    $('ex-corrupt').addEventListener('click', example({
      a: 'examples/speed_command_corrupt.csv', l: 'examples/hoist_step.layout.json', v: 'examples/speed_command_corrupt.verdicts.csv',
      f: 'examples/speed_command_corrupt.frames.csv', d: 'examples/open-crank.dbc'
    }));

    var q = new URLSearchParams(location.search);
    if (q.get('a') || q.get('b') || q.get('layout') || q.get('verdicts') || q.get('frames')) {
      loadUrls({ a: q.get('a'), b: q.get('b'), l: q.get('layout'), v: q.get('verdicts'), f: q.get('frames'), d: q.get('dbc') }).then(function () {
        if (q.get('criterion')) { selectById(q.get('criterion')); }
        if (q.get('frame')) { selectFrameByLine(Number(q.get('frame'))); }
        if (q.get('latency') === '1' && state.bus) { state.showLatency = true; buildBusAgain(); }
      });
    }
  }

  wire();
}());
