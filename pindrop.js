/**
 * Pindrop v0.9.5 — drop-in design annotation tool
 * Pins · Threaded comments
 * Backed by Supabase (free tier works great).
 * License: MIT + Commons Clause (free to use, not for resale)
 *
 * Usage — add one script tag to any page:
 *
 *   <script src="pindrop.min.js"
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
  var WEBHOOK_URL       = (_self && _self.getAttribute('data-webhook-url')) || null;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[Pindrop] Missing data-supabase-url or data-supabase-key on <script> tag — not loading.');
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
  var mode          = null;   // null | 'pin'
  var activeColor   = '#ef4444';
  var pending       = null;   // { data, tempPin? } — waiting for comment submission
  var annotations   = [];
  var activeAnnId   = null;   // currently focused annotation id (focus/dim mode)
  var replies       = {};     // annotation_id → [{id, author_name, comment, created_at}]
  var pinSeqMap     = {};     // ann.id → display number
  var pinSeqNext    = 0;
  var tempPinSeq    = 0;      // for pins not yet saved
  var realtimeChannel        = null;  // Supabase Realtime channel
  var realtimeConnected      = false; // true when channel is SUBSCRIBED
  var realtimeEverSubscribed = false; // true after first successful subscribe
  var cursors       = {};     // token → { el, hideTimer }
  var adminUser     = null;   // Supabase Auth user when signed in
  var isAdminUser   = false;  // true when signed-in user has profiles.is_admin = true
  var repositionTimer = null; // debounce handle for resize/reflow-triggered repositioning

  // Sidebar filter/sort state
  var sbFilterStatus = null;      // null | 'open' | 'resolved'
  var sbFilterAuthor = null;      // null | string
  var sbSearch       = '';
  var sbSort         = 'newest';  // 'newest' | 'oldest' | 'unresolved'

  // ─── DOM FINGERPRINT ─────────────────────────────────────────────────────
  /**
   * Compute a short fingerprint of the DOM context around an annotation.
   * Stored at creation time; compared on load to detect page structure changes.
   *   pin → anchored element tagName + textContent (first 200 chars)
   */
  function computeFingerprint(ann) {
    try {
      if (ann.type === 'pin') {
        if (!ann.anchor || !ann.anchor.selector) return null;
        var el = document.querySelector(ann.anchor.selector);
        if (!el) return '__element_missing__';
        return el.tagName + '|' + el.textContent.trim().slice(0, 200);
      }
    } catch (e) {}
    return null;
  }

  /** Mark annotations outdated where the stored fingerprint no longer matches. */
  function checkFingerprints() {
    annotations.forEach(function (ann) {
      if (!ann.dom_fingerprint) { ann.outdated = false; return; }
      var current = computeFingerprint(ann);
      ann.outdated = (current !== null && current !== ann.dom_fingerprint);
    });
  }

  // ─── WEBHOOK ─────────────────────────────────────────────────────────────
  function fireWebhook(payload) {
    if (!WEBHOOK_URL) return;
    fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(function (err) {
      console.warn('[Pindrop] Webhook delivery failed:', err);
    });
  }

  // ─── BOOT ────────────────────────────────────────────────────────────────
  function boot() {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = function () {
      db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { flowType: 'implicit' }
      });
      injectStyles();
      buildToolbar();
      buildPopover();
      setupInteractions();
      buildSidebar();
      buildIdentityPrompt();
      loadAnnotations();
      setupRealtime();
      setupReconnectHandlers();
      setupAuth();
      setupResizeHandling();
    };
    document.head.appendChild(s);
  }

  // ─── RESIZE / REFLOW HANDLING ───────────────────────────────────────────
  /**
   * Pins are re-derived from their element anchor whenever the layout might
   * have changed — not just on a literal window resize. A window resize is
   * the obvious trigger (desktop-to-mobile viewport change), but content can
   * also reflow without one firing at all (a web font swapping in, a lazy
   * image finishing load, an accordion opening) — a ResizeObserver on the
   * document catches those too. Debounced so a drag-resize or a burst of
   * layout shifts doesn't recompute on every frame.
   */
  function scheduleReposition() {
    if (repositionTimer) clearTimeout(repositionTimer);
    repositionTimer = setTimeout(function () {
      repositionTimer = null;
      repositionPins();
    }, 120);
  }

  function setupResizeHandling() {
    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('orientationchange', scheduleReposition);
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(scheduleReposition);
      ro.observe(document.documentElement);
    }
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
.pd-divider { height: 1px; background: #f1f5f9; }\
.pd-btn {\
  width: 100%; padding: 8px; border: none; border-radius: 9px;\
  background: #f1f5f9; font-size: 12px; font-weight: 700;\
  color: #475569; cursor: pointer; transition: background .15s;\
}\
.pd-btn:hover { background: #e2e8f0; }\
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
.pd-pin-approx .pd-pin-dot { border-style: dashed; opacity: .6; }\
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
#pd-sb-head h3  { margin: 0; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; color: #1e1b4b; font-family: system-ui, -apple-system, sans-serif; }\
#pd-sb-head p   { margin: 3px 0 0; font-size: 11px; color: #94a3b8; }\
#pd-sb-close {\
  background: none; border: none; cursor: pointer;\
  color: #94a3b8; font-size: 18px; padding: 2px; line-height: 1;\
}\
#pd-sb-close:hover { color: #475569; }\
#pd-sb-filters { margin: 12px 12px 0; background: #f8fafc; border-radius: 10px; border: 1.5px solid transparent; flex-shrink: 0; transition: border-color .15s; }\
#pd-sb-filters:hover { border-color: #e2e8f0; }\
#pd-sb-filters-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 13px; cursor: pointer; user-select: none; }\
#pd-sb-filters-head span:first-child { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; color: #1e1b4b; }\
#pd-sb-filters-chevron { font-size: 11px; color: #94a3b8; transition: transform .2s; }\
#pd-sb-filters.pd-collapsed #pd-sb-filters-chevron { transform: rotate(-90deg); }\
#pd-sb-filters-body { padding: 0 13px 12px; display: flex; flex-direction: column; gap: 7px; }\
#pd-sb-filters.pd-collapsed #pd-sb-filters-body { display: none; }\
.pd-sb-search { width: 100%; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 6px 10px; font-size: 12px; outline: none; color: #1e1b4b; font-family: inherit; }\
.pd-sb-search:focus { border-color: #4f46e5; }\
.pd-sb-chips { display: flex; gap: 4px; flex-wrap: wrap; }\
.pd-sb-chip { font-size: 11px; font-weight: 600; padding: 3px 9px; border: 1.5px solid #e2e8f0; border-radius: 20px; background: white; color: #64748b; cursor: pointer; transition: all .15s; font-family: inherit; }\
.pd-sb-chip:hover { border-color: #4f46e5; color: #4f46e5; }\
.pd-sb-chip.pd-active { background: #4f46e5; border-color: #4f46e5; color: white; }\
.pd-sb-row { display: flex; gap: 6px; align-items: center; }\
.pd-sb-select { font-size: 11px; font-weight: 600; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 3px 6px; color: #64748b; background: white; cursor: pointer; font-family: inherit; }\
.pd-sb-select:focus { outline: none; border-color: #4f46e5; }\
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
.pd-badge-approx { background: #fef3c7; color: #b45309; }\
.pd-card-author { font-size: 12px; font-weight: 700; color: #334155; }\
.pd-card-time   { font-size: 11px; color: #94a3b8; margin-left: auto; }\
.pd-outdated-badge { font-size: 10px; font-weight: 700; color: #b45309; background: #fef3c7; border: 1.5px solid #fcd34d; border-radius: 4px; padding: 1px 6px; white-space: nowrap; }\
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
/* ── Inline edit ── */\
.pd-edit-btn {\
  background: none; border: none; cursor: pointer;\
  font-size: 11px; color: #94a3b8; padding: 0 4px; transition: color .15s;\
}\
.pd-edit-btn:hover { color: #4f46e5; }\
.pd-inline-edit { margin-top: 4px; }\
.pd-inline-edit textarea {\
  width: 100%; border: 1.5px solid #4f46e5; border-radius: 7px;\
  padding: 7px 9px; font-size: 13px; color: #1e293b; outline: none;\
  font-family: system-ui, sans-serif; resize: vertical; min-height: 52px;\
  margin-bottom: 6px; box-sizing: border-box;\
}\
.pd-inline-edit-btns { display: flex; gap: 6px; }\
.pd-inline-edit-btns button {\
  flex: 1; padding: 5px; border: none; border-radius: 7px;\
  font-size: 12px; font-weight: 700; cursor: pointer;\
}\
.pd-inline-save   { background: #4f46e5; color: white; }\
.pd-inline-cancel { background: #f1f5f9; color: #475569; }\
\
/* ── Reply edit ── */\
.pd-reply-edit-btn {\
  background: none; border: none; cursor: pointer;\
  font-size: 10px; color: #94a3b8; padding: 0 2px; transition: color .15s;\
}\
.pd-reply-edit-btn:hover { color: #4f46e5; }\
\
/* ── Body cursor overrides ── */\
body.pd-pin-cursor, body.pd-pin-cursor * { cursor: crosshair !important; }\
\
/* ── Live cursors ── */\
.pd-cursor { position: fixed; pointer-events: none; z-index: 10010; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; transform: translate(-2px, -2px); }\
.pd-cursor-dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 1px 4px rgba(0,0,0,.3); flex-shrink: 0; }\
.pd-cursor-name { font-size: 10px; font-weight: 700; background: rgba(15,15,15,.75); color: white; border-radius: 4px; padding: 1px 6px; white-space: nowrap; margin-left: 8px; }\
\
/* ── Viewer count ── */\
#pd-viewers { display: none; font-size: 11px; color: #64748b; text-align: center; padding: 0; }\
\
/* ── Reconnect badge ── */\
#pd-reconnect-badge { position: fixed; bottom: 80px; right: 20px; background: #f59e0b; color: #fff; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px; z-index: 10005; display: none; box-shadow: 0 2px 8px rgba(0,0,0,.2); pointer-events: none; letter-spacing: .02em; }\
\
/* ── Admin panel ── */\
#pd-admin-form { display: flex; flex-direction: column; gap: 6px; }\
#pd-admin-email { width: 100%; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 7px 10px; font-size: 12px; outline: none; font-family: inherit; box-sizing: border-box; color: #1e293b; }\
#pd-admin-email:focus { border-color: #4f46e5; }\
#pd-admin-active { display: none; flex-direction: column; gap: 6px; }\
#pd-admin-email-label { font-size: 11px; color: #475569; font-weight: 600; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\
.pd-btn-admin { width: 100%; padding: 8px; border: none; border-radius: 9px; background: #ede9fe; font-size: 12px; font-weight: 700; color: #4f46e5; cursor: pointer; transition: background .15s; }\
.pd-btn-admin:hover { background: #ddd6fe; }\
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
  var COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#4f46e5',
                '#1e1b4b', '#ec4899', '#06b6d4', '#3b82f6', '#a855f7'];

  function buildToolbar() {
    var root = mkEl('div', { id: 'pd-root' });

    // Toggle button
    var toggle = mkEl('button', { id: 'pd-toggle', title: 'Annotate this page' });
    toggle.textContent = '✏️';
    toggle.addEventListener('click', togglePanel);
    root.appendChild(toggle);

    // Panel
    var panel = mkEl('div', { id: 'pd-panel' });

    // Tool button
    var toolLabel = mkEl('p', { class: 'pd-label' }); toolLabel.textContent = 'Tool';
    var toolRow = mkEl('div', { class: 'pd-tools' });
    var pinBtn  = mkEl('button', { class: 'pd-tool', id: 'pd-pin-btn' }); pinBtn.textContent = '📍 Pin';
    pinBtn.addEventListener('click', function () {
      setMode(mode === 'pin' ? null : 'pin');
    });
    toolRow.appendChild(pinBtn);

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

    // View button
    var div1 = mkEl('div', { class: 'pd-divider' });
    var viewBtn = mkEl('button', { class: 'pd-btn', id: 'pd-view-btn' });
    viewBtn.textContent = '📋 View annotations (0)';
    viewBtn.addEventListener('click', toggleSidebar);

    var viewersEl = mkEl('div', { id: 'pd-viewers' });

    // Admin section
    var adminDiv   = mkEl('div', { class: 'pd-divider' });
    var adminLabel = mkEl('p',   { class: 'pd-label' }); adminLabel.textContent = 'Account';

    var adminForm      = mkEl('div', { id: 'pd-admin-form' });
    var adminEmailInput = mkEl('input', { id: 'pd-admin-email', type: 'email', placeholder: 'your@email.com' });
    var adminSendBtn   = mkEl('button', { class: 'pd-btn', id: 'pd-admin-send' });
    adminSendBtn.textContent = '✉️ Send magic link';
    adminForm.appendChild(adminEmailInput);
    adminForm.appendChild(adminSendBtn);

    var adminActive    = mkEl('div',   { id: 'pd-admin-active' });
    var adminEmailLbl  = mkEl('div',   { id: 'pd-admin-email-label' });
    var adminSignOut   = mkEl('button', { class: 'pd-btn pd-btn-admin', id: 'pd-admin-signout' });
    adminSignOut.textContent = '👋 Sign out';
    adminActive.appendChild(adminEmailLbl);
    adminActive.appendChild(adminSignOut);

    adminSendBtn.addEventListener('click', function () {
      var email = adminEmailInput.value.trim();
      if (!email) { adminEmailInput.focus(); return; }
      adminSendBtn.disabled    = true;
      adminSendBtn.disabled    = true;
      adminSendBtn.textContent = 'Sending…';
      db.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
      }).then(function (result) {
        if (result.error) {
          adminSendBtn.disabled    = false;
          adminSendBtn.textContent = '❌ Error — try again';
          console.error('[Pindrop] Magic link error:', result.error);
        } else {
          adminSendBtn.textContent = '✓ Check your email';
          adminEmailInput.value    = '';
        }
        setTimeout(function () {
          if (!adminUser) {
            adminSendBtn.disabled    = false;
            adminSendBtn.textContent = '✉️ Send magic link';
          }
        }, 4000);
      });
    });

    adminSignOut.addEventListener('click', function () {
      db.auth.signOut();
    });

    [toolLabel, toolRow, mkEl('div', { class: 'pd-divider' }),
     colorLabel, colorRow,
     div1, viewersEl, viewBtn,
     adminDiv, adminLabel, adminForm, adminActive
    ].forEach(function (node) { panel.appendChild(node); });

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
    document.body.classList.remove('pd-pin-cursor');
    document.querySelectorAll('.pd-tool').forEach(function (b) { b.classList.remove('pd-active'); });
    if (m === 'pin') {
      document.body.classList.add('pd-pin-cursor');
      document.getElementById('pd-pin-btn').classList.add('pd-active');
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
    document.getElementById('pd-pop-comment').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); submitAnnotation(); }
    });
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
      page_url:        PAGE_KEY,
      author_name:     name,
      comment:         comment || null,
      author_token:    MY_TOKEN,
      dom_fingerprint: computeFingerprint(pending.data),
      user_id:         adminUser ? adminUser.id : null,
    });

    db.from('pindrop_annotations').insert(record).select().single().then(function (result) {
      if (result.error) {
        console.error('[Pindrop] Save failed:', result.error);
        alert('Could not save — check the browser console.');
        return;
      }
      if (pending && pending.tempPin) pending.tempPin.remove();
      annotations.push(result.data);
      renderAnnotation(result.data);
      updateCount();
      renderSidebarList();
      hidePopover();
      fireWebhook({ event: 'annotation.created', page_url: PAGE_KEY, annotation: result.data });
    });
  }

  function cancelAnnotation() {
    if (pending && pending.tempPin) {
      pending.tempPin.remove();
      tempPinSeq = Math.max(0, tempPinSeq - 1);
    }
    hidePopover();
  }

  // ─── INTERACTIONS ─────────────────────────────────────────────────────────
  function setupInteractions() {
    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      var inInput = tag === 'INPUT' || tag === 'TEXTAREA';
      if (e.key === 'Escape') {
        if (document.getElementById('pd-pop').classList.contains('pd-open')) {
          cancelAnnotation(); return;
        }
        var sb = document.getElementById('pd-sidebar');
        if (sb && sb.classList.contains('pd-open')) { toggleSidebar(); return; }
        setMode(null);
        return;
      }
      if (inInput) return;
      if (e.key === 'p' || e.key === 'P') { setMode(mode === 'pin' ? null : 'pin'); return; }
      if (e.key === 't' || e.key === 'T') { togglePanel(); return; }
      if (e.key === 'a' || e.key === 'A') { toggleSidebar(); return; }
    });

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
      if (e.target.closest('.pd-pin')) return;
      clearFocus();
    }, false);
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
    if (ann.type !== 'pin') return;
    var n   = getPinNum(ann.id);
    var pos = resolveAnchor(ann);
    var pin = makePinEl(n, pos.x, pos.y, ann.color || '#4f46e5');
    pin.dataset.id = ann.id;
    pin.classList.toggle('pd-pin-approx', !pos.resolved);
    var title = (ann.author_name || 'Anonymous') + ': ' + (ann.comment || '(no comment)');
    pin.title = pos.resolved ? title
      : title + ' (position approximate — the marked content is hidden or has moved at this screen size)';
    if (ann.resolved) pin.style.opacity = '0.4';
    pin.addEventListener('click', function (e) {
      e.stopPropagation();
      openSidebarTo(ann.id);
    });
    document.body.appendChild(pin);
  }

  function getPinNum(id) {
    if (!pinSeqMap[id]) pinSeqMap[id] = ++pinSeqNext;
    return pinSeqMap[id];
  }

  // ─── LOAD FROM SUPABASE ───────────────────────────────────────────────────
  function loadAnnotations() {
    db.from('pindrop_annotations')
      .select('*')
      .eq('page_url', PAGE_KEY)
      .order('created_at', { ascending: true })
      .then(function (result) {
        if (result.error) { console.error('[Pindrop] Load failed:', result.error); return; }
        annotations = result.data || [];
        checkFingerprints();
        annotations.forEach(renderAnnotation);
        updateCount();
        loadReplies();
      });
  }

  function loadReplies() {
    if (!annotations.length) { renderSidebarList(); return; }
    var ids = annotations.map(function (a) { return a.id; });
    db.from('pindrop_replies')
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

  // ─── REALTIME ─────────────────────────────────────────────────────────────
  function showReconnectBadge(visible) {
    var badge = document.getElementById('pd-reconnect-badge');
    if (!badge) {
      badge = mkEl('div', { id: 'pd-reconnect-badge' });
      badge.textContent = '⟳ Reconnecting…';
      document.body.appendChild(badge);
    }
    badge.style.display = visible ? 'block' : 'none';
  }

  function teardownRealtime() {
    if (realtimeChannel) {
      db.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    realtimeConnected = false;
    // Clear stale remote cursors
    Object.keys(cursors).forEach(function (token) {
      if (cursors[token] && cursors[token].el) cursors[token].el.remove();
      if (cursors[token] && cursors[token].hideTimer) clearTimeout(cursors[token].hideTimer);
    });
    cursors = {};
    updateViewerCount(0);
  }

  function reconnectRealtime() {
    teardownRealtime();
    setupRealtime();
  }

  function setupReconnectHandlers() {
    window.addEventListener('online', function () {
      if (!realtimeConnected) reconnectRealtime();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        // Broadcast cursor leave so peers remove our cursor immediately
        if (realtimeChannel) {
          realtimeChannel.send({ type: 'broadcast', event: 'cursor_leave', payload: { token: MY_TOKEN } });
        }
      } else if (!realtimeConnected) {
        reconnectRealtime();
      }
    });
  }

  function setupRealtime() {
    realtimeChannel = db.channel('pindrop:' + PAGE_KEY, {
      config: { presence: { key: MY_TOKEN } }
    });

    // Annotation changes
    realtimeChannel.on('postgres_changes', {
      event: '*', schema: 'public', table: 'pindrop_annotations',
      filter: 'page_url=eq.' + PAGE_KEY
    }, function (payload) {
      var ann, idx;
      if (payload.eventType === 'INSERT') {
        ann = payload.new;
        if (annotations.some(function (a) { return a.id === ann.id; })) return;
        annotations.push(ann);
        renderAnnotation(ann);
        updateCount();
        renderSidebarList();
      } else if (payload.eventType === 'UPDATE') {
        ann = payload.new;
        idx = -1;
        annotations.forEach(function (a, i) { if (a.id === ann.id) idx = i; });
        if (idx !== -1) {
          annotations[idx] = ann;
          removeAnnotationDOM(ann.id);
          renderAnnotation(ann);
          renderSidebarList();
        }
      } else if (payload.eventType === 'DELETE') {
        var delId = payload.old && payload.old.id;
        if (!delId) return;
        annotations = annotations.filter(function (a) { return a.id !== delId; });
        removeAnnotationDOM(delId);
        updateCount();
        renderSidebarList();
      }
    });

    // Reply changes
    realtimeChannel.on('postgres_changes', {
      event: '*', schema: 'public', table: 'pindrop_replies'
    }, function (payload) {
      var r, list, repliesEl;
      if (payload.eventType === 'INSERT') {
        r = payload.new;
        list = replies[r.annotation_id] || [];
        if (list.some(function (x) { return x.id === r.id; })) return;
        if (!replies[r.annotation_id]) replies[r.annotation_id] = [];
        replies[r.annotation_id].push(r);
        repliesEl = document.querySelector('.pd-replies[data-ann="' + r.annotation_id + '"]');
        if (repliesEl) renderRepliesIn(repliesEl, r.annotation_id);
      } else if (payload.eventType === 'UPDATE') {
        r = payload.new;
        list = replies[r.annotation_id] || [];
        var ridx = -1;
        list.forEach(function (x, i) { if (x.id === r.id) ridx = i; });
        if (ridx !== -1) {
          list[ridx] = r;
          repliesEl = document.querySelector('.pd-replies[data-ann="' + r.annotation_id + '"]');
          if (repliesEl) renderRepliesIn(repliesEl, r.annotation_id);
        }
      } else if (payload.eventType === 'DELETE') {
        var dId = payload.old && payload.old.id;
        if (!dId) return;
        Object.keys(replies).forEach(function (annId) {
          var before = replies[annId].length;
          replies[annId] = replies[annId].filter(function (x) { return x.id !== dId; });
          if (replies[annId].length !== before) {
            repliesEl = document.querySelector('.pd-replies[data-ann="' + annId + '"]');
            if (repliesEl) renderRepliesIn(repliesEl, annId);
          }
        });
      }
    });

    // Presence — viewer count
    realtimeChannel.on('presence', { event: 'sync' }, function () {
      var state = realtimeChannel.presenceState();
      updateViewerCount(Object.keys(state).length);
    });

    // Cursor broadcast — receive
    realtimeChannel.on('broadcast', { event: 'cursor' }, function (payload) {
      var d = payload.payload;
      if (!d || d.token === MY_TOKEN) return;
      updateCursor(d.token, d.x, d.y, d.name, d.color, d.tool);
    });
    realtimeChannel.on('broadcast', { event: 'cursor_leave' }, function (payload) {
      var d = payload.payload;
      if (d && d.token) removeCursor(d.token);
    });

    realtimeChannel.subscribe(function (status) {
      if (status === 'SUBSCRIBED') {
        realtimeConnected = true;
        showReconnectBadge(false);
        var myName = localStorage.getItem('pd_name') || 'Anonymous';
        realtimeChannel.track({ name: myName, token: MY_TOKEN });
        if (realtimeEverSubscribed) loadAnnotations(); // refresh missed changes on reconnect
        realtimeEverSubscribed = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        realtimeConnected = false;
        showReconnectBadge(true);
      }
    });

    // Cursor broadcast — send (throttled to 50ms)
    var cursorTimer = null;
    var lastCx = 0, lastCy = 0;
    document.addEventListener('mousemove', function (e) {
      lastCx = e.clientX; lastCy = e.clientY;
      if (cursorTimer) return;
      cursorTimer = setTimeout(function () {
        cursorTimer = null;
        if (!realtimeChannel) return;
        realtimeChannel.send({
          type: 'broadcast', event: 'cursor',
          payload: {
            x: lastCx / window.innerWidth,
            y: lastCy / window.innerHeight,
            name: localStorage.getItem('pd_name') || 'Anonymous',
            token: MY_TOKEN,
            color: activeColor,
            tool: mode
          }
        });
      }, 50);
    });

  }

  function removeAnnotationDOM(id) {
    document.querySelectorAll('.pd-pin[data-id="' + id + '"]').forEach(function (el) { el.remove(); });
  }

  function updateCursor(token, xPct, yPct, name, color, tool) {
    var el = document.getElementById('pd-cur-' + token);
    if (!el) {
      el = mkEl('div', { class: 'pd-cursor', id: 'pd-cur-' + token });
      var dot = mkEl('div', { class: 'pd-cursor-dot' });
      var label = mkEl('div', { class: 'pd-cursor-name' });
      el.appendChild(dot);
      el.appendChild(label);
      document.body.appendChild(el);
    }
    var dot = el.querySelector('.pd-cursor-dot');
    var label = el.querySelector('.pd-cursor-name');
    if (dot) dot.style.background = color || '#4f46e5';
    if (label) {
      var toolIcon = tool === 'pin' ? '📍' : '';
      label.textContent = (toolIcon ? toolIcon + ' ' : '') + (name || 'Someone');
    }
    el.style.left    = (xPct * window.innerWidth)  + 'px';
    el.style.top     = (yPct * window.innerHeight) + 'px';
    el.style.display = 'flex';
    clearTimeout(cursors[token] && cursors[token].hideTimer);
    cursors[token] = { el: el, hideTimer: setTimeout(function () { el.style.display = 'none'; }, 4000) };
  }

  function removeCursor(token) {
    var c = cursors[token];
    if (c) { clearTimeout(c.hideTimer); c.el.remove(); delete cursors[token]; }
  }

  function updateViewerCount(count) {
    var el = document.getElementById('pd-viewers');
    if (!el) return;
    if (count > 1) {
      el.textContent = '👁 ' + count + ' people viewing';
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  function submitReply(annId, nameEl, textEl, formEl, repliesEl) {
    var name = nameEl.value.trim() || 'Anonymous';
    var text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }
    localStorage.setItem('pd_name', name);
    var submitBtn = formEl.querySelector('.pd-reply-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    db.from('pindrop_replies')
      .insert({ annotation_id: annId, author_name: name, comment: text, author_token: MY_TOKEN, user_id: adminUser ? adminUser.id : null })
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
        fireWebhook({ event: 'reply.created', page_url: PAGE_KEY, annotation_id: annId, reply: result.data });
      });
  }

  function renderRepliesIn(container, annId) {
    container.innerHTML = '';
    var list = replies[annId] || [];
    list.forEach(function (r) {
      var item = mkEl('div', { class: 'pd-reply-item' });
      var t = new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

      var meta = mkEl('div', { class: 'pd-reply-meta' });
      var authorSpan = mkEl('span', { class: 'pd-reply-author' }); authorSpan.textContent = r.author_name || 'Anonymous';
      var timeSpan   = mkEl('span', { class: 'pd-reply-time' });   timeSpan.textContent   = t;
      meta.appendChild(authorSpan);
      meta.appendChild(timeSpan);

      var textEl = mkEl('div', { class: 'pd-reply-text' }); textEl.textContent = r.comment;
      item.appendChild(meta);
      item.appendChild(textEl);

      if (r.author_token === MY_TOKEN || (adminUser && r.user_id === adminUser.id)) {
        var replyEditBtn = mkEl('button', { class: 'pd-reply-edit-btn', title: 'Edit reply' });
        replyEditBtn.textContent = '✏';
        item.appendChild(replyEditBtn);

        var replyEditForm = mkEl('div', { class: 'pd-inline-edit' });
        replyEditForm.style.display = 'none';
        var replyEditTa = mkEl('textarea'); replyEditTa.value = r.comment;
        var replyEditBtns   = mkEl('div', { class: 'pd-inline-edit-btns' });
        var replyEditSave   = mkEl('button', { class: 'pd-inline-save' });   replyEditSave.textContent = 'Save';
        var replyEditCancel = mkEl('button', { class: 'pd-inline-cancel' }); replyEditCancel.textContent = 'Cancel';
        replyEditBtns.appendChild(replyEditSave);
        replyEditBtns.appendChild(replyEditCancel);
        replyEditForm.appendChild(replyEditTa);
        replyEditForm.appendChild(replyEditBtns);
        item.appendChild(replyEditForm);

        replyEditBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          textEl.style.display = 'none';
          replyEditBtn.style.display = 'none';
          replyEditTa.value = r.comment;
          replyEditForm.style.display = 'block';
          replyEditTa.focus();
        });
        replyEditCancel.addEventListener('click', function (e) {
          e.stopPropagation();
          replyEditForm.style.display = 'none';
          textEl.style.display = '';
          replyEditBtn.style.display = '';
        });
        replyEditSave.addEventListener('click', function (e) {
          e.stopPropagation();
          var newText = replyEditTa.value.trim();
          if (!newText) { replyEditTa.focus(); return; }
          db.from('pindrop_replies').update({ comment: newText }).eq('id', r.id).then(function (res) {
            if (res.error) { console.error('[Pindrop] Reply edit failed:', res.error); return; }
            r.comment = newText;
            textEl.textContent = newText;
            replyEditForm.style.display = 'none';
            textEl.style.display = '';
            replyEditBtn.style.display = '';
          });
        });
      }

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
      '<div id="pd-sb-filters" class="pd-collapsed">',
        '<div id="pd-sb-filters-head">',
          '<span>Filters</span>',
          '<span id="pd-sb-filters-chevron">▾</span>',
        '</div>',
        '<div id="pd-sb-filters-body">',
          '<input id="pd-sb-search" class="pd-sb-search" type="text" placeholder="Search…">',
          '<div class="pd-sb-row">',
            '<div class="pd-sb-chips" id="pd-sb-status-chips">',
              '<button class="pd-sb-chip pd-active" data-status="">All</button>',
              '<button class="pd-sb-chip" data-status="open">Open</button>',
              '<button class="pd-sb-chip" data-status="resolved">Resolved</button>',
            '</div>',
            '<select id="pd-sb-sort" class="pd-sb-select" style="margin-left:auto">',
              '<option value="newest">Newest</option>',
              '<option value="oldest">Oldest</option>',
              '<option value="unresolved">Unresolved first</option>',
            '</select>',
          '</div>',
          '<select id="pd-sb-author" class="pd-sb-select" style="width:100%">',
            '<option value="">All authors</option>',
          '</select>',
        '</div>',
      '</div>',
      '<div id="pd-sb-list">',
        '<div id="pd-sb-empty">No annotations on this page yet.</div>',
      '</div>',
    ].join('');
    document.body.appendChild(sb);

    document.getElementById('pd-sb-close').addEventListener('click', toggleSidebar);

    // Filters toggle
    document.getElementById('pd-sb-filters-head').addEventListener('click', function () {
      document.getElementById('pd-sb-filters').classList.toggle('pd-collapsed');
    });

    // Search
    document.getElementById('pd-sb-search').addEventListener('input', function () {
      sbSearch = this.value.trim().toLowerCase();
      renderSidebarList();
    });

    // Status chips
    document.getElementById('pd-sb-status-chips').addEventListener('click', function (e) {
      var btn = e.target.closest('.pd-sb-chip');
      if (!btn) return;
      this.querySelectorAll('.pd-sb-chip').forEach(function (b) { b.classList.remove('pd-active'); });
      btn.classList.add('pd-active');
      sbFilterStatus = btn.dataset.status || null;
      renderSidebarList();
    });

    // Sort
    document.getElementById('pd-sb-sort').addEventListener('change', function () {
      sbSort = this.value;
      renderSidebarList();
    });

    // Author
    document.getElementById('pd-sb-author').addEventListener('change', function () {
      sbFilterAuthor = this.value || null;
      renderSidebarList();
    });
  }

  function toggleSidebar() {
    var sb      = document.getElementById('pd-sidebar');
    var opening = !sb.classList.contains('pd-open');
    sb.classList.toggle('pd-open');
    if (opening) {
      // Close the toolbar panel so it doesn't block the sidebar
      var panel  = document.getElementById('pd-panel');
      var toggle = document.getElementById('pd-toggle');
      if (panel && panel.classList.contains('pd-open')) {
        panel.classList.remove('pd-open');
        if (toggle) toggle.classList.remove('pd-on');
      }
    }
  }

  function setFocus(annId) {
    activeAnnId = annId;
    // Dim all pins
    document.querySelectorAll('.pd-pin').forEach(function (el) {
      el.style.opacity = el.dataset.id === annId ? '' : '0.1';
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
      if (empty) { empty.style.display = 'block'; empty.textContent = 'No annotations on this page yet.'; }
      return;
    }

    // Rebuild author select (preserve current selection)
    var authorSel = document.getElementById('pd-sb-author');
    if (authorSel) {
      var prevAuthor = authorSel.value;
      var authors = {};
      annotations.forEach(function (a) { if (a.author_name) authors[a.author_name] = true; });
      authorSel.innerHTML = '<option value="">All authors</option>';
      Object.keys(authors).sort().forEach(function (name) {
        var opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        if (name === prevAuthor) opt.selected = true;
        authorSel.appendChild(opt);
      });
    }

    // Filter
    var visible = annotations.filter(function (ann) {
      if (sbFilterStatus === 'open'     &&  ann.resolved) return false;
      if (sbFilterStatus === 'resolved' && !ann.resolved) return false;
      if (sbFilterAuthor && ann.author_name !== sbFilterAuthor) return false;
      if (sbSearch) {
        var hay = (ann.comment || '').toLowerCase();
        var reps = (replies[ann.id] || []).map(function (r) { return (r.comment || '').toLowerCase(); }).join(' ');
        if (hay.indexOf(sbSearch) === -1 && reps.indexOf(sbSearch) === -1) return false;
      }
      return true;
    });

    // Sort
    var sorted = visible.slice().sort(function (a, b) {
      if (sbSort === 'oldest')    return new Date(a.created_at) - new Date(b.created_at);
      if (sbSort === 'unresolved') {
        if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
        return new Date(b.created_at) - new Date(a.created_at);
      }
      return new Date(b.created_at) - new Date(a.created_at); // newest
    });

    if (!sorted.length) {
      if (empty) { empty.style.display = 'block'; empty.textContent = 'No annotations match your filters.'; }
      return;
    }
    if (empty) empty.style.display = 'none';

    sorted.forEach(function (ann) {
      var card    = mkEl('div', { class: 'pd-card pd-collapsed', 'data-id': ann.id });
      var approx  = !resolveAnchor(ann).resolved;
      var badge   = '<span class="pd-badge pd-badge-pin">Pin</span>' +
        (approx ? '<span class="pd-badge pd-badge-approx" title="Hidden or moved at this screen size">Approx.</span>' : '');
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
        (ann.outdated ? '<span class="pd-outdated-badge">⚠ Outdated</span>' : '') +
        '<span class="pd-card-chevron">▾</span>';
      header.addEventListener('click', function (e) {
        e.stopPropagation();
        card.classList.toggle('pd-collapsed');
      });
      card.appendChild(header);

      // Collapsible body
      var body = mkEl('div', { class: 'pd-card-body' });

      // Comment + inline edit
      var commentEl = mkEl('div', { class: ann.comment ? 'pd-card-comment' : 'pd-card-empty' });
      commentEl.textContent = ann.comment || 'No comment';
      body.appendChild(commentEl);

      if (ann.author_token === MY_TOKEN) {
        var editCommentBtn = mkEl('button', { class: 'pd-edit-btn', title: 'Edit comment' });
        editCommentBtn.textContent = '✏ Edit';
        body.appendChild(editCommentBtn);

        var editForm = mkEl('div', { class: 'pd-inline-edit' });
        editForm.style.display = 'none';
        var editTa = mkEl('textarea'); editTa.value = ann.comment || '';
        var editBtns = mkEl('div', { class: 'pd-inline-edit-btns' });
        var editSave = mkEl('button', { class: 'pd-inline-save' }); editSave.textContent = 'Save';
        var editCancel = mkEl('button', { class: 'pd-inline-cancel' }); editCancel.textContent = 'Cancel';
        editBtns.appendChild(editSave);
        editBtns.appendChild(editCancel);
        editForm.appendChild(editTa);
        editForm.appendChild(editBtns);
        body.appendChild(editForm);

        editCommentBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          commentEl.style.display = 'none';
          editCommentBtn.style.display = 'none';
          editTa.value = ann.comment || '';
          editForm.style.display = 'block';
          editTa.focus();
        });
        editCancel.addEventListener('click', function (e) {
          e.stopPropagation();
          editForm.style.display = 'none';
          commentEl.style.display = '';
          editCommentBtn.style.display = '';
        });
        editSave.addEventListener('click', function (e) {
          e.stopPropagation();
          var newText = editTa.value.trim() || null;
          db.from('pindrop_annotations').update({ comment: newText }).eq('id', ann.id).then(function (r) {
            if (r.error) { console.error('[Pindrop] Edit failed:', r.error); return; }
            ann.comment = newText;
            commentEl.textContent = newText || 'No comment';
            commentEl.className   = newText ? 'pd-card-comment' : 'pd-card-empty';
            editForm.style.display = 'none';
            commentEl.style.display = '';
            editCommentBtn.style.display = '';
          });
        });
      }

      card.appendChild(body);

      // Action row (resolve + delete)
      var actionsRow = mkEl('div', { class: 'pd-card-actions' });

      var canOwn = ann.author_token === MY_TOKEN || (adminUser && ann.user_id === adminUser.id) || isAdminUser;

      if (canOwn) {
        var resolveBtn = mkEl('button', { class: 'pd-act-btn pd-act-resolve' + (ann.resolved ? ' pd-resolved' : '') });
        resolveBtn.textContent = ann.resolved ? '✓ Resolved' : '✓ Resolve';
        resolveBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleResolve(ann, resolveBtn, card);
        });
        actionsRow.appendChild(resolveBtn);
      }

      if (canOwn) {
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
      var repliesEl = mkEl('div', { class: 'pd-replies', 'data-ann': ann.id });
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
      textEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); submitReply(ann.id, nameEl, textEl, formEl, repliesEl); }
      });

      card.addEventListener('click', function () { jumpTo(ann); setFocus(ann.id); });
      list.appendChild(card);
    });
  }

  function toggleResolve(ann, btn, card) {
    var newState = !ann.resolved;
    db.from('pindrop_annotations').update({ resolved: newState }).eq('id', ann.id).then(function (result) {
      if (result.error) { console.error('[Pindrop] Resolve failed:', result.error); return; }
      ann.resolved = newState;
      btn.textContent = newState ? '✓ Resolved' : '✓ Resolve';
      btn.classList.toggle('pd-resolved', newState);
      card.classList.toggle('pd-card-resolved', newState);
      if (newState) { card.classList.add('pd-collapsed'); clearFocus(); }
      else card.classList.remove('pd-collapsed');
      // Update pin opacity
      var pin = document.querySelector('.pd-pin[data-id="' + ann.id + '"]');
      if (pin) pin.style.opacity = newState ? '0.4' : '';
    });
  }

  function deleteAnnotation(ann, card) {
    db.from('pindrop_annotations').delete().eq('id', ann.id).then(function (result) {
      if (result.error) { console.error('[Pindrop] Delete failed:', result.error); return; }
      // Remove from arrays
      annotations = annotations.filter(function (a) { return a.id !== ann.id; });
      delete replies[ann.id];
      // Remove pin from DOM
      var pin = document.querySelector('.pd-pin[data-id="' + ann.id + '"]');
      if (pin) pin.remove();
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
    var y = resolveAnchor(ann).y;
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

  function isOurs(target) {
    if (!target || !target.closest) return false;
    return !!(
      target.closest('#pd-root')    ||
      target.closest('#pd-pop')     ||
      target.closest('#pd-sidebar') ||
      target.closest('.pd-pin')
    );
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ─── IDENTITY PROMPT ─────────────────────────────────────────────────────
  function buildIdentityPrompt() {
    if (adminUser) return;               // already signed in
    if (localStorage.getItem('pd_name')) return;  // already named / skipped

    var prompt = mkEl('div', { id: 'pd-name-prompt' });
    prompt.innerHTML = [
      '<h4>👋 Who are you?</h4>',
      '<p>Enter your email to tie feedback to your identity across devices.</p>',
      '<input id="pd-name-input" type="email" placeholder="your@email.com" autocomplete="email" />',
      '<button id="pd-name-go">Send magic link</button>',
      '<button id="pd-name-skip">Continue anonymously</button>',
    ].join('');
    document.body.appendChild(prompt);

    var input = document.getElementById('pd-name-input');
    var goBtn = document.getElementById('pd-name-go');

    goBtn.addEventListener('click', function () {
      var email = input.value.trim();
      if (!email) { input.focus(); return; }
      goBtn.disabled    = true;
      goBtn.textContent = 'Sending…';
      db.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
      }).then(function (result) {
        if (result.error) {
          goBtn.disabled    = false;
          goBtn.textContent = '❌ Try again';
        } else {
          goBtn.textContent   = '✓ Check your email!';
          input.style.display = 'none';
          document.getElementById('pd-name-skip').textContent = 'Close for now';
        }
      });
    });

    document.getElementById('pd-name-skip').addEventListener('click', function () {
      localStorage.setItem('pd_name', 'Anonymous');
      prompt.remove();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') goBtn.click();
    });

    setTimeout(function () { input.focus(); }, 100);
  }

  // ─── ELEMENT ANCHORING ────────────────────────────────────────────────────

  /**
   * Escape a string for use as a literal CSS identifier (class name or id)
   * inside a selector. Utility-CSS frameworks like Tailwind routinely put
   * characters that are meaningful in CSS selector syntax — `:` for variants
   * (`lg:flex-1`), `[...]` for arbitrary values (`leading-[1.02]`), `/` and
   * `.` for fractional/decimal values (`w-1/2`, `opacity-0.5`) — directly
   * into class names. Those are perfectly valid class *names*, but used
   * unescaped in a selector string they either change its meaning (`:` reads
   * as a pseudo-class) or make it outright invalid (`document.querySelector`
   * throws a SyntaxError). Previously getSelectorPath used class names as-is,
   * so any pin anchored on or under an element carrying one of these classes
   * produced a selector that threw every time it was resolved — permanently
   * falling back to raw pixel coordinates, not just after a resize.
   */
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1'); // defensive fallback for very old browsers
  }

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
        parts.unshift('#' + cssEscape(node.id));
        break;  // id is unique — stop here
      }
      // Build class segment (up to 2 stable classes)
      var classes = [];
      for (var i = 0; i < node.classList.length && classes.length < 2; i++) {
        var c = node.classList[i];
        if (!/^pd-/.test(c)) classes.push(cssEscape(c));
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
   * Given a stored annotation, return {x, y, resolved} in document coordinates.
   * Uses the element anchor when available; falls back to x_doc/y_doc.
   *
   * `resolved` is false when the anchor can't be trusted at the current
   * viewport — the anchored element is gone, or it (or an ancestor) is
   * collapsed to zero size, which happens when it's hidden by a responsive
   * breakpoint (e.g. a mobile-only or desktop-only block). Previously this
   * case fell through to a raw `rect.left`/`rect.top` of (0, 0), which
   * snapped the pin to the scroll origin instead of somewhere near the
   * content. Now we keep the last known document position and flag it as
   * approximate instead of asserting a wrong one.
   */
  function resolveAnchor(ann) {
    var fallback = { x: ann.x_doc || 0, y: ann.y_doc || 0, resolved: false };
    if (!ann.anchor || !ann.anchor.selector) return fallback;
    try {
      var el = document.querySelector(ann.anchor.selector);
      if (!el) return fallback;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return fallback;
      var cx = rect.left + ann.anchor.offset_x_pct * rect.width;
      var cy = rect.top  + ann.anchor.offset_y_pct * rect.height;
      return {
        x: cx + window.scrollX,
        y: cy + window.scrollY,
        resolved: true,
      };
    } catch (err) {
      return fallback;
    }
  }

  /**
   * Reposition all rendered pins using their element anchor. Called on
   * window resize, orientation change, and document-level reflow (see
   * setupResizeHandling) — not just literal window resizes, so pins also
   * catch up after content shifts without one (a lazy image finishing load,
   * a font swap, an accordion opening).
   */
  function repositionPins() {
    annotations.forEach(function (ann) {
      if (ann.type !== 'pin') return;
      var pin = document.querySelector('.pd-pin[data-id="' + ann.id + '"]');
      if (!pin) return;
      var pos = resolveAnchor(ann);
      pin.style.left = pos.x + 'px';
      pin.style.top  = pos.y + 'px';
      pin.classList.toggle('pd-pin-approx', !pos.resolved);
    });
  }

  // ─── ADMIN AUTH ───────────────────────────────────────────────────────────
  function setupAuth() {
    // Check for an existing session (covers magic link redirect on page load)
    db.auth.getSession().then(function (result) {
      var session = result.data && result.data.session;
      if (session && session.user) {
        adminUser = session.user;
        fetchProfile(adminUser.id);
      }
    });

    // React to sign-in / sign-out events
    db.auth.onAuthStateChange(function (event, session) {
      if (event === 'SIGNED_IN' && session && session.user) {
        adminUser = session.user;
        fetchProfile(adminUser.id);
        // Remove identity prompt if still showing
        var prompt = document.getElementById('pd-name-prompt');
        if (prompt) prompt.remove();
      } else if (event === 'SIGNED_OUT') {
        adminUser   = null;
        isAdminUser = false;
        updateAdminUI();
        renderSidebarList();
      }
    });
  }

  function fetchProfile(userId) {
    db.from('pindrop_profiles').select('*').eq('id', userId).single().then(function (result) {
      if (result.data) {
        isAdminUser = !!result.data.is_admin;
        if (result.data.display_name) {
          localStorage.setItem('pd_name', result.data.display_name);
          var popName = document.getElementById('pd-pop-name');
          if (popName) popName.value = result.data.display_name;
        }
      } else {
        // First sign-in — create profile with email prefix as display name
        isAdminUser = false;
        var displayName = adminUser.email ? adminUser.email.split('@')[0] : 'User';
        localStorage.setItem('pd_name', displayName);
        var popName = document.getElementById('pd-pop-name');
        if (popName) popName.value = displayName;
        db.from('pindrop_profiles').insert({ id: userId, display_name: displayName }).then(function () {});
      }
      updateAdminUI();
      renderSidebarList();
    });
  }

  function updateAdminUI() {
    var formEl   = document.getElementById('pd-admin-form');
    var activeEl = document.getElementById('pd-admin-active');
    var lblEl    = document.getElementById('pd-admin-email-label');
    if (!formEl || !activeEl) return;
    if (adminUser) {
      formEl.style.display   = 'none';
      activeEl.style.display = 'flex';
      if (lblEl) lblEl.textContent = (isAdminUser ? '👑 ' : '✓ ') + (adminUser.email || 'Signed in');
    } else {
      formEl.style.display   = 'flex';
      activeEl.style.display = 'none';
      var sendBtn = document.getElementById('pd-admin-send');
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '✉️ Send magic link'; }
    }
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
