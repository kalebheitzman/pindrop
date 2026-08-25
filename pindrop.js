/**
 * PageNotes — drop-in design annotation tool
 * Pins · Freehand drawing · Text highlights · Threaded comments
 * Backed by Supabase (free tier works great).
 *
 * Usage — add one script tag to any page:
 *
 *   <script src="pagenotes.js"
 *           data-supabase-url="https://xxxx.supabase.co"
 *           data-supabase-key="eyJ..."
 *           defer></script>
 *
 * Optional attributes:
 *   data-page-key   Override the page identifier (default: pathname)
 *   data-position   Toggle button corner: "bottom-right" (default) | "bottom-left"
 */
(function () {
  'use strict';

  // ─── CONFIG — read from the <script> tag ─────────────────────────────────
  var _self = document.currentScript ||
              document.querySelector('script[data-supabase-url]');

  var SUPABASE_URL      = _self && _self.getAttribute('data-supabase-url');
  var SUPABASE_ANON_KEY = _self && _self.getAttribute('data-supabase-key');
  var PAGE_KEY          = (_self && _self.getAttribute('data-page-key')) ||
                          window.location.pathname;
  var POSITION          = (_self && _self.getAttribute('data-position')) || 'bottom-right';

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[PageNotes] Missing data-supabase-url or data-supabase-key on <script> tag — not loading.');
    return;
  }

  // Anonymous ownership token — generated once per browser, persisted in localStorage
  var MY_TOKEN = (function () {
    var k = 'pd_author_token';
    var t = localStorage.getItem(k);
    if (!t) {
      t = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      localStorage.setItem(k, t);
    }
    return t;
  }());

  // ─── STATE ───────────────────────────────────────────────────────────────
  var db            = null;
  var mode          = null;   // null | 'pin' | 'draw'
  var activeColor   = '#ef4444';
  var activeWidth   = 3;
  var isDrawing     = false;
  var currentPoints = [];
  var pending       = null;   // { data, tempPin? } — waiting for comment submission
  var annotations   = [];
  var activeAnnId   = null;   // currently focused annotation id (focus/dim mode)
  var replies       = {};     // annotation_id → [{id, author_name, comment, created_at}]
  var pinSeqMap     = {};     // ann.id → display number
  var pinSeqNext    = 0;
  var tempPinSeq    = 0;      // for pins not yet saved

  // DOM refs
  var canvas, ctx, svgLayer;

  // ─── BOOT ────────────────────────────────────────────────────────────────
  function boot() {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = function () {
      db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      injectStyles();
      buildToolbar();
      buildPopover();
      buildCanvas();
      buildSVGLayer();
      buildSidebar();
      buildNamePrompt();
      loadAnnotations();
      window.addEventListener('resize', function () {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
        syncSVGSize();
        repositionPins();
      });
    };
    document.head.appendChild(s);
  }

  // ─── STYLES ──────────────────────────────────────────────────────────────
  function injectStyles() {
    var css = '\
#pd-root * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; line-height: 1.4; }\
\
/* ── Toggle ── */\
#pd-toggle {\
  position: fixed; bottom: 24px; z-index: 10002;\
  width: 48px; height: 48px; border-radius: 50%;\
  background: #1e1b4b; color: white; border: none; cursor: pointer;\
  font-size: 20px; display: flex; align-items: center; justify-content: center;\
  box-shadow: 0 4px 16px rgba(0,0,0,.35); transition: background .2s, transform .15s;\
}\
#pd-toggle:hover  { background: #312e81; transform: scale(1.08); }\
#pd-toggle.pd-on { background: #4f46e5; }\
\
/* ── Toolbar panel ── */\
#pd-panel {\
  position: fixed; bottom: 84px; z-index: 10002;\
  background: white; border-radius: 14px; padding: 14px; width: 204px;\
  box-shadow: 0 8px 32px rgba(0,0,0,.18);\
  display: none; flex-direction: column; gap: 10px;\
}\
#pd-panel.pd-open { display: flex; }\
.pd-label {\
  font-size: 10px; font-weight: 700; text-transform: uppercase;\
  letter-spacing: .06em; color: #94a3b8; margin: 0;\
}\
.pd-tools { display: flex; gap: 6px; }\
.pd-tool {\
  flex: 1; padding: 8px 4px; border: 2px solid #e2e8f0; border-radius: 9px;\
  background: white; font-size: 12px; font-weight: 700; color: #475569;\
  cursor: pointer; text-align: center; transition: all .15s;\
}\
.pd-tool:hover              { border-color: #4f46e5; color: #4f46e5; }\
.pd-tool.pd-active        { background: #4f46e5; border-color: #4f46e5; color: white; }\
.pd-colors { display: flex; gap: 6px; flex-wrap: wrap; }\
.pd-swatch {\
  width: 26px; height: 26px; border-radius: 50%; cursor: pointer;\
  border: 3px solid transparent; transition: transform .15s;\
}\
.pd-swatch:hover         { transform: scale(1.2); }\
.pd-swatch.pd-active   { border-color: #1e1b4b; transform: scale(1.12); }\
.pd-widths { display: flex; gap: 6px; align-items: center; }\
.pd-w {\
  flex: 1; border: 2px solid #e2e8f0; border-radius: 9px; padding: 8px 4px;\
  cursor: pointer; background: white;\
  display: flex; align-items: center; justify-content: center;\
  transition: all .15s;\
}\
.pd-w:hover        { border-color: #4f46e5; }\
.pd-w.pd-active  { border-color: #4f46e5; background: #ede9fe; }\
.pd-w span { display: block; background: #1e1b4b; border-radius: 99px; width: 70%; }\
.pd-divider { height: 1px; background: #f1f5f9; }\
.pd-btn {\
  width: 100%; padding: 8px; border: none; border-radius: 9px;\
  background: #f1f5f9; font-size: 12px; font-weight: 700;\
  color: #475569; cursor: pointer; transition: background .15s;\
}\
.pd-btn:hover { background: #e2e8f0; }\
\
/* ── Canvas ── */\
#pd-canvas {\
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;\
  z-index: 9999; pointer-events: none;\
}\
#pd-canvas.pd-draw { pointer-events: all; cursor: crosshair; }\
\
/* ── SVG persisted drawings ── */\
#pd-svg {\
  position: absolute; top: 0; left: 0;\
  z-index: 9998; overflow: visible;\
}\
\
/* ── Pins ── */\
.pd-pin {\
  position: absolute; z-index: 10000;\
  pointer-events: all; cursor: pointer;\
  transform: translate(-50%, -100%);\
}\
.pd-pin-dot {\
  width: 30px; height: 30px;\
  border-radius: 50% 50% 50% 0; transform: rotate(-45deg);\
  display: flex; align-items: center; justify-content: center;\
  box-shadow: 0 3px 10px rgba(0,0,0,.3); border: 2.5px solid white;\
  transition: transform .15s, box-shadow .15s;\
}\
.pd-pin:hover .pd-pin-dot {\
  transform: rotate(-45deg) scale(1.12);\
  box-shadow: 0 4px 16px rgba(0,0,0,.4);\
}\
.pd-pin-num { transform: rotate(45deg); color: white; font-size: 11px; font-weight: 800; }\
\
/* ── Comment popover ── */\
#pd-pop {\
  position: fixed; z-index: 10003; background: white;\
  border-radius: 14px; box-shadow: 0 8px 36px rgba(0,0,0,.2);\
  padding: 18px; width: 290px; display: none;\
}\
#pd-pop.pd-open { display: block; }\
#pd-pop h4 { margin: 0 0 14px; font-size: 14px; font-weight: 800; color: #1e1b4b; }\
#pd-pop label {\
  display: block; font-size: 10px; font-weight: 700;\
  text-transform: uppercase; letter-spacing: .06em;\
  color: #94a3b8; margin-bottom: 4px;\
}\
#pd-pop input, #pd-pop textarea {\
  width: 100%; border: 1.5px solid #e2e8f0; border-radius: 9px;\
  padding: 9px 11px; font-size: 13px; color: #1e293b;\
  outline: none; transition: border .15s; margin-bottom: 12px;\
  font-family: system-ui, sans-serif;\
}\
#pd-pop input:focus, #pd-pop textarea:focus { border-color: #4f46e5; }\
#pd-pop textarea { min-height: 80px; resize: vertical; }\
.pd-pop-btns { display: flex; gap: 8px; }\
.pd-pop-btns button {\
  flex: 1; padding: 9px; border: none; border-radius: 9px;\
  font-size: 13px; font-weight: 700; cursor: pointer; transition: opacity .15s;\
}\
.pd-pop-btns button:hover { opacity: .85; }\
#pd-pop-submit { background: #4f46e5; color: white; }\
#pd-pop-cancel  { background: #f1f5f9; color: #475569; }\
\
/* ── Sidebar ── */\
#pd-sidebar {\
  position: fixed; top: 0; right: -360px; width: 340px; height: 100%;\
  background: white; z-index: 10001;\
  box-shadow: -4px 0 24px rgba(0,0,0,.12);\
  transition: right .28s ease; display: flex; flex-direction: column;\
}\
#pd-sidebar.pd-open { right: 0; }\
#pd-sb-head {\
  padding: 20px 16px 14px; border-bottom: 1px solid #f1f5f9;\
  display: flex; align-items: flex-start; justify-content: space-between; flex-shrink: 0;\
}\
#pd-sb-head h3  { margin: 0; font-size: 15px; font-weight: 800; color: #1e1b4b; }\
#pd-sb-head p   { margin: 3px 0 0; font-size: 11px; color: #94a3b8; }\
#pd-sb-close {\
  background: none; border: none; cursor: pointer;\
  color: #94a3b8; font-size: 18px; padding: 2px; line-height: 1;\
}\
#pd-sb-close:hover { color: #475569; }\
#pd-sb-list { flex: 1; overflow-y: auto; padding: 12px; }\
#pd-sb-empty { text-align: center; padding: 48px 20px; color: #94a3b8; font-size: 13px; }\
.pd-card {\
  background: #f8fafc; border-radius: 10px; padding: 12px 13px;\
  margin-bottom: 10px; cursor: pointer;\
  border: 1.5px solid transparent; transition: all .15s;\
}\
.pd-card:hover { border-color: #4f46e5; background: #f5f3ff; }\
.pd-card-flash { border-color: #4f46e5 !important; background: #ede9fe !important; }\
.pd-card-header { display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; }\
.pd-card-chevron { margin-left: auto; font-size: 11px; color: #94a3b8; transition: transform .2s; flex-shrink: 0; }\
.pd-card.pd-collapsed .pd-card-chevron { transform: rotate(-90deg); }\
.pd-card-body { margin-top: 8px; overflow: hidden; }\
.pd-card.pd-collapsed .pd-card-body { display: none; }\
.pd-card-row { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }\
.pd-badge {\
  font-size: 10px; font-weight: 800; padding: 2px 7px;\
  border-radius: 5px; text-transform: uppercase; letter-spacing: .05em;\
}\
.pd-badge-pin  { background: #ede9fe; color: #4f46e5; }\
.pd-badge-draw { background: #fee2e2; color: #dc2626; }\
.pd-badge-hl   { background: #fef9c3; color: #a16207; }\
.pd-hl-snip {\
  font-size: 12px; color: #78350f; font-style: italic;\
  background: #fef9c3; border-left: 3px solid #eab308;\
  padding: 4px 8px; border-radius: 4px; margin-bottom: 4px;\
}\
.pd-card-author { font-size: 12px; font-weight: 700; color: #334155; }\
.pd-card-time   { font-size: 11px; color: #94a3b8; margin-left: auto; }\
.pd-card-comment { font-size: 13px; color: #475569; }\
.pd-card-empty   { font-size: 12px; color: #94a3b8; font-style: italic; }\
\
/* ── Replies ── */\
.pd-replies { margin-top: 8px; padding-top: 8px; border-top: 1px solid #f1f5f9; }\
.pd-reply-item { padding: 5px 0; }\
.pd-reply-item + .pd-reply-item { border-top: 1px solid #f1f5f9; }\
.pd-reply-meta { display: flex; align-items: baseline; gap: 5px; margin-bottom: 2px; }\
.pd-reply-author { font-size: 11px; font-weight: 700; color: #334155; }\
.pd-reply-time   { font-size: 10px; color: #94a3b8; }\
.pd-reply-text   { font-size: 12px; color: #475569; }\
.pd-reply-toggle {\
  margin-top: 8px; background: none; border: 1.5px solid #e2e8f0;\
  border-radius: 7px; padding: 5px 10px; font-size: 11px; font-weight: 700;\
  color: #94a3b8; cursor: pointer; transition: all .15s; width: 100%; text-align: left;\
}\
.pd-reply-toggle:hover { border-color: #4f46e5; color: #4f46e5; }\
.pd-reply-form { display: none; margin-top: 8px; }\
.pd-reply-form.pd-open { display: block; }\
.pd-reply-form input, .pd-reply-form textarea {\
  width: 100%; border: 1.5px solid #e2e8f0; border-radius: 7px;\
  padding: 7px 9px; font-size: 12px; color: #1e293b; outline: none;\
  transition: border .15s; margin-bottom: 6px; font-family: system-ui, sans-serif;\
}\
.pd-reply-form input:focus, .pd-reply-form textarea:focus { border-color: #4f46e5; }\
.pd-reply-form textarea { min-height: 58px; resize: vertical; }\
.pd-reply-actions { display: flex; gap: 6px; }\
.pd-reply-actions button {\
  flex: 1; padding: 6px; border: none; border-radius: 7px;\
  font-size: 12px; font-weight: 700; cursor: pointer; transition: opacity .15s;\
}\
.pd-reply-actions button:hover { opacity: .85; }\
.pd-reply-submit { background: #4f46e5; color: white; }\
.pd-reply-cancel  { background: #f1f5f9; color: #475569; }\
\
/* ── Name prompt ── */\
#pd-name-prompt {\
  position: fixed; bottom: 84px; z-index: 10004;\
  background: white; border-radius: 14px; padding: 18px 20px; width: 260px;\
  box-shadow: 0 8px 32px rgba(0,0,0,.18);\
  animation: pd-slide-up .25s ease;\
}\
@keyframes pd-slide-up {\
  from { opacity: 0; transform: translateY(12px); }\
  to   { opacity: 1; transform: translateY(0); }\
}\
#pd-name-prompt h4 { margin: 0 0 4px; font-size: 14px; font-weight: 800; color: #1e1b4b; }\
#pd-name-prompt p  { margin: 0 0 12px; font-size: 12px; color: #94a3b8; }\
#pd-name-input {\
  width: 100%; border: 1.5px solid #e2e8f0; border-radius: 9px;\
  padding: 9px 11px; font-size: 13px; color: #1e293b; outline: none;\
  transition: border .15s; margin-bottom: 10px; font-family: system-ui, sans-serif;\
  box-sizing: border-box;\
}\
#pd-name-input:focus { border-color: #4f46e5; }\
#pd-name-go {\
  width: 100%; padding: 9px; border: none; border-radius: 9px;\
  background: #4f46e5; color: white; font-size: 13px; font-weight: 700;\
  cursor: pointer; transition: opacity .15s; margin-bottom: 8px;\
}\
#pd-name-go:hover { opacity: .88; }\
#pd-name-skip {\
  display: block; text-align: center; font-size: 11px; color: #94a3b8;\
  cursor: pointer; background: none; border: none; width: 100%;\
}\
#pd-name-skip:hover { color: #475569; }\
\
/* ── Card actions ── */\
.pd-card-actions { display: flex; gap: 6px; margin-top: 8px; }\
.pd-act-btn {\
  padding: 4px 10px; border: 1.5px solid #e2e8f0; border-radius: 6px;\
  font-size: 11px; font-weight: 700; cursor: pointer; background: white;\
  color: #64748b; transition: all .15s;\
}\
.pd-act-btn:hover { border-color: #4f46e5; color: #4f46e5; }\
.pd-act-resolve.pd-resolved { border-color: #22c55e; color: #16a34a; background: #f0fdf4; }\
.pd-act-delete { margin-left: auto; }\
.pd-act-delete:hover { border-color: #ef4444 !important; color: #ef4444 !important; }\
.pd-card.pd-card-resolved { opacity: 0.6; }\
.pd-card.pd-card-focused {\
  border-color: #4f46e5 !important;\
  box-shadow: 0 0 0 2px #4f46e5, 0 4px 16px rgba(79,70,229,.15);\
  background: #f5f3ff;\
}\
.pd-card.pd-card-resolved .pd-card-comment,\
.pd-card.pd-card-resolved .pd-card-empty { text-decoration: line-through; }\
\
/* ── Highlights ── */\
.pd-highlight {\
  position: absolute; z-index: 9997;\
  pointer-events: all; cursor: pointer;\
  border-radius: 2px; mix-blend-mode: multiply;\
  transition: opacity .2s;\
}\
\
/* ── Body cursor overrides ── */\
body.pd-pin-cursor, body.pd-pin-cursor * { cursor: crosshair !important; }\
body.pd-draw-cursor #pd-canvas { cursor: crosshair; }\
body.pd-hl-cursor, body.pd-hl-cursor * { cursor: text !important; }\
';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // Apply corner position
    var side = POSITION === 'bottom-left' ? 'left' : 'right';
    var opp  = POSITION === 'bottom-left' ? 'right' : 'left';
    var posStyle = document.createElement('style');
    posStyle.textContent =
      '#pd-toggle { ' + side + ': 24px; ' + opp + ': auto; }' +
      '#pd-panel, #pd-name-prompt { ' + side + ': 20px; ' + opp + ': auto; }';
    document.head.appendChild(posStyle);
  }

  // ─── TOOLBAR ─────────────────────────────────────────────────────────────
  var COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#4f46e5', '#1e1b4b'];

  function buildToolbar() {
    var root = mkEl('div', { id: 'pd-root' });

    // Toggle button
    var toggle = mkEl('button', { id: 'pd-toggle', title: 'Annotate this page' });
    toggle.textContent = '✏️';
    toggle.addEventListener('click', togglePanel);
    root.appendChild(toggle);

    // Panel
    var panel = mkEl('div', { id: 'pd-panel' });

    // Tool buttons
    var toolLabel = mkEl('p', { class: 'pd-label' }); toolLabel.textContent = 'Tool';
    var toolRow = mkEl('div', { class: 'pd-tools' });
    var pinBtn  = mkEl('button', { class: 'pd-tool', id: 'pd-pin-btn' });       pinBtn.textContent  = '📍 Pin';
    var drawBtn = mkEl('button', { class: 'pd-tool', id: 'pd-draw-btn' });      drawBtn.textContent = '✏️ Draw';
    var hlBtn   = mkEl('button', { class: 'pd-tool', id: 'pd-highlight-btn' }); hlBtn.textContent   = '🖍 Highlight';
    pinBtn.addEventListener('click',  function () { setMode('pin');       });
    drawBtn.addEventListener('click', function () { setMode('draw');      });
    hlBtn.addEventListener('click',   function () { setMode('highlight'); });
    toolRow.appendChild(pinBtn); toolRow.appendChild(drawBtn); toolRow.appendChild(hlBtn);

    // Color swatches
    var colorLabel = mkEl('p', { class: 'pd-label' }); colorLabel.textContent = 'Color';
    var colorRow   = mkEl('div', { class: 'pd-colors' });
    COLORS.forEach(function (c) {
      var sw = mkEl('div', { class: 'pd-swatch' + (c === activeColor ? ' pd-active' : ''), 'data-color': c });
      sw.style.background = c;
      sw.addEventListener('click', function () {
        colorRow.querySelectorAll('.pd-swatch').forEach(function (s) { s.classList.remove('pd-active'); });
        sw.classList.add('pd-active');
        activeColor = c;
      });
      colorRow.appendChild(sw);
    });

    // Line weight
    var wLabel = mkEl('p', { class: 'pd-label' }); wLabel.textContent = 'Weight';
    var wRow   = mkEl('div', { class: 'pd-widths' });
    [{ w: 3, h: '2px' }, { w: 6, h: '5px' }, { w: 12, h: '9px' }].forEach(function (item, i) {
      var btn = mkEl('button', { class: 'pd-w' + (i === 0 ? ' pd-active' : ''), 'data-w': item.w });
      var bar = mkEl('span'); bar.style.height = item.h;
      btn.appendChild(bar);
      btn.addEventListener('click', function () {
        wRow.querySelectorAll('.pd-w').forEach(function (b) { b.classList.remove('pd-active'); });
        btn.classList.add('pd-active');
        activeWidth = item.w;
      });
      wRow.appendChild(btn);
    });

    // View button
    var div1 = mkEl('div', { class: 'pd-divider' });
    var viewBtn = mkEl('button', { class: 'pd-btn', id: 'pd-view-btn' });
    viewBtn.textContent = '📋 View annotations (0)';
    viewBtn.addEventListener('click', toggleSidebar);

    [toolLabel, toolRow, mkEl('div', { class: 'pd-divider' }),
     colorLabel, colorRow,
     wLabel, wRow,
     div1, viewBtn].forEach(function (node) { panel.appendChild(node); });

    root.appendChild(panel);
    document.body.appendChild(root);
  }

  function togglePanel() {
    var panel  = document.getElementById('pd-panel');
    var toggle = document.getElementById('pd-toggle');
    if (panel.classList.contains('pd-open')) {
      panel.classList.remove('pd-open');
      toggle.classList.remove('pd-on');
      setMode(null);
    } else {
      panel.classList.add('pd-open');
      toggle.classList.add('pd-on');
    }
  }

  function setMode(m) {
    mode = m;
    document.body.classList.remove('pd-pin-cursor', 'pd-draw-cursor', 'pd-hl-cursor');
    document.querySelectorAll('.pd-tool').forEach(function (b) { b.classList.remove('pd-active'); });
    canvas.classList.remove('pd-draw');
    if (m === 'pin') {
      document.body.classList.add('pd-pin-cursor');
      document.getElementById('pd-pin-btn').classList.add('pd-active');
    } else if (m === 'draw') {
      document.body.classList.add('pd-draw-cursor');
      document.getElementById('pd-draw-btn').classList.add('pd-active');
      canvas.classList.add('pd-draw');
    } else if (m === 'highlight') {
      document.body.classList.add('pd-hl-cursor');
      document.getElementById('pd-highlight-btn').classList.add('pd-active');
    }
  }

  // ─── POPOVER ─────────────────────────────────────────────────────────────
  function buildPopover() {
    var pop = mkEl('div', { id: 'pd-pop' });
    pop.innerHTML = [
      '<h4 id="pd-pop-title">Add a comment</h4>',
      '<label>Your name</label>',
      '<input id="pd-pop-name" type="text" placeholder="e.g. Kaleb" />',
      '<label>Comment</label>',
      '<textarea id="pd-pop-comment" placeholder="What\'s on your mind?"></textarea>',
      '<div class="pd-pop-btns">',
        '<button id="pd-pop-cancel">Cancel</button>',
        '<button id="pd-pop-submit">Submit</button>',
      '</div>',
    ].join('');
    document.body.appendChild(pop);

    var saved = localStorage.getItem('pd_name');
    if (saved) document.getElementById('pd-pop-name').value = saved;

    document.getElementById('pd-pop-submit').addEventListener('click', submitAnnotation);
    document.getElementById('pd-pop-cancel').addEventListener('click', cancelAnnotation);
  }

  function showPopover(cx, cy, title) {
    var pop = document.getElementById('pd-pop');
    document.getElementById('pd-pop-title').textContent = title;
    var left = cx + 14;
    var top  = cy - 20;
    if (left + 306 > window.innerWidth)  left = cx - 306 - 14;
    if (top  + 260 > window.innerHeight) top  = window.innerHeight - 270;
    if (top < 10) top = 10;
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
    pop.classList.add('pd-open');
    setTimeout(function () { document.getElementById('pd-pop-comment').focus(); }, 50);
  }

  function hidePopover() {
    document.getElementById('pd-pop').classList.remove('pd-open');
    document.getElementById('pd-pop-comment').value = '';
    pending = null;
  }

  function submitAnnotation() {
    if (!pending) return;
    var name    = document.getElementById('pd-pop-name').value.trim() || 'Anonymous';
    var comment = document.getElementById('pd-pop-comment').value.trim();
    localStorage.setItem('pd_name', name);

    var record = Object.assign({}, pending.data, {
      page_url:     PAGE_KEY,
      author_name:  name,
      comment:      comment || null,
      author_token: MY_TOKEN,
    });

    db.from('tcm_annotations').insert(record).select().single().then(function (result) {
      if (result.error) {
        console.error('[Pindrop] Save failed:', result.error);
        alert('Could not save — check the browser console.');
        return;
      }
      if (pending && pending.tempPin) pending.tempPin.remove();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      annotations.push(result.data);
      renderAnnotation(result.data);
      updateCount();
      renderSidebarList();
      hidePopover();
    });
  }

  function cancelAnnotation() {
    if (pending && pending.tempPin) {
      pending.tempPin.remove();
      tempPinSeq = Math.max(0, tempPinSeq - 1);
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    currentPoints = [];
    isDrawing = false;
    hidePopover();
  }

  // ─── CANVAS (active drawing) ──────────────────────────────────────────────
  function buildCanvas() {
    canvas        = mkEl('canvas', { id: 'pd-canvas' });
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    ctx = canvas.getContext('2d');
    document.body.appendChild(canvas);

    canvas.addEventListener('mousedown',  onDrawStart);
    canvas.addEventListener('mousemove',  onDrawMove);
    canvas.addEventListener('mouseup',    onDrawEnd);
    canvas.addEventListener('mouseleave', function (e) { if (isDrawing) onDrawEnd(e); });

    // Pin clicks bubble up to document
    document.addEventListener('click', function (e) {
      if (mode !== 'pin') return;
      if (isOurs(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      dropPin(e.clientX, e.clientY, e.target);
    }, true);

    // Click on empty space clears focus mode
    document.addEventListener('click', function (e) {
      if (!activeAnnId) return;
      if (isOurs(e.target)) return;
      if (e.target.closest('.pd-pin') || e.target.closest('.pd-highlight')) return;
      clearFocus();
    }, false);

    // Highlight — fires after user finishes a text selection
    document.addEventListener('mouseup', function (e) {
      if (mode !== 'highlight') return;
      if (isOurs(e.target)) return;
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      var range = sel.getRangeAt(0);
      var clientRects = Array.prototype.slice.call(range.getClientRects());
      if (!clientRects.length) return;
      var text = sel.toString().trim();
      if (!text) return;
      sel.removeAllRanges();

      var docRects = clientRects.map(function (r, i) {
        var obj = { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
        if (i === 0) obj.sel = text.slice(0, 300);
        return obj;
      });
      pending = { data: { type: 'highlight', paths: docRects, color: activeColor } };
      showPopover(e.clientX, e.clientY, '🖍 Highlight');
    });
  }

  function onDrawStart(e) {
    if (mode !== 'draw') return;
    isDrawing = true;
    currentPoints = [docPt(e)];
    ctx.beginPath();
    ctx.moveTo(e.clientX, e.clientY);
    applyCtxStyle();
  }

  function onDrawMove(e) {
    if (!isDrawing || mode !== 'draw') return;
    currentPoints.push(docPt(e));
    ctx.lineTo(e.clientX, e.clientY);
    ctx.stroke();
  }

  function onDrawEnd(e) {
    if (!isDrawing || mode !== 'draw') return;
    isDrawing = false;
    if (currentPoints.length < 4) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      currentPoints = [];
      return;
    }
    var lastPt = currentPoints[currentPoints.length - 1];
    var vpX = lastPt.x - window.scrollX;
    var vpY = lastPt.y - window.scrollY;
    pending = {
      data: {
        type:  'drawing',
        paths: [{ points: currentPoints.slice(), color: activeColor, width: activeWidth }],
      }
    };
    showPopover(vpX, vpY, 'Add a comment (optional)');
  }

  function applyCtxStyle() {
    ctx.strokeStyle = activeColor;
    ctx.lineWidth   = activeWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
  }

  // ─── SVG LAYER (persisted drawings) ──────────────────────────────────────
  function buildSVGLayer() {
    svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgLayer.id = 'pd-svg';
    // SVG attribute (not CSS) — lets children override while the container itself passes through
    svgLayer.setAttribute('pointer-events', 'none');
    syncSVGSize();
    document.body.appendChild(svgLayer);
  }

  function syncSVGSize() {
    var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight);
    var w = Math.max(document.body.scrollWidth,  document.documentElement.scrollWidth,  window.innerWidth);
    svgLayer.setAttribute('width',  w);
    svgLayer.setAttribute('height', h);
    svgLayer.style.width  = w + 'px';
    svgLayer.style.height = h + 'px';
  }

  // ─── PINS ─────────────────────────────────────────────────────────────────
  function dropPin(cx, cy, targetEl) {
    tempPinSeq++;
    var xDoc   = cx + window.scrollX;
    var yDoc   = cy + window.scrollY;
    var anchor = buildAnchor(targetEl, cx, cy);
    var tmpPin = makePinEl(tempPinSeq, xDoc, yDoc, activeColor);
    tmpPin.dataset.temp = '1';
    document.body.appendChild(tmpPin);
    pending = {
      tempPin: tmpPin,
      data: { type: 'pin', x_doc: xDoc, y_doc: yDoc, color: activeColor, anchor: anchor },
    };
    showPopover(cx, cy, 'Pin #' + tempPinSeq);
  }

  function makePinEl(num, xDoc, yDoc, col) {
    var pin = mkEl('div', { class: 'pd-pin' });
    pin.style.left = xDoc + 'px';
    pin.style.top  = yDoc + 'px';
    pin.innerHTML  = '<div class="pd-pin-dot" style="background:' + col + '"><span class="pd-pin-num">' + num + '</span></div>';
    return pin;
  }

  // ─── RENDER ANNOTATION ────────────────────────────────────────────────────
  function renderAnnotation(ann) {
    if (ann.type === 'pin') {
      var n   = getPinNum(ann.id);
      var pos = resolveAnchor(ann);
      var pin = makePinEl(n, pos.x, pos.y, ann.color || '#4f46e5');
      pin.dataset.id = ann.id;
      pin.title = (ann.author_name || 'Anonymous') + ': ' + (ann.comment || '(no comment)');
      if (ann.resolved) pin.style.opacity = '0.4';
      pin.addEventListener('click', function (e) {
        e.stopPropagation();
        openSidebarTo(ann.id);
      });
      document.body.appendChild(pin);

    } else if (ann.type === 'highlight' && ann.paths && ann.paths.length) {
      ann.paths.forEach(function (r) {
        var el = mkEl('div', { class: 'pd-highlight' });
        el.style.left       = r.x + 'px';
        el.style.top        = r.y + 'px';
        el.style.width      = r.w + 'px';
        el.style.height     = r.h + 'px';
        el.style.background = hexToRgba(ann.color || '#eab308', 0.35);
        el.dataset.id       = ann.id;
        if (ann.resolved) el.style.opacity = '0.3';
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          openSidebarTo(ann.id);
        });
        document.body.appendChild(el);
      });

    } else if (ann.type === 'drawing' && ann.paths) {
      ann.paths.forEach(function (path) {
        var d = path.points.map(function (pt, i) {
          return (i === 0 ? 'M' : 'L') + ' ' + pt.x + ' ' + pt.y;
        }).join(' ');

        // Visible stroke — no pointer events of its own
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        p.setAttribute('stroke', path.color || '#ef4444');
        p.setAttribute('stroke-width', path.width || 3);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        p.setAttribute('pointer-events', 'none');
        p.setAttribute('data-id', ann.id);
        svgLayer.appendChild(p);

        // Invisible wider hit area — captures clicks on the drawing
        var hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', Math.max((path.width || 3) + 14, 16));
        hit.setAttribute('fill', 'none');
        hit.setAttribute('stroke-linecap', 'round');
        hit.setAttribute('stroke-linejoin', 'round');
        hit.setAttribute('pointer-events', 'stroke');
        hit.style.cursor = 'pointer';
        hit.setAttribute('data-id', ann.id);
        hit.addEventListener('click', function (e) {
          e.stopPropagation();
          openSidebarTo(ann.id);
        });
        svgLayer.appendChild(hit);
      });
      syncSVGSize();
    }
  }

  function getPinNum(id) {
    if (!pinSeqMap[id]) pinSeqMap[id] = ++pinSeqNext;
    return pinSeqMap[id];
  }

  // ─── LOAD FROM SUPABASE ───────────────────────────────────────────────────
  function loadAnnotations() {
    db.from('tcm_annotations')
      .select('*')
      .eq('page_url', PAGE_KEY)
      .order('created_at', { ascending: true })
      .then(function (result) {
        if (result.error) { console.error('[Pindrop] Load failed:', result.error); return; }
        annotations = result.data || [];
        annotations.forEach(renderAnnotation);
        updateCount();
        loadReplies();
      });
  }

  function loadReplies() {
    if (!annotations.length) { renderSidebarList(); return; }
    var ids = annotations.map(function (a) { return a.id; });
    db.from('tcm_replies')
      .select('*')
      .in('annotation_id', ids)
      .order('created_at', { ascending: true })
      .then(function (result) {
        if (result.error) { console.error('[Pindrop] Replies load failed:', result.error); }
        replies = {};
        (result.data || []).forEach(function (r) {
          if (!replies[r.annotation_id]) replies[r.annotation_id] = [];
          replies[r.annotation_id].push(r);
        });
        renderSidebarList();
      });
  }

  function submitReply(annId, nameEl, textEl, formEl, repliesEl) {
    var name = nameEl.value.trim() || 'Anonymous';
    var text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }
    localStorage.setItem('pd_name', name);
    var submitBtn = formEl.querySelector('.pd-reply-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    db.from('tcm_replies')
      .insert({ annotation_id: annId, author_name: name, comment: text, author_token: MY_TOKEN })
      .select().single()
      .then(function (result) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Reply';
        if (result.error) { console.error('[Pindrop] Reply failed:', result.error); alert('Could not save reply.'); return; }
        if (!replies[annId]) replies[annId] = [];
        replies[annId].push(result.data);
        textEl.value = '';
        formEl.classList.remove('pd-open');
        renderRepliesIn(repliesEl, annId);
      });
  }

  function renderRepliesIn(container, annId) {
    container.innerHTML = '';
    var list = replies[annId] || [];
    list.forEach(function (r) {
      var item = mkEl('div', { class: 'pd-reply-item' });
      var t = new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      item.innerHTML =
        '<div class="pd-reply-meta">' +
          '<span class="pd-reply-author">' + esc(r.author_name || 'Anonymous') + '</span>' +
          '<span class="pd-reply-time">'   + t + '</span>' +
        '</div>' +
        '<div class="pd-reply-text">' + esc(r.comment) + '</div>';
      container.appendChild(item);
    });
  }

  // ─── SIDEBAR ──────────────────────────────────────────────────────────────
  function buildSidebar() {
    var sb = mkEl('div', { id: 'pd-sidebar' });
    sb.innerHTML = [
      '<div id="pd-sb-head">',
        '<div>',
          '<h3>Annotations</h3>',
          '<p id="pd-sb-path">' + esc(PAGE_KEY) + '</p>',
        '</div>',
        '<button id="pd-sb-close">✕</button>',
      '</div>',
      '<div id="pd-sb-list">',
        '<div id="pd-sb-empty">No annotations on this page yet.</div>',
      '</div>',
    ].join('');
    document.body.appendChild(sb);
    document.getElementById('pd-sb-close').addEventListener('click', toggleSidebar);
  }

  function toggleSidebar() {
    document.getElementById('pd-sidebar').classList.toggle('pd-open');
  }

  function setFocus(annId) {
    activeAnnId = annId;
    // Dim all pins
    document.querySelectorAll('.pd-pin').forEach(function (el) {
      el.style.opacity = el.dataset.id === annId ? '' : '0.1';
    });
    // Dim all highlights
    document.querySelectorAll('.pd-highlight').forEach(function (el) {
      el.style.opacity = el.dataset.id === annId ? '' : '0.08';
    });
    // Dim all SVG drawing paths
    svgLayer.querySelectorAll('[data-id]').forEach(function (el) {
      el.style.opacity = el.getAttribute('data-id') === annId ? '' : '0.1';
    });
    // Focus the sidebar card
    document.querySelectorAll('.pd-card').forEach(function (card) {
      card.classList.toggle('pd-card-focused', card.dataset.id === annId);
    });
  }

  function clearFocus() {
    activeAnnId = null;
    // Restore annotation opacities (respecting resolved state)
    document.querySelectorAll('.pd-pin').forEach(function (el) {
      var ann = annotations.find(function (a) { return a.id === el.dataset.id; });
      el.style.opacity = (ann && ann.resolved) ? '0.4' : '';
    });
    document.querySelectorAll('.pd-highlight').forEach(function (el) {
      var ann = annotations.find(function (a) { return a.id === el.dataset.id; });
      el.style.opacity = (ann && ann.resolved) ? '0.3' : '';
    });
    svgLayer.querySelectorAll('[data-id]').forEach(function (el) {
      el.style.opacity = '';
    });
    // Clear focused card
    document.querySelectorAll('.pd-card-focused').forEach(function (card) {
      card.classList.remove('pd-card-focused');
    });
  }

  function openSidebarTo(annId) {
    setFocus(annId);
    var sb = document.getElementById('pd-sidebar');
    if (!sb.classList.contains('pd-open')) sb.classList.add('pd-open');
    var card = sb.querySelector('.pd-card[data-id="' + annId + '"]');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    card.classList.add('pd-card-flash');
    setTimeout(function () { card.classList.remove('pd-card-flash'); }, 1200);
    // Expand if collapsed
    card.classList.remove('pd-collapsed');
    // Auto-open the reply form so clicking a pin is an invitation to respond
    var form = card.querySelector('.pd-reply-form');
    if (form && !form.classList.contains('pd-open')) {
      form.classList.add('pd-open');
      setTimeout(function () {
        var ta = form.querySelector('textarea');
        if (ta) ta.focus();
      }, 350);
    }
  }

  function renderSidebarList() {
    var list  = document.getElementById('pd-sb-list');
    var empty = document.getElementById('pd-sb-empty');
    list.querySelectorAll('.pd-card').forEach(function (c) { c.remove(); });

    if (!annotations.length) {
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    annotations.forEach(function (ann) {
      var card    = mkEl('div', { class: 'pd-card', 'data-id': ann.id });
      var isPin   = ann.type === 'pin';
      var badgeLabel = isPin ? 'pd-badge-pin">Pin' : (ann.type === 'highlight' ? 'pd-badge-hl">Highlight' : 'pd-badge-draw">Drawing');
      var badge   = '<span class="pd-badge ' + badgeLabel + '</span>';
      var t       = new Date(ann.created_at).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      // Start resolved cards collapsed
      if (ann.resolved) {
        card.classList.add('pd-card-resolved');
        card.classList.add('pd-collapsed');
      }

      // Always-visible header
      var header = mkEl('div', { class: 'pd-card-header' });
      header.innerHTML =
        badge +
        '<span class="pd-card-author">' + esc(ann.author_name || 'Anonymous') + '</span>' +
        '<span class="pd-card-time">'   + t + '</span>' +
        '<span class="pd-card-chevron">▾</span>';
      header.addEventListener('click', function (e) {
        e.stopPropagation();
        card.classList.toggle('pd-collapsed');
      });
      card.appendChild(header);

      // Collapsible body
      var body = mkEl('div', { class: 'pd-card-body' });

      // Highlighted text snippet (for highlights)
      if (ann.type === 'highlight' && ann.paths && ann.paths[0] && ann.paths[0].sel) {
        var snip = mkEl('div', { class: 'pd-hl-snip' });
        snip.textContent = '“' + ann.paths[0].sel.slice(0, 120) + (ann.paths[0].sel.length > 120 ? '…' : '') + '”';
        body.appendChild(snip);
      }

      // Comment
      var commentEl = mkEl('div', { class: ann.comment ? 'pd-card-comment' : 'pd-card-empty' });
      commentEl.textContent = ann.comment || 'No comment';
      body.appendChild(commentEl);

      card.appendChild(body);

      // Action row (resolve + delete)
      var actionsRow = mkEl('div', { class: 'pd-card-actions' });

      var resolveBtn = mkEl('button', { class: 'pd-act-btn pd-act-resolve' + (ann.resolved ? ' pd-resolved' : '') });
      resolveBtn.textContent = ann.resolved ? '✓ Resolved' : '✓ Resolve';
      resolveBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleResolve(ann, resolveBtn, card);
      });
      actionsRow.appendChild(resolveBtn);

      if (ann.author_token === MY_TOKEN) {
        var deleteBtn = mkEl('button', { class: 'pd-act-btn pd-act-delete' });
        deleteBtn.textContent = '🗑 Delete';
        deleteBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!confirm('Delete this annotation and all its replies?')) return;
          deleteAnnotation(ann, card);
        });
        actionsRow.appendChild(deleteBtn);
      }

      body.appendChild(actionsRow);

      // Replies section
      var repliesEl = mkEl('div', { class: 'pd-replies' });
      renderRepliesIn(repliesEl, ann.id);
      body.appendChild(repliesEl);

      // Reply toggle button
      var savedName = localStorage.getItem('pd_name') || '';
      var replyToggle = mkEl('button', { class: 'pd-reply-toggle' });
      replyToggle.textContent = '💬 Reply';
      body.appendChild(replyToggle);

      // Reply form
      var formEl   = mkEl('div',      { class: 'pd-reply-form' });
      var nameEl   = mkEl('input',    { type: 'text',  placeholder: 'Your name' });
      nameEl.value = savedName;
      var textEl   = mkEl('textarea', { placeholder: 'Add a reply…' });
      var actionsEl = mkEl('div',     { class: 'pd-reply-actions' });
      var cancelBtn = mkEl('button',  { class: 'pd-reply-cancel' });  cancelBtn.textContent = 'Cancel';
      var submitBtn = mkEl('button',  { class: 'pd-reply-submit' });  submitBtn.textContent = 'Reply';
      actionsEl.appendChild(cancelBtn);
      actionsEl.appendChild(submitBtn);
      formEl.appendChild(nameEl);
      formEl.appendChild(textEl);
      formEl.appendChild(actionsEl);
      body.appendChild(formEl);

      replyToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        formEl.classList.toggle('pd-open');
        if (formEl.classList.contains('pd-open')) setTimeout(function () { textEl.focus(); }, 50);
      });
      cancelBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        formEl.classList.remove('pd-open');
        textEl.value = '';
      });
      submitBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        submitReply(ann.id, nameEl, textEl, formEl, repliesEl);
      });

      card.addEventListener('click', function () { jumpTo(ann); setFocus(ann.id); });
      list.appendChild(card);
    });
  }

  function toggleResolve(ann, btn, card) {
    var newState = !ann.resolved;
    db.from('tcm_annotations').update({ resolved: newState }).eq('id', ann.id).then(function (result) {
      if (result.error) { console.error('[Pindrop] Resolve failed:', result.error); return; }
      ann.resolved = newState;
      btn.textContent = newState ? '✓ Resolved' : '✓ Resolve';
      btn.classList.toggle('pd-resolved', newState);
      card.classList.toggle('pd-card-resolved', newState);
      if (newState) { card.classList.add('pd-collapsed'); clearFocus(); }
      else card.classList.remove('pd-collapsed');
      // Update pin/highlight opacity
      var pin = document.querySelector('.pd-pin[data-id="' + ann.id + '"]');
      if (pin) pin.style.opacity = newState ? '0.4' : '';
      document.querySelectorAll('.pd-highlight[data-id="' + ann.id + '"]').forEach(function (el) {
        el.style.opacity = newState ? '0.3' : '';
      });
    });
  }

  function deleteAnnotation(ann, card) {
    db.from('tcm_annotations').delete().eq('id', ann.id).then(function (result) {
      if (result.error) { console.error('[Pindrop] Delete failed:', result.error); return; }
      // Remove from arrays
      annotations = annotations.filter(function (a) { return a.id !== ann.id; });
      delete replies[ann.id];
      // Remove pin/drawing/highlight from DOM
      var pin = document.querySelector('.pd-pin[data-id="' + ann.id + '"]');
      if (pin) pin.remove();
      svgLayer.querySelectorAll('[data-id="' + ann.id + '"]').forEach(function (el) { el.remove(); });
      document.querySelectorAll('.pd-highlight[data-id="' + ann.id + '"]').forEach(function (el) { el.remove(); });
      // Remove card
      card.remove();
      updateCount();
      // Show empty state if nothing left
      var list = document.getElementById('pd-sb-list');
      if (!list.querySelector('.pd-card')) {
        var empty = document.getElementById('pd-sb-empty');
        if (empty) empty.style.display = 'block';
      }
    });
  }

  function jumpTo(ann) {
    var y = 0;
    if (ann.type === 'pin') {
      y = resolveAnchor(ann).y;
    } else if (ann.type === 'highlight' && ann.paths && ann.paths[0]) {
      y = ann.paths[0].y;
    } else if (ann.paths && ann.paths[0] && ann.paths[0].points[0]) {
      y = ann.paths[0].points[0].y;
    }
    window.scrollTo({ top: Math.max(0, y - 200), behavior: 'smooth' });
  }

  function updateCount() {
    var btn = document.getElementById('pd-view-btn');
    if (btn) btn.textContent = '📋 View annotations (' + annotations.length + ')';
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────
  function mkEl(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function docPt(e) {
    return { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
  }

  function isOurs(target) {
    if (!target || !target.closest) return false;
    return !!(
      target.closest('#pd-root')    ||
      target.closest('#pd-pop')     ||
      target.closest('#pd-sidebar') ||
      target.closest('#pd-canvas')  ||
      target.closest('.pd-pin')     ||
      target.closest('.pd-highlight')
    );
  }

  function hexToRgba(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ─── NAME PROMPT ─────────────────────────────────────────────────────────
  function buildNamePrompt() {
    if (localStorage.getItem('pd_name')) return;  // already set

    var prompt = mkEl('div', { id: 'pd-name-prompt' });
    prompt.innerHTML = [
      '<h4>👋 Who are you?</h4>',
      '<p>Your name will appear on any feedback you leave.</p>',
      '<input id="pd-name-input" type="text" placeholder="e.g. Kaleb" autocomplete="name" />',
      '<button id="pd-name-go">Let\'s go</button>',
      '<button id="pd-name-skip">Continue anonymously</button>',
    ].join('');
    document.body.appendChild(prompt);

    var input = document.getElementById('pd-name-input');

    function saveName() {
      var name = input.value.trim();
      if (name) localStorage.setItem('pd_name', name);
      // Pre-fill any open popover name fields
      var popName = document.getElementById('pd-pop-name');
      if (popName) popName.value = name;
      prompt.remove();
    }

    document.getElementById('pd-name-go').addEventListener('click', saveName);
    document.getElementById('pd-name-skip').addEventListener('click', function () {
      localStorage.setItem('pd_name', 'Anonymous');
      prompt.remove();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveName();
    });

    setTimeout(function () { input.focus(); }, 100);
  }

  // ─── ELEMENT ANCHORING ────────────────────────────────────────────────────

  /**
   * Walk up the DOM from el, building a CSS selector path.
   * Stops at the first ancestor with an id (uses #id as the root).
   * Adds class names and nth-of-type to disambiguate siblings.
   * Returns a selector string, or null if el is not suitable.
   */
  function getSelectorPath(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    var parts = [];
    var node  = el;
    var MAX   = 6;
    while (node && node !== document.body && parts.length < MAX) {
      // Skip our own UI elements
      if (node.id && /^pd-/.test(node.id)) return null;
      var tag = node.tagName.toLowerCase();
      if (node.id && !/^pd-/.test(node.id)) {
        parts.unshift('#' + node.id);
        break;  // id is unique — stop here
      }
      // Build class segment (up to 2 stable classes)
      var classes = [];
      for (var i = 0; i < node.classList.length && classes.length < 2; i++) {
        var c = node.classList[i];
        if (!/^pd-/.test(c)) classes.push(c);
      }
      var seg = tag + (classes.length ? '.' + classes.join('.') : '');
      // Add nth-of-type to disambiguate siblings with the same tag
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (ch) {
          return ch.tagName === node.tagName;
        });
        if (siblings.length > 1) {
          seg += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  /**
   * Build an anchor object for a click at (cx, cy) on targetEl.
   * Stores a CSS selector and the click offset as percentages of the element's
   * bounding box, plus the absolute fallback coords.
   */
  function buildAnchor(el, cx, cy) {
    var selector = el ? getSelectorPath(el) : null;
    if (!selector) return null;
    try {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        selector:    selector,
        offset_x_pct: (cx - rect.left) / rect.width,
        offset_y_pct: (cy - rect.top)  / rect.height,
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Given a stored annotation, return {x, y} in document coordinates.
   * Uses the element anchor when available; falls back to x_doc/y_doc.
   */
  function resolveAnchor(ann) {
    var fallback = { x: ann.x_doc || 0, y: ann.y_doc || 0 };
    if (!ann.anchor || !ann.anchor.selector) return fallback;
    try {
      var el = document.querySelector(ann.anchor.selector);
      if (!el) return fallback;
      var rect = el.getBoundingClientRect();
      var cx   = rect.left + ann.anchor.offset_x_pct * rect.width;
      var cy   = rect.top  + ann.anchor.offset_y_pct * rect.height;
      return {
        x: cx + window.scrollX,
        y: cy + window.scrollY,
      };
    } catch (err) {
      return fallback;
    }
  }

  /**
   * Reposition all rendered pins using their element anchor.
   * Called on window resize.
   */
  function repositionPins() {
    annotations.forEach(function (ann) {
      if (ann.type !== 'pin') return;
      var pin = document.querySelector('.pd-pin[data-id="' + ann.id + '"]');
      if (!pin) return;
      var pos = resolveAnchor(ann);
      pin.style.left = pos.x + 'px';
      pin.style.top  = pos.y + 'px';
    });
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
