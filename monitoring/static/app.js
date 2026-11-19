'use strict';
// Desktop panel, shared by three routes: / (vivo), /nodos and /historial.
// <body data-page> says which parts exist. Depends on comun.js (window.Monitor).
const M = window.Monitor;
const $ = id => document.getElementById(id);
const PAGE = document.body.dataset.page;
const CONTEXT_LABELS = { dry_test: 'Prueba en seco', culture: 'En cultivo', unknown: 'Contexto desconocido' };
const dateTime = new Intl.DateTimeFormat('es-CL', { timeZone: M.TZ, dateStyle: 'short', timeStyle: 'short' });
const dayFormat = new Intl.DateTimeFormat('es-CL', { timeZone: M.TZ, day: '2-digit', month: '2-digit' });
const RING = 2 * Math.PI * 27;
const SPARK_REFRESH = 2 * 60 * 1000;
const reduce = M.reducedMotion();

let devices = [], fetchedAt = performance.now(), gatewayLabel = '', initialized = false;
const hidden = M.loadHidden();
const cards = new Map(), minis = new Map(), seen = new Map(), arrivals = new Map(), sparks = new Map();
let log = [], chipSignature = null, marksSignature = null, tagSignature = null, algaSize = { cols: 80, rows: 38 };
let editing = null, historyBusy = false, historyAbort = null, historyRequest = 0;
let requestedDevice = new URLSearchParams(location.search).get('nodo');

const elapsed = () => (performance.now() - fetchedAt) / 1000;
const visible = () => devices.filter(d => !hidden.has(d._id));
const statesNow = () => { const e = elapsed(); return new Map(devices.map(d => [d._id, M.status(d, e)])); };

function fit(text, width) {
  const s = String(text);
  return (s.length > width - 1 ? s.slice(0, width - 2) + '…' : s).padEnd(width);
}

// ---------- Live data (all routes) ----------
async function refresh() {
  try {
    const data = await M.json('/api/v1/devices');
    fetchedAt = performance.now();
    gatewayLabel = data.gateway_id || '';
    for (const d of data.devices) {
      const at = d.latest?.received_at;
      if (!at || seen.get(d._id) === at) continue;
      if (initialized) arrivals.set(d._id, performance.now());
      seen.set(d._id, at);
      addLog(d);
    }
    initialized = true;
    devices = data.devices;
    devices.forEach((d, i) => { d.num = i + 1; });
    $('connection').dataset.state = 'online';
    $('connection-text').textContent = (data.central_available ? 'Central conectado' : 'Central sin conexión · copia local') + ' · ' + data.pending_records + ' envíos pendientes';
    if ($('chips')) renderChips();
    if (PAGE === 'vivo') renderStrip();
    if (PAGE === 'nodos') { renderCards(); loadSparks(); }
    if (PAGE === 'historial') renderSelect();
    tick();
    if (PAGE === 'historial' && !historyBusy) await loadHistory();
  } catch (e) {
    $('connection').dataset.state = 'offline';
    $('connection-text').textContent = 'Sin conexión con el panel · ' + e.message;
  }
}

function addLog(d) {
  const at = new Date(d.latest.received_at);
  const parts = Object.entries(d.latest.measurements || {}).map(([k, m]) =>
    M.short(k) + '=' + (m.quality === 'invalid' ? 'inválida' : M.number(m.value, M.decimals(k))));
  // Older readings carry their day so yesterday's 18:46 is not read as today's.
  const when = (dayFormat.format(at) === dayFormat.format(new Date()) ? M.clock(at) : dayFormat.format(at) + ' ' + M.clock(at).slice(0, 5)).padEnd(11);
  log.push({ id: d._id, at: +at, text: when + '  ' + fit(M.name(d), 18) + parts.join('  ') });
  log.sort((a, b) => b.at - a.at);
  log = log.slice(0, 16);
}

// ---------- Node selector (shared with /pared through localStorage) ----------
function renderChips() {
  const signature = devices.map(d => d._id + '|' + M.name(d)).join(',');
  if (signature === chipSignature) return;
  chipSignature = signature;
  $('chips').replaceChildren(...devices.map(d => {
    const chip = M.el('button', 'chip'), dot = M.el('span', 'state-dot');
    chip.type = 'button';
    chip.dataset.id = d._id;
    dot.setAttribute('aria-hidden', 'true');
    chip.append(M.el('span', 'chip-num', String(d.num)), M.el('span', 'chip-name', M.name(d)), dot);
    chip.onclick = () => toggle(d._id);
    return chip;
  }));
}

