/**
 * ap-heatmap.js
 * Drop-in vanilla JS widget for Attention Proximity (AP) heatmaps.
 * No React, no npm, no build step.
 *
 * Usage:
 *   <link rel="stylesheet" href="/ap-heatmap.css">
 *   <script src="/ap-heatmap.js"></script>
 *   <div id="my-widget"></div>
 *   <script>APHeatmap.load('my-widget', '/data/romeo.json')</script>
 *
 * JSON format (output of scorer.py):
 *   { text, tokens, char_spans, ap, ape, scalar_ap, scalar_ape, matrix }
 */
(function (global) {
  'use strict';

  // ── Color schemes ─────────────────────────────────────────────────────────

  const STOPS = {
    'Blue-White-Red': [
      [0.0, [240, 100, 50]],
      [0.5, [  0,   0,100]],
      [1.0, [  0, 100, 50]],
    ],
    'Viridis': [
      [0.00, [275, 65, 20]],
      [0.25, [245, 75, 45]],
      [0.50, [175, 65, 42]],
      [0.75, [140, 55, 48]],
      [1.00, [ 62, 90, 55]],
    ],
    'Plasma': [
      [0.00, [268, 70, 28]],
      [0.33, [310, 75, 48]],
      [0.67, [ 22, 95, 53]],
      [1.00, [ 55, 95, 62]],
    ],
    'Hot': [
      [0.00, [  0,  0,  0]],
      [0.33, [  0,100, 30]],
      [0.67, [ 35,100, 50]],
      [1.00, [ 55,100, 80]],
    ],
    'Inferno': [
      [0.00, [  0,  0,  2]],
      [0.25, [280, 70, 30]],
      [0.50, [330, 85, 45]],
      [0.75, [ 15,100, 52]],
      [1.00, [ 53, 95, 72]],
    ],
    'Grayscale': [
      [0.0, [0, 0,  5]],
      [1.0, [0, 0, 95]],
    ],
  };

  const COLOR_SCHEME_NAMES = Object.keys(STOPS).sort();

  function lerp(a, b, t) { return a + (b - a) * t; }

  function piecewise(stops, v) {
    v = Math.max(0, Math.min(1, v));
    for (var i = 0; i < stops.length - 1; i++) {
      var t0 = stops[i][0],   c0 = stops[i][1];
      var t1 = stops[i+1][0], c1 = stops[i+1][1];
      if (v <= t1) {
        var t = (v - t0) / (t1 - t0);
        return [lerp(c0[0],c1[0],t), lerp(c0[1],c1[1],t), lerp(c0[2],c1[2],t)];
      }
    }
    return stops[stops.length - 1][1];
  }

  function heatToColor(value, scheme, alpha) {
    var hsl = piecewise(STOPS[scheme] || STOPS['Blue-White-Red'], value);
    return 'hsla(' + hsl[0].toFixed(1) + ',' + hsl[1].toFixed(1) + '%,' + hsl[2].toFixed(1) + '%,' + alpha + ')';
  }

  // ── Scrub handler factory (shared by panel scrubbers + SVG axis labels) ───
  // Returns a mousedown handler that drives drag-to-change behaviour.

  function makeScrubHandler(getStartVal, onChange, speed) {
    speed = speed || 0.02;
    return function(e) {
      e.preventDefault();
      var startX   = e.clientX;
      var startVal = getStartVal();
      function onMove(ev) {
        onChange(Math.round((startVal + (ev.clientX - startX) * speed) * 100) / 100);
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup',   onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',   onUp);
    };
  }

  // ── Histogram helpers ─────────────────────────────────────────────────────

  var N_BINS = 100;

  function computeHistogram(values, xMin, xMax) {
    var bins  = new Array(N_BINS).fill(0);
    var range = xMax - xMin;
    if (range <= 0) { bins[Math.floor(N_BINS / 2)] = values.length; return bins; }
    for (var i = 0; i < values.length; i++) {
      var idx = Math.min(N_BINS - 1, Math.max(0, Math.floor((values[i] - xMin) / range * N_BINS)));
      bins[idx]++;
    }
    return bins;
  }

  // ── Unique ID helper ──────────────────────────────────────────────────────

  var _idCounter = 0;
  function uid(prefix) { return prefix + '-' + (++_idCounter); }

  // ── Token display helpers ─────────────────────────────────────────────────

  var SPACE_PAD = 5;

  function getDisplayText(tok, text, charSpan) {
    return text.slice(charSpan[0], charSpan[1]).replace(/\n/g, '');
  }

  function hasNewlineInSpan(text, charSpan) {
    return text.slice(charSpan[0], charSpan[1]).includes('\n');
  }

  function computeWordGroups(displayTexts, newlines) {
    var g  = new Array(displayTexts.length).fill(0);
    var id = 0;
    for (var i = 0; i < displayTexts.length; i++) {
      if (i > 0 && (/^\s/.test(displayTexts[i]) || newlines[i - 1])) id++;
      g[i] = id;
    }
    return g;
  }

  // ── APDistribution SVG chart ───────────────────────────────────────────────

  var W_SVG        = 600;
  var H_SVG        = 178;
  var PAD_L        = 6;
  var PAD_R        = 6;
  var PAD_T        = 8;
  var GRAD_H       = 16;
  var GRAD_Y       = 106;
  var CHART_H      = GRAD_Y - PAD_T;
  var CHART_W      = W_SVG - PAD_L - PAD_R;
  var BIN_W        = CHART_W / N_BINS;
  var BAR_BOT      = GRAD_Y + GRAD_H;
  var TICK_SM_Y2   = BAR_BOT + 4;
  var TICK_LG_Y2   = BAR_BOT + 8;
  var TICK_LABEL_Y = TICK_LG_Y2 + 12;
  var RUG_Y0       = TICK_LABEL_Y + 5;
  var RUG_Y1       = RUG_Y0 + 8;
  var AP_LABEL_Y   = H_SVG - 3;
  var SVG_FONT     = 11;

  function makeSVGEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) {
      for (var k in attrs) el.setAttribute(k, attrs[k]);
    }
    return el;
  }

  /**
   * Build the distribution SVG.
   * @param {number[]}  heatValues  - array of per-token values (nulls excluded from histogram)
   * @param {number}    heatMin
   * @param {number}    heatMax
   * @param {string}    scheme
   * @param {number}    alpha
   * @param {string}    metric      - 'ap' or 'ape' (label only)
   * @param {string}    gradId      - unique id for linearGradient
   * @param {Function}  [onMinScrub] - if provided, min edge label becomes a scrubber
   * @param {Function}  [onMaxScrub] - if provided, max edge label becomes a scrubber
   */
  function buildDistributionSVG(heatValues, heatMin, heatMax, scheme, alpha, metric, gradId, onMinScrub, onMaxScrub) {
    var range  = Math.max(heatMax - heatMin, 1e-10);
    var xOf    = function(v) { return PAD_L + CHART_W * (v - heatMin) / range; };

    var validValues = heatValues.filter(function(v) { return v !== null && v !== undefined; });
    var bins   = computeHistogram(validValues, heatMin, heatMax);
    var maxCt  = Math.max.apply(null, bins.concat([1]));

    var svg = makeSVGEl('svg', {
      viewBox:             '0 0 ' + W_SVG + ' ' + H_SVG,
      preserveAspectRatio: 'none',
      style:               'width:100%;height:auto;display:block;',
    });

    // Gradient def
    var defs = makeSVGEl('defs');
    var grad = makeSVGEl('linearGradient', { id: gradId, x1: '0', x2: '1', y1: '0', y2: '0' });
    for (var si = 0; si < 24; si++) {
      var stop = makeSVGEl('stop', {
        offset:       (si / 23 * 100).toFixed(1) + '%',
        'stop-color': heatToColor(si / 23, scheme, alpha),
      });
      grad.appendChild(stop);
    }
    defs.appendChild(grad);
    svg.appendChild(defs);

    // Histogram bars
    var barEls = [];
    bins.forEach(function(count, i) {
      if (count === 0) return;
      var h   = CHART_H * (count / maxCt);
      var bar = makeSVGEl('rect', {
        x:         (PAD_L + i * BIN_W + 0.3).toFixed(1),
        y:         (GRAD_Y - h).toFixed(1),
        width:     (BIN_W - 0.6).toFixed(1),
        height:    h.toFixed(1),
        fill:      'rgba(255,255,255,0.18)',
        'data-bin': i,
      });
      svg.appendChild(bar);
      barEls.push({ el: bar, idx: i });
    });

    // Gradient bar
    svg.appendChild(makeSVGEl('rect', {
      x: PAD_L, y: GRAD_Y, width: CHART_W, height: GRAD_H,
      fill: 'url(#' + gradId + ')', rx: 2,
    }));

    // End ticks
    [PAD_L, PAD_L + CHART_W].forEach(function(tx) {
      svg.appendChild(makeSVGEl('line', {
        x1: tx, y1: BAR_BOT, x2: tx, y2: TICK_LG_Y2,
        stroke: 'rgba(255,255,255,0.55)', 'stroke-width': 1.2,
      }));
    });

    // Min edge label (scrubable if onMinScrub provided)
    var minG = makeSVGEl('g');
    if (onMinScrub) {
      minG.setAttribute('style', 'cursor:ew-resize;user-select:none;');
      minG.addEventListener('mousedown', makeScrubHandler(function() { return heatMin; }, onMinScrub));
    }
    var minText = makeSVGEl('text', {
      x: PAD_L, y: TICK_LABEL_Y,
      'text-anchor': 'start', 'font-size': SVG_FONT,
    });
    if (onMinScrub) {
      var mt1 = makeSVGEl('tspan', { fill: 'rgba(255,255,255,0.25)' }); mt1.textContent = '‹ ';
      var mt2 = makeSVGEl('tspan', { fill: 'rgba(255,255,255,0.55)' }); mt2.textContent = heatMin.toFixed(2);
      var mt3 = makeSVGEl('tspan', { fill: 'rgba(255,255,255,0.25)' }); mt3.textContent = ' ›';
      minText.appendChild(mt1); minText.appendChild(mt2); minText.appendChild(mt3);
    } else {
      minText.textContent = heatMin.toFixed(2);
      minText.setAttribute('fill', 'rgba(255,255,255,0.55)');
    }
    minG.appendChild(minText);
    svg.appendChild(minG);

    // Max edge label (scrubable if onMaxScrub provided)
    var maxG = makeSVGEl('g');
    if (onMaxScrub) {
      maxG.setAttribute('style', 'cursor:ew-resize;user-select:none;');
      maxG.addEventListener('mousedown', makeScrubHandler(function() { return heatMax; }, onMaxScrub));
    }
    var maxText = makeSVGEl('text', {
      x: PAD_L + CHART_W, y: TICK_LABEL_Y,
      'text-anchor': 'end', 'font-size': SVG_FONT,
    });
    if (onMaxScrub) {
      var xt1 = makeSVGEl('tspan', { fill: 'rgba(255,255,255,0.25)' }); xt1.textContent = '‹ ';
      var xt2 = makeSVGEl('tspan', { fill: 'rgba(255,255,255,0.55)' }); xt2.textContent = heatMax.toFixed(2);
      var xt3 = makeSVGEl('tspan', { fill: 'rgba(255,255,255,0.25)' }); xt3.textContent = ' ›';
      maxText.appendChild(xt1); maxText.appendChild(xt2); maxText.appendChild(xt3);
    } else {
      maxText.textContent = heatMax.toFixed(2);
      maxText.setAttribute('fill', 'rgba(255,255,255,0.55)');
    }
    maxG.appendChild(maxText);
    svg.appendChild(maxG);

    // Interior axis ticks
    var step  = 0.1;
    var first = Math.ceil(heatMin / step + 1e-9) * step;
    for (var v = first; v < heatMax - 1e-9; v += step) {
      var rv      = Math.round(v * 10) / 10;
      var isWhole = Math.abs(rv % 1) < 0.01;
      var nearEdge = Math.abs(rv - heatMin) < 0.2 || Math.abs(rv - heatMax) < 0.2;
      var x       = xOf(rv).toFixed(1);
      svg.appendChild(makeSVGEl('line', {
        x1: x, y1: BAR_BOT,
        x2: x, y2: isWhole ? TICK_LG_Y2 : TICK_SM_Y2,
        stroke: isWhole ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)',
        'stroke-width': isWhole ? 1.2 : 0.8,
      }));
      if (isWhole && !nearEdge) {
        var lbl = makeSVGEl('text', {
          x: x, y: TICK_LABEL_Y,
          'text-anchor': 'middle', 'font-size': SVG_FONT,
          fill: 'rgba(255,255,255,0.55)',
        });
        lbl.textContent = String(Math.round(rv));
        svg.appendChild(lbl);
      }
    }

    // Rug marks
    validValues.forEach(function(v) {
      var cx = xOf(Math.max(heatMin, Math.min(heatMax, v))).toFixed(1);
      svg.appendChild(makeSVGEl('line', {
        x1: cx, y1: RUG_Y0, x2: cx, y2: RUG_Y1,
        stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 0.8,
      }));
    });

    // Metric label
    var metLbl = makeSVGEl('text', {
      x: W_SVG / 2, y: AP_LABEL_Y,
      'text-anchor': 'middle', 'font-size': SVG_FONT,
      fill: 'rgba(255,255,255,0.4)',
    });
    metLbl.textContent = 'AP';
    svg.appendChild(metLbl);

    // Invisible hit areas
    var hitAreas = bins.map(function(_, i) {
      var hit = makeSVGEl('rect', {
        x:      (PAD_L + i * BIN_W).toFixed(1),
        y:      PAD_T,
        width:  BIN_W.toFixed(1),
        height: GRAD_Y - PAD_T,
        fill:   'transparent',
        style:  'cursor:default',
      });
      svg.appendChild(hit);
      return { el: hit, idx: i };
    });

    return { svg: svg, barEls: barEls, hitAreas: hitAreas };
  }

  // ── Main widget ───────────────────────────────────────────────────────────

  function createWidget(container, data) {
    // ── State ──────────────────────────────────────────────────────────────
    var scheme         = 'Viridis';
    var alpha          = 0.75;
    var selectedSet    = new Set();
    var chipAnchor     = null;
    var manualMin      = null;
    var manualMax      = null;
    var currentAutoMin = 0;
    var currentAutoMax = 1;
    var lastHeatValues = [];
    var lastHeatMin    = 0;
    var lastHeatMax    = 1;

    // Precomputed derived data
    var tokens      = data.tokens;
    var charSpans   = data.char_spans;
    var text        = data.text;
    var matrix      = data.matrix;

    var displayTexts = tokens.map(function(tok, i) { return getDisplayText(tok, text, charSpans[i]); });
    var newlines     = charSpans.map(function(s) { return hasNewlineInSpan(text, s); });
    var wordGroups   = computeWordGroups(displayTexts, newlines);

    var paddings = displayTexts.map(function(d) {
      return { left: /^\s/.test(d) ? SPACE_PAD : 0, right: /\s$/.test(d) ? SPACE_PAD : 0 };
    });

    // Heat values: when chips selected, selected positions become null (self excluded)
    function getHeatValues() {
      if (selectedSet.size === 0) return data.ap;
      var N   = tokens.length;
      var sum = new Array(N).fill(0);
      selectedSet.forEach(function(idx) {
        matrix[idx].forEach(function(v, col) { sum[col] += v; });
      });
      return sum.map(function(v, i) {
        return selectedSet.has(i) ? null : v / selectedSet.size;
      });
    }

    function getAutoMinMax(values) {
      var mn = Infinity, mx = -Infinity;
      values.forEach(function(v) {
        if (v !== null && v !== undefined) {
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      });
      return [mn === Infinity ? 0 : mn, mx === -Infinity ? 1 : mx];
    }

    // ── Scrubber factory ────────────────────────────────────────────────────
    // Returns a div with ‹ value › that you drag to change a value.
    // el._current: null = auto mode, number = manual override
    // el._update(): refreshes the displayed value

    function makeScrubber(getAutoVal, onCommit, speed) {
      speed = speed || 0.02;
      var el = document.createElement('div');
      el.className = 'aphm-scrubber';
      el._current  = null;

      var chevL = document.createElement('span');
      chevL.className = 'aphm-scrubber-chev';
      chevL.textContent = '‹';

      var valSpan = document.createElement('span');
      valSpan.className = 'aphm-scrubber-val';

      var chevR = document.createElement('span');
      chevR.className = 'aphm-scrubber-chev';
      chevR.textContent = '›';

      el.appendChild(chevL);
      el.appendChild(valSpan);
      el.appendChild(chevR);

      function updateDisplay() {
        var v = el._current !== null ? el._current : getAutoVal();
        valSpan.textContent = v.toFixed(2);
        el.classList.toggle('aphm-scrubber--auto', el._current === null);
      }
      el._update = updateDisplay;

      el.addEventListener('mousedown', makeScrubHandler(
        function() { return el._current !== null ? el._current : getAutoVal(); },
        function(val) {
          el._current = val;
          updateDisplay();
          onCommit(val);
        },
        speed
      ));

      return el;
    }

    // ── DOM structure ───────────────────────────────────────────────────────
    container.classList.add('ap-heatmap-widget');
    container.innerHTML = '';

    // Controls bar (pills only — colormap lives in dist panel)
    var controls = document.createElement('div');
    controls.className = 'aphm-controls';

    var pillsDiv = document.createElement('div');
    pillsDiv.className = 'aphm-pills';
    [
      { label: 'AP',     val: data.scalar_ap.toFixed(2) },
      { label: 'APE',    val: data.scalar_ape.toFixed(2) },
      { label: 'tokens', val: String(tokens.length) },
    ].forEach(function(p) {
      var pill = document.createElement('span');
      pill.className = 'aphm-pill';
      pill.innerHTML = '<span class="aphm-pill-label">' + p.label + '</span>' +
                       '<span class="aphm-pill-val">'   + p.val   + '</span>';
      pillsDiv.appendChild(pill);
    });
    controls.appendChild(pillsDiv);
    container.appendChild(controls);

    // Status bar
    var statusBar = document.createElement('div');
    statusBar.className = 'aphm-status-bar';
    container.appendChild(statusBar);

    // Distribution area: left controls panel + right SVG
    var distArea = document.createElement('div');
    distArea.className = 'aphm-dist-area';

    // Left panel
    var distLeft = document.createElement('div');
    distLeft.className = 'aphm-dist-left';

    function makeDistLabel(txt) {
      var lbl = document.createElement('span');
      lbl.className = 'aphm-dist-label';
      lbl.textContent = txt;
      return lbl;
    }

    function makeDistRow(label, control) {
      var row = document.createElement('div');
      row.className = 'aphm-dist-row';
      row.appendChild(makeDistLabel(label));
      row.appendChild(control);
      return row;
    }

    var maxScrubber = makeScrubber(
      function() { return currentAutoMax; },
      function(val) { manualMax = val; render(); }
    );
    var minScrubber = makeScrubber(
      function() { return currentAutoMin; },
      function(val) { manualMin = val; render(); }
    );

    // Colormap select (moved from top controls into dist left panel)
    var schemeSelect = document.createElement('select');
    schemeSelect.className = 'aphm-select';
    COLOR_SCHEME_NAMES.forEach(function(name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === scheme) opt.selected = true;
      schemeSelect.appendChild(opt);
    });

    // Auto checkbox row
    var autoRow = document.createElement('div');
    autoRow.className = 'aphm-auto-row';
    var autoCheck = document.createElement('input');
    autoCheck.type    = 'checkbox';
    autoCheck.checked = true;
    autoCheck.style.cursor = 'pointer';
    var autoLbl = document.createElement('label');
    autoLbl.className = 'aphm-dist-label';
    autoLbl.style.cursor = 'pointer';
    autoLbl.textContent = 'Automatic range';
    autoLbl.prepend(autoCheck);
    autoRow.appendChild(autoLbl);

    distLeft.appendChild(makeDistRow('AP Max', maxScrubber));
    distLeft.appendChild(makeDistRow('AP Min', minScrubber));
    distLeft.appendChild(makeDistRow('Colormap', schemeSelect));
    distLeft.appendChild(autoRow);

    // Right panel (SVG)
    var distRight = document.createElement('div');
    distRight.className = 'aphm-dist-right';

    distArea.appendChild(distLeft);
    distArea.appendChild(distRight);
    container.appendChild(distArea);

    // Reset colormap button
    var resetColormap = document.createElement('button');
    resetColormap.className = 'aphm-wide-btn';
    resetColormap.textContent = 'Reset colormap range';
    container.appendChild(resetColormap);

    // Reset heatmap (top)
    var resetTop = document.createElement('button');
    resetTop.className = 'aphm-wide-btn';
    resetTop.textContent = 'Reset heatmap';
    container.appendChild(resetTop);

    // Heat text area
    var heatBox = document.createElement('div');
    heatBox.className = 'aphm-heatbox';
    heatBox.style.fontSize = '28px';
    container.appendChild(heatBox);

    // Reset heatmap (bottom)
    var resetBot = document.createElement('button');
    resetBot.className = 'aphm-wide-btn';
    resetBot.textContent = 'Reset heatmap';
    container.appendChild(resetBot);

    // ── Chip rendering ──────────────────────────────────────────────────────
    var chipEls = [];

    function buildChips() {
      heatBox.innerHTML = '';
      chipEls.length = 0;

      var measureDiv = document.createElement('div');
      measureDiv.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit;font-size:28px;';
      document.body.appendChild(measureDiv);

      var widths = displayTexts.map(function(d, i) {
        var span = document.createElement('span');
        span.style.paddingLeft  = paddings[i].left  + 'px';
        span.style.paddingRight = paddings[i].right + 'px';
        span.textContent = d;
        measureDiv.appendChild(span);
        return span.getBoundingClientRect().width;
      });
      document.body.removeChild(measureDiv);

      var containerW = heatBox.getBoundingClientRect().width || heatBox.offsetWidth || 800;

      var lines = [];
      var curLine = [], curW = 0;
      for (var i = 0; i < tokens.length; i++) {
        var w = widths[i];
        if (curLine.length > 0 && curW + w > containerW) {
          lines.push(curLine); curLine = [i]; curW = w;
        } else {
          curLine.push(i); curW += w;
        }
        if (newlines[i]) { lines.push(curLine); curLine = []; curW = 0; }
      }
      if (curLine.length > 0) lines.push(curLine);

      lines.forEach(function(lineIdxs) {
        var lineDiv = document.createElement('div');
        lineDiv.className = 'aphm-line';
        lineIdxs.forEach(function(i) {
          if (displayTexts[i].length === 0) return;

          var chip = document.createElement('span');
          chip.className   = 'aphm-chip';
          chip.dataset.idx = i;
          chip.style.paddingLeft  = paddings[i].left  + 'px';
          chip.style.paddingRight = paddings[i].right + 'px';
          chip.title       = tokens[i];
          chip.textContent = displayTexts[i];

          chip.addEventListener('mousedown', function(e) { e.preventDefault(); });

          chip.addEventListener('mouseenter', function() {
            var v = lastHeatValues[parseInt(chip.dataset.idx)];
            if (v === null || v === undefined) return;
            var bin = getBinForValue(v, lastHeatMin, lastHeatMax);
            currentBarEls.forEach(function(b) {
              b.el.setAttribute('fill', b.idx === bin ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.18)');
            });
          });
          chip.addEventListener('mouseleave', function() {
            refreshBarHighlights();
          });

          chip.addEventListener('click', function(e) {
            var idx     = parseInt(chip.dataset.idx);
            var isShift = e.shiftKey;
            var isCtrl  = e.ctrlKey || e.metaKey;

            if (isShift && chipAnchor !== null) {
              var lo = Math.min(chipAnchor, idx), hi = Math.max(chipAnchor, idx);
              var range = Array.from({ length: hi - lo + 1 }, function(_, k) { return lo + k; });
              if (isCtrl) { range.forEach(function(x) { selectedSet.add(x); }); }
              else        { selectedSet = new Set(range); }
            } else if (isCtrl) {
              if (selectedSet.has(idx)) selectedSet.delete(idx);
              else selectedSet.add(idx);
              chipAnchor = idx;
            } else {
              if (selectedSet.size === 1 && selectedSet.has(idx)) {
                selectedSet.clear(); chipAnchor = null;
              } else {
                selectedSet = new Set([idx]); chipAnchor = idx;
              }
            }
            render();
          });

          chip.addEventListener('dblclick', function(e) {
            var idx  = parseInt(chip.dataset.idx);
            var wg   = wordGroups[idx];
            var word = tokens.map(function(_, j) { return j; })
                             .filter(function(j) { return wordGroups[j] === wg; });
            if (e.ctrlKey || e.metaKey) { word.forEach(function(j) { selectedSet.add(j); }); }
            else { selectedSet = new Set(word); }
            chipAnchor = idx;
            render();
          });

          lineDiv.appendChild(chip);
          chipEls.push({ el: chip, idx: i });
        });
        heatBox.appendChild(lineDiv);
      });
    }

    // ── Histogram highlight helpers ─────────────────────────────────────────

    function getBinForValue(v, min, max) {
      var range = Math.max(max - min, 1e-10);
      return Math.min(N_BINS - 1, Math.max(0, Math.floor((v - min) / range * N_BINS)));
    }

    // Highlight bars for currently selected chips; reset all to dim if nothing selected.
    function refreshBarHighlights() {
      if (selectedSet.size === 0) {
        currentBarEls.forEach(function(b) { b.el.setAttribute('fill', 'rgba(255,255,255,0.18)'); });
        return;
      }
      var selBins = new Set();
      selectedSet.forEach(function(idx) {
        var v = lastHeatValues[idx];
        if (v !== null && v !== undefined) {
          selBins.add(getBinForValue(v, lastHeatMin, lastHeatMax));
        }
      });
      currentBarEls.forEach(function(b) {
        b.el.setAttribute('fill', selBins.has(b.idx) ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.18)');
      });
    }

    // ── Distribution chart rendering ────────────────────────────────────────
    var currentBarEls   = [];
    var currentHitAreas = [];
    var gradId = uid('aphm-grad');

    function renderDist(heatValues, heatMin, heatMax) {
      distRight.innerHTML = '';
      var result = buildDistributionSVG(
        heatValues, heatMin, heatMax, scheme, alpha, 'ap', gradId,
        // Min label scrubber: sets manualMin
        function(val) { manualMin = val; minScrubber._current = val; minScrubber._update(); autoCheck.checked = false; render(); },
        // Max label scrubber: sets manualMax
        function(val) { manualMax = val; maxScrubber._current = val; maxScrubber._update(); autoCheck.checked = false; render(); }
      );
      currentBarEls   = result.barEls;
      currentHitAreas = result.hitAreas;

      result.hitAreas.forEach(function(h) {
        h.el.addEventListener('mouseenter', function() {
          currentBarEls.forEach(function(b) {
            b.el.setAttribute('fill',
              b.idx === h.idx ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.18)');
          });
          var rng   = Math.max(heatMax - heatMin, 1e-10);
          var binLo = heatMin + h.idx * (rng / N_BINS);
          var binHi = binLo + rng / N_BINS;
          chipEls.forEach(function(c) {
            var v = heatValues[c.idx];
            c.el.classList.toggle('aphm-chip--bin-highlight', v !== null && v >= binLo && v < binHi);
          });
        });
        h.el.addEventListener('mouseleave', function() {
          refreshBarHighlights();
          chipEls.forEach(function(c) { c.el.classList.remove('aphm-chip--bin-highlight'); });
        });
      });

      distRight.appendChild(result.svg);
    }

    // ── Full render ─────────────────────────────────────────────────────────

    function render() {
      var heatValues = getHeatValues();

      // Update auto bounds
      var auto = getAutoMinMax(heatValues);
      currentAutoMin = auto[0];
      currentAutoMax = auto[1];

      var heatMin  = manualMin !== null ? manualMin : auto[0];
      var heatMax  = manualMax !== null ? manualMax : auto[1];
      var rangeVal = Math.max(heatMax - heatMin, 1e-10);

      // Cache for chip↔histogram cross-highlight
      lastHeatValues = heatValues;
      lastHeatMin    = heatMin;
      lastHeatMax    = heatMax;

      // Chip colors + selection state
      chipEls.forEach(function(c) {
        var v         = heatValues[c.idx];
        var isNull    = v === null;
        var isSelected = selectedSet.has(c.idx);
        var norm      = isNull ? 0 : Math.max(0, Math.min(1, (v - heatMin) / rangeVal));
        c.el.style.backgroundColor = (isSelected || isNull) ? 'transparent' : heatToColor(norm, scheme, alpha);
        c.el.classList.toggle('aphm-chip--selected', isSelected);
        c.el.style.opacity = isNull ? '0.25' : '';
      });

      // Status bar
      var msg;
      if (selectedSet.size === 0) {
        msg = 'Showing attention proximity heatmap';
      } else if (selectedSet.size === 1) {
        var idx = Array.from(selectedSet)[0];
        msg = 'Showing “' + tokens[idx] + '” relative heatmap';
      } else {
        msg = 'Showing relative heatmap for ' + selectedSet.size + ' selected tokens';
      }
      statusBar.textContent = msg;

      // Reset buttons
      var hasSelection = selectedSet.size > 0;
      resetTop.disabled = !hasSelection;
      resetBot.disabled = !hasSelection;

      // Colormap reset button
      var isAuto = manualMin === null && manualMax === null;
      resetColormap.disabled = isAuto;

      // Scrubbers
      minScrubber._update();
      maxScrubber._update();
      autoCheck.checked = isAuto;

      // Distribution chart
      renderDist(heatValues, heatMin, heatMax);

      // Re-highlight bars for any selected chips (renderDist rebuilds barEls so must run after)
      refreshBarHighlights();
    }

    // ── Wire up controls ────────────────────────────────────────────────────

    schemeSelect.addEventListener('change', function() {
      scheme = schemeSelect.value;
      render();
    });

    function resetSelection() { selectedSet.clear(); chipAnchor = null; render(); }
    resetTop.addEventListener('click', resetSelection);
    resetBot.addEventListener('click', resetSelection);

    resetColormap.addEventListener('click', function() {
      manualMin = null; manualMax = null;
      minScrubber._current = null; maxScrubber._current = null;
      minScrubber._update(); maxScrubber._update();
      render();
    });

    autoCheck.addEventListener('change', function() {
      if (autoCheck.checked) {
        manualMin = null; manualMax = null;
        minScrubber._current = null; maxScrubber._current = null;
      } else {
        manualMin = currentAutoMin; manualMax = currentAutoMax;
        minScrubber._current = currentAutoMin; maxScrubber._current = currentAutoMax;
      }
      minScrubber._update(); maxScrubber._update();
      render();
    });

    // ── Initial build ────────────────────────────────────────────────────────
    requestAnimationFrame(function() {
      buildChips();
      render();

      if (typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(function() { buildChips(); render(); });
        ro.observe(heatBox);
      }
    });
  }

  // ── Gallery navigator ─────────────────────────────────────────────────────

  function createGallery(container, examples) {
    var N = examples.length;
    if (N === 0) return;

    var currentIndex = -1;
    var cache = new Map();

    var nav = document.createElement('div');
    nav.className = 'aphm-gallery-nav';

    var prevBtn = document.createElement('button');
    prevBtn.className = 'aphm-gallery-btn aphm-gallery-prev';
    prevBtn.textContent = '← Previous Example';

    var select = document.createElement('select');
    select.className = 'aphm-gallery-select';
    examples.forEach(function(ex, i) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = (i + 1) + ' — ' + ex.title;
      select.appendChild(opt);
    });

    var nextBtn = document.createElement('button');
    nextBtn.className = 'aphm-gallery-btn aphm-gallery-next';
    nextBtn.textContent = 'Next Example →';

    nav.appendChild(prevBtn);
    nav.appendChild(select);
    nav.appendChild(nextBtn);
    container.appendChild(nav);

    var contentDiv = document.createElement('div');
    contentDiv.className = 'aphm-gallery-content';
    container.appendChild(contentDiv);

    function navigateTo(index) {
      index = ((index % N) + N) % N;
      if (index === currentIndex) return;
      currentIndex = index;
      select.value = index;

      var url = examples[index].url;

      if (cache.has(url)) {
        contentDiv.innerHTML = '';
        createWidget(contentDiv, cache.get(url));
        return;
      }

      contentDiv.innerHTML = '<div class="aphm-loading">Loading…</div>';

      fetch(url)
        .then(function(r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function(data) {
          cache.set(url, data);
          if (currentIndex === index) {
            contentDiv.innerHTML = '';
            createWidget(contentDiv, data);
          }
        })
        .catch(function(err) {
          if (currentIndex === index) {
            contentDiv.innerHTML =
              '<div class="aphm-error">Failed to load ' + url + ': ' + err.message + '</div>';
          }
        });
    }

    prevBtn.addEventListener('click', function() { navigateTo(currentIndex - 1); });
    nextBtn.addEventListener('click', function() { navigateTo(currentIndex + 1); });
    select.addEventListener('change', function() { navigateTo(parseInt(select.value, 10)); });

    navigateTo(0);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  global.APHeatmap = {
    load: function(containerId, jsonUrl) {
      var container = document.getElementById(containerId);
      if (!container) { console.error('APHeatmap.load: no element "' + containerId + '"'); return; }
      container.classList.add('ap-heatmap-widget');
      container.innerHTML = '<div class="aphm-loading">Loading…</div>';
      fetch(jsonUrl)
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) { createWidget(container, data); })
        .catch(function(err) {
          container.innerHTML = '<div class="aphm-error">Failed to load ' + jsonUrl + ': ' + err.message + '</div>';
        });
    },

    render: function(containerId, data) {
      var container = document.getElementById(containerId);
      if (!container) { console.error('APHeatmap.render: no element "' + containerId + '"'); return; }
      createWidget(container, data);
    },

    loadGallery: function(containerId, examples) {
      var container = document.getElementById(containerId);
      if (!container) { console.error('APHeatmap.loadGallery: no element "' + containerId + '"'); return; }
      container.classList.add('ap-heatmap-widget');
      container.innerHTML = '';
      createGallery(container, examples);
    },
  };

})(typeof window !== 'undefined' ? window : this);
