'use strict';
// Wall display for the lab TV. Depends on comun.js (window.Monitor).
// Shows the nodes chosen in this browser's panel, or ?nodos=ID1,ID2 to pin them.
const M = window.Monitor;
const $ = id => document.getElementById(id);
const reduce = M.reducedMotion();
const BEAT_WINDOW = 300, MAX_TILES = 6;
const dateFormat = new Intl.DateTimeFormat('es-CL', { timeZone: M.TZ, weekday: 'long', day: 'numeric', month: 'long' });
const pinned = (() => {
  const value = new URLSearchParams(location.search).get('nodos');
  return value ? new Set(value.split(',').map(s => s.trim()).filter(Boolean)) : null;
})();
const hidden = M.loadHidden();

let devices = [], fetchedAt = performance.now(), serverOffset = 0, initialized = false;
let algaSize = { cols: 92, rows: 44 }, beatWidth = 200;
const seen = new Map(), arrivals = new Map(), beats = new Map(), tiles = new Map(), beatRows = new Map();

const elapsed = () => (performance.now() - fetchedAt) / 1000;
const serverNow = () => Date.now() + serverOffset;
function shown() {
  const list = pinned ? devices.filter(d => pinned.has(d.device_id) || pinned.has(d._id) || pinned.has(d.alias)) : devices.filter(d => !hidden.has(d._id));
  return list.slice(0, MAX_TILES);
}

async function refresh() {
  try {
    const data = await M.json('/api/v1/devices');
    fetchedAt = performance.now();
    for (const d of data.devices) {
      const at = d.latest?.received_at;
      if (!at) continue;
      // Server clock estimate, so heartbeats line up with received_at.
      serverOffset = Date.parse(at) + d.age_seconds * 1000 - Date.now();
      if (seen.get(d._id) === at) continue;
      if (initialized) arrivals.set(d._id, performance.now());
      seen.set(d._id, at);
      beats.set(d._id, [...new Set((beats.get(d._id) || []).concat(Date.parse(at)))]);
    }
    devices = data.devices;
    if (!initialized) loadBeats().then(tick);
    initialized = true;
    $('wall-connection').textContent = (data.central_available ? 'Central conectado' : 'Central sin conexión · copia local') + ' · ' + data.pending_records + ' envíos pendientes';
    renderTiles();
    tick();
  } catch (e) {
    $('wall-connection').textContent = 'Sin conexión con el panel';
  }
}

// One reading per minute is kept by the gateway; that is what the heartbeat shows.
async function loadBeats() {
  const end = new Date(serverNow() + 1000), start = new Date(end.getTime() - (BEAT_WINDOW + 60) * 1000);
  await Promise.all(shown().filter(d => d.latest).map(async d => {
    try {
      const p = new URLSearchParams({ gateway: d.gateway_id, device: d.device_id, start: start.toISOString(), end: end.toISOString(), resolution: 'minute' });
      const data = await M.json('/api/v1/history?' + p);
      const times = data.records.map(r => Date.parse(r.received_at || r.timestamp)).concat(Date.parse(d.latest.received_at));
      beats.set(d._id, [...new Set(times)]);
    } catch (e) { /* Keep the arrivals already seen. */ }
  }));
}

function buildTile() {
  const root = M.el('article', 'tile');
  const head = M.el('div', 'tile-head'), titles = M.el('div', 'tile-titles'), name = M.el('h2', 'tile-name');
  const sub = M.el('div', 'tile-sub'), id = M.el('span', 'tile-id'), ctx = M.el('span', 'tile-ctx');
  sub.append(id, ctx);
  titles.append(name, sub);
  const pill = M.el('span', 'tile-pill'), pillText = M.el('span');
  pill.append(M.el('span', 'state-dot'), pillText);
  head.append(titles, pill);
  const values = M.el('div', 'tile-values');
  const bottom = M.el('div', 'tile-bottom'), bar = M.el('div', 'tile-bar'), fill = M.el('div');
  bar.setAttribute('role', 'img');
  bar.append(fill);
  const foot = M.el('div', 'tile-foot'), age = M.el('span'), next = M.el('span', 'tile-next');
  foot.append(age, next);
  bottom.append(bar, foot);
  root.append(head, values, bottom);
  return { root, name, id, ctx, pillText, values, bar, fill, age, next };
}