function updateChips(states) {
  for (const chip of $('chips').children) {
    const d = devices.find(x => x._id === chip.dataset.id);
    if (!d) continue;
    const st = states.get(d._id);
    chip.setAttribute('aria-pressed', String(!hidden.has(d._id)));
    chip.dataset.state = st.state;
    chip.setAttribute('aria-label', 'Nodo ' + d.num + ', ' + M.name(d) + ', ' + M.STATES[st.state].toLowerCase());
  }
  $('visible-count').textContent = visible().length + ' de ' + devices.length + ' visibles';
  $('show-all').hidden = !devices.some(d => hidden.has(d._id));
}

function selectionChanged() {
  M.saveHidden(hidden);
  if (PAGE === 'vivo') { renderStrip(); measureAlga(); }
  if (PAGE === 'nodos') { renderCards(); loadSparks(); }
  tick();
}

function toggle(id) {
  if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
  selectionChanged();
}

// ---------- En vivo ----------
function buildMini() {
  const root = M.el('a', 'mini');
  root.href = '/nodos';
  const top = M.el('span', 'mini-top'), num = M.el('span', 'mini-num'), name = M.el('span', 'mini-name'), dot = M.el('span', 'state-dot');
  dot.setAttribute('aria-hidden', 'true');
  top.append(num, name, dot);
  const values = M.el('span', 'mini-values'), state = M.el('span', 'mini-state'), bar = M.el('span', 'mini-bar'), fill = M.el('span');
  bar.append(fill);
  root.append(top, values, state, bar);
  return { root, num, name, values, state, fill };
}

function renderStrip() {
  const list = visible(), box = $('strip'), ids = new Set(list.map(d => d._id));
  for (const [id, m] of minis) if (!ids.has(id)) { m.root.remove(); minis.delete(id); }
  list.forEach((d, i) => {
    let m = minis.get(d._id);
    if (!m) { m = buildMini(); minis.set(d._id, m); }
    m.device = d;
    m.num.textContent = d.num;
    m.name.textContent = M.name(d);
    const entries = Object.entries(d.latest?.measurements || {}).slice(0, 2);
    m.values.replaceChildren(...(entries.length ? entries.map(([k, v]) => {
      const item = M.el('span', 'mini-value');
      if (v.quality === 'invalid') item.append(M.el('em', '', M.label(k) + ': sin lectura válida'));
      else item.append(M.el('strong', '', M.number(v.value, M.decimals(k))), M.el('span', '', v.unit || M.label(k)));
      return item;
    }) : [M.el('span', 'mini-wait', 'Sin mediciones todavía')]));
    if (box.children[i] !== m.root) box.insertBefore(m.root, box.children[i] || null);
  });
  $('strip-empty').hidden = list.length > 0;
  $('strip-empty').textContent = devices.length ? 'No hay nodos en pantalla. Elige al menos uno en la barra de arriba.' : 'Esperando la primera señal de los ESP32.';
}

function updateStrip(states) {
  const now = performance.now();
  for (const m of minis.values()) {
    const st = states.get(m.device._id);
    if (!st) continue;
    const r = M.ring(st);
    m.root.dataset.state = st.state;
    m.root.classList.toggle('fresh', now - (arrivals.get(m.device._id) ?? -1e9) < 1800);
    m.state.textContent = M.STATES[st.state] + (st.age == null ? '' : ' · hace ' + M.ageText(st.age));
    m.fill.style.width = (st.state === 'stale' || st.state === 'waiting' ? 0 : r.progress * 100) + '%';
    const values = Object.entries(m.device.latest?.measurements || {}).slice(0, 2)
      .map(([k, v]) => M.label(k) + ' ' + (v.quality === 'invalid' ? 'sin lectura válida' : M.number(v.value, M.decimals(k)) + ' ' + (v.unit || ''))).join(', ');
    m.root.setAttribute('aria-label', 'Nodo ' + m.device.num + ', ' + M.name(m.device) + ': ' + M.STATES[st.state].toLowerCase() + (values ? '. ' + values : '') + '. ' + r.aria + '. Ver en Nodos');
  }
}

