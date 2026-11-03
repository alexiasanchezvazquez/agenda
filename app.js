/* Personal agenda: month and day views backed by Supabase */
(() => {
  'use strict';

  // ---------- Settings ----------
  const FIRST = new Date(2026, 10, 1);   // 1 Nov 2026
  const LAST = new Date(2027, 11, 31);   // 31 Dec 2027
  const COLORS = ['#b5654f', '#d1953a', '#7f9a62', '#4f8a8b', '#5a7bb0', '#8a6fb0', '#c0718f', '#8f8a82'];
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const WEEKDAYS_SHORT = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const INK_COLORS = ['#1f1c18', '#b5654f', '#5a7bb0', '#7f9a62'];
  const INK_SCALE = 10000;   // stroke coordinates are stored relative to panel width
  const INK_REF_W = 280;     // reference panel width for line thickness
  const SAVE_DELAY = 700;
  const RETRY_DELAY = 5000;

  const sb = window.supabase.createClient(window.AGENDA_CONFIG.url, window.AGENDA_CONFIG.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  // ---------- State ----------
  const days = new Map();      // 'YYYY-MM-DD' -> { items: [], notes: '' }
  const months = new Map();    // 'YYYY-MM' -> { notes: '', ink: [] }
  const timers = new Map();    // pending debounced saves
  const inFlight = new Set();  // days being written
  const dirty = new Set();     // days changed while being written
  let user = null;
  let started = false;
  let currentColor = COLORS[0];
  let palette = null;
  let panelObserver = null;

  // ---------- DOM ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const loginEl = $('#login');
  const appEl = $('#app');
  const viewEl = $('#view');
  const monthsEl = $('#months');
  const statusEl = $('#status');

  // ---------- Helpers ----------
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monthKey = (y, m) => `${y}-${pad(m + 1)}`;
  const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d || 1); };
  const dow = d => (d.getDay() + 6) % 7;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const todayDate = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
  const inRange = d => d >= FIRST && d <= LAST;
  const clamp = d => (d < FIRST ? new Date(FIRST) : d > LAST ? new Date(LAST) : d);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const sortItems = arr => [...arr].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

  const getDay = k => days.get(k) || { items: [], notes: '' };
  const ensureDay = k => { if (!days.has(k)) days.set(k, { items: [], notes: '' }); return days.get(k); };
  const getMonth = mk => months.get(mk) || { notes: '', ink: [] };
  const ensureMonth = mk => { if (!months.has(mk)) months.set(mk, { notes: '', ink: [] }); return months.get(mk); };
  const isTyping = () => document.activeElement && document.activeElement.matches('input, textarea');

  // ---------- Status ----------
  function setStatus(text, kind) { statusEl.textContent = text; statusEl.dataset.kind = kind || ''; }
  function refreshStatus() {
    if (timers.size || inFlight.size) setStatus('Guardando…', 'busy');
    else setStatus('Guardado', 'ok');
  }

  // ---------- Persistence ----------
  async function loadAll() {
    const [dRes, mRes] = await Promise.all([
      sb.from('days').select('day,items,notes').gte('day', keyOf(FIRST)).lte('day', keyOf(LAST)),
      sb.from('months').select('month,notes,ink')
    ]);
    if (dRes.error || mRes.error) { console.error(dRes.error || mRes.error); setStatus('Sin conexión', 'error'); return false; }
    const busy = k => timers.has(k) || inFlight.has(k);

    const remoteDays = new Set();
    for (const row of dRes.data) {
      remoteDays.add(row.day);
      if (busy(row.day)) continue;
      days.set(row.day, { items: Array.isArray(row.items) ? row.items : [], notes: row.notes || '' });
    }
    for (const k of [...days.keys()]) if (!remoteDays.has(k) && !busy(k)) days.delete(k);

    const remoteMonths = new Set();
    for (const row of mRes.data) {
      remoteMonths.add(row.month);
      if (busy(`m:${row.month}`)) continue;
      months.set(row.month, { notes: row.notes || '', ink: Array.isArray(row.ink) ? row.ink : [] });
    }
    for (const mk of [...months.keys()]) if (!remoteMonths.has(mk) && !busy(`m:${mk}`)) months.delete(mk);

    refreshStatus();
    return true;
  }

  function queueSave(k) {
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => { timers.delete(k); write(k); }, SAVE_DELAY));
    refreshStatus();
  }

  async function write(k) {
    if (inFlight.has(k)) { dirty.add(k); return; }
    inFlight.add(k);
    refreshStatus();
    const { error } = k.startsWith('m:') ? await writeMonth(k.slice(2)) : await writeDay(k);
    inFlight.delete(k);
    if (error) {
      console.error(error);
      setStatus('Error al guardar', 'error');
      setTimeout(() => queueSave(k), RETRY_DELAY);
      return;
    }
    if (dirty.has(k)) { dirty.delete(k); write(k); return; }
    refreshStatus();
  }

  function writeDay(k) {
    const d = getDay(k);
    if (!d.items.length && !d.notes.trim()) return sb.from('days').delete().eq('user_id', user.id).eq('day', k);
    return sb.from('days').upsert(
      { user_id: user.id, day: k, items: d.items, notes: d.notes, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,day' }
    );
  }

  function writeMonth(mk) {
    const d = getMonth(mk);
    if (!d.ink.length && !d.notes.trim()) return sb.from('months').delete().eq('user_id', user.id).eq('month', mk);
    return sb.from('months').upsert(
      { user_id: user.id, month: mk, notes: d.notes, ink: d.ink, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,month' }
    );
  }

  function flushAll() {
    for (const [k, t] of [...timers]) { clearTimeout(t); timers.delete(k); write(k); }
  }

  // ---------- Colour palette ----------
  function openPalette(anchor, onPick) {
    closePalette();
    palette = document.createElement('div');
    palette.className = 'palette';
    palette.innerHTML = COLORS.map(c => `<button type="button" data-c="${c}" style="--c:${c}" aria-label="Color"></button>`).join('');
    document.body.appendChild(palette);
    const r = anchor.getBoundingClientRect();
    const maxLeft = window.scrollX + document.documentElement.clientWidth - palette.offsetWidth - 12;
    palette.style.left = `${Math.max(12, Math.min(r.left + window.scrollX - 8, maxLeft))}px`;
    palette.style.top = `${r.bottom + window.scrollY + 8}px`;
    palette.addEventListener('click', e => {
      const b = e.target.closest('[data-c]');
      if (b) { onPick(b.dataset.c); closePalette(); }
    });
    setTimeout(() => document.addEventListener('click', onOutside, true), 0);
  }
  function onOutside(e) { if (palette && !palette.contains(e.target)) closePalette(); }
  function closePalette() {
    if (!palette) return;
    palette.remove();
    palette = null;
    document.removeEventListener('click', onOutside, true);
  }

  // ---------- Month strip ----------
  function renderStrip(y, m) {
    let html = '';
    let lastYear = null;
    for (let d = new Date(FIRST); d <= LAST; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const yy = d.getFullYear(), mm = d.getMonth();
      if (yy !== lastYear) { html += `<span class="yr">${yy}</span>`; lastYear = yy; }
      html += `<a href="#${monthKey(yy, mm)}" class="${yy === y && mm === m ? 'on' : ''}">${MONTHS_SHORT[mm]}</a>`;
    }
    monthsEl.innerHTML = html;
    const on = $('.on', monthsEl);
    if (on) monthsEl.scrollLeft = on.offsetLeft - monthsEl.clientWidth / 2 + on.offsetWidth / 2;
  }

  function arrow(dir, href, label) {
    const sym = dir === 'prev' ? '‹' : '›';
    return href
      ? `<a class="arrow" data-nav="${dir}" href="${href}" aria-label="${label}">${sym}</a>`
      : `<span class="arrow off" aria-hidden="true">${sym}</span>`;
  }

  // ---------- Month view ----------
  function renderMonth(y, m) {
    closePalette();
    renderStrip(y, m);
    document.title = `${cap(MONTHS[m])} ${y} · Agenda`;

    const first = new Date(y, m, 1);
    const nDays = new Date(y, m + 1, 0).getDate();
    const lead = dow(first);
    const tKey = keyOf(todayDate());
    const prev = new Date(y, m - 1, 1);
    const next = new Date(y, m + 1, 1);
    const prevHref = prev >= new Date(FIRST.getFullYear(), FIRST.getMonth(), 1) ? `#${monthKey(prev.getFullYear(), prev.getMonth())}` : null;
    const nextHref = next <= LAST ? `#${monthKey(next.getFullYear(), next.getMonth())}` : null;

    let cells = '<div class="cell blank"></div>'.repeat(lead);
    for (let d = 1; d <= nDays; d++) {
      const date = new Date(y, m, d);
      const k = keyOf(date);
      const day = getDay(k);
      const items = sortItems(day.items);
      const evs = items.slice(0, 3).map(it =>
        `<span class="ev${it.done ? ' done' : ''}" style="--c:${it.color}">${it.time ? `<b>${esc(it.time)}</b> ` : ''}${esc(it.text)}</span>`
      ).join('');
      const more = items.length > 3 ? `<span class="more">+${items.length - 3}</span>` : '';
      const note = day.notes.trim() ? '<i class="note" aria-label="Notas"></i>' : '';
      const cls = ['cell', k === tKey ? 'today' : '', dow(date) >= 5 ? 'weekend' : ''].filter(Boolean).join(' ');
      cells += `<a class="${cls}" href="#${k}"><span class="num"><span class="n">${d}</span>${note}</span><span class="evs">${evs}${more}</span></a>`;
    }
    cells += '<div class="cell blank"></div>'.repeat((7 - ((lead + nDays) % 7)) % 7);

    viewEl.innerHTML = `
      <section class="month">
        <div class="mhead">
          <h1><span class="mname">${MONTHS[m]}</span> <span class="myear">${y}</span></h1>
          <div class="arrows">${arrow('prev', prevHref, 'Mes anterior')}${arrow('next', nextHref, 'Mes siguiente')}</div>
        </div>
        <div class="mbody">
          <aside class="mpanel" id="mpanel">
            <div class="ptabs">
              <button type="button" data-tab="text">Texto</button>
              <button type="button" data-tab="ink">A mano</button>
            </div>
            <div class="parea">
              <textarea class="ptext" placeholder="Notas de ${MONTHS[m]}…"></textarea>
              <canvas class="pink" aria-label="Notas a mano"></canvas>
            </div>
            <div class="ptools">
              ${INK_COLORS.map((c, i) => `<button type="button" class="pcol${i === 0 ? ' on' : ''}" data-c="${c}" style="--c:${c}" aria-label="Color"></button>`).join('')}
              <span class="psep"></span>
              <button type="button" class="ptool" data-tool="eraser" aria-label="Goma">Goma</button>
              <button type="button" class="ptool" data-tool="undo" aria-label="Deshacer">↶</button>
              <button type="button" class="ptool" data-tool="clear" aria-label="Borrar todo">Borrar</button>
            </div>
          </aside>
          <div class="mcal">
            <div class="grid wd">${WEEKDAYS_SHORT.map(w => `<span>${w}</span>`).join('')}</div>
            <div class="grid days">${cells}</div>
          </div>
        </div>
      </section>`;
    bindPanel(monthKey(y, m));
  }

  // ---------- Month notes panel ----------
  function preferredTab() {
    try { const t = localStorage.getItem('agenda-panel-tab'); if (t === 'text' || t === 'ink') return t; } catch (e) { /* storage unavailable */ }
    return matchMedia('(pointer: coarse)').matches && window.innerWidth >= 760 ? 'ink' : 'text';
  }

  function bindPanel(mk) {
    const k = `m:${mk}`;
    const panel = $('#mpanel', viewEl);
    const text = $('.ptext', panel);
    const canvas = $('.pink', panel);
    const tools = $('.ptools', panel);
    const tabBtns = [...panel.querySelectorAll('[data-tab]')];
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0;
    let tool = 'pen';
    let penColor = INK_COLORS[0];
    let current = null;
    let erasing = false;

    // Text tab
    text.value = getMonth(mk).notes;
    text.addEventListener('input', () => { ensureMonth(mk).notes = text.value; queueSave(k); markTabs(); });

    function markTabs() {
      const d = getMonth(mk);
      tabBtns[0].classList.toggle('has', !!d.notes.trim());
      tabBtns[1].classList.toggle('has', d.ink.length > 0);
    }

    function setTab(t) {
      try { localStorage.setItem('agenda-panel-tab', t); } catch (e) { /* storage unavailable */ }
      tabBtns.forEach(b => b.classList.toggle('on', b.dataset.tab === t));
      text.hidden = t !== 'text';
      canvas.hidden = t !== 'ink';
      tools.hidden = t !== 'ink';
      if (t === 'ink') resize();
    }
    tabBtns.forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

    // Ink rendering
    const widthAt = pr => 1.6 * (0.35 + pr * 1.3) * (W / INK_REF_W);

    function drawSegment(c, x0, y0, x1, y1, pr) {
      const u = W / INK_SCALE;
      ctx.strokeStyle = c;
      ctx.lineWidth = widthAt(pr);
      ctx.beginPath();
      ctx.moveTo(x0 * u, y0 * u);
      ctx.lineTo(x1 * u, y1 * u);
      ctx.stroke();
    }

    function drawStroke(st) {
      const p = st.p;
      if (p.length === 3) { drawSegment(st.c, p[0], p[1], p[0] + 1, p[1], p[2] / 100); return; }
      for (let i = 3; i < p.length; i += 3) drawSegment(st.c, p[i - 3], p[i - 2], p[i], p[i + 1], (p[i - 1] + p[i + 2]) / 200);
    }

    function redraw() {
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      getMonth(mk).ink.forEach(drawStroke);
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = window.devicePixelRatio || 1;
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }

    if (panelObserver) panelObserver.disconnect();
    panelObserver = new ResizeObserver(() => { if (!canvas.hidden) resize(); });
    panelObserver.observe(canvas);

    // Ink input: Apple Pencil and mouse draw; fingers keep scrolling
    const toUnits = ev => {
      const r = canvas.getBoundingClientRect();
      return [Math.round((ev.clientX - r.left) / W * INK_SCALE), Math.round((ev.clientY - r.top) / W * INK_SCALE)];
    };

    function addPoint(ev) {
      const [x, y] = toUnits(ev);
      const pr = Math.round((ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5) * 100);
      const p = current.p;
      const n = p.length;
      if (n && Math.abs(p[n - 3] - x) < 4 && Math.abs(p[n - 2] - y) < 4) return;
      p.push(x, y, pr);
      if (n) drawSegment(current.c, p[n - 3], p[n - 2], x, y, (p[n - 1] + pr) / 200);
      else drawSegment(current.c, x, y, x + 1, y, pr / 100);
    }

    function eraseAt(ev) {
      const [x, y] = toUnits(ev);
      const rad = 14 / W * INK_SCALE;
      const d = getMonth(mk);
      const keep = d.ink.filter(st => {
        for (let i = 0; i < st.p.length; i += 3) if (Math.hypot(st.p[i] - x, st.p[i + 1] - y) < rad) return false;
        return true;
      });
      if (keep.length !== d.ink.length) { ensureMonth(mk).ink = keep; redraw(); queueSave(k); markTabs(); }
    }

    ['touchstart', 'touchmove'].forEach(type => canvas.addEventListener(type, e => {
      if ([...e.touches].some(t => t.touchType === 'stylus')) e.preventDefault();
    }, { passive: false }));

    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || e.button > 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (tool === 'eraser') { erasing = true; eraseAt(e); return; }
      ctx.lineCap = 'round';
      current = { c: penColor, p: [] };
      addPoint(e);
    });
    canvas.addEventListener('pointermove', e => {
      if (current) (e.getCoalescedEvents ? e.getCoalescedEvents() : [e]).forEach(addPoint);
      else if (erasing) eraseAt(e);
    });
    const endStroke = () => {
      if (current && current.p.length) { ensureMonth(mk).ink.push(current); queueSave(k); markTabs(); }
      current = null;
      erasing = false;
    };
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);

    // Toolbar
    tools.addEventListener('click', e => {
      const col = e.target.closest('[data-c]');
      if (col) {
        penColor = col.dataset.c;
        tool = 'pen';
        tools.querySelectorAll('.pcol').forEach(b => b.classList.toggle('on', b === col));
        tools.querySelector('[data-tool="eraser"]').classList.remove('on');
        return;
      }
      const t = e.target.closest('[data-tool]');
      if (!t) return;
      const d = getMonth(mk);
      if (t.dataset.tool === 'eraser') {
        tool = tool === 'eraser' ? 'pen' : 'eraser';
        t.classList.toggle('on', tool === 'eraser');
      } else if (t.dataset.tool === 'undo' && d.ink.length) {
        d.ink.pop(); redraw(); queueSave(k); markTabs();
      } else if (t.dataset.tool === 'clear' && d.ink.length && confirm('¿Borrar todo lo escrito a mano este mes?')) {
        ensureMonth(mk).ink = []; redraw(); queueSave(k); markTabs();
      }
    });

    markTabs();
    setTab(preferredTab());
  }

  // ---------- Day view ----------
  function renderDay(date, focusAdd) {
    closePalette();
    if (panelObserver) { panelObserver.disconnect(); panelObserver = null; }
    const k = keyOf(date);
    const day = getDay(k);
    const y = date.getFullYear(), m = date.getMonth();
    renderStrip(y, m);
    document.title = `${date.getDate()} de ${MONTHS[m]} · Agenda`;

    const prev = addDays(date, -1), next = addDays(date, 1);
    const isToday = k === keyOf(todayDate());
    const rows = sortItems(day.items).map(it => `
      <li class="item${it.done ? ' done' : ''}" data-id="${esc(it.id)}" style="--c:${it.color}">
        <button type="button" class="dot" data-act="color" aria-label="Cambiar color"></button>
        <input type="checkbox" class="check" data-act="done" ${it.done ? 'checked' : ''} aria-label="Hecho">
        <input type="time" class="time" data-act="time" value="${esc(it.time || '')}" aria-label="Hora">
        <input type="text" class="text" data-act="text" value="${esc(it.text)}" placeholder="Sin título">
        <button type="button" class="del" data-act="del" aria-label="Borrar">×</button>
      </li>`).join('');

    viewEl.innerHTML = `
      <section class="day">
        <div class="dhead">
          <a class="back" href="#${monthKey(y, m)}">← ${MONTHS[m]} ${y}</a>
          <div class="arrows">
            ${arrow('prev', inRange(prev) ? `#${keyOf(prev)}` : null, 'Día anterior')}
            ${arrow('next', inRange(next) ? `#${keyOf(next)}` : null, 'Día siguiente')}
          </div>
        </div>
        <h1 class="dtitle">
          <span class="wday">${WEEKDAYS[dow(date)]}${isToday ? '<em>hoy</em>' : ''}</span>
          <span class="dnum">${date.getDate()}</span>
          <span class="dmon">${MONTHS[m]} ${y}</span>
        </h1>
        <ul class="items">${rows}</ul>
        <form class="add" id="addForm" autocomplete="off">
          <button type="button" class="dot" id="addColor" style="--c:${currentColor}" aria-label="Color"></button>
          <input type="time" class="time" id="addTime" aria-label="Hora">
          <input type="text" class="text" id="addText" placeholder="Añadir…" enterkeyhint="done">
          <button type="submit" class="addbtn">Añadir</button>
        </form>
        <label class="notes-label" for="notes">Notas</label>
        <textarea id="notes" class="notes" placeholder="Lo que quieras apuntar de este día…">${esc(day.notes)}</textarea>
      </section>`;

    bindDay(k);
    if (focusAdd) $('#addText').focus();
  }

  function bindDay(k) {
    const list = $('.items', viewEl);
    const itemOf = li => li && getDay(k).items.find(i => i.id === li.dataset.id);

    list.addEventListener('input', e => {
      const it = itemOf(e.target.closest('.item'));
      if (!it) return;
      const act = e.target.dataset.act;
      if (act === 'text') it.text = e.target.value;
      else if (act === 'time') it.time = e.target.value;
      else return;
      queueSave(k);
    });

    list.addEventListener('change', e => {
      if (e.target.dataset.act !== 'done') return;
      const li = e.target.closest('.item');
      const it = itemOf(li);
      if (!it) return;
      it.done = e.target.checked;
      li.classList.toggle('done', it.done);
      queueSave(k);
    });

    list.addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const li = btn.closest('.item');
      const it = itemOf(li);
      if (!it) return;
      if (btn.dataset.act === 'del') {
        if (it.text.trim() && !confirm(`¿Borrar «${it.text.trim()}»?`)) return;
        const d = getDay(k);
        d.items = d.items.filter(i => i !== it);
        li.remove();
        queueSave(k);
      } else if (btn.dataset.act === 'color') {
        openPalette(btn, c => { it.color = c; li.style.setProperty('--c', c); queueSave(k); });
      }
    });

    const addColor = $('#addColor');
    addColor.addEventListener('click', () => openPalette(addColor, c => {
      currentColor = c;
      addColor.style.setProperty('--c', c);
    }));

    $('#addForm').addEventListener('submit', e => {
      e.preventDefault();
      const text = $('#addText').value.trim();
      if (!text) { $('#addText').focus(); return; }
      ensureDay(k).items.push({ id: newId(), text, time: $('#addTime').value || '', color: currentColor, done: false });
      queueSave(k);
      renderDay(parseKey(k), true);
    });

    const notes = $('#notes');
    const grow = () => { notes.style.height = 'auto'; notes.style.height = `${notes.scrollHeight + 2}px`; };
    notes.addEventListener('input', () => { ensureDay(k).notes = notes.value; queueSave(k); grow(); });
    grow();
  }

  // ---------- Routing ----------
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (/^\d{4}-\d{2}-\d{2}$/.test(h)) {
      const d = parseKey(h);
      if (inRange(d)) { renderDay(d); window.scrollTo(0, 0); return; }
    }
    if (/^\d{4}-\d{2}$/.test(h)) {
      const d = parseKey(h);
      if (inRange(d)) { renderMonth(d.getFullYear(), d.getMonth()); window.scrollTo(0, 0); return; }
    }
    const t = clamp(todayDate());
    renderMonth(t.getFullYear(), t.getMonth());
  }

  // ---------- Session ----------
  function showLogin() {
    appEl.hidden = true;
    loginEl.hidden = false;
    $('#loginBtn').disabled = false;
  }

  async function start(session) {
    user = session.user;
    loginEl.hidden = true;
    appEl.hidden = false;
    setStatus('Cargando…', 'busy');
    viewEl.innerHTML = '';
    await loadAll();
    route();
    if (started) return;
    started = true;

    window.addEventListener('hashchange', route);
    $('#todayBtn').addEventListener('click', () => {
      const k = keyOf(clamp(todayDate()));
      if (location.hash === `#${k}`) route(); else location.hash = k;
    });
    $('#logoutBtn').addEventListener('click', async () => {
      flushAll();
      await sb.auth.signOut();
    });
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'hidden') { flushAll(); return; }
      if (await loadAll() && !isTyping() && !palette) route();
    });
    window.addEventListener('pagehide', flushAll);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && palette) { closePalette(); return; }
      if (appEl.hidden || isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.key === 'ArrowLeft' ? $('[data-nav="prev"]', viewEl)
        : e.key === 'ArrowRight' ? $('[data-nav="next"]', viewEl)
        : e.key === 'Escape' ? $('.back', viewEl) : null;
      if (target) target.click();
    });
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#loginBtn'), msg = $('#loginMsg');
    btn.disabled = true;
    msg.textContent = '';
    const { data, error } = await sb.auth.signInWithPassword({
      email: $('#email').value.trim(),
      password: $('#password').value
    });
    if (error) {
      msg.textContent = 'Email o contraseña incorrectos.';
      btn.disabled = false;
      return;
    }
    $('#password').value = '';
    start(data.session);
  });

  sb.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') {
      days.clear();
      user = null;
      showLogin();
    }
  });

  (async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (session) start(session); else showLogin();
  })();
})();
