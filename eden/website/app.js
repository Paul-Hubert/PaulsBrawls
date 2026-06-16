/* ============================================================
   Eden app — shell, hash router, header controls, live plumbing.
   Screens register themselves on window.Screens[name].
   ============================================================ */
(function () {
  var API = window.EdenAPI;

  var NAV = [
    { group: 'Mission control' },
    { hash: '#/overview', ico: '◉', label: 'Overview' },
    { group: 'Entities' },
    { hash: '#/villagers', ico: '☺', label: 'Villagers', countOf: 'villagers' },
    { hash: '#/skills', ico: '▤', label: 'Skill library', countOf: 'skills' },
    { hash: '#/curriculum', ico: '☰', label: 'Curriculum & tasks' },
    { hash: '#/verdicts', ico: '⚖', label: 'Verdicts & directives' },
    { group: 'Debug' },
    { hash: '#/rollouts', ico: '↻', label: 'Rollouts' },
    { hash: '#/journal', ico: '≡', label: 'Journal explorer' }
  ];

  // ---------- shell ----------
  function buildShell() {
    document.body.innerHTML =
      '<div class="app">' +
        '<div class="brandcell"><span class="logo"><span class="mark"></span>Eden</span><span class="brandtag">obs</span></div>' +
        '<header class="topbar">' +
          '<div class="cmd" id="cmd"><span class="mono">⌕</span>' +
            '<input id="cmdInput" placeholder="Jump to id, villager, skill, rollout…" autocomplete="off" spellcheck="false"/>' +
            '<span class="kbd">⏎</span></div>' +
          '<div class="spacer"></div>' +
          '<button class="iconbtn" id="connBtn" title="Toggle /journal/stream WebSocket">⇅</button>' +
          '<div class="conn" id="conn" title="WebSocket /journal/stream"><span class="led"></span><span id="connTxt">connecting…</span></div>' +
          '<button class="pausebtn" id="pauseBtn" title="POST /pause · /resume"><span class="ic">⏸</span><span id="pauseTxt">running</span></button>' +
          '<button class="iconbtn" id="themeBtn" title="Toggle light / dark">◐</button>' +
        '</header>' +
        '<nav class="sidebar" id="sidebar"></nav>' +
        '<main class="main" id="main"></main>' +
      '</div>';

    var side = document.getElementById('sidebar');
    var html = '';
    NAV.forEach(function (n) {
      if (n.group) { html += '<div class="navgroup">' + n.group + '</div>'; return; }
      html += '<a class="navlink" data-hash="' + n.hash + '" href="' + n.hash + '">' +
        '<span class="ico">' + n.ico + '</span><span>' + n.label + '</span>' +
        // Counts are populated at runtime from real API calls (refreshNavCounts) — never a hardcoded literal.
        (n.countOf ? '<span class="count" data-count-of="' + n.countOf + '"></span>' : '') + '</a>';
    });
    html += '<div class="sidefoot">live admin API · :8770<br>localhost · single operator<br>journal-backed · real data</div>';
    side.innerHTML = html;

    wireHeader();
    refreshNavCounts();
  }

  // Sidebar entity counts come straight from the list endpoints — no fabricated totals.
  function refreshNavCounts() {
    API.getVillagers().then(function (vs) { setNavCount('villagers', vs.length); });
    API.getSkills().then(function (sk) { setNavCount('skills', sk.length); });
  }
  function setNavCount(of, n) {
    var el = document.querySelector('.count[data-count-of="' + of + '"]');
    if (el) el.textContent = n;
  }

  function wireHeader() {
    var pauseBtn = document.getElementById('pauseBtn');
    pauseBtn.addEventListener('click', function () {
      API.getStatus().then(function (s) {
        var p = s.paused ? API.resume() : API.pause();
        p.then(function () { refreshHeader(); UI.toast(s.paused ? 'Resumed — LLM scheduling on' : 'Paused — LLM scheduling gated', 'POST /' + (s.paused ? 'resume' : 'pause')); });
      });
    });
    document.getElementById('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      document.documentElement.setAttribute('data-theme', cur === 'light' ? 'dark' : 'light');
    });
    var connBtn = document.getElementById('connBtn');
    connBtn.addEventListener('click', function () {
      var c = !API.stream.isConnected();
      API.stream.setConnected(c);
      updateConn();
      UI.toast(c ? 'Reconnected to /journal/stream' : 'Disconnected — feed frozen', c ? 'live' : 'stale');
    });

    var input = document.getElementById('cmdInput');
    var cmd = document.getElementById('cmd');
    input.addEventListener('focus', function () { cmd.classList.add('focus'); });
    input.addEventListener('blur', function () { cmd.classList.remove('focus'); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { resolveCommand(input.value.trim()); input.value = ''; input.blur(); }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); }
    });
  }

  function resolveCommand(q) {
    if (!q) return;
    var lower = q.toLowerCase();
    return API.getVillagers().then(function (vs) {
      var v = vs.find(function (x) { return x.name.toLowerCase() === lower; });
      if (v) { go('#/villagers/' + v.name); return; }
      return API.getSkills().then(function (sk) {
        var s = sk.find(function (x) { return x.name.toLowerCase() === lower || x.name.toLowerCase().indexOf(lower) === 0; });
        if (s) { go('#/skills/' + s.name); return; }
        if (/^ro_/i.test(q)) { go('#/rollout/' + q); return; }
        // fall back: pivot journal on the id as a ref  (API gap: no /resolve endpoint)
        go('#/journal/r/' + q);
        UI.toast('No exact match — pivoting journal on ref', 'API gap: GET /resolve/:id');
      });
    });
  }

  // ---------- connection indicator ----------
  function updateConn() {
    var c = API.stream.isConnected();
    var conn = document.getElementById('conn');
    conn.classList.toggle('stale', !c);
    document.getElementById('connBtn').textContent = c ? '⇅' : '⤫';
    if (!c) document.getElementById('connTxt').textContent = 'stale · reconnect';
    else refreshHeader();
  }
  function refreshHeader() {
    API.getStatus().then(function (s) {
      var paused = s.paused;
      document.getElementById('pauseBtn').classList.toggle('paused', paused);
      document.getElementById('pauseTxt').textContent = paused ? 'paused' : 'running';
      document.getElementById('pauseBtn').querySelector('.ic').textContent = paused ? '▶' : '⏸';
      if (API.stream.isConnected()) document.getElementById('connTxt').textContent = 'live · ' + s.botsConnected + '/' + s.totalBots;
    });
  }

  // ---------- router ----------
  var cleanups = [];
  function runCleanups() { cleanups.forEach(function (f) { try { f(); } catch (e) {} }); cleanups = []; }
  function go(hash) { if (location.hash === hash) { route(); } else { location.hash = hash; } }

  function route() {
    runCleanups();
    var raw = (location.hash || '#/overview').replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean);
    var name = parts[0] || 'overview';
    var params = parts.slice(1);
    var main = document.getElementById('main');
    main.scrollTop = 0;

    // active nav
    document.querySelectorAll('.navlink').forEach(function (a) {
      var h = a.getAttribute('data-hash').replace(/^#\/?/, '').split('/')[0];
      a.classList.toggle('active', h === name);
    });

    var fn = (window.Screens || {})[name];
    if (!fn) { main.innerHTML = '<div class="screen"><div class="empty">Unknown route: ' + UI.esc(name) + '</div></div>'; return; }
    main.innerHTML = '<div class="screen">' + UI.spinner() + '</div>';
    fn(main, params);
  }

  // ---------- global click delegation ----------
  document.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-hash]');
    if (nav && nav.tagName === 'A') { e.preventDefault(); go(nav.getAttribute('data-hash')); return; }
    var navEl = e.target.closest('[data-go]');
    if (navEl) { e.preventDefault(); go(navEl.getAttribute('data-go')); return; }
    var refEl = e.target.closest('[data-ref]');
    if (refEl) { e.preventDefault(); go('#/journal/r/' + refEl.getAttribute('data-ref')); return; }
  });

  // ---------- public API for screens ----------
  window.Eden = {
    go: go,
    onCleanup: function (fn) { cleanups.push(fn); },
    subscribeStream: function (kinds, cb) {
      var unsub = API.stream.subscribe(kinds, cb);
      cleanups.push(unsub);
      return unsub;
    },
    refreshHeader: refreshHeader,
    isConnected: function () { return API.stream.isConnected(); }
  };

  // ---------- boot ----------
  buildShell();
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/overview';
  route();
  refreshHeader();
  // header connection: keep bots count fresh
  setInterval(function () { if (API.stream.isConnected()) refreshHeader(); }, 5000);
})();