function renderHero(states) {
  const list = visible(), c = M.counts(list.map(d => states.get(d._id)));
  $('hero-status').textContent = list.length ? M.summary(c) : 'Sin nodos en pantalla';
  const withData = list.filter(d => states.get(d._id).age != null);
  const newest = withData.sort((a, b) => states.get(a._id).age - states.get(b._id).age)[0];
  $('last-signal').textContent = newest ? 'Última señal: ' + M.name(newest) + ' · hace ' + M.ageText(states.get(newest._id).age) : 'Esperando la primera señal';
  const focus = list.find(d => d.latest);
  const signature = focus ? focus._id + focus.latest.received_at + M.name(focus) : '';
  if (signature !== tagSignature) {
    tagSignature = signature;
    const tags = !focus ? [] : Object.entries(focus.latest.measurements || {})
      .filter(([, m]) => m.quality !== 'invalid').slice(0, 2)
      .map(([k, m]) => {
        const tag = M.el('span', 'hero-tag');
        tag.append(M.el('strong', '', M.number(m.value, M.decimals(k)) + (m.unit && m.unit !== 'pH' ? ' ' + m.unit : '')), M.el('span', '', M.label(k) + ' · ' + M.name(focus)));
        return tag;
      });
    $('hero-tags').replaceChildren(...tags);
  }
  const all = M.counts(devices.map(d => states.get(d._id)));
  $('net-label').textContent = all.ok + ' de ' + devices.length + ' al día' + (devices.length > 6 ? ' · se muestran 6' : '');
  $('net-wrap').setAttribute('aria-label', 'Red de sensores: ' + (devices.length ? M.summary(all) : 'sin módulos todavía'));
  const mood = c.ok ? 'gira y respira: hay nodos al día' : c.late ? 'se mueve lenta: los nodos visibles están atrasados' : 'se desarma: no hay lecturas recientes en pantalla';
  $('alga-wrap').setAttribute('aria-label', 'Microalga animada que ' + mood);
}

// Size the microalga to whatever room the hero has on this screen.
function measureAlga() {
  const art = $('alga-wrap'), pre = $('alga');
  if (!art) return;
  const size = parseFloat(getComputedStyle(pre).fontSize) || 10, charW = size * 0.6, lineH = size * 1.2;
  const rows = Math.max(14, Math.min(60, Math.floor((art.clientHeight - 32) / lineH)));
  const cols = Math.max(30, Math.min(Math.floor(art.clientWidth / charW) - 4, Math.round(rows * 2.1)));
  algaSize = { cols, rows: Math.min(rows, Math.floor(cols / 1.8)) };
}

function drawAscii(states) {
  const c = M.counts(visible().map(d => states.get(d._id)));
  const energy = c.ok ? 1 : c.late ? 0.45 : 0.1;
  $('alga').textContent = M.alga(reduce ? 1.7 : performance.now() / 1000, algaSize.cols, algaSize.rows, energy, false);
  const nodes = devices.map(d => ({ state: states.get(d._id).state, packet: arrivals.has(d._id) ? (performance.now() - arrivals.get(d._id)) / 1000 : null }));
  $('net').textContent = M.network(nodes, gatewayLabel);
}

function renderPh(states) {
  const marks = [];
  for (const d of visible()) {
    const st = states.get(d._id), m = d.latest?.measurements?.ph;
    if (!m || m.quality === 'invalid' || st.state === 'stale' || st.state === 'waiting') continue;
    marks.push({ num: d.num, value: m.value, state: st.state });
  }
  const signature = marks.map(m => m.num + ':' + m.value + ':' + m.state).join('|');
  if (signature === marksSignature) return;
  marksSignature = signature;
  const values = marks.map(m => m.value);
  const lo = Math.min(6, ...values.map(Math.floor)), hi = Math.max(9, ...values.map(Math.ceil)), span = hi - lo;
  const step = span > 4 ? 2 : 1, ticks = [];
  for (let v = hi; v >= lo; v -= step) {
    const tick = M.el('span', 'ph-tick', String(v));
    tick.style.top = ((hi - v) / span * 100) + '%';
    ticks.push(tick);
  }
  $('ph-ticks').replaceChildren(...ticks);
  $('ph-marks').replaceChildren(...marks.map(m => {
    const mark = M.el('div', 'ph-mark');
    mark.dataset.state = m.state;
    mark.style.top = ((hi - m.value) / span * 100) + '%';
    mark.append(M.el('span', '', String(m.num)), M.el('span', '', M.number(m.value, 2)));
    return mark;
  }));
  $('ph-range').textContent = !values.length ? '—' : values.length === 1 ? M.number(values[0], 2)
    : M.number(Math.min(...values), 2) + '–' + M.number(Math.max(...values), 2);
  $('ph-caption').textContent = values.length ? 'Última lectura de ' + values.length + (values.length === 1 ? ' nodo visible' : ' nodos visibles') + ' con pH reciente' : 'Ningún nodo visible con pH reciente';
  $('ph-scale').setAttribute('aria-label', 'Escala de pH de ' + lo + ' a ' + hi + (marks.length ? ': ' + marks.map(m => 'nodo ' + m.num + ' en ' + M.number(m.value, 2)).join(', ') : ', sin lecturas'));
}

