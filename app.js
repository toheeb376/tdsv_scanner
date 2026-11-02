/* ==========================================================================
   TDSV Attendee Check-in — application logic
   --------------------------------------------------------------------------
   - Verifies a scanned QR / barcode / typed value against the attendee register
   - Records check-ins with timestamp (WAT), gate / operator and method
   - Detects duplicates, unknown passes, pending and denied RSVPs
   - Keeps an audit log; exports CSV / XLSX; imports a verified register
   - All data stays in this browser (localStorage). No network requests.
   Security notes: every value from the register / scanner is written to the DOM
   with textContent (never innerHTML); CSV exports neutralise formula injection.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */
  var EVENT = window.TDSV_EVENT || { name: 'Event', shortName: 'EVENT', venue: '', timeZone: 'Africa/Lagos' };
  var SAMPLE = Array.isArray(window.TDSV_REGISTER) ? window.TDSV_REGISTER : [];
  var TZ = EVENT.timeZone || 'Africa/Lagos';
  var TZ_OFFSET = '+01:00';                 // Africa/Lagos has no daylight saving
  var KEY = 'tdsv.checkin.v1.';
  var PROBE_KEY = 'tdsv.probe';
  var LOG_CAP = 5000;
  var LOG_RENDER_CAP = 300;
  var PAGE_SIZE = 25;
  var REPEAT_SCAN_MS = 2500;                // same QR kept in view is not re-processed
  var MAX_IMPORT_BYTES = 10 * 1024 * 1024;
  var MAX_IMPORT_ROWS = 20000;
  var PRINT_CONFIRM_OVER = 300;
  var VIEWS = ['scan', 'attendees', 'activity', 'settings'];
  var VIEW_LABEL = { scan: 'Scan', attendees: 'Attendees', activity: 'Activity log', settings: 'Settings & data' };
  var CATEGORY_ORDER = ['VVIP', 'VIP', 'GENERAL'];

  var OUTCOMES = {
    admitted:  'Admitted',
    override:  'Admitted (override)',
    verified:  'Verified, awaiting admit',
    duplicate: 'Duplicate: already in',
    pending:   'RSVP pending: needs approval',
    denied:    'Denied',
    notfound:  'Not found',
    undo:      'Check-in undone',
    reset:     'Check-ins reset',
    import:    'Register imported',
    restore:   'Sample register restored'
  };

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) appendKids(node, arguments[i]);
    return node;
  }
  function appendKids(node, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { appendKids(node, k); }); return; }
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }

  /** Normalise free text: NFKC, strip control characters, collapse spaces, cap length. */
  function str(v, max) {
    var s = (v === null || v === undefined) ? '' : String(v);
    s = s.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, max || 200);
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ------------------------------------------------------------------ *
   * Date / time (always shown in the event time zone, WAT)
   * ------------------------------------------------------------------ */
  function makeFmt(opts) {
    try { return new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: TZ, hourCycle: 'h23' }, opts)); }
    catch (e) { return new Intl.DateTimeFormat('en-GB', Object.assign({ hourCycle: 'h23' }, opts)); }
  }
  var fmtLong  = makeFmt({ day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  var fmtClockF = makeFmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
  var fmtDay   = makeFmt({ day: '2-digit', month: '2-digit', year: 'numeric' });
  var fmtParts = makeFmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function toDate(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? null : d; }
  function fmtDateTime(iso) { var d = toDate(iso); return d ? fmtLong.format(d) : ''; }
  function fmtClock(d) { return fmtClockF.format(d || new Date()); }
  /** Short form: time only when it is today, otherwise date and time. */
  function fmtWhen(iso) {
    var d = toDate(iso); if (!d) return '';
    return fmtDay.format(d) === fmtDay.format(new Date()) ? fmtClockF.format(d) : fmtLong.format(d);
  }
  function partsOf(d) {
    var o = {};
    fmtParts.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  /** "YYYY-MM-DD HH:mm:ss" in WAT, used in exports. */
  function stamp(iso) {
    var d = toDate(iso); if (!d) return '';
    var p = partsOf(d);
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
  }
  function fileStamp() {
    var p = partsOf(new Date());
    return p.year + p.month + p.day + '_' + p.hour + p.minute;
  }
  function parseStamp(s) {
    s = str(s); if (!s) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    var d = m ? new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') + TZ_OFFSET) : new Date(s);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }

  /* ------------------------------------------------------------------ *
   * Storage (localStorage, fully guarded)
   * ------------------------------------------------------------------ */
  var store = {
    ok: true,
    get: function (k) {
      try { var v = window.localStorage.getItem(KEY + k); return v === null ? null : JSON.parse(v); }
      catch (e) { return null; }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(KEY + k, JSON.stringify(v)); return true; }
      catch (e) { store.ok = false; showStorageBanner(); return false; }
    },
    probe: function () {
      try { window.localStorage.setItem(PROBE_KEY, '1'); window.localStorage.removeItem(PROBE_KEY); return true; }
      catch (e) { return false; }
    }
  };
  function showStorageBanner() { var b = $('storageBanner'); if (b) b.hidden = false; }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  var state = {
    register: [],
    byCode: new Map(),
    byId: new Map(),
    log: [],
    settings: { operator: 'Gate 1', auto: true, sound: true, vibrate: true },
    source: { type: 'sample', name: '', at: '' },
    att: { page: 1, sortKey: 'id', sortDir: 1, q: '', cat: '', status: '', rsvp: '' },
    lastResultId: ''
  };

  function recordFrom(r) {
    return {
      id: str(r.id, 80),
      name: str(r.name, 120),
      category: (str(r.category, 40) || 'GENERAL').toUpperCase(),
      role: str(r.role, 80),
      organisation: str(r.organisation, 120),
      email: str(r.email, 120),
      phone: str(r.phone, 40),
      code: str(r.code, 120),
      rsvp: str(r.rsvp, 40) || 'Pending',
      seat: str(r.seat, 80),
      notes: str(r.notes, 300),
      checkedIn: r.checkedIn === true || /^checked in$/i.test(str(r.status)),
      checkInTime: r.checkInTime ? str(r.checkInTime, 40) : '',
      checkedInBy: str(r.checkedInBy, 40)
    };
  }
  function validStored(r) {
    return r && typeof r === 'object' && typeof r.id === 'string' && r.id &&
      typeof r.name === 'string' && typeof r.code === 'string' && r.code;
  }
  function sampleRegister() { return SAMPLE.map(recordFrom); }

  function rebuildIndex() {
    state.byCode = new Map();
    state.byId = new Map();
    state.register.forEach(function (a) {
      state.byCode.set(a.code.toUpperCase(), a);
      state.byId.set(a.id.toUpperCase(), a);
    });
  }

  function loadState() {
    var reg = store.get('register');
    var regOk = Array.isArray(reg) && reg.length > 0 && reg.every(validStored);
    state.register = regOk ? reg.map(recordFrom) : sampleRegister();

    var log = store.get('log');
    state.log = Array.isArray(log) ? log.filter(function (e) { return e && typeof e === 'object' && e.ts; }).slice(0, LOG_CAP) : [];

    var s = store.get('settings');
    if (s && typeof s === 'object') {
      state.settings.operator = str(s.operator, 40) || 'Gate 1';
      state.settings.auto = s.auto !== false;
      state.settings.sound = s.sound !== false;
      state.settings.vibrate = s.vibrate !== false;
    }
    var src = store.get('source');
    state.source = (regOk && src && src.type === 'imported')
      ? { type: 'imported', name: str(src.name, 120), at: str(src.at, 40) }
      : { type: 'sample', name: '', at: '' };
    rebuildIndex();
  }
  function persistRegister() { store.set('register', state.register); store.set('source', state.source); }
  function persistLog() { store.set('log', state.log); }
  function persistSettings() { store.set('settings', state.settings); }

  /* ------------------------------------------------------------------ *
   * Domain helpers
   * ------------------------------------------------------------------ */
  var RSVP_OK = ['confirmed', 'accepted', 'yes', 'attending', 'approved', 'paid'];
  var RSVP_DENIED = ['declined', 'cancelled', 'canceled', 'no', 'revoked', 'void', 'voided', 'refunded', 'banned', 'blocked', 'rejected', 'not attending'];
  /** 'ok' = may be admitted, 'pending' = needs staff approval, 'denied' = must not be admitted. */
  function rsvpClass(v) {
    var s = str(v, 40).toLowerCase();
    if (RSVP_OK.indexOf(s) !== -1) return 'ok';
    if (RSVP_DENIED.indexOf(s) !== -1) return 'denied';
    return 'pending';
  }
  function catRank(c) { var i = CATEGORY_ORDER.indexOf(c); return i === -1 ? CATEGORY_ORDER.length : i; }
  function catCompare(a, b) { return (catRank(a) - catRank(b)) || a.localeCompare(b); }
  function catClass(c) {
    var k = String(c).toLowerCase();
    return (k === 'vvip' || k === 'vip' || k === 'general') ? k : 'other';
  }
  function categories() {
    var set = {};
    state.register.forEach(function (a) { set[a.category] = true; });
    return Object.keys(set).sort(catCompare);
  }
  function counts() {
    var total = state.register.length, inCount = 0, byCat = {};
    state.register.forEach(function (a) {
      var c = byCat[a.category] || (byCat[a.category] = { total: 0, inn: 0, confirmed: 0, pending: 0 });
      c.total++;
      if (rsvpClass(a.rsvp) === 'ok') c.confirmed++; else c.pending++;
      if (a.checkedIn) { c.inn++; inCount++; }
    });
    return { total: total, inn: inCount, left: total - inCount, byCat: byCat };
  }

  /* ------------------------------------------------------------------ *
   * Lookup of scanned values
   * ------------------------------------------------------------------ */
  function cleanScan(raw) {
    return String(raw === null || raw === undefined ? '' : raw)
      .normalize('NFKC')
      .replace(/[‐-―−]/g, '-')       // dash look-alikes → hyphen
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/^\][A-Za-z]\d/, '')                 // AIM symbology identifier, e.g. "]Q1"
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }
  function lookup(key) { return state.byCode.get(key) || state.byId.get(key) || null; }
  function findAttendee(raw) {
    var s = cleanScan(raw);
    if (!s) return null;
    var up = s.toUpperCase();
    var a = lookup(up);
    if (a) return a;
    var tokens = up.split(/[^A-Z0-9\-_.\/]+/).filter(Boolean);
    for (var i = 0; i < tokens.length; i++) { a = lookup(tokens[i]); if (a) return a; }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Feedback: toast, announcements, sound, vibration
   * ------------------------------------------------------------------ */
  var toastTimer = 0;
  function toast(message, tone) {
    var t = $('toast');
    if (!t) {
      t = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true });
      document.body.append(t);
    }
    t.className = 'toast' + (tone ? ' toast--' + tone : '');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function announce(msg, assertive) {
    var n = $(assertive ? 'announceAssertive' : 'announcePolite');
    if (!n) return;
    n.textContent = '';
    setTimeout(function () { n.textContent = msg; }, 60);
  }

  var audioCtx = null;
  function beep(tone) {
    if (!state.settings.sound) return;
    var seq = { success: [[880, 0.12]], warning: [[620, 0.12], [620, 0.12]], danger: [[190, 0.4]] }[tone];
    if (!seq) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;
      seq.forEach(function (n) {
        var osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.type = tone === 'danger' ? 'sawtooth' : 'sine';
        osc.frequency.value = n[0];
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n[1]);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(t); osc.stop(t + n[1] + 0.02);
        t += n[1] + 0.08;
      });
    } catch (e) { /* audio is optional */ }
  }
  function vibrate(tone) {
    if (!state.settings.vibrate || !navigator.vibrate) return;
    try { navigator.vibrate({ success: [60], warning: [80, 60, 80], danger: [300] }[tone] || 0); } catch (e) { /* optional */ }
  }
  var reticleTimer = 0;
  function flashReticle(tone) {
    var cam = $('camera'); if (!cam) return;
    cam.classList.remove('camera--success', 'camera--warning', 'camera--danger');
    if (tone === 'success' || tone === 'warning' || tone === 'danger') cam.classList.add('camera--' + tone);
    clearTimeout(reticleTimer);
    reticleTimer = setTimeout(function () {
      cam.classList.remove('camera--success', 'camera--warning', 'camera--danger');
    }, 1600);
  }
  function feedback(tone) { beep(tone); vibrate(tone); flashReticle(tone); }

  /* ------------------------------------------------------------------ *
   * Dialogs
   * ------------------------------------------------------------------ */
  function openDialog(d) {
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
  }
  function anyDialogOpen() { return !!document.querySelector('dialog[open]'); }
  function confirmAction(o) {
    return new Promise(function (resolve) {
      var d = $('confirmDialog');
      $('confirmTitle').textContent = o.title;
      $('confirmMsg').textContent = o.message;
      $('confirmOk').textContent = o.ok || 'Confirm';
      d.returnValue = '';
      var done = function () { d.removeEventListener('close', done); resolve(d.returnValue === 'ok'); };
      d.addEventListener('close', done);
      openDialog(d);
    });
  }

  /* ------------------------------------------------------------------ *
   * Audit log
   * ------------------------------------------------------------------ */
  function addLog(type, att, scanned, method, note) {
    state.log.unshift({
      ts: new Date().toISOString(),
      type: type,
      id: att ? att.id : '',
      name: att ? att.name : '',
      category: att ? att.category : '',
      scanned: scanned ? str(scanned, 80) : '',
      gate: state.settings.operator,
      method: method || '',
      note: note || ''
    });
    if (state.log.length > LOG_CAP) state.log.length = LOG_CAP;
    persistLog();
  }

  /* ------------------------------------------------------------------ *
   * Badges and detail lists
   * ------------------------------------------------------------------ */
  function catBadge(c) { return el('span', { class: 'badge badge--' + catClass(c), text: c }); }
  function rsvpBadge(a) {
    var rc = rsvpClass(a.rsvp);
    var cls = rc === 'ok' ? 'confirmed' : (rc === 'denied' ? 'bad' : 'pending');
    return el('span', { class: 'badge badge--' + cls, text: a.rsvp || 'Pending' });
  }
  function dlItem(label, value, mono) {
    return el('div', null, el('dt', { text: label }), el('dd', { class: mono ? 'mono' : null, text: value || '—' }));
  }
  function scanDetails(a) {
    return el('dl', { class: 'details' },
      dlItem('Attendee ID', a.id, true),
      dlItem('Pass code', a.code, true),
      dlItem('Role', a.role),
      dlItem('Organisation', a.organisation),
      dlItem('Seat / section', a.seat),
      el('div', null, el('dt', { text: 'RSVP' }), el('dd', null, rsvpBadge(a))),
      a.checkedIn ? dlItem('Checked in', fmtDateTime(a.checkInTime) || '—') : null
    );
  }

  /* ------------------------------------------------------------------ *
   * Scan result panel
   * ------------------------------------------------------------------ */
  var ICONS = { success: '✓', warning: '!', danger: '✕', neutral: 'i' };

  function renderIdle() {
    var r = $('result');
    r.className = 'result result--idle';
    r.replaceChildren(
      el('div', { class: 'result__idle-icon', 'aria-hidden': 'true', text: 'QR' }),
      el('p', { text: 'Ready to scan' }),
      el('p', { class: 'help', text: 'Scan a QR pass or enter a code. The verification result appears here.' })
    );
    state.lastResultId = '';
  }

  function renderResult(o) {
    var r = $('result');
    r.className = 'result';
    void r.offsetWidth;
    r.classList.add('result--pop');
    var band = el('div', { class: 'result__band result__band--' + o.tone },
      el('span', { class: 'result__icon', 'aria-hidden': 'true', text: ICONS[o.tone] || 'i' }),
      el('div', null,
        el('div', { class: 'result__title', text: o.title }),
        o.msg ? el('div', { class: 'result__msg', text: o.msg }) : null));
    var body = el('div', { class: 'result__body' });
    if (o.att) {
      body.append(el('div', { class: 'result__who' }, el('span', { class: 'result__name', text: o.att.name }), catBadge(o.att.category)));
      body.append(scanDetails(o.att));
    } else if (o.scanned) {
      body.append(el('div', null,
        el('div', { class: 'label', text: 'Scanned value' }),
        el('div', { class: 'result__scanned', text: trunc(o.scanned, 100) })));
    }
    if (o.actions && o.actions.length) body.append(el('div', { class: 'result__actions' }, o.actions));
    body.append(el('div', { class: 'result__time', text:
      fmtDateTime(new Date().toISOString()) + ' · ' + state.settings.operator + (o.method ? ' · ' + o.method : '') }));
    r.replaceChildren(band, body);
    state.lastResultId = o.att ? o.att.id : '';
    var rect = r.getBoundingClientRect();
    if (rect.top < 0 || rect.top > (window.innerHeight || 800) * 0.6) {
      r.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    announce(o.title + '. ' + (o.att ? o.att.name + '. ' : '') + (o.msg || ''), o.tone === 'danger' || o.tone === 'warning');
    feedback(o.tone);
  }

  function btn(label, cls, handler, extra) {
    return el('button', Object.assign({ type: 'button', class: 'btn ' + (cls || ''), text: label, onclick: handler }, extra || {}));
  }

  /* ------------------------------------------------------------------ *
   * Check-in actions
   * ------------------------------------------------------------------ */
  function admit(att, opts) {
    if (att.checkedIn) return false;
    att.checkedIn = true;
    att.checkInTime = new Date().toISOString();
    att.checkedInBy = state.settings.operator;
    persistRegister();
    addLog(opts.override ? 'override' : 'admitted', att, opts.scanned, opts.method,
      opts.override ? 'RSVP was "' + (att.rsvp || 'Pending') + '"' : '');
    refreshAll();
    return true;
  }

  function showAdmitted(att, method, override) {
    renderResult({
      tone: 'success', icon: '✓',
      title: override ? 'Admitted (override)' : 'Admitted',
      msg: 'Check-in recorded at ' + fmtClock(toDate(att.checkInTime)) + '.',
      att: att, method: method,
      actions: [btn('Undo check-in', 'btn--danger btn--sm', function () { undoCheckIn(att); })]
    });
  }

  async function undoCheckIn(att) {
    if (!att.checkedIn) return;
    var ok = await confirmAction({
      title: 'Undo check-in?',
      message: att.name + ' (' + att.id + ') will be marked as not checked in. This is recorded in the activity log.',
      ok: 'Undo check-in'
    });
    if (!ok || !att.checkedIn) return;
    att.checkedIn = false; att.checkInTime = ''; att.checkedInBy = '';
    persistRegister();
    addLog('undo', att, '', 'Manual');
    refreshAll();
    toast('Check-in undone for ' + att.name + '.', 'warning');
    if (state.lastResultId === att.id) {
      renderResult({ tone: 'neutral', icon: 'i', title: 'Check-in undone', msg: att.name + ' is marked as not checked in.', att: att, method: 'Manual' });
    }
    refreshDetailIfOpen(att);
  }

  async function approveOverride(att, scanned, method) {
    var ok = await confirmAction({
      title: 'Admit with pending RSVP?',
      message: att.name + ' (' + att.id + ') has RSVP status “' + (att.rsvp || 'Pending') + '”. Admit only with supervisor approval.',
      ok: 'Admit anyway'
    });
    if (!ok) return;
    if (att.checkedIn) { toast(att.name + ' is already checked in.', 'warning'); return; }
    if (admit(att, { method: method, scanned: scanned, override: true })) showAdmitted(att, method, true);
  }

  /** Core verification flow for any scanned or typed value. */
  function processScan(raw, method) {
    var scanned = cleanScan(raw);
    if (!scanned) return;
    var att = findAttendee(scanned);

    if (!att) {
      addLog('notfound', null, scanned, method);
      renderResult({
        tone: 'danger', icon: '✕', title: 'Not found',
        msg: 'This pass code or ID is not in the register. Do not admit.',
        scanned: scanned, method: method,
        actions: [btn('Search attendees', 'btn--sm', function () { searchAttendees(scanned); })]
      });
      refreshAll();
      return;
    }

    if (att.checkedIn) {
      addLog('duplicate', att, scanned, method);
      renderResult({
        tone: 'warning', icon: '!', title: 'Already checked in',
        msg: 'Checked in ' + fmtDateTime(att.checkInTime) + (att.checkedInBy ? ' at ' + att.checkedInBy : '') + '.',
        att: att, method: method,
        actions: [btn('Attendee details', 'btn--sm', function () { openDetail(att); })]
      });
      refreshAll();
      return;
    }

    var rc = rsvpClass(att.rsvp);
    if (rc === 'denied') {
      addLog('denied', att, scanned, method, 'RSVP: ' + att.rsvp);
      renderResult({
        tone: 'danger', icon: '✕', title: 'Access denied',
        msg: 'RSVP status is “' + att.rsvp + '”. Do not admit; refer to a supervisor.',
        att: att, method: method
      });
      refreshAll();
      return;
    }

    if (rc === 'pending') {
      addLog('pending', att, scanned, method, 'RSVP: ' + (att.rsvp || 'Pending'));
      renderResult({
        tone: 'warning', icon: '!', title: 'RSVP pending',
        msg: 'Not confirmed yet. Get supervisor approval before admitting.',
        att: att, method: method,
        actions: [btn('Admit (override)…', 'btn--primary', function () { approveOverride(att, scanned, method); })]
      });
      refreshAll();
      return;
    }

    if (state.settings.auto) {
      if (admit(att, { method: method, scanned: scanned })) showAdmitted(att, method, false);
      return;
    }
    addLog('verified', att, scanned, method);
    renderResult({
      tone: 'neutral', icon: 'i', title: 'Verified',
      msg: 'Confirmed attendee. Tap Admit to record the check-in.',
      att: att, method: method,
      actions: [btn('Admit', 'btn--primary', function () {
        if (admit(att, { method: method, scanned: scanned })) showAdmitted(att, method, false);
      })]
    });
    refreshAll();
  }

  /** Check-in from the attendee list or detail dialog (no pass presented). */
  async function manualAdmit(att) {
    if (att.checkedIn) return;
    var rc = rsvpClass(att.rsvp);
    if (rc === 'denied') { toast('RSVP status is “' + att.rsvp + '”. Cannot admit.', 'danger'); return; }
    if (rc === 'pending') {
      var ok = await confirmAction({
        title: 'Admit with pending RSVP?',
        message: att.name + ' (' + att.id + ') has RSVP status “' + (att.rsvp || 'Pending') + '”. Admit only with supervisor approval.',
        ok: 'Admit anyway'
      });
      if (!ok || att.checkedIn) return;
    }
    if (admit(att, { method: 'Manual (list)', scanned: '', override: rc === 'pending' })) {
      toast('Admitted: ' + att.name, 'success');
      beep('success'); vibrate('success');
      refreshDetailIfOpen(att);
    }
  }

  function searchAttendees(q) {
    $('attSearch').value = trunc(q, 80);
    state.att.q = $('attSearch').value; state.att.page = 1;
    if (location.hash !== '#attendees') location.hash = '#attendees'; else route(true);
    renderAttendees();
  }

  /* ------------------------------------------------------------------ *
   * Stats
   * ------------------------------------------------------------------ */
  function renderStats() {
    var c = counts();
    $('statIn').textContent = c.inn;
    $('statLeft').textContent = c.left;
    $('statTotal').textContent = c.total;
    var pct = c.total ? Math.round((c.inn / c.total) * 100) : 0;
    var bar = $('statBar');
    bar.max = 100; bar.value = pct; bar.textContent = pct + '%';
    $('statPct').textContent = pct + '% of registered attendees are checked in.';
    var tb = $('statTable').querySelector('tbody');
    tb.replaceChildren.apply(tb, Object.keys(c.byCat).sort(catCompare).map(function (k) {
      var x = c.byCat[k];
      return el('tr', null,
        el('td', { text: k }),
        el('td', { class: 'num', text: x.inn }),
        el('td', { class: 'num', text: x.total }),
        el('td', { class: 'num', text: x.total - x.inn }));
    }));
  }

  /* ------------------------------------------------------------------ *
   * Attendees view
   * ------------------------------------------------------------------ */
  function fillSelect(sel, values, label) {
    var cur = sel.value;
    sel.replaceChildren(el('option', { value: '', text: label || 'All' }));
    values.forEach(function (v) { sel.append(el('option', { value: v, text: v })); });
    sel.value = values.indexOf(cur) !== -1 ? cur : '';
  }
  function populateFilters() {
    fillSelect($('attCat'), categories());
    var rs = {}; state.register.forEach(function (a) { rs[a.rsvp || 'Pending'] = true; });
    fillSelect($('attRsvp'), Object.keys(rs).sort());
    state.att.cat = $('attCat').value; state.att.rsvp = $('attRsvp').value;
    var logSel = $('logType'), cur = logSel.value;
    logSel.replaceChildren(el('option', { value: '', text: 'All' }));
    Object.keys(OUTCOMES).forEach(function (k) { logSel.append(el('option', { value: k, text: OUTCOMES[k] })); });
    logSel.value = OUTCOMES[cur] ? cur : '';
  }

  function filteredAttendees() {
    var f = state.att;
    var terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    var list = state.register.filter(function (a) {
      if (f.cat && a.category !== f.cat) return false;
      if (f.rsvp && (a.rsvp || 'Pending') !== f.rsvp) return false;
      if (f.status === 'in' && !a.checkedIn) return false;
      if (f.status === 'out' && a.checkedIn) return false;
      if (terms.length) {
        var hay = (a.id + ' ' + a.name + ' ' + a.code + ' ' + a.organisation + ' ' + a.role + ' ' + a.seat).toLowerCase();
        for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
      }
      return true;
    });
    var key = f.sortKey, dir = f.sortDir;
    list.sort(function (a, b) {
      var r;
      if (key === 'category') r = catCompare(a.category, b.category);
      else if (key === 'time') {
        if (!a.checkInTime && !b.checkInTime) r = 0;
        else if (!a.checkInTime) return 1;
        else if (!b.checkInTime) return -1;
        else r = a.checkInTime < b.checkInTime ? -1 : (a.checkInTime > b.checkInTime ? 1 : 0);
      } else r = String(a[key] || '').localeCompare(String(b[key] || ''), 'en', { numeric: true, sensitivity: 'base' });
      return (r || a.id.localeCompare(b.id, 'en', { numeric: true })) * (r ? dir : 1);
    });
    return list;
  }

  function renderAttendees() {
    var list = filteredAttendees();
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.att.page > pages) state.att.page = pages;
    if (state.att.page < 1) state.att.page = 1;
    var start = (state.att.page - 1) * PAGE_SIZE;
    var slice = list.slice(start, start + PAGE_SIZE);

    $('attCount').textContent = plural(list.length, 'attendee') + ' shown of ' + state.register.length + ' registered.';
    $('pageInfo').textContent = 'Page ' + state.att.page + ' of ' + pages;
    $('pagePrev').disabled = state.att.page <= 1;
    $('pageNext').disabled = state.att.page >= pages;

    var tb = $('attTable').querySelector('tbody');
    if (!slice.length) {
      tb.replaceChildren(el('tr', null, el('td', { colspan: 9, class: 'table-empty', text: 'No attendees match these filters.' })));
    } else {
      tb.replaceChildren.apply(tb, slice.map(attRow));
    }
    $('attTable').querySelectorAll('th[aria-sort]').forEach(function (th) {
      var b = th.querySelector('.sort');
      th.setAttribute('aria-sort', b && b.dataset.sort === state.att.sortKey ? (state.att.sortDir === 1 ? 'ascending' : 'descending') : 'none');
    });
  }

  function attRow(a) {
    var rc = rsvpClass(a.rsvp);
    var actions = [btn('Details', 'btn--sm', function () { openDetail(a); }, { 'aria-label': 'Details for ' + a.name })];
    if (a.checkedIn) actions.push(btn('Undo', 'btn--sm btn--danger', function () { undoCheckIn(a); }, { 'aria-label': 'Undo check-in for ' + a.name }));
    else actions.push(btn('Admit', 'btn--sm btn--primary', function () { manualAdmit(a); },
      { 'aria-label': 'Admit ' + a.name, disabled: rc === 'denied' }));
    return el('tr', null,
      el('td', { class: 'mono', text: a.id }),
      el('td', { text: a.name }),
      el('td', null, catBadge(a.category)),
      el('td', { text: a.role || '—' }),
      el('td', { text: a.organisation || '—' }),
      el('td', null, rsvpBadge(a)),
      el('td', { class: 'nowrap' }, a.checkedIn
        ? [el('span', { class: 'badge badge--in', text: '✓ In' }), ' ', el('span', { class: 'help', text: fmtWhen(a.checkInTime) })]
        : el('span', { class: 'badge badge--out', text: 'Not in' })),
      el('td', { class: 'nowrap', text: a.seat || '—' }),
      el('td', null, el('div', { class: 'cell-actions' }, actions)));
  }

  /* ------------------------------------------------------------------ *
   * Attendee detail dialog (with QR pass)
   * ------------------------------------------------------------------ */
  var detailId = '';
  function qrDataUrl(text, cell) {
    try {
      var q = window.qrcode(0, 'M');
      q.addData(String(text));
      q.make();
      return q.createDataURL(cell || 6, 2);
    } catch (e) { return ''; }
  }

  function openDetail(a) {
    detailId = a.id;
    $('detailTitle').textContent = a.name;
    var qr = qrDataUrl(a.code, 6);
    var info = el('dl', { class: 'details' },
      dlItem('Attendee ID', a.id, true),
      dlItem('Pass code', a.code, true),
      el('div', null, el('dt', { text: 'Access category' }), el('dd', null, catBadge(a.category))),
      dlItem('Role', a.role),
      dlItem('Organisation', a.organisation),
      el('div', null, el('dt', { text: 'RSVP' }), el('dd', null, rsvpBadge(a))),
      dlItem('Seat / section', a.seat),
      dlItem('Email', a.email),
      dlItem('Phone', a.phone),
      el('div', null, el('dt', { text: 'Check-in' }), el('dd', null,
        a.checkedIn ? el('span', { class: 'badge badge--in', text: '✓ Checked in' }) : el('span', { class: 'badge badge--out', text: 'Not checked in' }))),
      dlItem('Check-in time', a.checkedIn ? fmtDateTime(a.checkInTime) : ''),
      dlItem('Gate / operator', a.checkedInBy),
      dlItem('Notes', a.notes));
    var rc = rsvpClass(a.rsvp);
    var actions = el('div', { class: 'detail__actions' },
      a.checkedIn
        ? btn('Undo check-in', 'btn--danger', function () { undoCheckIn(a); })
        : btn('Admit', 'btn--primary', function () { manualAdmit(a); }, { disabled: rc === 'denied' }),
      btn('Print pass', '', function () { $('detailDialog').close(); printPasses([a]); }));
    var qrFig = el('figure', { class: 'detail__qr', style: null },
      qr ? el('img', { src: qr, alt: 'QR code for pass ' + a.code, width: 180, height: 180 }) : el('p', { class: 'help', text: 'QR code unavailable.' }),
      el('figcaption', { text: a.code }));
    $('detailBody').replaceChildren(
      el('div', { class: 'detail' }, info, qrFig),
      actions);
    openDialog($('detailDialog'));
  }
  function refreshDetailIfOpen(a) {
    var d = $('detailDialog');
    if (d.open && detailId === a.id) openDetail(a);
  }

  /* ------------------------------------------------------------------ *
   * Printable passes
   * ------------------------------------------------------------------ */
  async function printPasses(list) {
    if (!list.length) { toast('There are no attendees to print.', 'warning'); return; }
    if (list.length > PRINT_CONFIRM_OVER) {
      var ok = await confirmAction({
        title: 'Print ' + list.length + ' passes?',
        message: 'This will create a long print job (about ' + Math.ceil(list.length / 8) + ' pages).',
        ok: 'Print'
      });
      if (!ok) return;
    }
    var area = $('printArea');
    area.replaceChildren.apply(area, list.map(function (a) {
      var cc = catClass(a.category);
      var qr = qrDataUrl(a.code, 5);
      return el('div', { class: 'pass' },
        el('div', { class: 'pass__event' },
          el('img', { src: 'assets/redbox-mark.png', alt: '', width: 40, height: 40 }),
          el('span', { text: EVENT.name || '' })),
        el('div', null,
          el('div', { class: 'pass__name', text: a.name }),
          el('span', { class: 'pass__cat' + (cc === 'vip' ? ' pass__cat--vip' : (cc === 'general' ? ' pass__cat--general' : '')), text: a.category }),
          el('div', { class: 'pass__meta' },
            el('div', { text: [a.role, a.organisation].filter(Boolean).join(' · ') }),
            el('div', { text: 'Seat / section: ' + (a.seat || '—') }),
            el('div', { text: 'ID: ' + a.id }))),
        el('div', { class: 'pass__qr' },
          qr ? el('img', { src: qr, alt: '' }) : null,
          el('div', { text: a.code })));
    }));
    var done = function () {
      window.removeEventListener('afterprint', done);
      document.body.classList.remove('is-printing');
      area.replaceChildren();
    };
    window.addEventListener('afterprint', done);
    document.body.classList.add('is-printing');
    setTimeout(function () { window.print(); }, 50);
  }

  /* ------------------------------------------------------------------ *
   * Activity log view
   * ------------------------------------------------------------------ */
  function logBadgeClass(t) {
    if (t === 'admitted' || t === 'override') return 'in';
    if (t === 'duplicate' || t === 'pending' || t === 'verified') return 'pending';
    if (t === 'denied' || t === 'notfound') return 'bad';
    return 'out';
  }
  function renderLog() {
    var q = $('logSearch').value.toLowerCase().trim(), type = $('logType').value;
    var list = state.log.filter(function (e) {
      if (type && e.type !== type) return false;
      if (q) return (e.name + ' ' + e.id + ' ' + e.scanned + ' ' + e.gate + ' ' + e.method + ' ' + e.note).toLowerCase().indexOf(q) !== -1;
      return true;
    });
    var shown = list.slice(0, LOG_RENDER_CAP);
    $('logCount').textContent = (list.length > shown.length
      ? 'Showing the latest ' + shown.length + ' of ' + list.length + ' entries (export for the full log). '
      : plural(list.length, 'entry', 'entries') + '. ') +
      (state.log.length >= LOG_CAP ? 'The log keeps the latest ' + LOG_CAP + ' entries.' : '');
    var tb = $('logTable').querySelector('tbody');
    if (!shown.length) {
      tb.replaceChildren(el('tr', null, el('td', { colspan: 7, class: 'table-empty', text: 'No activity recorded yet.' })));
      return;
    }
    tb.replaceChildren.apply(tb, shown.map(function (e) {
      return el('tr', null,
        el('td', { class: 'nowrap', text: fmtDateTime(e.ts) }),
        el('td', null, el('span', { class: 'badge badge--' + logBadgeClass(e.type), text: OUTCOMES[e.type] || e.type })),
        el('td', { text: e.name ? e.name + ' (' + e.id + ')' : '—' }),
        el('td', { text: e.category || '—' }),
        el('td', { class: 'mono', text: e.scanned || '—' }),
        el('td', { text: e.gate || '—' }),
        el('td', { text: e.method || '—' }));
    }));
  }

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */
  function csvCell(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;           // neutralise spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function toCsv(rows) { return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }
  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name, hidden: true });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }
  function exportCheckinCsv() {
    var rows = [['Attendee ID', 'Full Name', 'Access Category', 'Attendee Type / Role', 'Organisation / Affiliation', 'RSVP Status',
      'Check-in Status', 'Check-in Time (WAT)', 'Gate / Operator', 'Seat / Section']];
    state.register.slice().sort(function (a, b) { return a.id.localeCompare(b.id, 'en', { numeric: true }); }).forEach(function (a) {
      rows.push([a.id, a.name, a.category, a.role, a.organisation, a.rsvp, a.checkedIn ? 'Checked In' : 'Not Checked In',
        a.checkedIn ? stamp(a.checkInTime) : '', a.checkedInBy, a.seat]);
    });
    download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), 'TDSV_Checkin_Report_' + fileStamp() + '.csv');
    toast('Check-in report exported.', 'success');
  }
  function exportLogCsv() {
    var rows = [['Time (WAT)', 'Outcome', 'Attendee ID', 'Attendee', 'Category', 'Scanned value', 'Gate / Operator', 'Method', 'Note']];
    state.log.forEach(function (e) {
      rows.push([stamp(e.ts), OUTCOMES[e.type] || e.type, e.id, e.name, e.category, e.scanned, e.gate, e.method, e.note]);
    });
    download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), 'TDSV_Activity_Log_' + fileStamp() + '.csv');
    toast('Activity log exported.', 'success');
  }
  function exportXlsx() {
    if (!window.XLSX) { toast('The spreadsheet library did not load.', 'danger'); return; }
    var X = window.XLSX;
    var head = ['Attendee ID', 'Full Name', 'Access Category', 'Attendee Type / Role', 'Organisation / Affiliation', 'Email', 'Phone',
      'Ticket / Pass Code', 'RSVP Status', 'Check-in Status', 'Check-in Time', 'Seat / Section', 'Notes', 'Checked in at gate'];
    var rows = state.register.map(function (a) {
      return [a.id, a.name, a.category, a.role, a.organisation, a.email, a.phone, a.code, a.rsvp,
        a.checkedIn ? 'Checked In' : 'Not Checked In', a.checkedIn ? stamp(a.checkInTime) : '', a.seat, a.notes, a.checkedInBy];
    });
    var ws = X.utils.aoa_to_sheet([head].concat(rows));
    ws['!cols'] = [12, 24, 14, 24, 28, 32, 14, 14, 12, 16, 20, 16, 40, 16].map(function (w) { return { wch: w }; });
    ws['!autofilter'] = { ref: 'A1:N' + (rows.length + 1) };
    var c = counts();
    var sum = [['Access Category', 'Registered', 'Confirmed', 'Pending / other', 'Checked In', 'Not Checked In']];
    Object.keys(c.byCat).sort(catCompare).forEach(function (k) {
      var x = c.byCat[k]; sum.push([k, x.total, x.confirmed, x.pending, x.inn, x.total - x.inn]);
    });
    sum.push(['TOTAL', c.total, '', '', c.inn, c.left]);
    var ws2 = X.utils.aoa_to_sheet(sum);
    ws2['!cols'] = [18, 12, 12, 16, 12, 16].map(function (w) { return { wch: w }; });
    var wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, 'Attendee Register');
    X.utils.book_append_sheet(wb, ws2, 'Summary');
    var out = X.write(wb, { bookType: 'xlsx', type: 'array' });
    download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'TDSV_Event_Attendee_Register_updated_' + fileStamp() + '.xlsx');
    toast('Updated register exported.', 'success');
  }

  /* ------------------------------------------------------------------ *
   * Import
   * ------------------------------------------------------------------ */
  var HEADER_ALIASES = {
    id: ['attendee id', 'id', 'attendee number', 'guest id'],
    name: ['full name', 'name', 'attendee name', 'guest name'],
    code: ['ticket pass code', 'pass code', 'ticket code', 'ticket', 'code', 'qr code', 'barcode'],
    category: ['access category', 'category', 'access level', 'ticket type'],
    role: ['attendee type role', 'attendee type', 'role', 'type'],
    organisation: ['organisation affiliation', 'organization affiliation', 'organisation', 'organization', 'affiliation', 'company'],
    rsvp: ['rsvp status', 'rsvp'],
    status: ['check in status', 'checkin status', 'checked in'],
    time: ['check in time', 'checkin time'],
    seat: ['seat section', 'seat', 'section'],
    notes: ['notes', 'note', 'remarks'],
    gate: ['checked in at gate', 'gate']
  };
  function normHeader(v) { return String(v === null || v === undefined ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function mapHeaders(cells) {
    var map = {};
    cells.forEach(function (cell, i) {
      var h = normHeader(cell); if (!h) return;
      var field = null;
      Object.keys(HEADER_ALIASES).some(function (f) { if (HEADER_ALIASES[f].indexOf(h) !== -1) { field = f; return true; } return false; });
      if (!field && h.indexOf('email') === 0) field = 'email';
      if (!field && (h.indexOf('phone') === 0 || h.indexOf('mobile') === 0)) field = 'phone';
      if (field && map[field] === undefined) map[field] = i;
    });
    return map;
  }
  function findTable(wb) {
    var X = window.XLSX;
    var names = wb.SheetNames.slice();
    names.sort(function (a, b) { return (/^attendee register$/i.test(b) ? 1 : 0) - (/^attendee register$/i.test(a) ? 1 : 0); });
    for (var s = 0; s < names.length; s++) {
      var ws = wb.Sheets[names[s]]; if (!ws || !ws['!ref']) continue;
      var rows = X.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
      var base = X.utils.decode_range(ws['!ref']).s.r;
      for (var i = 0; i < Math.min(rows.length, 25); i++) {
        var map = mapHeaders(rows[i]);
        if (map.id !== undefined && map.name !== undefined && map.code !== undefined) return { rows: rows, headerIndex: i, map: map, base: base, sheet: names[s] };
      }
    }
    return null;
  }

  function buildRegister(tbl) {
    var m = tbl.map, errors = [], records = [], seen = new Map();
    var hasRsvp = m.rsvp !== undefined, hasStatus = m.status !== undefined;
    function cell(row, f, max) { return m[f] === undefined ? '' : str(row[m[f]], max); }
    for (var i = tbl.headerIndex + 1; i < tbl.rows.length; i++) {
      var row = tbl.rows[i];
      if (!row.some(function (c) { return str(c) !== ''; })) continue;
      var line = tbl.base + i + 1;
      if (records.length >= MAX_IMPORT_ROWS) { errors.push('More than ' + MAX_IMPORT_ROWS + ' rows. Split the file.'); break; }
      var id = cell(row, 'id', 80), name = cell(row, 'name', 120), code = cell(row, 'code', 120);
      var missing = [];
      if (!id) missing.push('Attendee ID'); if (!name) missing.push('Full Name'); if (!code) missing.push('Ticket / Pass Code');
      if (missing.length) { errors.push('Row ' + line + ': missing ' + missing.join(', ') + '.'); continue; }
      var keys = [id.toUpperCase()]; if (code.toUpperCase() !== keys[0]) keys.push(code.toUpperCase());
      var clash = null;
      keys.forEach(function (k) { if (!clash && seen.has(k)) clash = { key: k, row: seen.get(k) }; });
      if (clash) { errors.push('Row ' + line + ': “' + clash.key + '” is already used on row ' + clash.row + '. IDs and pass codes must be unique.'); continue; }
      keys.forEach(function (k) { seen.set(k, line); });
      var status = hasStatus ? cell(row, 'status', 40) : '';
      var rsvp = hasRsvp ? (cell(row, 'rsvp', 40) || 'Pending') : 'Confirmed';
      var checked = /^checked[ -]?in$/i.test(status);
      records.push(recordFrom({
        id: id, name: name, code: code,
        category: cell(row, 'category', 40), role: cell(row, 'role', 80), organisation: cell(row, 'organisation', 120),
        email: cell(row, 'email', 120), phone: cell(row, 'phone', 40), rsvp: rsvp, seat: cell(row, 'seat', 80),
        notes: cell(row, 'notes', 300), checkedIn: checked,
        checkInTime: checked ? parseStamp(cell(row, 'time', 40)) : '',
        checkedInBy: checked ? cell(row, 'gate', 40) : ''
      }));
    }
    if (!records.length && !errors.length) errors.push('No attendee rows were found under the header row.');
    return { records: records, errors: errors };
  }

  function importMessage(text, ok) {
    var m = $('importMsg');
    m.textContent = text;
    m.className = 'msg ' + (ok ? 'msg--ok' : 'msg--err');
    m.hidden = false;
  }

  async function importFile(file) {
    $('importMsg').hidden = true;
    if (!file) return;
    if (!window.XLSX) { importMessage('The spreadsheet library did not load. Reload the page and try again.', false); return; }
    if (file.size > MAX_IMPORT_BYTES) { importMessage('That file is larger than 10 MB. Remove unused sheets or split it.', false); return; }
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) { importMessage('Unsupported file type. Choose an .xlsx, .xls or .csv file.', false); return; }
    var wb;
    try {
      if (/\.csv$/i.test(file.name)) wb = window.XLSX.read(await file.text(), { type: 'string' });
      else wb = window.XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    } catch (e) { importMessage('This file could not be read. Check that it is a valid spreadsheet.', false); return; }
    var tbl = findTable(wb);
    if (!tbl) { importMessage('No header row found. The sheet needs the columns “Attendee ID”, “Full Name” and “Ticket / Pass Code”.', false); return; }
    var res = buildRegister(tbl);
    if (res.errors.length) {
      var shown = res.errors.slice(0, 8).join(' ');
      importMessage('Import cancelled; nothing was changed. ' + plural(res.errors.length, 'problem') + ' found. ' + shown +
        (res.errors.length > 8 ? ' (+' + (res.errors.length - 8) + ' more)' : ''), false);
      return;
    }
    var existing = counts().inn;
    if (existing > 0) {
      var ok = await confirmAction({
        title: 'Replace the register?',
        message: 'This device holds ' + plural(existing, 'check-in') + ' for the current register. Replacing it discards them (the activity log is kept). Export a report first if needed.',
        ok: 'Replace register'
      });
      if (!ok) { importMessage('Import cancelled; nothing was changed.', false); return; }
    }
    state.register = res.records;
    state.source = { type: 'imported', name: str(file.name, 120), at: new Date().toISOString() };
    rebuildIndex();
    persistRegister();
    addLog('import', null, file.name, 'Settings', res.records.length + ' attendees');
    state.att.page = 1;
    populateFilters(); refreshAll(); renderIdle();
    var already = counts().inn;
    importMessage('Imported ' + plural(res.records.length, 'attendee') + ' from “' + file.name + '” (sheet “' + tbl.sheet + '”)' +
      (already ? '; ' + already + ' already marked as checked in.' : '.'), true);
  }

  async function restoreSample() {
    var ok = await confirmAction({
      title: 'Restore the sample register?',
      message: 'The current register and all check-ins on this device will be replaced by the fictional sample data. The activity log is kept.',
      ok: 'Restore sample'
    });
    if (!ok) return;
    state.register = sampleRegister();
    state.source = { type: 'sample', name: '', at: '' };
    rebuildIndex(); persistRegister();
    addLog('restore', null, '', 'Settings');
    state.att.page = 1;
    populateFilters(); refreshAll(); renderIdle();
    importMessage('Sample register restored (' + plural(state.register.length, 'attendee') + ').', true);
  }

  async function resetCheckins() {
    var n = counts().inn;
    var ok = await confirmAction({
      title: 'Reset all check-ins?',
      message: n ? 'This clears ' + plural(n, 'check-in') + ' on this device. The activity log is kept and records the reset. This cannot be undone.' :
        'No attendees are checked in. Nothing will change.',
      ok: 'Reset check-ins'
    });
    if (!ok || !n) return;
    state.register.forEach(function (a) { a.checkedIn = false; a.checkInTime = ''; a.checkedInBy = ''; });
    persistRegister();
    addLog('reset', null, '', 'Settings', n + ' check-ins cleared');
    refreshAll(); renderIdle();
    toast('All check-ins were reset.', 'warning');
  }

  /* ------------------------------------------------------------------ *
   * Camera scanning (jsQR)
   * ------------------------------------------------------------------ */
  var cam = { stream: null, track: null, raf: 0, running: false, startId: 0, last: 0, lastValue: '', lastSeen: 0, canvas: null, ctx: null, torch: false };

  function setCameraUI(running, title, hint) {
    $('btnCamera').textContent = running ? 'Stop camera' : 'Start camera';
    var chip = $('cameraState');
    chip.textContent = running ? 'Camera live' : 'Camera off';
    chip.classList.toggle('chip--live', running);
    var msg = $('cameraMsg');
    msg.hidden = running;
    if (!running) {
      msg.replaceChildren(el('p', { text: title || 'Camera is off.' }),
        el('p', { class: 'camera__hint', text: hint || 'Start the camera to scan a QR pass, or type / scan a code below.' }));
    }
    $('btnTorch').hidden = !running || !cam.canTorch;
    if (!running) $('cameraSelect').hidden = true;
  }

  function cameraError(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return ['Camera access was blocked.', 'Allow the camera for this page in the browser settings, then start it again. You can still type or scan a code below.'];
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return ['No camera found.', 'Connect a camera or use the code field below.'];
    if (n === 'NotReadableError' || n === 'TrackStartError') return ['The camera is busy.', 'Another app or tab is using it. Close it and try again.'];
    return ['The camera could not be started.', 'Use the code field below, or try another camera.'];
  }

  async function startCamera(deviceId) {
    if (cam.running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraUI(false, 'Camera not available.', window.isSecureContext === false
        ? 'Camera access needs HTTPS or localhost. Open this page over HTTPS, or use the code field below.'
        : 'This browser cannot access a camera. Use the code field below.');
      return;
    }
    var id = ++cam.startId;
    $('btnCamera').disabled = true;
    $('cameraState').textContent = 'Starting…';
    var stream = null;
    try {
      var base = { width: { ideal: 1280 }, height: { ideal: 720 } };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: Object.assign({}, base, deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }) });
      } catch (e1) {
        if (deviceId && e1 && e1.name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: base });
        else throw e1;
      }
      if (id !== cam.startId) { stream.getTracks().forEach(function (t) { t.stop(); }); setCameraUI(false); return; }
      var video = $('video');
      video.srcObject = stream;
      await video.play();
      if (id !== cam.startId) { stream.getTracks().forEach(function (t) { t.stop(); }); video.srcObject = null; setCameraUI(false); return; }
      cam.stream = stream; cam.track = stream.getVideoTracks()[0]; cam.running = true;
      cam.lastValue = ''; cam.lastSeen = 0; cam.torch = false;
      var caps = cam.track && cam.track.getCapabilities ? cam.track.getCapabilities() : {};
      cam.canTorch = !!(caps && caps.torch);
      $('btnTorch').setAttribute('aria-pressed', 'false'); $('btnTorch').textContent = 'Torch off';
      cam.track.addEventListener('ended', function () { if (cam.running) { stopCamera(); setCameraUI(false, 'The camera was disconnected.', 'Start it again or use the code field below.'); } });
      setCameraUI(true);
      await listCameras();
      cam.raf = requestAnimationFrame(tick);
    } catch (e) {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      var m = cameraError(e);
      setCameraUI(false, m[0], m[1]);
    } finally {
      $('btnCamera').disabled = false;
    }
  }

  function stopCamera() {
    cam.startId++;
    cancelAnimationFrame(cam.raf);
    if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
    var video = $('video'); if (video) video.srcObject = null;
    var was = cam.running;
    cam.stream = null; cam.track = null; cam.running = false; cam.canTorch = false;
    if (was || $('btnCamera').textContent === 'Stop camera') setCameraUI(false);
  }

  async function listCameras() {
    try {
      var devs = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === 'videoinput'; });
      var sel = $('cameraSelect');
      if (devs.length < 2) { sel.hidden = true; return; }
      var cur = cam.track && cam.track.getSettings ? cam.track.getSettings().deviceId : '';
      sel.replaceChildren.apply(sel, devs.map(function (d, i) {
        return el('option', { value: d.deviceId, text: d.label || 'Camera ' + (i + 1) });
      }));
      if (cur) sel.value = cur;
      sel.hidden = false;
    } catch (e) { /* optional */ }
  }

  function tick(ts) {
    if (!cam.running) return;
    cam.raf = requestAnimationFrame(tick);
    if (ts - cam.last < 110) return;
    cam.last = ts;
    var video = $('video');
    if (video.readyState < 2 || !video.videoWidth || typeof window.jsQR !== 'function') return;
    var scale = Math.min(1, 640 / video.videoWidth);
    var w = Math.max(1, Math.round(video.videoWidth * scale)), h = Math.max(1, Math.round(video.videoHeight * scale));
    if (!cam.canvas) { cam.canvas = $('frame'); cam.ctx = cam.canvas.getContext('2d', { willReadFrequently: true }); }
    if (cam.canvas.width !== w || cam.canvas.height !== h) { cam.canvas.width = w; cam.canvas.height = h; }
    cam.ctx.drawImage(video, 0, 0, w, h);
    var img = cam.ctx.getImageData(0, 0, w, h);
    var code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    if (code && code.data) onCameraValue(code.data);
  }

  function onCameraValue(value) {
    var key = cleanScan(value); if (!key) return;
    var now = Date.now();
    var same = key === cam.lastValue && (now - cam.lastSeen) < REPEAT_SCAN_MS;
    cam.lastValue = key; cam.lastSeen = now;
    if (same || anyDialogOpen()) return;
    processScan(key, 'Camera');
  }

  async function toggleTorch() {
    if (!cam.track) return;
    try {
      cam.torch = !cam.torch;
      await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] });
    } catch (e) { cam.torch = false; toast('Torch is not available on this camera.', 'warning'); }
    $('btnTorch').setAttribute('aria-pressed', String(cam.torch));
    $('btnTorch').textContent = cam.torch ? 'Torch on' : 'Torch off';
  }

  /* ------------------------------------------------------------------ *
   * Routing, header, settings
   * ------------------------------------------------------------------ */
  function route(moveFocus) {
    var name = (location.hash || '').replace('#', '');
    if (VIEWS.indexOf(name) === -1) name = 'scan';
    if (name !== 'scan') stopCamera();
    document.querySelectorAll('[data-view]').forEach(function (s) { s.hidden = s.dataset.view !== name; });
    document.querySelectorAll('.tab').forEach(function (t) {
      if (t.dataset.tab === name) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    document.title = VIEW_LABEL[name] + ' · TDSV Attendee Check-in';
    if (name === 'attendees') renderAttendees();
    if (name === 'activity') renderLog();
    if (moveFocus) {
      var h = document.querySelector('[data-view="' + name + '"] h2');
      if (h) h.focus();
    }
    if (name === 'scan' && window.matchMedia && window.matchMedia('(pointer: fine)').matches && !moveFocus) $('codeInput').focus();
  }

  /** True while the register still contains demo / placeholder records (e.g. the sample workbook was imported). */
  function looksLikeSample() {
    return state.register.some(function (a) {
      return /fictional|demo record|sample/i.test(a.notes) || /@example\.(com|org|net)$/i.test(a.email);
    });
  }

  function renderHeader() {
    $('gateLabel').textContent = state.settings.operator;
    $('sampleBanner').hidden = !(state.source.type === 'sample' || looksLikeSample());
    $('eventLine').textContent = EVENT.name || '';
    $('footVenue').textContent = EVENT.venue || '';
    $('sourceInfo').textContent = state.source.type === 'sample'
      ? 'Using the built-in sample register: ' + plural(state.register.length, 'fictional record') + ' from TDSV_Event_Attendee_Register.xlsx.'
      : 'Using imported file “' + state.source.name + '” (' + plural(state.register.length, 'attendee') + ', imported ' + fmtDateTime(state.source.at) + ').';
  }

  function applySettingsUI() {
    $('setOperator').value = state.settings.operator;
    $('setAuto').checked = state.settings.auto;
    $('setSound').checked = state.settings.sound;
    $('setVibrate').checked = state.settings.vibrate;
  }

  function refreshAll() {
    renderHeader();
    renderStats();
    renderAttendees();
    renderLog();
  }

  function updateNet() {
    var p = $('netStatus'), on = navigator.onLine !== false;
    p.textContent = on ? 'Online' : 'Offline';
    p.className = 'pill ' + (on ? 'pill--ok' : 'pill--off');
    p.title = on ? '' : 'No connection. Scanning and check-in keep working; data is stored on this device.';
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); };
  }

  /* ------------------------------------------------------------------ *
   * Event wiring
   * ------------------------------------------------------------------ */
  function bind() {
    window.addEventListener('hashchange', function () { route(true); });

    $('manualForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('codeInput'), v = input.value;
      if (!cleanScan(v)) { announce('Enter a pass code or attendee ID.', true); input.focus(); return; }
      input.value = '';
      processScan(v, 'Keyboard / scanner');
      if (window.matchMedia && window.matchMedia('(pointer: fine)').matches && !anyDialogOpen()) input.focus();
    });

    $('btnCamera').addEventListener('click', function () { if (cam.running) stopCamera(); else startCamera($('cameraSelect').value || undefined); });
    $('cameraSelect').addEventListener('change', function () { var id = $('cameraSelect').value; stopCamera(); startCamera(id); });
    $('btnTorch').addEventListener('click', toggleTorch);
    document.addEventListener('visibilitychange', function () { if (document.hidden) stopCamera(); });
    window.addEventListener('pagehide', stopCamera);

    var onAtt = debounce(function () { state.att.q = $('attSearch').value.trim(); state.att.page = 1; renderAttendees(); }, 150);
    $('attSearch').addEventListener('input', onAtt);
    $('attCat').addEventListener('change', function () { state.att.cat = $('attCat').value; state.att.page = 1; renderAttendees(); });
    $('attStatus').addEventListener('change', function () { state.att.status = $('attStatus').value; state.att.page = 1; renderAttendees(); });
    $('attRsvp').addEventListener('change', function () { state.att.rsvp = $('attRsvp').value; state.att.page = 1; renderAttendees(); });
    $('pagePrev').addEventListener('click', function () { state.att.page--; renderAttendees(); });
    $('pageNext').addEventListener('click', function () { state.att.page++; renderAttendees(); });
    $('attTable').querySelectorAll('.sort').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.dataset.sort;
        if (state.att.sortKey === k) state.att.sortDir *= -1; else { state.att.sortKey = k; state.att.sortDir = 1; }
        state.att.page = 1; renderAttendees();
      });
    });
    $('btnPrintList').addEventListener('click', function () { printPasses(filteredAttendees()); });

    $('logSearch').addEventListener('input', debounce(renderLog, 150));
    $('logType').addEventListener('change', renderLog);
    $('btnExportLog').addEventListener('click', exportLogCsv);
    $('btnExportLog2').addEventListener('click', exportLogCsv);
    $('btnExportCsv').addEventListener('click', exportCheckinCsv);
    $('btnExportXlsx').addEventListener('click', exportXlsx);

    $('setOperator').addEventListener('change', function () {
      state.settings.operator = str($('setOperator').value, 40) || 'Gate 1';
      $('setOperator').value = state.settings.operator;
      persistSettings(); renderHeader();
    });
    [['setAuto', 'auto'], ['setSound', 'sound'], ['setVibrate', 'vibrate']].forEach(function (p) {
      $(p[0]).addEventListener('change', function () { state.settings[p[1]] = $(p[0]).checked; persistSettings(); });
    });
    $('fileImport').addEventListener('change', function () {
      var f = $('fileImport').files && $('fileImport').files[0];
      importFile(f).finally(function () { $('fileImport').value = ''; });
    });
    $('btnRestoreSample').addEventListener('click', restoreSample);
    $('btnReset').addEventListener('click', resetCheckins);

    window.addEventListener('online', updateNet);
    window.addEventListener('offline', updateNet);

    // Keep two tabs / windows of the same browser in step.
    window.addEventListener('storage', function (e) {
      if (!e.key || e.key.indexOf(KEY) !== 0) return;
      loadState(); applySettingsUI(); populateFilters(); refreshAll();
    });
  }

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */
  function init() {
    if (!store.probe()) { store.ok = false; showStorageBanner(); }
    loadState();
    applySettingsUI();
    populateFilters();
    bind();
    renderIdle();
    refreshAll();
    updateNet();
    var clock = $('clock');
    var tickClock = function () { clock.textContent = fmtClock(new Date()); };
    tickClock(); setInterval(tickClock, 1000);
    route(false);
    if (!store.ok) showStorageBanner();
  }

  init();
})();
