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
  const SAVE_DELAY = 700;
  const RETRY_DELAY = 5000;

  const sb = window.supabase.createClient(window.AGENDA_CONFIG.url, window.AGENDA_CONFIG.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  // ---------- State ----------
  const days = new Map();      // 'YYYY-MM-DD' -> { items: [], notes: '' }
  const timers = new Map();    // pending debounced saves
  const inFlight = new Set();  // days being written
  const dirty = new Set();     // days changed while being written
  let user = null;
  let started = false;
  let currentColor = COLORS[0];
  let palette = null;

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
  const isTyping = () => document.activeElement && document.activeElement.matches('input, textarea');

  // ---------- Status ----------
  function setStatus(text, kind) { statusEl.textContent = text; statusEl.dataset.kind = kind || ''; }
  function refreshStatus() {
    if (timers.size || inFlight.size) setStatus('Guardando…', 'busy');
    else setStatus('Guardado', 'ok');
  }

  // ---------- Persistence ----------
  async function loadAll() {
    const { data, error } = await sb.from('days')
      .select('day,items,notes')
      .gte('day', keyOf(FIRST))
      .lte('day', keyOf(LAST));
    if (error) { console.error(error); setStatus('Sin conexión', 'error'); return false; }
    const busy = k => timers.has(k) || inFlight.has(k);
    const remote = new Set();
    for (const row of data) {
      remote.add(row.day);
      if (busy(row.day)) continue;
      days.set(row.day, { items: Array.isArray(row.items) ? row.items : [], notes: row.notes || '' });
    }
    for (const k of [...days.keys()]) if (!remote.has(k) && !busy(k)) days.delete(k);
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
    const d = getDay(k);
    const isEmpty = !d.items.length && !d.notes.trim();
    const { error } = isEmpty
      ? await sb.from('days').delete().eq('user_id', user.id).eq('day', k)
      : await sb.from('days').upsert(
          { user_id: user.id, day: k, items: d.items, notes: d.notes, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,day' }
        );
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
        <div class="grid wd">${WEEKDAYS_SHORT.map(w => `<span>${w}</span>`).join('')}</div>
        <div class="grid days">${cells}</div>
      </section>`;
  }

  // ---------- Day view ----------
  function renderDay(date, focusAdd) {
    closePalette();
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