function renderLog(states) {
  const shown = new Set(visible().map(d => d._id));
  const alerts = visible()
    .map(d => [d, states.get(d._id)])
    .filter(([, st]) => st.state === 'late' || st.state === 'stale')
    .map(([d, st]) => (st.state === 'late' ? '!! ' : '?? ') + fit(M.name(d), 18) + (st.state === 'late' ? 'atrasado' : 'sin datos') + ' · hace ' + M.ageText(st.age));
  const lines = log.filter(l => shown.has(l.id)).map(l => l.text);
  $('log').textContent = alerts.concat(lines).join('\n') || 'Esperando lecturas…';
}

// ---------- Nodos ----------
function buildCard() {
  const root = M.el('article', 'node-card');
  const head = M.el('div', 'node-head'), ident = M.el('div', 'node-id'), titles = M.el('div', 'node-titles');
  const num = M.el('span', 'node-num'), kind = M.el('span', 'node-kind'), name = M.el('h2', 'node-name'), place = M.el('span', 'node-place');
  num.setAttribute('aria-hidden', 'true');
  titles.append(kind, name, place);
  ident.append(num, titles);
  const ring = M.el('div', 'ring');
  ring.setAttribute('role', 'img');
  const svg = M.svg('svg', { viewBox: '0 0 64 64', width: 64, height: 64, 'aria-hidden': 'true' });
  const progress = M.svg('circle', { class: 'ring-progress', cx: 32, cy: 32, r: 27, 'stroke-dasharray': '0 ' + RING.toFixed(1) });
  svg.append(M.svg('circle', { class: 'ring-track', cx: 32, cy: 32, r: 27 }), progress);
  const ringText = M.el('span', 'ring-text');
  ringText.setAttribute('aria-hidden', 'true');
  ring.append(svg, ringText);
  head.append(ident, ring);
  const metrics = M.el('div', 'metrics');
  const tags = M.el('div', 'node-tags'), pill = M.el('span', 'state-pill'), pillText = M.el('span');
  pill.append(M.el('span', 'state-dot'), pillText);
  const ctx = M.el('span', 'tag'), quality = M.el('span', 'tag'), hour = M.el('span', 'tag');
  tags.append(pill, ctx, quality, hour);
  const foot = M.el('div', 'node-foot'), meta = M.el('div', 'node-meta'), age = M.el('span', 'node-age'), ids = M.el('span', 'node-ids');
  meta.append(age, ids);
  const actions = M.el('div', 'node-actions'), history = M.el('a', 'pill-button', 'Historial'), edit = M.el('button', 'pill-button', 'Configurar');
  edit.type = 'button';
  actions.append(history, edit);
  foot.append(meta, actions);
  root.append(head, metrics, tags, foot);
  return { root, num, kind, name, place, ring, progress, ringText, metrics, pillText, ctx, quality, hour, age, ids, history, edit, keys: null, tiles: new Map() };
}

