/* ============================================================
   Eden admin API client — the ONE data source for the dashboard.

   It exposes the `window.EdenAPI` surface every screen calls, with
   every method backed by the live Eden admin server (05) over
   same-origin HTTP + a WebSocket journal stream. No build step — a
   plain IIFE.

   Served by the admin server itself (AdminServer `webRoot`), so all
   requests are relative (`/status`, `/journal`, …) and need no CORS.

   Shape bridging (the admin API is the contract; this is presentation):
   - list routes are envelope-wrapped server-side ({villagers:[…]}) —
     unwrapped here to the bare arrays the screens expect.
   - the journal `kinds` filter is exact-match; the screens facet by
     DOMAIN, so domain names are expanded to concrete kinds here.
   - `domainOf` / `KINDS` are derived from the canonical registry
     (some kinds are bare — `vitals`, `inbox.delivered` — so a prefix
     split alone would mis-domain them; a table fixes that).
   ============================================================ */
(function () {
  // ── kind → domain registry (mirrors eden/src/journal/kinds.ts) ──────────────
  var KIND_DOMAINS = {
    system: ['system.boot', 'system.config-warning', 'system.bot-connected', 'system.bot-disconnected', 'system.error', 'system.loop-lag'],
    world: ['vitals', 'world.death'],
    skill: ['skill.draft', 'skill.admit', 'skill.quarantine', 'skill.archive', 'skill.run', 'skill.log'],
    llm: ['llm.call'],
    brain: ['brain.wakeup', 'brain.tool-call', 'brain.done'],
    god: ['god.ticket', 'god.verdict', 'god.appearance', 'god.rollout-abandoned', 'god.task-proposed', 'god.task-closed', 'god.directive', 'god.directive-closed'],
    social: ['inbox.delivered', 'chat.said', 'chat.heard', 'conversation.started', 'conversation.turn', 'conversation.ended', 'trade.proposed', 'trade.settled', 'trade.failed'],
    reactivity: ['subscription.created', 'subscription.removed', 'subscription.fired', 'subscription.suppressed']
  };
  var DOMAIN_OF = {};
  var KINDS = [];
  Object.keys(KIND_DOMAINS).forEach(function (dom) {
    KIND_DOMAINS[dom].forEach(function (k) { DOMAIN_OF[k] = dom; KINDS.push({ kind: k, domain: dom }); });
  });
  function domainOf(kind) { return DOMAIN_OF[kind] || (String(kind).split('.')[0]) || 'unknown'; }

  // Expand the screens' DOMAIN facets into the concrete kinds the exact-match server filter wants.
  function expandKinds(list) {
    var out = {};
    list.forEach(function (d) {
      if (KIND_DOMAINS[d]) KIND_DOMAINS[d].forEach(function (k) { out[k] = 1; });
      else out[d] = 1; // already a concrete kind
    });
    return Object.keys(out);
  }

  // ── HTTP helpers (relative, same-origin) ────────────────────────────────────
  function get(path) {
    return fetch(path, { headers: { accept: 'application/json' } }).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; },
        function () { return { status: res.status, body: null }; });
    });
  }
  function post(path, body) {
    var opts = { method: 'POST' };
    if (body !== undefined) { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (res) { return res.json().catch(function () { return {}; }); });
  }
  function enc(s) { return encodeURIComponent(String(s)); }

  // Best-effort merge of any server-registered kinds we don't know about (future-proofing the badges).
  get('/kinds').then(function (r) {
    var list = (r.body && r.body.kinds) || [];
    list.forEach(function (k) {
      if (k && k.kind && !DOMAIN_OF[k.kind]) { var d = String(k.kind).split('.')[0]; DOMAIN_OF[k.kind] = d; KINDS.push({ kind: k.kind, domain: d }); }
    });
  }).catch(function () { /* dashboard still works on the seeded table */ });

  // ── WebSocket journal stream (live tail) ────────────────────────────────────
  var WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/journal/stream';
  var ws = null, desired = true, openState = false, backoff = 500;
  var subs = [], stateCbs = [];

  function matches(filter, kind) {
    if (!filter || !filter.length) return true;
    return filter.some(function (f) {
      if (f.indexOf('.') === -1) return domainOf(kind) === f; // a domain facet
      if (f.charAt(f.length - 1) === '*') return kind.indexOf(f.slice(0, -1)) === 0;
      return kind === f; // an exact kind
    });
  }
  function notifyState(c) { openState = c; stateCbs.forEach(function (cb) { try { cb(c); } catch (e) { /* */ } }); }
  function dispatch(ev) { subs.forEach(function (s) { if (matches(s.kinds, ev.kind)) { try { s.cb(ev); } catch (e) { /* */ } } }); }
  function scheduleReconnect() {
    var wait = backoff; backoff = Math.min(backoff * 2, 8000);
    setTimeout(function () { if (desired && !openState) connect(); }, wait);
  }
  function connect() {
    if (!desired) return;
    try { ws = new WebSocket(WS_URL); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = function () { backoff = 500; notifyState(true); };
    ws.onmessage = function (m) { var ev; try { ev = JSON.parse(m.data); } catch (e) { return; } dispatch(ev); };
    ws.onclose = function () { ws = null; notifyState(false); if (desired) scheduleReconnect(); };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* */ } };
  }
  connect();

  var stream = {
    subscribe: function (kinds, cb) {
      var s = { kinds: kinds || [], cb: cb };
      subs.push(s);
      return function () { subs = subs.filter(function (x) { return x !== s; }); };
    },
    isConnected: function () { return openState; },
    setConnected: function (c) {
      desired = c;
      if (c) { if (!ws) connect(); }
      else if (ws) { var w = ws; ws = null; w.onclose = null; try { w.close(); } catch (e) { /* */ } notifyState(false); }
    },
    onState: function (cb) {
      stateCbs.push(cb);
      return function () { stateCbs = stateCbs.filter(function (x) { return x !== cb; }); };
    }
  };

  // ── public API (the EdenAPI surface every screen consumes) ──────────────────
  window.EdenAPI = {
    KINDS: KINDS,
    domainOf: domainOf,

    getStatus: function () { return get('/status').then(function (r) { return r.body || {}; }); },
    getVillagers: function () { return get('/villagers').then(function (r) { return (r.body && r.body.villagers) || []; }); },
    getVillager: function (name) { return get('/villagers/' + enc(name)).then(function (r) { return r.status === 200 ? r.body : null; }); },
    getSkills: function () { return get('/skills').then(function (r) { return (r.body && r.body.skills) || []; }); },
    getSkill: function (name, opts) {
      opts = opts || {};
      var qs = [];
      if (opts.code) qs.push('code=1');
      if (opts.version) qs.push('version=' + enc(opts.version));
      return get('/skills/' + enc(name) + (qs.length ? '?' + qs.join('&') : '')).then(function (r) { return r.status === 200 ? r.body : null; });
    },
    getLlmTranscript: function (callId) { return get('/llm/' + enc(callId)).then(function (r) { return r.status === 200 ? r.body : null; }); },
    getTasks: function () { return get('/tasks').then(function (r) { return r.body || { open: [], completed: [], failed: [] }; }); },
    getVerdicts: function () { return get('/verdicts').then(function (r) { return (r.body && r.body.verdicts) || []; }); },
    getDirectives: function () { return get('/directives').then(function (r) { return (r.body && r.body.directives) || []; }); },
    getRollouts: function () { return get('/rollouts').then(function (r) { return (r.body && r.body.rollouts) || []; }); },
    getKinds: function () { return Promise.resolve(KINDS); },

    getJournal: function (q) {
      q = q || {};
      var params = [];
      if (q.kinds && q.kinds.length) {
        var expanded = expandKinds(q.kinds);
        if (!expanded.length) return Promise.resolve([]); // an explicit, non-matching filter
        if (expanded.length < KINDS.length) params.push('kinds=' + enc(expanded.join(','))); // else: all kinds ⇒ no filter
      }
      if (q.actor) params.push('actor=' + enc(q.actor));
      if (q.ref) params.push('ref=' + enc(q.ref));
      if (q.since) params.push('since=' + q.since);
      if (q.until) params.push('until=' + q.until);
      if (q.limit) params.push('limit=' + q.limit);
      if (q.order) params.push('order=' + q.order);
      return get('/journal' + (params.length ? '?' + params.join('&') : '')).then(function (r) { return (r.body && r.body.events) || []; });
    },

    // POST verbs — the server journals each BEFORE acting, so they surface in the live feed.
    pause: function () { return post('/pause'); },
    resume: function () { return post('/resume'); },
    quarantine: function (name, reason) { return post('/skills/' + enc(name) + '/quarantine', { reason: reason }); },
    prompt: function (name, text, from) { return post('/villagers/' + enc(name) + '/prompt', { text: text, from: from || 'admin' }); },

    stream: stream
  };
})();
