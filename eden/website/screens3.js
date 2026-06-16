/* ============================================================
   Screens: curriculum · verdicts & directives · journal explorer
   ============================================================ */
(function () {
  var API = window.EdenAPI, U = window.UI;
  window.Screens = window.Screens || {};

  // ============ CURRICULUM ============
  Screens.curriculum = function (main) {
    API.getTasks().then(function (t) {
      function card(task, kind) {
        var badge = kind === 'open' ? U.statusBadge('probation', 'prio ' + task.priority) : kind === 'completed' ? U.statusBadge('success', 'done') : U.statusBadge('fail', 'failed');
        var link = task.rolloutId ? '<span class="refp" data-hash="#/rollout/' + task.rolloutId + '">rollout ' + task.rolloutId + ' ↗</span>' : '<span class="faint mono" style="font-size:11px">no rollout yet</span>';
        return '<div class="card pad"><div class="row between center mb8"><b style="font-size:13.5px">' + U.esc(task.title) + '</b>' + badge + '</div>' +
          '<div class="muted" style="font-size:12px;margin-bottom:8px">→ ' + U.esc(task.to) + ' · ' + U.esc(task.reason) + (task.result ? '<br><span class="faint">' + U.esc(task.result) + '</span>' : '') + '</div>' + link + '</div>';
      }
      function colHtml(title, list, kind, stColor, stLabel) {
        return '<div class="col" style="gap:12px"><div class="row between center"><h3 style="margin:0;font-size:14px;font-weight:600">' + title + '</h3>' + U.statusBadge(stColor, String(list.length)) + '</div>' +
          (list.length ? list.map(function (x) { return card(x, kind); }).join('') : '<div class="empty">none</div>') + '</div>';
      }
      main.innerHTML = '<div class="screen">' +
        '<div class="screen-head"><div class="screen-title">Curriculum &amp; tasks</div><span class="route">GET /tasks</span></div>' +
        '<p class="screen-sub">The curriculum ledger — what God’s orchestrator has set the village to learn. Each task links to the rollout(s) that pursued it.</p>' +
        '<div class="grid g3" style="align-items:start">' +
          colHtml('Open', t.open, 'open', 'probation') +
          colHtml('Completed', t.completed, 'completed', 'success') +
          colHtml('Failed', t.failed, 'failed', 'fail') +
        '</div></div>';
    });
  };

  // ============ VERDICTS & DIRECTIVES ============
  Screens.verdicts = function (main) {
    Promise.all([API.getVerdicts(), API.getDirectives()]).then(function (r) {
      var verdicts = r[0], directives = r[1];
      main.innerHTML = '<div class="screen">' +
        '<div class="screen-head"><div class="screen-title">Verdicts &amp; directives</div><span class="route">GET /verdicts</span><span class="route">GET /directives</span></div>' +
        '<p class="screen-sub">God’s outputs. The critic’s verdict stream on the left; the orchestrator’s open directives on the right. Read-heavy — no writes here.</p>' +
        '<div class="row" style="align-items:flex-start">' +
          '<div class="grow" style="min-width:0"><div class="row between center mb12"><h3 style="margin:0;font-size:14px;font-weight:600">Critic verdicts</h3><span class="conn" style="font-size:11px"><span class="led"></span>live</span></div>' +
            '<div class="col" id="vlist"></div></div>' +
          '<div style="width:340px;flex:none"><h3 style="margin:0 0 12px;font-size:14px;font-weight:600">Open directives</h3><div class="col" id="dlist"></div></div>' +
        '</div></div>';

      document.getElementById('vlist').innerHTML = verdicts.map(function (v) {
        var col = v.success ? (v.action === 'admit' ? 'var(--s-success)' : 'var(--s-probation)') : 'var(--s-fail)';
        return '<div class="card pad" style="border-color:color-mix(in srgb,' + col + ' 35%,var(--border))">' +
          '<div class="row between center"><div class="row center gap8">' + U.kindBadge('god.verdict') + '<span class="mono" style="font-size:12px">' + v.skill + ' ' + v.version + '</span></div><span class="faint mono" style="font-size:11px">' + U.relTime(v.at) + ' ago</span></div>' +
          '<div class="row center gap8 mt8">' + U.statusBadge(v.success ? 'success' : 'fail', v.success ? 'success' : 'fail') + '<b class="mono">' + v.score.toFixed(2) + '</b>' +
            '<span class="bar" style="max-width:180px"><span style="width:' + (v.score * 100) + '%;background:' + col + '"></span></span>' +
            '<span class="badge soft" style="font-size:10px">action: ' + v.action + '</span></div>' +
          '<div class="muted" style="font-size:12.5px;margin-top:8px">“' + U.esc(v.critique) + '” <span class="refp" data-hash="#/rollout/' + v.rolloutId + '">rollout ↗</span></div></div>';
      }).join('');

      document.getElementById('dlist').innerHTML = directives.map(function (d) {
        return '<div class="card pad"><div class="row between center"><b style="font-size:13.5px">→ ' + U.esc(d.to) + '</b>' + U.statusBadge(d.priority === 'high' ? 'probation' : 'draft', 'prio ' + d.priority) + '</div>' +
          '<div style="font-size:13px;margin:7px 0 7px">' + U.esc(d.goal) + '</div>' +
          '<div class="row between" style="font-size:11.5px"><span class="faint">reason: ' + U.esc(d.reason) + '</span><span class="faint mono">expiry: ' + U.esc(d.expiry) + '</span></div>' +
          '<div class="mt8">' + (d.standing ? U.statusBadge('active', 'standing') : '<span class="badge soft" style="font-size:10px">one-shot</span>') + '</div></div>';
      }).join('');
    });
  };

  // ============ JOURNAL EXPLORER ============
  Screens.journal = function (main, params) {
    var initRef = (params[0] === 'r' && params[1]) ? decodeURIComponent(params[1]) : null;
    var state = { domains: { system: 1, skill: 1, god: 1, brain: 1, llm: 1, social: 0, world: 0, reactivity: 0 }, actor: '', ref: initRef || '', since: 0, limit: 200, live: true };
    var DOMAINS = ['system', 'skill', 'god', 'brain', 'llm', 'social', 'world', 'reactivity'];

    Promise.all([API.getKinds(), API.getVillagers()]).then(function (r) {
      var villagers = r[1];
      main.innerHTML = '<div class="screen" style="max-width:none">' +
        '<div class="screen-head"><div class="screen-title">Journal explorer</div>' +
          '<span class="route">GET /journal?kinds=&amp;actor=&amp;ref=&amp;since=&amp;limit=</span><span class="route">GET /kinds</span><span class="route">WS /journal/stream</span></div>' +
        '<p class="screen-sub">The universal debugger. Every view in Eden is a saved query against this one table. Facet, expand a payload, then click any ref to pivot the whole view onto that causal thread.</p>' +
        '<div class="row" style="align-items:flex-start">' +
          '<div style="width:210px;flex:none" class="col">' +
            '<div class="card pad"><div class="eyebrow mb8">active query</div><div class="mono" id="qstr" style="font-size:11px;color:var(--text-soft);word-break:break-all"></div>' +
              '<button class="btn mt10" id="clearBtn" style="width:100%;font-size:12px;padding:5px">clear filters ✕</button></div>' +
            '<div class="card pad"><div class="eyebrow mb8">kinds <span class="faint">· /kinds</span></div><div class="col" id="kindFacets" style="gap:5px"></div></div>' +
            '<div class="card pad"><div class="eyebrow mb8">filters</div>' +
              '<div class="col" style="gap:9px">' +
                '<div><div class="eyebrow mb8" style="font-size:9px">actor</div><select class="field" id="fActor"><option value="">any</option>' +
                  '<optgroup label="god">' + ['god:critic', 'god:curriculum', 'god:orchestrator'].map(function (a) { return '<option>' + a + '</option>'; }).join('') + '</optgroup>' +
                  '<optgroup label="villagers">' + villagers.map(function (v) { return '<option>villager:' + v.name + '</option>'; }).join('') + '</optgroup>' +
                  '<option>engine</option><option>admin</option></select></div>' +
                '<div><div class="eyebrow mb8" style="font-size:9px">ref</div><input class="field" id="fRef" placeholder="ro_… / tk_… / rn_…"/></div>' +
                '<div><div class="eyebrow mb8" style="font-size:9px">time range</div><select class="field" id="fSince"><option value="0">all</option><option value="300">last 5m</option><option value="900">last 15m</option><option value="3600">last 1h</option></select></div>' +
                '<div><div class="eyebrow mb8" style="font-size:9px">limit</div><select class="field" id="fLimit"><option>100</option><option selected>200</option><option>500</option></select></div>' +
              '</div></div>' +
          '</div>' +
          '<div class="grow" style="min-width:0">' +
            '<div class="row between center mb12"><div class="row center gap8"><span class="muted" style="font-size:13px" id="count">…</span></div>' +
              '<button class="chip ' + (state.live ? 'on' : '') + '" id="liveBtn"><span class="led" style="width:7px;height:7px;border-radius:50%;background:var(--s-active);display:inline-block"></span> live tail</button></div>' +
            '<div class="card" style="overflow:hidden"><table class="tbl"><thead><tr><th style="width:74px">at</th><th style="width:140px">actor</th><th style="width:150px">kind</th><th>summary</th></tr></thead>' +
              '<tbody id="jrows"></tbody></table></div>' +
            '<p class="muted" style="font-size:11.5px;margin-top:8px" id="jnote"></p>' +
          '</div>' +
        '</div></div>';

      // build kind facets
      document.getElementById('kindFacets').innerHTML = DOMAINS.map(function (d) {
        return '<label class="row center gap6" style="font-size:12px;cursor:pointer"><span class="badge kind ' + U.DOMAIN_CLASS[d] + '" style="padding:0 4px"><span class="pip"></span></span><span style="flex:1">' + d + '</span><input type="checkbox" data-d="' + d + '"' + (state.domains[d] ? ' checked' : '') + '/></label>';
      }).join('');

      if (initRef) document.getElementById('fRef').value = initRef;

      // wiring
      document.getElementById('kindFacets').addEventListener('change', function (e) { var cb = e.target.closest('[data-d]'); if (!cb) return; state.domains[cb.getAttribute('data-d')] = cb.checked ? 1 : 0; refetch(); });
      document.getElementById('fActor').addEventListener('change', function (e) { state.actor = e.target.value; refetch(); });
      document.getElementById('fRef').addEventListener('input', debounce(function (e) { state.ref = e.target.value.trim(); refetch(); }, 280));
      document.getElementById('fSince').addEventListener('change', function (e) { state.since = +e.target.value; refetch(); });
      document.getElementById('fLimit').addEventListener('change', function (e) { state.limit = +e.target.value; refetch(); });
      document.getElementById('liveBtn').addEventListener('click', function () { state.live = !state.live; document.getElementById('liveBtn').classList.toggle('on', state.live); });
      document.getElementById('clearBtn').addEventListener('click', function () {
        state.actor = ''; state.ref = ''; state.since = 0; DOMAINS.forEach(function (d) { state.domains[d] = (['social', 'world', 'reactivity'].indexOf(d) === -1) ? 1 : 0; });
        document.getElementById('fActor').value = ''; document.getElementById('fRef').value = ''; document.getElementById('fSince').value = '0';
        document.querySelectorAll('#kindFacets input').forEach(function (cb) { cb.checked = !!state.domains[cb.getAttribute('data-d')]; });
        if (location.hash.indexOf('/r/') > -1) { Eden.go('#/journal'); return; }
        refetch();
      });

      function buildQuery() {
        var kinds = DOMAINS.filter(function (d) { return state.domains[d]; });
        var q = { kinds: kinds, order: 'desc', limit: state.limit };
        if (state.actor) q.actor = state.actor;
        if (state.ref) q.ref = state.ref;
        if (state.since) q.since = Date.now() - state.since * 1000;
        return q;
      }
      function queryStr(q) {
        var s = [];
        if (q.ref) s.push('ref=' + q.ref);
        if (q.actor) s.push('actor=' + q.actor);
        s.push('kinds=' + (q.kinds.length === 8 ? 'all' : q.kinds.join(',')));
        if (q.since) s.push('since=-' + state.since + 's');
        s.push('limit=' + q.limit);
        return '?' + s.join('&');
      }

      var rows = [];
      function refetch() {
        var q = buildQuery();
        document.getElementById('qstr').textContent = queryStr(q);
        API.getJournal(q).then(function (list) {
          rows = list;
          document.getElementById('count').textContent = list.length + ' events' + (q.ref ? ' · pivoted on ref ' + q.ref : '');
          document.getElementById('jnote').textContent = 'Virtualised in production — renders ~30 rows, streams the rest. ' + (state.live ? 'Live events prepend with a highlight.' : 'Live tail paused.');
          paint();
        });
      }
      function paint() {
        var tb = document.getElementById('jrows');
        tb.innerHTML = rows.slice(0, 60).map(rowHtml).join('') || '<tr><td colspan="4"><div class="empty">no events match this query</div></td></tr>';
      }
      function rowHtml(ev) {
        return '<tr data-evid="' + ev.id + '"><td class="mono" style="font-size:11px">' + U.timeHMS(ev.at) + '</td>' +
          '<td class="id">' + U.esc(ev.actor) + '</td><td>' + U.kindBadge(ev.kind) + '</td><td>' + U.eventMsg(ev) + '</td></tr>';
      }
      function expandHtml(ev) {
        var refs = Object.keys(ev.refs || {});
        var refHtml = refs.length ? refs.map(function (k) { return '<div class="row between" style="font-size:12px;padding:2px 0"><span class="faint mono">' + k + '</span><span class="refp" data-ref="' + U.esc(ev.refs[k]) + '">' + U.esc(ev.refs[k]) + '</span></div>'; }).join('') : '<span class="faint">no refs</span>';
        // For an llm.call, the journal carries metrics only; the full prompt/response transcript (when
        // debugPrompts dumped it) is fetched lazily from GET /llm/:llmCallId into this panel.
        var txPanel = '';
        if (ev.kind === 'llm.call') {
          var cid = (ev.refs && ev.refs.llmCallId) || '';
          txPanel = '<div class="card pad" id="llmtx-' + ev.id + '" style="margin-top:12px">' +
            '<div class="eyebrow mb8">llm transcript <span class="faint">· GET /llm/' + U.esc(cid) + '</span></div>' +
            '<div class="faint" style="font-size:12px">' + (cid ? 'loading…' : 'no llmCallId on this event') + '</div></div>';
        }
        return '<tr class="exp"><td colspan="4" style="background:var(--surface-2);padding:0 12px 14px"><div class="row" style="gap:14px">' +
          '<div class="card pad grow"><div class="eyebrow mb8">payload</div><pre class="mono" style="margin:0;font-size:11.5px;line-height:1.7;color:var(--text-soft);white-space:pre-wrap">' + U.esc(JSON.stringify(ev.payload, null, 2)) + '</pre></div>' +
          '<div class="card pad" style="width:250px;flex:none"><div class="eyebrow mb8">refs · click to pivot</div>' + refHtml + '<div class="faint" style="font-size:10.5px;margin-top:8px">id <span class="mono">' + ev.id + '</span></div></div>' +
        '</div>' + txPanel + '</td></tr>';
      }
      function loadTranscript(ev) {
        var cid = ev.refs && ev.refs.llmCallId;
        if (!cid) return;
        API.getLlmTranscript(cid).then(function (tx) {
          var box = document.getElementById('llmtx-' + ev.id);
          if (!box) return; // the row was collapsed before the fetch resolved
          if (!tx) {
            box.innerHTML = '<div class="eyebrow mb8">llm transcript</div><div class="faint" style="font-size:12px">No transcript on disk — set <span class="mono">journal.debugPrompts: true</span> in eden.json to capture prompt/response bodies.</div>';
            return;
          }
          box.innerHTML = '<div class="eyebrow mb8">llm transcript <span class="faint">· GET /llm/' + U.esc(cid) + '</span></div>' +
            '<pre class="mono" style="margin:0;font-size:11.5px;line-height:1.7;color:var(--text-soft);white-space:pre-wrap;max-height:420px;overflow:auto">' + U.esc(JSON.stringify(tx, null, 2)) + '</pre>';
        });
      }
      document.getElementById('jrows').addEventListener('click', function (e) {
        var refEl = e.target.closest('[data-ref]');
        if (refEl) { Eden.go('#/journal/r/' + encodeURIComponent(refEl.getAttribute('data-ref'))); return; }
        var tr = e.target.closest('tr[data-evid]'); if (!tr) return;
        var next = tr.nextElementSibling;
        if (next && next.classList.contains('exp')) { next.remove(); tr.classList.remove('expanded'); return; }
        document.querySelectorAll('#jrows tr.exp').forEach(function (x) { x.remove(); });
        document.querySelectorAll('#jrows tr.expanded').forEach(function (x) { x.classList.remove('expanded'); });
        var ev = rows.find(function (x) { return x.id === tr.getAttribute('data-evid'); });
        if (ev) { tr.classList.add('expanded'); tr.insertAdjacentHTML('afterend', expandHtml(ev)); if (ev.kind === 'llm.call') loadTranscript(ev); }
      });

      // live tail
      Eden.subscribeStream([], function (ev) {
        if (!state.live) return;
        var q = buildQuery();
        if (q.actor && ev.actor !== q.actor) return;
        if (q.ref && !Object.keys(ev.refs).some(function (k) { return ev.refs[k] === q.ref; })) return;
        if (q.kinds.indexOf(API.domainOf(ev.kind)) === -1) return;
        rows.unshift(ev); if (rows.length > state.limit) rows.pop();
        var tb = document.getElementById('jrows');
        var tmp = document.createElement('tbody'); tmp.innerHTML = rowHtml(ev);
        var node = tmp.firstChild; node.classList.add('expanded'); node.classList.remove('expanded');
        node.style.animation = 'flashin 1.1s ease-out';
        tb.insertBefore(node, tb.firstChild);
        document.getElementById('count').textContent = rows.length + ' events' + (q.ref ? ' · pivoted on ref ' + q.ref : '');
        while (tb.querySelectorAll('tr[data-evid]').length > 60) { var last = tb.querySelector('tr[data-evid]:last-of-type'); if (last) { var nx = last.nextElementSibling; if (nx && nx.classList.contains('exp')) nx.remove(); last.remove(); } else break; }
      });

      refetch();
    });

    function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  };
})();
