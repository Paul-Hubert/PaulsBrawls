/* ============================================================
   Screens: skills · skill detail · rollout replay
   ============================================================ */
(function () {
  var API = window.EdenAPI, U = window.UI;
  window.Screens = window.Screens || {};

  function rate(s) { return s.stats.runs ? (s.stats.successes / s.stats.runs) : 0; }

  // ============ SKILL LIBRARY ============
  Screens.skills = function (main, params) {
    if (params && params[0]) return Screens._skillDetail(main, params[0]);
    API.getSkills().then(function (skills) {
      main.innerHTML = '<div class="screen">' +
        '<div class="screen-head"><div class="screen-title">Skill library</div><span class="route">GET /skills</span><span class="route post">POST /skills/:name/quarantine</span></div>' +
        '<p class="screen-sub">The core asset — the single shared, God-owned library. A skill only enters it after the critic judges a real run a success. Status is first-class.</p>' +
        '<div class="row wrap gap8 mb16" id="sfilter">' +
          ['all', 'draft', 'active-probation', 'active', 'quarantined', 'archived'].map(function (st) {
            return '<span class="chip ' + (st === 'all' ? 'on' : (U.statusBadge(st).match(/st-\w+/) || [''])[0]) + '" data-f="' + st + '">' + (st === 'all' ? 'all' : st) + '</span>';
          }).join('') +
        '</div>' +
        '<div class="card" style="overflow:hidden"><table class="tbl"><thead><tr>' +
          '<th>skill</th><th>status</th><th>tier</th><th>tags</th><th style="text-align:right">runs</th><th>success rate</th><th style="text-align:right">avg ms</th>' +
        '</tr></thead><tbody id="srows"></tbody></table></div>' +
        '<p class="muted" style="font-size:12px;margin-top:10px">' + skills.length + ' skills · click a row for manifest, version history &amp; source.</p>' +
      '</div>';

      function paint(filter) {
        var list = skills.filter(function (s) { return filter === 'all' || s.status === filter; });
        document.getElementById('srows').innerHTML = list.map(function (s) {
          var arch = s.status === 'archived';
          var rr = rate(s);
          var col = s.status === 'quarantined' ? 'var(--s-fail)' : rr > 0.7 ? 'var(--s-success)' : rr > 0.45 ? 'var(--s-probation)' : 'var(--s-fail)';
          return '<tr data-hash="#/skills/' + s.name + '"' + (arch ? ' style="opacity:.6"' : '') + '>' +
            '<td><b>' + s.name + '</b></td>' +
            '<td>' + U.statusBadge(s.status, s.status) + '</td>' +
            '<td class="mono faint" style="font-size:12px">' + s.tier + '</td>' +
            '<td>' + s.tags.map(function (t) { return '<span class="badge soft" style="font-size:10px">' + t + '</span>'; }).join(' ') + '</td>' +
            '<td style="text-align:right" class="mono num">' + s.stats.runs + '</td>' +
            '<td><span class="row center gap8">' + U.sparkline(s.history, col, 56, 18) + '<span class="mono num" style="font-size:12px">' + (arch ? '—' : rr.toFixed(2)) + '</span></span></td>' +
            '<td style="text-align:right" class="mono num">' + (s.stats.avg_ms ? s.stats.avg_ms.toLocaleString() : '—') + '</td>' +
          '</tr>';
        }).join('');
        document.querySelectorAll('#srows tr').forEach(function (tr) { tr.addEventListener('click', function () { Eden.go(tr.getAttribute('data-hash')); }); });
      }
      paint('all');
      document.getElementById('sfilter').addEventListener('click', function (e) {
        var c = e.target.closest('[data-f]'); if (!c) return;
        document.querySelectorAll('#sfilter .chip').forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on');
        paint(c.getAttribute('data-f'));
      });
    });
  };

  // ============ SKILL DETAIL ============
  Screens._skillDetail = function (main, name) {
    API.getSkill(name, { code: 1 }).then(function (s) {
      if (!s) { main.innerHTML = '<div class="screen"><div class="empty">No skill “' + U.esc(name) + '”</div></div>'; return; }
      var rr = rate(s);
      var sel = s.versions[0].version;

      main.innerHTML = '<div class="screen">' +
        '<div class="crumb"><a data-hash="#/skills" href="#/skills">← skill library</a><span>/</span><span class="id">' + s.name + '</span></div>' +
        '<div class="screen-head"><div class="screen-title">' + s.name + '</div>' + U.statusBadge(s.status, s.status) +
          '<span class="route">GET /skills/:name?code=1</span><span class="route post">POST /skills/:name/quarantine</span></div>' +
        '<p class="screen-sub">' + U.esc(s.description) + '</p>' +

        '<div class="detail">' +
          '<div class="stack">' +
            '<div class="card"><div class="panel-h"><h3>Manifest</h3></div><div class="pad row wrap" style="gap:22px">' +
              field('signature', '<span class="mono">' + U.esc(s.signature) + '</span>') +
              field('tier', s.tier) +
              field('tags', s.tags.join(', ')) +
              field('runs / succ / fail / stall', '<span class="mono">' + s.stats.runs + ' / ' + s.stats.successes + ' / ' + s.stats.failures + ' / ' + s.stats.stalls + '</span>') +
              field('avg ms', '<span class="mono">' + (s.stats.avg_ms || '—') + '</span>') +
            '</div></div>' +

            '<div class="card"><div class="panel-h"><h3>Version history</h3><span class="sub">append-only · never deleted</span></div><div class="pad">' +
              '<div style="border-left:1px solid var(--border);padding-left:16px">' +
              s.versions.map(function (v) {
                return '<div style="position:relative;margin-bottom:14px">' +
                  '<span style="position:absolute;left:-21px;top:3px;width:9px;height:9px;border-radius:50%;background:' + (v.status === 'active' ? 'var(--s-active)' : v.status.indexOf('probation') > -1 ? 'var(--s-probation)' : 'var(--text-faint)') + '"></span>' +
                  '<div class="row center gap8"><b>' + v.version + '</b>' + U.statusBadge(v.status, v.status) + '<span class="faint mono" style="font-size:11px">' + v.runs + ' runs · ' + v.score + '</span></div>' +
                  '<div class="muted" style="font-size:12.5px;margin:3px 0 4px">' + U.esc(v.note) + '</div>' +
                  (v.admittedBy ? '<span class="refp" data-hash="#/rollout/' + v.admittedBy + '">admitted by ' + v.admittedBy + ' ↗</span>' : '<span class="faint mono" style="font-size:11px">not admitted</span>') +
                '</div>';
              }).join('') + '</div></div></div>' +

            '<div class="card" style="overflow:hidden"><div class="panel-h"><h3>Source</h3><div class="spacer"></div><div class="seg" id="verSeg">' +
              s.versions.map(function (v, i) { return '<button class="' + (i === 0 ? 'on' : '') + '" data-v="' + v.version + '">' + v.version + '</button>'; }).join('') +
            '</div></div>' +
              '<pre class="mono" id="srcView" style="margin:0;padding:14px 16px;font-size:12px;line-height:1.7;color:var(--text-soft);background:var(--surface-2);overflow-x:auto"></pre>' +
            '</div>' +
          '</div>' +

          '<div class="stack">' +
            '<div class="card stat"><div class="l">success rate</div><div class="row center gap8 mt8">' + U.sparkline(s.history, 'var(--s-success)', 120, 34) + '<span class="v" style="font-size:22px">' + rr.toFixed(2) + '</span></div>' +
              '<div class="row between mt14">' + mini('success', s.stats.successes, 'var(--s-success)') + mini('fail', s.stats.failures, 'var(--s-fail)') + mini('stall', s.stats.stalls, 'var(--s-probation)') + '</div></div>' +
            '<div class="card pad"><div class="l muted mb8">used by</div><div class="row wrap gap6">' + (s.usedBy.length ? s.usedBy.map(function (n) { return '<a class="badge soft" data-hash="#/villagers/' + n + '" href="#/villagers/' + n + '" style="cursor:pointer">' + n + '</a>'; }).join('') : '<span class="faint" style="font-size:12px">no villagers</span>') + '</div></div>' +
            quarantineBox(s) +
          '</div>' +
        '</div>' +
      '</div>';

      // source switcher
      var codeByVer = {}; s.versions.forEach(function (v) { codeByVer[v.version] = v.code; });
      function showSrc(ver) { document.getElementById('srcView').textContent = codeByVer[ver] || '// source unavailable'; }
      showSrc(sel);
      document.getElementById('verSeg').addEventListener('click', function (e) {
        var b = e.target.closest('[data-v]'); if (!b) return;
        document.querySelectorAll('#verSeg button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on');
        showSrc(b.getAttribute('data-v'));
      });

      // quarantine
      var qBtn = document.getElementById('qBtn');
      if (qBtn) qBtn.addEventListener('click', function () {
        var reason = (document.getElementById('qReason').value || '').trim();
        if (!reason) { document.getElementById('qReason').focus(); return; }
        API.quarantine(name, reason).then(function () { U.toast(name + ' quarantined', 'POST /skills/' + name + '/quarantine'); Eden.go('#/skills/' + name); });
      });
    });

    function field(l, v) { return '<div><div class="eyebrow mb8">' + l + '</div><div style="font-size:13px">' + v + '</div></div>'; }
    function mini(l, n, c) { return '<div><div style="font-size:20px;font-weight:600;color:' + c + '" class="num">' + n + '</div><div class="eyebrow">' + l + '</div></div>'; }
    function quarantineBox(s) {
      if (s.status === 'quarantined') {
        return '<div class="card pad" style="border-color:color-mix(in srgb,var(--s-quarantined) 40%,var(--border))">' +
          '<h3 style="margin:0 0 6px;font-size:13px;color:var(--s-quarantined)">Quarantined</h3>' +
          '<p class="muted" style="font-size:12.5px;margin:0">“' + U.esc(s.quarantine ? s.quarantine.reason : '') + '”</p>' +
          '<div class="faint mono" style="font-size:11px;margin-top:8px">by ' + (s.quarantine ? s.quarantine.by : 'admin') + ' · journalled</div></div>';
      }
      if (s.status === 'archived') return '';
      return '<div class="card pad" style="border-color:color-mix(in srgb,var(--s-quarantined) 30%,var(--border))">' +
        '<h3 style="margin:0 0 6px;font-size:13px;color:var(--s-quarantined)">Quarantine</h3>' +
        '<p class="muted" style="font-size:12px;margin:0 0 10px">Admin kill-switch. Stops every villager from running this skill immediately. Reason is required and journalled.</p>' +
        '<input class="field" id="qReason" placeholder="reason… (e.g. “places torches on TNT”)"/>' +
        '<button class="btn danger mt10" id="qBtn" style="width:100%">☠ Quarantine ' + s.name + '</button></div>';
    }
  };

  // ============ ROLLOUTS INDEX ============
  Screens.rollouts = function (main) {
    API.getRollouts().then(function (rollouts) {
      main.innerHTML = '<div class="screen">' +
        '<div class="screen-head"><div class="screen-title">Rollouts</div><span class="route">GET /rollouts</span></div>' +
        '<p class="screen-sub">Every refinement loop the village has run, folded from the journal. Click one to replay it — task → directive → drafts → trials → verdicts → admit.</p>' +
        (rollouts.length
          ? '<div class="card" style="overflow:hidden"><table class="tbl"><thead><tr>' +
              '<th>rollout</th><th>villager</th><th>skill</th><th>status</th><th style="text-align:right">trials</th><th style="text-align:right">started</th>' +
            '</tr></thead><tbody id="rorows"></tbody></table></div>'
          : '<div class="empty">no rollouts yet — they appear here once a refinement loop runs.</div>') +
      '</div>';

      if (!rollouts.length) return;
      // newest first
      var list = rollouts.slice().sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
      document.getElementById('rorows').innerHTML = list.map(function (r) {
        var st = r.status === 'admitted' ? 'success' : r.status === 'open' ? 'probation' : 'fail';
        return '<tr data-hash="#/rollout/' + encodeURIComponent(r.rolloutId) + '">' +
          '<td class="mono" style="font-size:12px">' + U.esc(r.rolloutId) + '</td>' +
          '<td>' + (r.villager ? U.esc(r.villager) : '<span class="faint">—</span>') + '</td>' +
          '<td class="mono faint" style="font-size:12px">' + (r.skill ? U.esc(r.skill) : '—') + '</td>' +
          '<td>' + U.statusBadge(st, r.status) + '</td>' +
          '<td style="text-align:right" class="mono num">' + (r.trials != null ? r.trials : 0) + '</td>' +
          '<td class="mono faint" style="text-align:right;font-size:11px">' + (r.startedAt ? U.relTime(r.startedAt) + ' ago' : '—') + '</td>' +
        '</tr>';
      }).join('');
      document.querySelectorAll('#rorows tr').forEach(function (tr) { tr.addEventListener('click', function () { Eden.go(tr.getAttribute('data-hash')); }); });
    });
  };

  // ============ ROLLOUT REPLAY ============
  Screens.rollout = function (main, params) {
    var id = params[0];
    if (!id) {
      main.innerHTML = '<div class="screen">' +
        '<div class="crumb"><a data-hash="#/rollouts" href="#/rollouts">← rollouts</a></div>' +
        '<div class="screen-head"><div class="screen-title">Rollout replay</div></div>' +
        '<div class="empty">No rollout selected — pick one from the <a data-hash="#/rollouts" href="#/rollouts">rollouts list</a> or <a data-hash="#/curriculum" href="#/curriculum">Curriculum</a>.</div>' +
      '</div>';
      return;
    }
    API.getJournal({ ref: id, order: 'asc', limit: 10000 }).then(function (events) {
      if (!events.length) { main.innerHTML = '<div class="screen"><div class="empty">No events for ref ' + U.esc(id) + '</div></div>'; return; }

      // derive summary
      var task = events.find(function (e) { return e.kind === 'god.task-proposed'; });
      var learner = (events.find(function (e) { return e.actor.indexOf('villager:') === 0; }) || {}).actor;
      var drafts = events.filter(function (e) { return e.kind === 'skill.draft'; });
      var trials = events.filter(function (e) { return e.kind === 'skill.run'; });
      var admit = events.find(function (e) { return e.kind === 'skill.admit'; });
      var lastVerdict = events.filter(function (e) { return e.kind === 'god.verdict'; }).slice(-1)[0];
      var elapsed = Math.round((events[events.length - 1].at - events[0].at) / 1000);

      // group into blocks
      var blocks = [], cur = null;
      events.forEach(function (ev) {
        var ver = ev.refs.skillVersion;
        if (ver) { if (!cur || cur.version !== ver) { cur = { type: 'band', version: ver, events: [] }; blocks.push(cur); } cur.events.push(ev); }
        else { cur = null; blocks.push({ type: 'node', ev: ev }); }
      });

      main.innerHTML = '<div class="screen">' +
        '<div class="crumb"><a data-hash="#/curriculum" href="#/curriculum">← curriculum</a><span>/</span><span class="id">rollout ' + id + '</span></div>' +
        '<div class="screen-head"><div class="screen-title">Rollout replay</div>' + (admit ? U.statusBadge('success', 'admitted') : U.statusBadge('fail', 'open')) +
          '<span class="route">GET /journal?ref=' + id + '&amp;order=at</span></div>' +
        '<p class="screen-sub">One God closes every loop — the whole story of ' + (task ? '<span class="mono">' + U.esc(task.payload.goal) + '</span>' : 'this rollout') + ' reconstructed from a single ref query: task → directive → drafts → trials → verdicts → revise → admit.</p>' +

        '<div class="card pad row between center wrap mb16" style="gap:14px">' +
          '<div class="row wrap" style="gap:22px">' +
            sfield('task', task ? U.esc(task.payload.goal) : '—') +
            sfield('learner', learner ? '<span class="refp" data-hash="#/villagers/' + U.actorShort(learner) + '">' + learner + '</span>' : '—') +
            sfield('attempts', drafts.length + ' drafts · ' + trials.length + ' trials') +
            sfield('outcome', lastVerdict ? (lastVerdict.refs.skillVersion != null ? 'v' + lastVerdict.refs.skillVersion + ' ' : '') + (lastVerdict.payload.success ? 'admitted · ' + (lastVerdict.payload.score != null ? lastVerdict.payload.score : '') : 'rejected') : '—') +
            sfield('elapsed', '<span class="mono">' + Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's</span>') +
          '</div>' +
          '<div class="seg" id="roSeg"><button class="on" data-v="tl">↕ timeline</button><button data-v="gr">◇ node graph</button></div>' +
        '</div>' +

        '<div id="roTl">' + renderTimeline(blocks) + '</div>' +
        '<div id="roGr" style="display:none">' + renderGraph(events) + '</div>' +
      '</div>';

      document.getElementById('roSeg').addEventListener('click', function (e) {
        var b = e.target.closest('[data-v]'); if (!b) return;
        document.querySelectorAll('#roSeg button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on');
        var v = b.getAttribute('data-v');
        document.getElementById('roTl').style.display = v === 'tl' ? '' : 'none';
        document.getElementById('roGr').style.display = v === 'gr' ? '' : 'none';
      });
    });

    function sfield(l, v) { return '<div><div class="eyebrow">' + l + '</div><div style="font-size:13px;margin-top:3px">' + v + '</div></div>'; }

    function dotColor(ev) {
      if (ev.kind === 'god.verdict') return ev.payload.success ? 'var(--s-success)' : 'var(--s-fail)';
      return 'var(--' + ({ system: 'd-system', skill: 'd-skill', god: 'd-god', brain: 'd-brain', llm: 'd-llm', social: 'd-social', world: 'd-world', reactivity: 'd-react' }[API.domainOf(ev.kind)] || 'd-system') + ')';
    }
    function nodeCard(ev, soft) {
      var p = ev.payload, extra = '';
      if (ev.kind === 'skill.run' && p.outcome) {
        var rok = p.outcome.ok;
        extra = '<div class="row gap8 mt8 center">' + U.statusBadge(rok ? 'success' : 'fail', rok ? 'ok' : 'fail') +
          '<span class="faint" style="font-size:11px">' + (p.durationMs != null ? Math.round(p.durationMs) + 'ms' : '') + (p.pulses != null ? ' · ' + p.pulses + ' pulses' : '') + '</span>' +
          (!rok && p.outcome.error ? '<span class="faint" style="font-size:11px">· ' + U.esc(p.outcome.error) + '</span>' : '') + '</div>';
      }
      var border = ev.kind === 'god.verdict' ? (p.success ? 'var(--s-success)' : 'var(--s-fail)') : ev.kind === 'skill.admit' ? 'var(--d-skill)' : 'var(--border)';
      return '<div class="card pad" style="border-color:' + border + '">' +
        '<div class="row between center"><div class="row center gap8">' + U.kindBadge(ev.kind) + '<span class="id">' + U.esc(ev.actor) + '</span></div><span class="faint mono" style="font-size:11px">' + U.timeHMS(ev.at) + '</span></div>' +
        '<div style="font-size:13px;margin-top:7px">' + U.eventMsg(ev) + '</div>' + extra + '</div>';
    }
    function tlNode(ev) {
      return '<div class="tlnode" style="--c:' + dotColor(ev) + '"><span class="tldot"></span>' + nodeCard(ev) + '</div>';
    }
    function renderTimeline(blocks) {
      return '<div class="tl">' + blocks.map(function (b) {
        if (b.type === 'node') return tlNode(b.ev);
        var ver = b.version;
        var verdict = b.events.find(function (e) { return e.kind === 'god.verdict'; });
        var bandColor = verdict ? (verdict.payload.success ? (verdict.payload.libraryAction === 'admit' ? 'var(--s-success)' : 'var(--s-probation)') : 'var(--s-fail)') : 'var(--border)';
        return '<div class="band" style="border-color:' + bandColor + '"><span class="band-tag">draft ' + ver + (Number(ver) > 1 ? ' · revise' : '') + '</span>' +
          '<div class="tl inner">' + b.events.map(tlNode).join('') + '</div></div>';
      }).join('') + '</div>';
    }
    function renderGraph(events) {
      var byVer = {};
      events.forEach(function (e) { var v = e.refs.skillVersion; if (v) { (byVer[v] = byVer[v] || []).push(e); } });
      var task = events.find(function (e) { return e.kind === 'god.task-proposed'; });
      var dir = events.find(function (e) { return e.kind === 'god.directive'; });
      var admit = events.find(function (e) { return e.kind === 'skill.admit'; });
      var cols = '';
      cols += gcol('var(--d-god)', 'task', task ? U.esc(task.payload.goal) : '—');
      cols += garrow();
      cols += gcol('var(--d-god)', 'directive', dir ? '→ ' + U.esc(dir.payload.to) : '—');
      Object.keys(byVer).forEach(function (v) {
        cols += garrow();
        var evs = byVer[v];
        var draft = evs.find(function (e) { return e.kind === 'skill.draft'; });
        var verdict = evs.find(function (e) { return e.kind === 'god.verdict'; });
        var vcol = verdict ? (verdict.payload.success ? (verdict.payload.libraryAction === 'admit' ? 'var(--s-success)' : 'var(--s-probation)') : 'var(--s-fail)') : 'var(--text-faint)';
        var loop = verdict && verdict.payload.libraryAction !== 'admit' ? '<div class="gloop" style="color:' + vcol + '">↺ revise</div>' : '';
        cols += '<div class="gcol">' +
          gnode('var(--d-skill)', 'draft v' + v, draft ? U.esc((draft.payload.tier || '') + (draft.payload.lines != null ? ' · ' + draft.payload.lines + ' lines' : '')) : '') +
          gnode('var(--d-skill)', 'trial run', 'RunReport') +
          gnode(vcol, 'verdict', verdict ? (verdict.payload.success ? 'success ' + (verdict.payload.score != null ? verdict.payload.score : '') : 'fail ' + (verdict.payload.score != null ? verdict.payload.score : '')) : '—') +
          loop + '</div>';
      });
      if (admit) { cols += garrow(); cols += gcol('var(--d-skill)', 'admit', 'v' + admit.payload.version + ' → library', true); }
      return '<div class="card pad"><div class="graph">' + cols + '</div>' +
        '<p class="muted" style="font-size:12px;margin:8px 4px 0">Each column is one causal step; <span style="color:var(--s-fail)">↺ revise</span> edges are the draft→critique→redraft loop. Same events as the timeline, folded onto causality (refs) instead of time.</p></div>';
    }
    function gcol(c, label, body, tint) { return '<div class="gcol">' + gnode(c, label, body, tint) + '</div>'; }
    function gnode(c, label, body, tint) { return '<div class="gnode" style="color:' + c + (tint ? ';background:color-mix(in srgb,' + c + ' 12%,transparent)' : '') + '"><small>' + label + '</small><span style="color:var(--text)">' + body + '</span></div>'; }
    function garrow() { return '<div class="garrow">→</div>'; }
  };
})();