function renderTiles() {
  const list = shown(), box = $('tiles'), ids = new Set(list.map(d => d._id));
  box.dataset.count = String(list.length);
  for (const [id, t] of tiles) if (!ids.has(id)) { t.root.remove(); tiles.delete(id); }
  for (const [id, row] of beatRows) if (!ids.has(id)) { row.root.remove(); beatRows.delete(id); }
  const empty = box.querySelector('.wall-empty');
  if (!list.length && !empty) box.append(M.el('p', 'wall-empty', devices.length ? 'No hay nodos elegidos para la pared' : 'Esperando la primera señal'));
  if (list.length && empty) empty.remove();
  list.forEach((d, i) => {
    let t = tiles.get(d._id);
    if (!t) { t = buildTile(); tiles.set(d._id, t); }
    t.device = d;
    t.name.textContent = M.name(d);
    const context = d.latest?.context || d.context;
    t.id.textContent = d.device_id;
    t.ctx.textContent = M.context(context);
    t.ctx.dataset.context = context || 'unknown';
    const entries = M.readings(d.latest?.measurements).slice(0, 2);
    t.values.replaceChildren(...(entries.length ? entries.map(([k, m]) => {
      const value = M.el('div', 'tile-value'), number = M.el('span', 'tile-number');
      number.append(M.el('strong', '', m.quality === 'invalid' ? '—' : M.number(m.value, M.decimals(k))));
      if (m.unit && m.unit !== 'pH' && m.quality !== 'invalid') number.append(M.el('em', 'tile-unit', m.unit));
      value.append(M.el('span', 'tile-label', M.label(k) + (m.quality === 'invalid' ? ' · sin lectura válida' : '')), number);
      return value;
    }) : [M.el('p', 'tile-wait', 'Sin mediciones todavía')]));
    if (box.children[i] !== t.root) box.insertBefore(t.root, box.children[i] || null);
    let row = beatRows.get(d._id);
    if (!row) {
      row = { root: M.el('div', 'beat-row'), label: M.el('strong'), strip: M.el('pre', 'ascii') };
      row.strip.setAttribute('aria-hidden', 'true');
      row.root.append(row.label, row.strip);
      beatRows.set(d._id, row);
    }
    row.label.textContent = M.name(d);
    if ($('beats').children[i] !== row.root) $('beats').insertBefore(row.root, $('beats').children[i] || null);
  });
}

function tick() {
  const e = elapsed(), now = performance.now(), list = shown();
  const states = new Map(list.map(d => [d._id, M.status(d, e)]));
  const c = M.counts([...states.values()]);
  $('clock').textContent = M.clock(new Date());
  const day = dateFormat.format(new Date());
  $('wall-date').textContent = day.charAt(0).toUpperCase() + day.slice(1) + ' · America/Santiago';
  const count = $('wall-count'), accent = M.el('span', '', 'nodos al día');
  count.replaceChildren(c.ok + ' de ' + list.length, M.el('br'), accent);
  $('wall-alerts').textContent = list.filter(d => ['late', 'stale', 'waiting'].includes(states.get(d._id).state))
    .map(d => M.name(d) + ' · ' + M.STATES[states.get(d._id).state].toLowerCase()).join('\n') || 'Sin alertas';
  for (const t of tiles.values()) {
    const st = states.get(t.device._id);
    if (!st) continue;
    const r = M.ring(st);
    t.root.dataset.state = st.state;
    t.root.classList.toggle('fresh', now - (arrivals.get(t.device._id) ?? -1e9) < 1800);
    t.pillText.textContent = M.STATES[st.state];
    t.fill.style.width = (st.state === 'stale' || st.state === 'waiting' ? 0 : r.progress * 100) + '%';
    t.bar.setAttribute('aria-label', r.aria);
    t.age.textContent = st.age == null ? 'Sin lecturas todavía' : 'Última señal hace ' + M.ageText(st.age);
    t.next.textContent = st.state === 'ok' ? (st.interval >= 20 && st.age <= st.interval ? 'próxima en ' + Math.ceil(st.interval - st.age) + ' s' : 'al día')
      : st.state === 'late' ? 'sin datos a los ' + st.limit + ' s' : st.state === 'stale' ? 'revisar nodo' : 'esperando';
  }
  const nowServer = serverNow();
  for (const [id, row] of beatRows) {
    const st = states.get(id);
    if (!st) continue;
    row.root.dataset.state = st.state;
    row.strip.textContent = M.beat(beats.get(id) || [], nowServer, beatWidth, BEAT_WINDOW, st.state);
  }
  if (reduce || document.hidden) drawAlga(c);
}

function drawAlga(c) {
  const energy = c.ok ? 1 : c.late ? 0.45 : 0.1;
  $('alga').textContent = M.alga(reduce ? 1.7 : performance.now() / 1000, algaSize.cols, algaSize.rows, energy, true);
  $('wall-art').setAttribute('aria-label', 'Microalga animada que ' + (c.ok ? 'gira y respira' : c.late ? 'se mueve lenta' : 'se desarma'));
}

// Fit the ASCII to the screen, whatever TV resolution the lab uses.
function measure() {
  const pre = $('alga'), art = $('wall-art');
  const size = parseFloat(getComputedStyle(pre).fontSize) || 11, charW = size * 0.6, lineH = size * 1.2;
  const rows = Math.max(16, Math.min(56, Math.floor(art.clientHeight / lineH) - 1));
  const cols = Math.max(32, Math.min(Math.floor(art.clientWidth / charW) - 2, Math.round(rows * 2.1)));
  algaSize = { cols, rows: Math.min(rows, Math.floor(cols / 1.8)) };
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const beatsBox = $('beats'), label = 13.25 * rem + 8;
  const beatSize = parseFloat(getComputedStyle(pre).fontSize) || 11;
  beatWidth = Math.max(40, Math.floor((beatsBox.clientWidth - label) / (beatSize * 0.6)) - 2);
}

// The art box shrinks once tiles and heartbeat rows appear, so watch it instead of the window.
if (window.ResizeObserver) {
  const observer = new ResizeObserver(() => { measure(); tick(); });
  observer.observe($('wall-art'));
  observer.observe($('beats'));
} else {
  window.addEventListener('resize', () => { measure(); tick(); });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
measure();
refresh();
setInterval(refresh, M.POLL_SECONDS * 1000);
setInterval(loadBeats, 30000);
setInterval(tick, 1000);
if (!reduce) setInterval(() => {
  if (document.hidden) return;
  const e = elapsed();
  drawAlga(M.counts(shown().map(d => M.status(d, e))));
}, 120);
