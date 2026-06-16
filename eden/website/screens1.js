/* ============================================================
   Screens: overview · villagers · villager detail
   ============================================================ */
(function () {
  var API = window.EdenAPI, U = window.UI;
  window.Screens = window.Screens || {};

  function vitalsMini(v) {
    return '<div class="col" style="gap:4px">' + U.vitalsBar('hp', v.hp, v.hpMax) + U.vitalsBar('food', v.food, v.foodMax) + '</div>';
  }

  // ============ OVERVIEW ============
  Screens.overview = function (main) {
    Promise.all([API.getStatus(), API.getVillagers(), API.getJournal({ limit: 24, order: 'desc' })]).then(function (r) {
      var s = r[0], villagers = r[1], recent = r[2];

      main.innerHTML = '<div class="screen">' +
        '<div class="screen-head"><div class="screen-title">Overview</div>' +
          '<span class="route">GET /status</span><span class="route">WS /journal/stream</span><span class="route post">POST /pause · /resume</span></div>' +
        '<p class="screen-sub">Mission control. Bots up, anything running, paused state, and what just happened — at a glance.</p>' +

        '<div class="stats mb16" id="statTiles"></div>' +

        '<div class="row mb16" style="align-items:stretch">' +
          '<div class="card pad grow" style="display:flex;align-items:center;justify-content:space-between;gap:16px">' +
            '<div><div class="l muted">budget · today</div>' +
              '<div style="font-size:24px;font-weight:600" class="num">$<span id="bSpend">' + s.budgetSpend.toFixed(2) + '</span> <small class="faint" style="font-size:13px;font-weight:400">/ $' + s.budgetCap.toFixed(0) + ' cap</small></div></div>' +
            U.sparkline(s.budgetHistory, 'var(--d-llm)', 150, 40) +
          '</div>' +
          '<div class="card pad" style="display:flex;align-items:center;gap:14px;min-width:320px">' +
            '<button class="btn" id="ovPause"></button>' +
            '<div class="muted" style="font-size:12.5px">Gates LLM scheduling. Skills &amp; subscriptions keep running. The action shows up in the feed.</div>' +
          '</div>' +
        '</div>' +

        '<div class="row" style="align-items:flex-start">' +
          '<div class="grow" style="min-width:0">' +
            '<div class="row between center mb12"><h3 style="margin:0;font-size:14px;font-weight:600">Village at a glance</h3><span class="eyebrow">GET /villagers</span></div>' +
            '<div class="grid g3" id="glance"></div>' +
          '</div>' +
          '<div style="width:380px;flex:none">' +
            '<div class="card" style="overflow:hidden">' +
              '<div class="panel-h"><h3>Live activity</h3><span class="conn" style="font-size:11px"><span class="led"></span>tail</span>' +
                '<div class="spacer"></div></div>' +
              '<div style="padding:9px 12px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap" id="feedChips"></div>' +
              '<div class="feed" id="feed" style="max-height:440px;overflow-y:auto"></div>' +
            '</div>' +
            '<p class="muted" style="font-size:11.5px;margin-top:8px">Truthful: your pause / poke appears here as a journalled event, not just a toast.</p>' +
          '</div>' +
        '</div>' +
      '</div>';

      renderTiles(s);
      // glance
      document.getElementById('glance').innerHTML = villagers.map(function (v) {
        return '<a class="card pad" data-hash="#/villagers/' + v.name + '" href="#/villagers/' + v.name + '" style="display:block">' +
          '<div class="row between center mb8"><b>' + v.name + '</b>' + U.kindBadge(v.activityKind) + '</div>' +
          '<div class="muted" style="font-size:12px;margin-bottom:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
            (v.currentRun ? '▸ ' + v.currentRun : '▸ ' + v.role) + '</div>' +
          vitalsMini(v.vitals) + '</a>';
      }).join('');

      // pause buttons
      function paintPause(paused) {
        var label = paused ? '<span class="ic">▶</span> Resume village' : '<span class="ic">⏸</span> Pause village';
        var b = document.getElementById('ovPause'); b.innerHTML = label; b.classList.toggle('primary', !paused); b.classList.toggle('danger', paused);
      }
      paintPause(s.paused);
      document.getElementById('ovPause').addEventListener('click', function () {
        API.getStatus().then(function (st) {
          (st.paused ? API.resume() : API.pause()).then(function () { paintPause(!st.paused); Eden.refreshHeader(); refreshTiles(); });
        });
      });

      // feed
      setupFeed(recent);

      // poll tiles + budget
      var poll = setInterval(refreshTiles, 4000);
      Eden.onCleanup(function () { clearInterval(poll); });
      function refreshTiles() { API.getStatus().then(function (st) { renderTiles(st); document.getElementById('bSpend').textContent = st.budgetSpend.toFixed(2); }); }
    });

    function renderTiles(s) {
      // Tile captions are neutral descriptors or derived from the live status — never a fabricated breakdown.
      var offline = (s.totalBots || 0) - (s.botsConnected || 0);
      document.getElementById('statTiles').innerHTML =
        tile('bots connected', '<span class="num">' + s.botsConnected + '</span><small>/' + s.totalBots + '</small>', offline > 0 ? offline + ' not connected' : 'all connected') +
        tile('current runs', '<span class="num">' + s.currentRuns + '</span>', 'skill trees running') +
        tile('LLM queue', '<span class="num">' + s.queueDepth + '</span>', 'scheduler queue') +
        '<div class="card stat"><div class="l">system state</div><div style="margin-top:8px">' + (s.paused ? U.statusBadge('probation', 'paused') : U.statusBadge('active', 'running')) + '</div><div class="m">' + (s.paused ? 'LLM gated' : 'not paused') + '</div></div>' +
        tile('uptime', '<span class="num" style="font-size:20px">' + Math.floor(s.uptime / 3600) + 'h ' + Math.floor((s.uptime % 3600) / 60) + 'm</span>', 'since boot');
    }
    function tile(l, v, m) { return '<div class="card stat"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="m">' + m + '</div></div>'; }

    function setupFeed(initial) {
      var DOMAINS = ['skill', 'god', 'social', 'brain', 'llm', 'system'];
      var active = { skill: 1, god: 1, social: 1, brain: 1, llm: 1, system: 1, world: 0, reactivity: 0 };
      var feed = document.getElementById('feed');
      var chips = document.getElementById('feedChips');
      function paintChips() {
        var html = DOMAINS.map(function (d) { return '<span class="chip ' + U.DOMAIN_CLASS[d] + (active[d] ? ' on' : '') + '" data-d="' + d + '"><span class="pip"></span>' + d + '</span>'; }).join('');
        html += '<span class="chip k-world' + (active.world ? ' on' : '') + '" data-d="world">+ vitals</span>';
        html += '<span class="chip k-react' + (active.reactivity ? ' on' : '') + '" data-d="reactivity">+ subs</span>';
        chips.innerHTML = html;
      }
      paintChips();
      chips.addEventListener('click', function (e) { var c = e.target.closest('[data-d]'); if (!c) return; var d = c.getAttribute('data-d'); active[d] = active[d] ? 0 : 1; paintChips(); repaint(); });

      var buffer = initial.slice();
      function visible() { return buffer.filter(function (ev) { return active[API.domainOf(ev.kind)]; }).slice(0, 50); }
      function repaint() { feed.innerHTML = visible().map(function (ev) { return U.eventRow(ev); }).join('') || '<div class="empty">no events for these kinds</div>'; }
      repaint();

      Eden.subscribeStream([], function (ev) {
        buffer.unshift(ev); if (buffer.length > 120) buffer.pop();
        if (active[API.domainOf(ev.kind)]) {
          var div = document.createElement('div'); div.innerHTML = U.eventRow(ev, { flash: true });
          feed.insertBefore(div.firstChild, feed.firstChild);
          while (feed.children.length > 50) feed.removeChild(feed.lastChild);
        }
      });
      feed.addEventListener('click', function (e) { var r = e.target.closest('[data-evid]'); if (r) Eden.go('#/journal'); });
    }
  };

  // ============ VILLAGERS ROSTER ============
  Screens.villagers = function (main, params) {
    if (params && params[0]) return Screens._villagerDetail(main, params[0]);
    API.getVillagers().then(function (vs) {
      main.innerHTML = '<div class="screen">' +
        '<div class="screen-head"><div class="screen-title">Villagers</div><span class="route">GET /villagers</span></div>' +
        '<p class="screen-sub">The villager bots. Each card shows current activity and live vitals; click through to detail.</p>' +
        '<div class="row wrap gap8 mb16" id="vfilter">' +
          '<span class="chip on" data-f="all">all</span><span class="chip" data-f="run">running a skill</span>' +
          '<span class="chip" data-f="social">in conversation</span><span class="chip" data-f="low">low vitals</span></div>' +
        '<div class="grid g3" id="roster"></div></div>';
      var roster = document.getElementById('roster');
      function paint(filter) {
        var list = vs.filter(function (v) {
          if (filter === 'run') return !!v.currentRun;
          if (filter === 'social') return API.domainOf(v.activityKind) === 'social';
          if (filter === 'low') return v.vitals.hp / v.vitals.hpMax < 0.5 || v.vitals.food / v.vitals.foodMax < 0.5;
          return true;
        });
        roster.innerHTML = list.map(function (v) {
          return '<a class="card pad" data-hash="#/villagers/' + v.name + '" href="#/villagers/' + v.name + '" style="display:block">' +
            '<div class="row between center mb8"><div><div style="font-weight:600;font-size:15px">' + v.name + '</div><div class="id">villager:' + v.name + '</div></div>' + U.kindBadge(v.activityKind) + '</div>' +
            '<div class="muted" style="font-size:12px;margin-bottom:10px">' + U.esc(v.role) + (v.currentRun ? ' · <span class="mono">' + v.currentRun + '</span>' : '') + '</div>' +
            vitalsMini(v.vitals) +
            '<div class="row between mt10" style="font-size:11px"><span class="faint mono">inbox ' + v.inbox + '</span><span class="faint mono">subs ' + v.subscriptions.length + '</span><span class="faint mono">(' + v.vitals.pos.join(', ') + ')</span></div>' +
          '</a>';
        }).join('');
      }
      paint('all');
      document.getElementById('vfilter').addEventListener('click', function (e) {
        var c = e.target.closest('[data-f]'); if (!c) return;
        document.querySelectorAll('#vfilter .chip').forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on');
        paint(c.getAttribute('data-f'));
      });
    });
  };

  // ============ VILLAGER DETAIL ============
  Screens._villagerDetail = function (main, name) {
    Promise.all([API.getVillager(name), API.getJournal({ actor: 'villager:' + name, limit: 14, order: 'desc' })]).then(function (r) {
      var v = r[0], mem = r[1];
      if (!v) { main.innerHTML = '<div class="screen"><div class="empty">No villager “' + U.esc(name) + '”</div></div>'; return; }

      main.innerHTML = '<div class="screen">' +
        '<div class="crumb"><a data-hash="#/villagers" href="#/villagers">← villagers</a><span>/</span><span class="id">villager:' + v.name + '</span></div>' +
        '<div class="screen-head"><div class="screen-title">' + v.name + '</div>' + U.kindBadge(v.activityKind) +
          '<span class="route">GET /villagers/:name</span><span class="route post">POST /villagers/:name/prompt</span></div>' +
        '<p class="screen-sub">' + U.esc(v.role) + ' — ' + U.esc(v.persona) + '</p>' +

        '<div class="detail">' +
          '<div class="stack">' +

            '<div class="card"><div class="panel-h"><h3>Vitals</h3><span class="sub">vitals</span></div>' +
              '<div class="pad gauto" style="gap:18px">' +
                '<div class="col" style="gap:11px">' + U.vitalsBar('hp', v.vitals.hp, v.vitals.hpMax) + U.vitalsBar('food', v.vitals.food, v.vitals.foodMax) + '</div>' +
                '<div class="col" style="gap:9px;font-size:12.5px">' +
                  '<div class="row between" style="gap:12px"><span class="faint">position</span><span class="mono">' + v.vitals.pos.join(', ') + '</span></div>' +
                  '<div class="row between" style="gap:12px"><span class="faint">held</span><span class="mono">' + U.esc(v.vitals.held) + '</span></div>' +
                  '<div class="row between" style="gap:12px"><span class="faint">inbox</span><span class="mono">' + v.inbox + '</span></div>' +
                  '<div class="row between" style="gap:12px"><span class="faint">subscriptions</span><span class="mono">' + v.subscriptions.length + '</span></div>' +
                '</div>' +
              '</div></div>' +

            '<div class="card"><div class="panel-h"><h3>Current run</h3></div><div class="pad">' +
              // The villager payload carries the running skill name, not a rollout id — so no rollout link is fabricated.
              (v.currentRun ? '<div><div class="mono" style="font-size:14px">' + U.esc(v.currentRun) + '</div><div class="muted" style="font-size:12px;margin-top:4px">in progress</div></div>' : '<div class="muted" style="font-size:13px">idle — no skill running</div>') +
            '</div></div>' +

            '<div class="card"><div class="panel-h"><h3>Subscriptions</h3><span class="sub">reflexes · "when X do Y"</span></div><div class="pad col" style="gap:11px">' +
              v.subscriptions.map(function (s) { return '<div class="row center gap8" style="font-size:12.5px">' + U.kindBadge('subscription.fired') + '<span class="mono">when ' + U.esc(s.when) + ' → ' + U.esc(s.then) + '</span><span class="faint" style="margin-left:auto;font-size:11px;white-space:nowrap">' + (s.state === 'suppressed' ? 'suppressed' : 'fired ' + s.fired + '×') + '</span></div>'; }).join('') +
            '</div></div>' +

            '<div class="gauto">' +
              '<div class="card"><div class="panel-h"><h3>Relations</h3></div><div class="pad col" style="gap:10px">' +
                v.relations.map(function (rl) { var like = rl.score >= 0; return '<div class="row between center" style="gap:10px;font-size:13px"><span>' + rl.name + '</span>' + U.statusBadge(like ? 'success' : 'fail', (like ? 'likes +' : 'dislikes ') + rl.score) + '</div>'; }).join('') +
              '</div></div>' +
              '<div class="card"><div class="panel-h"><h3>Dossier · competence</h3></div><div class="pad col" style="gap:10px">' +
                Object.keys(v.dossier.competence).map(function (k) { var val = v.dossier.competence[k]; return '<div class="row center gap8" style="font-size:12px"><span class="mono" style="width:74px;flex:none">' + k + '</span><span class="bar"><span style="width:' + (val * 100) + '%;background:var(--accent)"></span></span></div>'; }).join('') +
                '<div class="muted" style="font-size:12px;margin-top:4px">“' + U.esc(v.dossier.note) + '”</div>' +
              '</div></div>' +
            '</div>' +
          '</div>' +

          '<div class="stack">' +
            '<div class="card"><div class="panel-h"><h3>Talk to villager</h3><span class="sub">inbox ' + v.inbox + '</span></div><div class="pad">' +
              '<textarea class="field" id="tellText" rows="3" placeholder="Tell ' + v.name + ' something… (e.g. “store your timber, then eat”)"></textarea>' +
              '<div class="row between center mt14"><span class="faint mono" style="font-size:11px">from: admin</span><button class="btn primary" id="tellBtn">Send tell →</button></div>' +
              '<hr class="sep"><p class="muted" style="font-size:11.5px;margin:0">The tell is journalled, lands in the inbox, and the <span class="badge kind k-social"><span class="pip"></span>inbox.delivered</span> event arrives live below.</p>' +
            '</div></div>' +
            '<div class="card" style="overflow:hidden"><div class="panel-h"><h3>Recent memory</h3><span class="conn" style="font-size:11px"><span class="led"></span></span></div>' +
              '<div style="padding:8px 16px 0;font-family:var(--mono);font-size:10px;color:var(--text-faint)">actor:villager:' + v.name + '</div>' +
              '<div class="feed" id="memFeed" style="max-height:320px;overflow-y:auto;margin-top:6px"></div></div>' +
          '</div>' +
        '</div>' +
      '</div>';

      var memFeed = document.getElementById('memFeed');
      function paintMem(list) { memFeed.innerHTML = list.map(function (ev) { return U.eventRow(ev); }).join('') || '<div class="empty">no memory yet</div>'; }
      paintMem(mem);

      Eden.subscribeStream([], function (ev) {
        if (ev.actor !== 'villager:' + name && !(ev.kind === 'inbox.delivered' && ev.payload.to === name)) return;
        var div = document.createElement('div'); div.innerHTML = U.eventRow(ev, { flash: true });
        memFeed.insertBefore(div.firstChild, memFeed.firstChild);
        while (memFeed.children.length > 30) memFeed.removeChild(memFeed.lastChild);
      });

      document.getElementById('tellBtn').addEventListener('click', function () {
        var t = document.getElementById('tellText');
        var text = t.value.trim(); if (!text) { t.focus(); return; }
        API.prompt(name, text, 'admin').then(function (res) {
          t.value = ''; U.toast('Tell delivered to ' + name, 'POST /villagers/' + name + '/prompt');
        });
      });
      document.getElementById('memFeed').addEventListener('click', function (e) { if (e.target.closest('[data-evid]')) Eden.go('#/journal/r/villager:' + name); });
    });
  };
})();
