/* ============================================================
   Eden UI helpers — pure render functions returning HTML strings
   (and a few DOM utilities). Used by every screen.
   ============================================================ */
(function () {
  var API = window.EdenAPI;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function timeHMS(at) { var d = new Date(at); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function relTime(at) {
    var s = Math.round((Date.now() - at) / 1000);
    if (s < 5) return 'now';
    if (s < 60) return s + 's';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm';
    var h = Math.round(m / 60);
    if (h < 24) return h + 'h';
    return Math.round(h / 24) + 'd';
  }

  var DOMAIN_CLASS = { system: 'k-system', skill: 'k-skill', god: 'k-god', brain: 'k-brain', llm: 'k-llm', social: 'k-social', world: 'k-world', reactivity: 'k-react' };
  function kindShort(kind) {
    var parts = kind.split('.');
    if (parts.length <= 1) return kind;
    return parts.slice(1).join('.');
  }
  function kindBadge(kind) {
    var dom = API.domainOf(kind);
    var cls = DOMAIN_CLASS[dom] || 'k-unknown';
    var known = !!API.KINDS.find(function (k) { return k.kind === kind; });
    return '<span class="badge kind ' + cls + '"' + (known ? '' : ' title="unknown kind — generic render"') + '><span class="pip"></span>' + esc(kindShort(kind)) + '</span>';
  }
  var ST_CLASS = { 'draft': 'st-draft', 'active-probation': 'st-probation', 'active': 'st-active', 'quarantined': 'st-quarantined', 'archived': 'st-archived', 'success': 'st-success', 'fail': 'st-fail', 'probation': 'st-probation' };
  function statusBadge(status, label) {
    var cls = ST_CLASS[status] || 'st-draft';
    return '<span class="badge ' + cls + '"><span class="pip"></span>' + esc(label || status) + '</span>';
  }
  function actorShort(a) {
    if (!a) return '';
    if (a.indexOf('villager:') === 0) return a.slice(9);
    return a;
  }

  function tradeItems(arr) {
    if (!arr || !arr.length) return '∅';
    return arr.map(function (t) { return esc(t.item) + '×' + esc(t.count); }).join(', ');
  }

  // human summary per event kind (known → rich, unknown → generic).
  // FIELD NAMES TRACK eden/src/journal/kinds.ts — the real journal payload contract served by the admin API.
  function eventMsg(ev) {
    var p = ev.payload || {}, k = ev.kind;
    switch (k) {
      // ── God: curriculum + orchestrator ──
      case 'god.task-proposed': return '“' + esc(p.goal) + '” proposed' + (p.assignee ? ' → ' + esc(p.assignee) : '') + (p.trigger ? ' · ' + esc(p.trigger) : '');
      case 'god.task-closed': return '“' + esc(p.goal) + '” — ' + esc(p.outcome || 'closed');
      case 'god.directive': return '→ ' + esc(p.to) + ': ' + esc(p.goal) + (p.priority ? ' · ' + esc(p.priority) : '');
      case 'god.directive-closed': return 'directive → ' + esc(p.to) + ' closed · ' + esc(p.reason || '');
      case 'god.verdict': return '<b class="' + (p.success ? 'st-success' : 'st-fail') + '">' + (p.success ? 'success' : 'fail') + (p.score != null ? ' ' + p.score : '') + '</b> · ' + esc(p.libraryAction || '');
      case 'god.ticket': return 'critic ticket · ' + esc(p.source || '') + (p.skill ? ' · ' + esc(p.skill) + (p.version != null ? ' v' + esc(p.version) : '') : '');
      case 'god.appearance': return esc(p.action || 'appearance') + ' → ' + esc(p.villager || '') + ' · <b class="' + (p.ok ? 'st-success' : 'st-fail') + '">' + (p.ok ? 'ok' : 'down') + '</b>';
      case 'god.rollout-abandoned': return 'rollout abandoned · ' + esc(p.reason || '');
      // ── Brain ──
      case 'brain.wakeup': return 'wakeup · ' + esc((p.triggers || []).join(', ') || '—') + (p.totalTokens != null ? ' · ' + p.totalTokens + ' tok' : '');
      case 'brain.tool-call': return esc(p.tool) + ' · <b class="' + (p.ok ? 'st-success' : 'st-fail') + '">' + (p.ok ? 'ok' : 'fail') + '</b>';
      case 'brain.done': return 'done · ' + esc(p.summary || '') + ' (' + esc(p.toolCalls != null ? p.toolCalls : 0) + ' calls)';
      // ── LLM (metrics only — full transcript via the llmCallId ref) ──
      case 'llm.call': return esc(p.model || '') + ' · ' + ((p.promptTokens || 0) + (p.completionTokens || 0)) + ' tok · ' + ((p.latencyMs || 0) / 1000).toFixed(1) + 's' + (p.retries ? ' · ' + p.retries + '↻' : '');
      // ── Skills ──
      case 'skill.draft': return esc(p.name) + ' v' + esc(p.version) + ' drafted · ' + esc(p.tier || '') + (p.lines != null ? ' · ' + p.lines + ' lines' : '');
      case 'skill.run': var rok = p.outcome && p.outcome.ok; return esc(p.skill) + ' v' + esc(p.version) + ' ' + (p.rolloutId ? 'trial' : 'run') + ' · <b class="' + (rok ? 'st-success' : 'st-fail') + '">' + (rok ? 'ok' : 'fail') + '</b>' + (!rok && p.outcome && p.outcome.error ? ' · ' + esc(p.outcome.error) : '');
      case 'skill.admit': return esc(p.name) + ' v' + esc(p.version) + ' → library';
      case 'skill.quarantine': return esc(p.name) + ' v' + esc(p.version) + ' quarantined' + (p.reason ? ' · ' + esc(p.reason) : '');
      case 'skill.archive': return esc(p.name) + ' v' + esc(p.version) + ' archived';
      case 'skill.log': return esc(p.skill) + ': ' + esc(p.message || '');
      // ── Social ──
      case 'inbox.delivered': return esc(p.kind || 'msg') + ' from ' + esc(p.from) + ' → ' + esc(p.to);
      case 'chat.said': return esc(p.from) + ' → ' + esc(p.to) + ': ' + esc(p.text || '…');
      case 'chat.heard': return esc(p.hearer) + ' heard ' + esc(p.from) + (p.eavesdrop ? ' (eavesdrop)' : '') + ': ' + esc(p.text || '…');
      case 'conversation.started': return esc(p.initiator) + ' ↔ ' + esc(p.partner) + (p.topic ? ' · ' + esc(p.topic) : '');
      case 'conversation.turn': return 'turn ' + esc(p.turn) + ' · ' + esc(p.speaker);
      case 'conversation.ended': return 'ended · ' + esc(p.reason || '') + (p.headline ? ' · “' + esc(p.headline) + '”' : '');
      case 'trade.proposed': return 'offer: ' + tradeItems(p.give) + ' ⇄ ' + tradeItems(p.want);
      case 'trade.settled': return 'trade ' + esc(p.from) + ' ⇄ ' + esc(p.to) + ' · ' + tradeItems(p.give) + ' ⇄ ' + tradeItems(p.want);
      case 'trade.failed': return 'trade failed · ' + esc(p.reason || '');
      // ── World ──
      case 'vitals': return esc(p.name) + ' · hp ' + esc(p.health) + ' · food ' + esc(p.food) + (p.currentRun ? ' · ' + esc(p.currentRun) : '');
      case 'world.death': return esc(p.name) + ' died · ' + esc(p.cause || 'unknown');
      // ── Reactivity ──
      case 'subscription.created': return 'on ' + esc(p.on) + ' → ' + esc(p.handler) + ' · ' + esc(p.source || '');
      case 'subscription.removed': return 'subscription removed';
      case 'subscription.fired': return 'on ' + esc(p.on) + ' → ' + esc(p.outcome) + ' ' + esc(p.target || '');
      case 'subscription.suppressed': return 'on ' + esc(p.on) + ' suppressed · ' + esc(p.reason || '');
      // ── System ──
      case 'system.loop-lag': return 'loop-lag p99 ' + esc(p.p99) + 'ms · max ' + esc(p.max) + 'ms';
      case 'system.bot-connected': return 'bot connected · ' + esc(p.name || '');
      case 'system.bot-disconnected': return 'bot disconnected · ' + esc(p.name || '') + (p.reason ? ' · ' + esc(p.reason) : '');
      case 'system.boot': return 'engine boot';
      case 'system.config-warning': return esc(p.message || 'config warning');
      case 'system.error': return 'error · ' + esc(p.message || '');
      // ── Scenario ──
      case 'scenario.start': return 'scenario start · ' + esc(p.name || '');
      case 'scenario.stop': return 'scenario stop';
      case 'scenario.restart': return 'scenario restart · ' + esc(p.name || '');
      default:
        var keys = Object.keys(p).slice(0, 2).map(function (kk) { var v = p[kk]; if (v && typeof v === 'object') v = JSON.stringify(v); return kk + '=' + esc(v); }).join(' · ');
        return '<span class="faint">' + esc(k) + (keys ? ' · ' + keys : '') + '</span>';
    }
  }

  function eventRow(ev, opts) {
    opts = opts || {};
    return '<div class="evrow' + (opts.flash ? ' new' : '') + '" data-evid="' + ev.id + '">' +
      '<span class="t">' + timeHMS(ev.at) + '</span>' +
      kindBadge(ev.kind) +
      '<span class="actor">' + esc(actorShort(ev.actor)) + '</span>' +
      '<span class="msg">' + eventMsg(ev) + '</span>' +
      '</div>';
  }

  function sparkline(arr, color, w, h) {
    w = w || 70; h = h || 20;
    if (!arr || !arr.length) return '';
    var max = Math.max.apply(null, arr), min = Math.min.apply(null, arr);
    var rng = (max - min) || 1;
    var pts = arr.map(function (v, i) {
      var x = (i / (arr.length - 1)) * (w - 2) + 1;
      var y = h - 2 - ((v - min) / rng) * (h - 4);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts + '" fill="none" stroke="' + (color || 'var(--accent)') + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  function vitalColor(frac) { return frac > 0.5 ? 'var(--s-active)' : frac > 0.25 ? 'var(--s-probation)' : 'var(--s-fail)'; }
  function vitalsBar(label, val, max) {
    var f = max ? val / max : 0;
    return '<div class="vrow"><span class="lab">' + label + '</span>' +
      '<span class="bar"><span style="width:' + (f * 100).toFixed(0) + '%;background:' + vitalColor(f) + '"></span></span>' +
      '<span class="val">' + val + '/' + max + '</span></div>';
  }

  function kvCard(obj) {
    var rows = Object.keys(obj || {}).map(function (k) {
      var v = obj[k];
      if (v && typeof v === 'object') v = JSON.stringify(v);
      return '<div class="row between" style="font-size:12px;padding:2px 0"><span class="faint mono">' + esc(k) + '</span><span class="mono" style="text-align:right;max-width:60%;word-break:break-all">' + esc(v) + '</span></div>';
    }).join('');
    return rows || '<span class="faint">∅</span>';
  }

  var toastWrap = null;
  function toast(msg, sub) {
    if (!toastWrap) { toastWrap = document.createElement('div'); toastWrap.className = 'toasts'; document.body.appendChild(toastWrap); }
    var t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = msg + (sub ? '<div class="tk">' + sub + '</div>' : '');
    toastWrap.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(function () { t.remove(); }, 300); }, 3200);
  }

  function spinner() { return '<div class="spin"></div>'; }

  window.UI = {
    esc: esc, timeHMS: timeHMS, relTime: relTime,
    kindBadge: kindBadge, kindShort: kindShort, statusBadge: statusBadge, actorShort: actorShort,
    eventMsg: eventMsg, eventRow: eventRow, sparkline: sparkline, vitalsBar: vitalsBar, vitalColor: vitalColor,
    kvCard: kvCard, toast: toast, spinner: spinner, DOMAIN_CLASS: DOMAIN_CLASS
  };
})();