function fillCard(c, d) {
  c.device = d;
  c.num.textContent = d.num;
  c.kind.textContent = M.source(d);
  c.name.textContent = M.name(d);
  c.place.textContent = d.location || 'Ubicación sin asignar';
  c.ids.textContent = d.gateway_id + ' · ' + d.device_id;
  c.history.href = '/historial?nodo=' + encodeURIComponent(d._id);
  c.history.setAttribute('aria-label', 'Historial de ' + M.name(d));
  c.edit.onclick = () => openEditor(d);
  c.edit.setAttribute('aria-label', 'Configurar ' + M.name(d));
  const measurements = d.latest?.measurements || {};
  c.ctx.textContent = M.context(d.latest?.context || d.context);
  const qualities = Object.values(measurements).map(m => m.quality);
  c.quality.textContent = !qualities.length ? 'Sin mediciones'
    : qualities.every(q => q === 'valid') ? 'Calidad válida'
    : qualities.includes('invalid') ? 'Con lecturas inválidas' : 'Calidad no verificada';
  const rows = sparks.get(d._id)?.rows;
  const coverage = hourCoverage(rows);
  c.hour.hidden = !coverage;
  if (coverage) c.hour.textContent = 'Hora en curso: ' + coverage.count + ' de ' + coverage.gone + ' min';
  const keys = Object.keys(measurements).join(',');
  if (keys !== c.keys) {
    c.keys = keys;
    c.tiles.clear();
    if (!keys) c.metrics.replaceChildren(M.el('p', 'spark-empty', 'Sin mediciones todavía'));
    else c.metrics.replaceChildren(...Object.keys(measurements).map(k => {
      const tile = M.el('div', 'metric'), value = M.el('span', 'metric-value'), spark = M.el('div', 'metric-spark'), range = M.el('span', 'metric-range');
      tile.append(M.el('span', 'metric-label', M.label(k)), value, spark, range);
      c.tiles.set(k, { value, spark, range });
      return tile;
    }));
  }
  for (const [k, m] of Object.entries(measurements)) {
    const tile = c.tiles.get(k);
    if (m.quality === 'invalid') tile.value.replaceChildren(M.el('span', 'invalid', 'Sin lectura válida'));
    else tile.value.replaceChildren(M.el('strong', '', M.number(m.value, M.decimals(k))), M.el('span', '', m.unit || ''));
    drawSpark(tile.spark, d, k);
    const r = range24(rows, k);
    tile.range.textContent = r ? '24 h: ' + M.number(r.min, M.decimals(k)) + ' – ' + M.number(r.max, M.decimals(k)) + ' ' + (m.unit || '') : '';
  }
}

function setColumns() {
  const box = $('devices'), count = visible().length;
  let cols = count <= 1 ? 1 : count <= 4 ? count : count <= 6 ? 3 : 4;
  cols = Math.max(1, Math.min(cols, Math.floor((box.clientWidth || window.innerWidth) / 300)));
  box.style.setProperty('--cols', String(cols));
}

function renderCards() {
  const list = visible(), box = $('devices'), ids = new Set(list.map(d => d._id));
  for (const [id, c] of cards) if (!ids.has(id)) { c.root.remove(); cards.delete(id); }
  list.forEach((d, i) => {
    let c = cards.get(d._id);
    if (!c) { c = buildCard(); cards.set(d._id, c); }
    fillCard(c, d);
    if (box.children[i] !== c.root) box.insertBefore(c.root, box.children[i] || null);
  });
  setColumns();
  $('empty').hidden = devices.length > 0;
  $('none-visible').hidden = !(devices.length && !list.length);
}

function updateCards(states) {
  const now = performance.now();
  for (const c of cards.values()) {
    const st = states.get(c.device._id);
    if (!st) continue;
    const r = M.ring(st);
    c.root.dataset.state = st.state;
    c.progress.setAttribute('stroke-dasharray', (r.progress * RING).toFixed(1) + ' ' + RING.toFixed(1));
    c.ringText.textContent = r.text;
    c.ring.setAttribute('aria-label', r.aria);
    c.pillText.textContent = M.STATES[st.state];
    const every = c.device.expected_interval_seconds ? 'se espera cada ' + c.device.expected_interval_seconds + ' s' : 'intervalo sin configurar';
    c.age.textContent = (st.age == null ? 'Sin lecturas todavía' : 'Última señal hace ' + M.ageText(st.age)) + ' · ' + every;
    c.root.classList.toggle('fresh', now - (arrivals.get(c.device._id) ?? -1e9) < 1800);
  }
}

// Hourly means of the last 24 h, oldest first; null marks an hour without data.
function hourlySlots(rows, key) {
  if (!rows) return [];
  const end = Math.floor(Date.now() / 3600000), sums = Array(24).fill(0), weights = Array(24).fill(0);
  for (const r of rows) {
    const m = r.measurements?.[key];
    if (!m || typeof m.value !== 'number') continue;
    const slot = 23 - (end - Math.floor(Date.parse(r.timestamp) / 3600000));
    if (slot < 0 || slot > 23) continue;
    const w = r.summary?.[key]?.count || 1;
    sums[slot] += m.value * w;
    weights[slot] += w;
  }
  return sums.map((s, i) => weights[i] ? s / weights[i] : null);
}

function range24(rows, key) {
  const stats = (rows || []).map(r => r.summary?.[key]).filter(s => s && typeof s.min === 'number');
  return stats.length ? { min: Math.min(...stats.map(s => s.min)), max: Math.max(...stats.map(s => s.max)) } : null;
}

function hourCoverage(rows) {
  if (!rows) return null;
  const hourStart = Math.floor(Date.now() / 3600000) * 3600000;
  const count = Math.min(60, rows.filter(r => Date.parse(r.timestamp) === hourStart).reduce((s, r) => s + (r.sample_count || 0), 0));
  return { count, gone: Math.min(60, Math.floor((Date.now() - hourStart) / 60000) + 1) };
}

function linePath(slots, width, height, pad) {
  const present = slots.filter(v => v != null);
  if (present.length < 2) return null;
  const lo = Math.min(...present), hi = Math.max(...present), span = hi - lo || 1;
  let line = '', area = '', seg = [];
  const flush = () => {
    if (seg.length > 1) {
      const d = 'M' + seg.map(p => p.join(' ')).join(' L');
      line += d + ' ';
      area += d + ' L' + seg[seg.length - 1][0] + ' ' + height + ' L' + seg[0][0] + ' ' + height + ' Z ';
    }
    seg = [];
  };
  slots.forEach((v, i) => {
    if (v == null) return flush();
    seg.push([(i / (slots.length - 1) * width).toFixed(1), (height - pad - (v - lo) / span * (height - 2 * pad)).toFixed(1)]);
  });
  flush();
  return { line: line.trim(), area: area.trim(), gaps: present.length < slots.length };
}

function drawSpark(box, d, key) {
  const entry = sparks.get(d._id);
  const path = entry?.rows ? linePath(hourlySlots(entry.rows, key), 120, 40, 3) : null;
  if (!path) {
    box.replaceChildren(M.el('span', 'spark-empty', entry?.rows ? 'Sin tendencia de 24 h' : 'Cargando tendencia…'));
    return;
  }
  const svg = M.svg('svg', { class: 'spark', viewBox: '0 0 120 40', preserveAspectRatio: 'none', role: 'img',
    'aria-label': M.label(key) + ': promedio por hora de las últimas 24 h' + (path.gaps ? ', con horas sin datos' : '') });
  svg.append(M.svg('path', { class: 'spark-area', d: path.area }), M.svg('path', { class: 'spark-line', d: path.line }));
  box.replaceChildren(svg);
}

async function loadSparks() {
  const now = Date.now();
  const due = visible().filter(d => d.latest && !sparks.get(d._id)?.loading && !(sparks.get(d._id)?.at > now - SPARK_REFRESH));
  if (!due.length) return;
  const start = new Date((Math.floor(now / 3600000) - 23) * 3600000).toISOString(), end = new Date(now + 1000).toISOString();
  await Promise.all(due.map(async d => {
    const previous = sparks.get(d._id) || {};
    sparks.set(d._id, Object.assign({}, previous, { loading: true }));
    try {
      const p = new URLSearchParams({ gateway: d.gateway_id, device: d.device_id, start, end, resolution: 'hour', mode: 'summary' });
      const data = await M.json('/api/v1/history?' + p);
      sparks.set(d._id, { at: Date.now(), rows: data.records });
    } catch (e) {
      // Keep what we had and retry in about a minute.
      sparks.set(d._id, { at: Date.now() - SPARK_REFRESH + 60000, rows: previous.rows || [] });
    }
  }));
  for (const c of cards.values()) fillCard(c, c.device);
}

// ---------- Every second ----------
function tick() {
  const states = statesNow();
  if ($('chips')) updateChips(states);
  if (PAGE === 'nodos') updateCards(states);
  if (PAGE === 'vivo') {
    updateStrip(states);
    renderHero(states);
    renderPh(states);
    renderLog(states);
    if (reduce || document.hidden) drawAscii(states);
  }
}

// ---------- Historial ----------
function dateChile(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: M.TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// Convert a Chilean calendar midnight without assuming a fixed DST offset.
function midnightChile(day) {
  const [y, m, d] = day.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: M.TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    t += Date.UTC(y, m - 1, d) - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }
  return new Date(t).toISOString();
}

function renderSelect() {
  const select = $('device'), current = select.value;
  const signature = devices.map(d => d._id + '|' + M.name(d)).join(',');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(...devices.map(d => { const o = M.el('option', '', d.num + ' · ' + M.name(d)); o.value = d._id; return o; }));
  }
  if (requestedDevice && devices.some(d => d._id === requestedDevice)) { select.value = requestedDevice; requestedDevice = null; }
  else if (devices.some(d => d._id === current)) select.value = current;
}

function params() {
  const selected = devices.find(d => d._id === $('device').value);
  if (!selected || !$('start').value || !$('end').value) return null;
  const endDay = new Date($('end').value + 'T12:00:00Z');
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  const p = new URLSearchParams({ gateway: selected.gateway_id, device: selected.device_id, start: midnightChile($('start').value),
    end: midnightChile(endDay.toISOString().slice(0, 10)), resolution: $('resolution').value, mode: $('mode').value });
  if ($('context').value) p.set('context', $('context').value);
  return p;
}

function plot(records, sensor, context, resolution) {
  const values = records.filter(r => r.context === context);
  const present = values.filter(r => r.measurements[sensor]);
  if (!present.length) return null;
  const card = M.el('div', 'chart');
  card.append(M.el('strong', '', M.label(sensor) + ' · ' + (CONTEXT_LABELS[context] || context)));
  const band = resolution === 'hour' && $('mode').value === 'summary' && present.some(r => r.summary?.[sensor]);
  const nums = present.flatMap(r => band && r.summary?.[sensor] ? [r.summary[sensor].min, r.summary[sensor].max, r.measurements[sensor].value] : [r.measurements[sensor].value]);
  const lo = Math.min(...nums), hi = Math.max(...nums), span = hi - lo || 1;
  const first = +new Date(values[0].timestamp), last = +new Date(values.at(-1).timestamp), duration = last - first || 1;
  const X = t => 10 + 480 * (t - first) / duration, Y = v => 130 - 110 * (v - lo) / span;
  const svg = M.svg('svg', { viewBox: '0 0 500 150', role: 'img',
    'aria-label': 'Serie de ' + M.label(sensor) + (band ? ' con banda entre el mínimo y el máximo de cada hora' : '') + '. Los huecos indican muestras ausentes.' });
  const gap = resolution === 'hour' ? 3600000 : 60000, unit = present[0].measurements[sensor].unit || '';
  let path = '', bandPath = '', prev = null, top = [], bottom = [];
  const dots = [];
  const flushBand = () => {
    if (top.length > 1) bandPath += 'M' + top.join(' L') + ' L' + bottom.reverse().join(' L') + ' Z ';
    top = []; bottom = [];
  };
  for (const row of values) {
    const v = row.measurements[sensor];
    if (!v) { prev = null; flushBand(); continue; }
    const t = +new Date(row.timestamp), x = X(t), y = Y(v.value), joined = prev !== null && t - prev <= gap * 1.1;
    if (!joined) flushBand();
    path += (joined ? ' L' : ' M') + x.toFixed(1) + ' ' + y.toFixed(1);
    const s = band && row.summary?.[sensor];
    if (s) { top.push(x.toFixed(1) + ' ' + Y(s.max).toFixed(1)); bottom.push(x.toFixed(1) + ' ' + Y(s.min).toFixed(1)); }
    if (present.length <= 240) {
      const circle = M.svg('circle', { class: 'chart-point', cx: x.toFixed(1), cy: y.toFixed(1), r: '2.5' });
      const title = M.svg('title');
      title.textContent = dateTime.format(new Date(t)) + ': ' + M.number(v.value) + ' ' + v.unit + (s ? ' (mín ' + M.number(s.min) + ' · máx ' + M.number(s.max) + ')' : '');
      circle.append(title);
      dots.push(circle);
    }
    prev = t;
  }
  flushBand();
  if (bandPath) svg.append(M.svg('path', { class: 'chart-band', d: bandPath.trim() }));
  svg.append(M.svg('path', { class: 'chart-line', d: path.trim() }), ...dots);
  card.append(svg);
  if (band) {
    const legend = M.el('div', 'chart-legend'), a = M.el('span'), b = M.el('span');
    a.append(M.el('i'), 'mínimo a máximo de la hora');
    b.append(M.el('i', 'line'), 'promedio');
    legend.append(a, b);
    card.append(legend);
  }
  card.append(M.el('div', 'range', 'Rango ' + M.number(lo) + ' – ' + M.number(hi) + ' ' + unit), M.el('div', 'range', dateTime.format(new Date(first)) + ' → ' + dateTime.format(new Date(last))));
  return card;
}

async function loadHistory() {
  if (historyAbort) historyAbort.abort();
  const request = ++historyRequest;
  historyAbort = new AbortController();
  const p = params();
  if (!p) { historyBusy = false; $('download').setAttribute('aria-disabled', 'true'); return; }
  historyBusy = true;
  $('history-status').textContent = 'Cargando mediciones…';
  $('download').setAttribute('aria-disabled', 'true');
  $('mode').disabled = $('resolution').value === 'minute';
  try {
    const d = await M.json('/api/v1/history?' + p, { signal: historyAbort.signal });
    if (request !== historyRequest) return;
    $('download').href = '/api/v1/export.csv?' + p;
    $('download').removeAttribute('aria-disabled');
    $('rows').replaceChildren();
    $('charts').replaceChildren();
    $('history-status').textContent = d.records.length
      ? d.records.length + ' registros · los contextos se muestran por separado. La hora actual puede estar incompleta.'
      : 'Sin datos en este rango. No se rellenan intervalos sin señal.';
    if (d.records.length > 200) $('history-status').textContent += ' Tabla: últimos 200 registros; el CSV incluye todos.';
    for (const r of d.records.slice(-200).reverse()) {
      const tr = M.el('tr');
      const text = Object.entries(r.measurements).map(([k, v]) => M.label(k) + ': ' + M.number(v.value) + ' ' + v.unit +
        (r.summary?.[k] ? ' (mín ' + M.number(r.summary[k].min) + ' · máx ' + M.number(r.summary[k].max) + ')' : '')).join(' · ');
      tr.append(M.el('td', '', dateTime.format(new Date(r.timestamp))), M.el('td', '', CONTEXT_LABELS[r.context] || r.context),
        M.el('td', '', text || 'Lectura puntual ausente'),
        M.el('td', '', d.resolution === 'hour' ? r.sample_count + '/60 minutos' + (!r.complete ? ' · parcial' : '') : '1 muestra'));
      $('rows').append(tr);
    }
    const sensors = new Set(d.records.flatMap(r => Object.keys(r.measurements)));
    for (const sensor of sensors) for (const context of new Set(d.records.map(r => r.context))) {
      const chart = plot(d.records, sensor, context, d.resolution);
      if (chart) $('charts').append(chart);
    }
  } catch (e) {
    if (e.name !== 'AbortError' && request === historyRequest) {
      $('history-status').textContent = e.message;
      $('download').setAttribute('aria-disabled', 'true');
    }
  } finally {
    if (request === historyRequest) historyBusy = false;
  }
}

// ---------- Editor (/nodos) ----------
function openEditor(d) {
  editing = d;
  $('alias').value = d.alias || d.device_id;
  $('location').value = d.location || '';
  $('edit-context').value = d.context || 'dry_test';
  $('interval').value = d.expected_interval_seconds || '';
  $('edit-error').textContent = '';
  $('editor').showModal();
}

if ($('editor')) {
  $('cancel').onclick = () => $('editor').close();
  $('edit-form').onsubmit = async e => {
    e.preventDefault();
    const body = { alias: $('alias').value, location: $('location').value, context: $('edit-context').value };
    const interval = parseInt($('interval').value, 10);
    if (interval > 0) body.expected_interval_seconds = interval;
    try {
      await M.json('/api/v1/devices/' + encodeURIComponent(editing.gateway_id) + '/' + encodeURIComponent(editing.device_id),
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      $('editor').close();
      await refresh();
    } catch (error) {
      $('edit-error').textContent = error.message;
    }
  };
}

// ---------- Start ----------
if ($('show-all')) $('show-all').onclick = () => { hidden.clear(); selectionChanged(); };
if (PAGE === 'historial') {
  $('filters').onsubmit = e => { e.preventDefault(); loadHistory(); };
  for (const id of ['device', 'mode', 'resolution', 'context', 'start', 'end']) $(id).onchange = loadHistory;
  $('start').value = $('end').value = dateChile(new Date());
}
if (PAGE === 'vivo') {
  measureAlga();
  if (window.ResizeObserver) new ResizeObserver(() => { measureAlga(); drawAscii(statesNow()); }).observe($('alga-wrap'));
  if (!reduce) setInterval(() => { if (!document.hidden) drawAscii(statesNow()); }, 110);
}
if (PAGE === 'nodos') window.addEventListener('resize', setColumns);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
refresh();
setInterval(refresh, M.POLL_SECONDS * 1000);
setInterval(tick, 1000);
