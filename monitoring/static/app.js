'use strict';
// Desktop panel, shared by three routes: / (vivo), /nodos and /historial.
// <body data-page> says which parts exist. Depends on comun.js (window.Monitor).
const M = window.Monitor;
const $ = id => document.getElementById(id);
const PAGE = document.body.dataset.page;
const CONTEXT_LABELS = { dry_test: 'Prueba en seco', culture: 'En cultivo', unknown: 'Contexto desconocido' };
const dateTime = new Intl.DateTimeFormat('es-CL', { timeZone: M.TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
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
    const first = !initialized;
    initialized = true;
    devices = data.devices;
    devices.forEach((d, i) => { d.num = i + 1; });
    $('connection').dataset.state = 'online';
    $('connection-text').textContent = (data.central_available ? 'Central conectado' : 'Central sin conexión · copia local') + ' · ' + data.pending_records + ' envíos pendientes';
    if ($('chips')) renderChips();
    if (PAGE === 'vivo') { renderStrip(); if (first) primeLog(); }
    if (PAGE === 'nodos') { renderCards(); loadSparks(); }
    if (PAGE === 'historial') renderSelect();
    tick();
    if (PAGE === 'historial' && !historyBusy) await loadHistory();
  } catch (e) {
    $('connection').dataset.state = 'offline';
    $('connection-text').textContent = 'Sin conexión con el panel · ' + e.message;
  }
}

function addLog(d, reading = d.latest) {
  const at = new Date(reading.received_at || reading.timestamp);
  if (log.some(l => l.id === d._id && l.at === +at)) return;
  const parts = M.readings(reading.measurements).map(([k, m]) =>
    M.short(k) + '=' + (m.quality === 'invalid' ? 'inválida' : M.number(m.value, M.decimals(k))));
  // Older readings carry their day so yesterday's 18:46 is not read as today's.
  const when = (dayFormat.format(at) === dayFormat.format(new Date()) ? M.clock(at) : dayFormat.format(at) + ' ' + M.clock(at).slice(0, 5)).padEnd(11);
  log.push({ id: d._id, at: +at, text: when + '  ' + fit(M.name(d), 18) + parts.join('  ') });
  log.sort((a, b) => b.at - a.at);
  log = log.slice(0, 40);
}

// Fill the incoming-signals log with the last half hour, so it is not empty on load.
async function primeLog() {
  const end = new Date(Date.now() + 1000), start = new Date(end - 30 * 60000);
  await Promise.all(devices.filter(d => d.latest).map(async d => {
    try {
      const p = new URLSearchParams({ gateway: d.gateway_id, device: d.device_id, start: start.toISOString(), end: end.toISOString(), resolution: 'minute' });
      for (const r of (await M.json('/api/v1/history?' + p)).records) addLog(d, r);
    } catch (e) { /* The live log still fills as readings arrive. */ }
  }));
  tick();
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
    const entries = M.readings(d.latest?.measurements).slice(0, 2);
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
    const values = M.readings(m.device.latest?.measurements).slice(0, 2)
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
  // Only fresh readings go up in the hero; an old value without its age would mislead.
  const focus = list.find(d => d.latest && ['ok', 'late'].includes(states.get(d._id).state));
  const signature = focus ? focus._id + focus.latest.received_at + M.name(focus) : '';
  if (signature !== tagSignature) {
    tagSignature = signature;
    const tags = !focus ? [] : M.readings(focus.latest.measurements)
      .filter(([, m]) => m.quality !== 'invalid').slice(0, 2)
      .map(([k, m]) => {
        const tag = M.el('span', 'hero-tag');
        tag.append(M.el('strong', '', M.number(m.value, M.decimals(k)) + (m.unit && m.unit !== 'pH' ? ' ' + m.unit : '')), M.el('span', '', M.label(k) + ' · ' + M.name(focus)));
        return tag;
      });
    $('hero-tags').replaceChildren(...tags);
  }
  const all = M.counts(devices.map(d => states.get(d._id)));
  $('net-label').textContent = all.ok + ' de ' + devices.length + ' al día' + (devices.length > NET.max ? ' · se muestran ' + NET.max : '');
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
}

// ---------- Red de sensores (SVG) ----------
// The gateway sits on top and each module hangs from it on its own curve.
// Links only move when a real reading arrives: a dot travels up to the gateway.
const NET = { W: 420, H: 156, gwW: 150, gwH: 40, gwY: 4, nodeY: 98, r: 16, nameY: 132, ageY: 147, max: 8, flight: 1300 };
let net = null, packetFrame = 0;
const packets = new Map(), launched = new Map();

function svgText(cls, x, y, text) {
  const node = M.svg('text', { class: cls, x, y });
  node.textContent = text;
  return node;
}

// Shorten to `chars`, keeping a short trailing word so "Fotobiorreactor 1" and
// "Fotobiorreactor 2" stay distinguishable ("Fotobiorrea… 1").
function shortName(text, chars) {
  if (text.length <= chars) return text;
  const words = text.split(' '), tail = words.length > 1 && words.at(-1).length <= 4 ? words.at(-1) : '';
  return tail ? text.slice(0, Math.max(1, chars - tail.length - 2)).trimEnd() + '… ' + tail : text.slice(0, chars - 1).trimEnd() + '…';
}

function buildNet() {
  const list = devices.slice(0, NET.max), n = list.length, cx = NET.W / 2;
  const spacing = n > 1 ? Math.min(84, (NET.W - 56) / (n - 1)) : 0;
  const chars = Math.max(4, Math.floor(((spacing || 150) - 10) / 6.2));
  const svg = $('net');
  svg.setAttribute('viewBox', '0 0 ' + NET.W + ' ' + NET.H);
  const links = M.svg('g', { class: 'net-links' }), nodes = M.svg('g'), flying = M.svg('g', { class: 'net-packets' });
  const gw = M.svg('g', { class: 'net-gw' }), left = cx - NET.gwW / 2, mid = NET.gwY + NET.gwH / 2;
  gw.append(
    M.svg('rect', { class: 'net-gw-box', x: left, y: NET.gwY, width: NET.gwW, height: NET.gwH, rx: NET.gwH / 2 }),
    M.svg('circle', { class: 'net-gw-ring', cx: left + 22, cy: mid, r: 9 }),
    M.svg('circle', { class: 'net-gw-dot', cx: left + 22, cy: mid, r: 4 }),
    svgText('net-gw-kind', left + 40, mid - 4, 'GATEWAY'),
    svgText('net-gw-name', left + 40, mid + 11, fit(gatewayLabel || 'sin nombre', 15).trim()));
  const parts = new Map();
  list.forEach((d, k) => {
    const x = +(cx + (k - (n - 1) / 2) * spacing).toFixed(1), top = NET.nodeY - NET.r, from = NET.gwY + NET.gwH - 2;
    // Fan the links out along the gateway's base instead of one shared point.
    const start = +(cx + (x - cx) * 0.16).toFixed(1);
    const link = M.svg('path', { class: 'net-link', d: `M${start} ${from} C${start} ${from + 30} ${x} ${top - 28} ${x} ${top}` });
    links.append(link);
    const g = M.svg('g', { class: 'net-node' }), title = M.svg('title');
    const label = shortName(M.name(d), chars);
    const age = svgText('net-age', x, NET.ageY, '');
    g.append(title,
      M.svg('circle', { class: 'net-halo', cx: x, cy: NET.nodeY, r: NET.r + 7 }),
      M.svg('circle', { class: 'net-dot', cx: x, cy: NET.nodeY, r: NET.r }),
      svgText('net-num', x, NET.nodeY + 4.5, String(d.num)),
      svgText('net-name', x, NET.nameY, label), age);
    nodes.append(g);
    const packet = M.svg('circle', { class: 'net-packet', r: 4.5, cx: x, cy: top, opacity: 0 });
    flying.append(packet);
    parts.set(d._id, { g, link, title, age, packet, length: 0 });
  });
  if (!n) gw.append(svgText('net-empty', cx, NET.nodeY, 'Esperando el primer módulo'));
  svg.replaceChildren(links, gw, nodes, flying);
  for (const p of parts.values()) p.length = p.link.getTotalLength();
  net = { signature: netSignature(), gw, parts };
}

function netSignature() {
  return gatewayLabel + '|' + devices.slice(0, NET.max).map(d => d._id + ':' + M.name(d)).join(',');
}

function renderNet(states) {
  if (!net || net.signature !== netSignature()) buildNet();
  const now = performance.now();
  for (const [id, p] of net.parts) {
    const d = devices.find(x => x._id === id), st = states.get(id);
    if (!d || !st) continue;
    p.g.setAttribute('data-state', st.state);
    p.link.setAttribute('data-state', st.state);
    p.age.textContent = st.age == null ? 'sin señal' : M.ageText(st.age);
    p.title.textContent = d.num + ' · ' + M.name(d) + ' · ' + M.STATES[st.state].toLowerCase() + (st.age == null ? '' : ', hace ' + M.ageText(st.age));
    const arrived = arrivals.get(id);
    p.g.classList.toggle('fresh', now - (arrived ?? -1e9) < 1800);
    if (arrived && arrived !== launched.get(id)) {
      launched.set(id, arrived);
      if (!reduce && !document.hidden) { packets.set(id, now); if (!packetFrame) packetFrame = requestAnimationFrame(flyPackets); }
    }
  }
}

// Ease in and out along the link, from the module up to the gateway.
function flyPackets(now) {
  packetFrame = 0;
  for (const [id, start] of packets) {
    const p = net?.parts.get(id), t = (now - start) / NET.flight;
    if (!p || t >= 1) {
      packets.delete(id);
      if (p) {
        p.packet.setAttribute('opacity', 0);
        net.gw.classList.remove('hit');
        net.gw.getBoundingClientRect();
        net.gw.classList.add('hit');
      }
      continue;
    }
    const e = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const point = p.link.getPointAtLength(p.length * (1 - e));
    p.packet.setAttribute('cx', point.x.toFixed(1));
    p.packet.setAttribute('cy', point.y.toFixed(1));
    p.packet.setAttribute('opacity', Math.min(1, t * 8, (1 - t) * 8).toFixed(2));
  }
  if (packets.size) packetFrame = requestAnimationFrame(flyPackets);
}

function renderPh(states) {
  const marks = [];
  for (const d of visible()) {
    const st = states.get(d._id), m = d.latest?.measurements?.ph;
    if (!m || m.quality === 'invalid' || st.state === 'stale' || st.state === 'waiting') continue;
    marks.push({ num: d.num, name: M.name(d), value: m.value, state: st.state });
  }
  const signature = marks.map(m => m.num + ':' + m.value + ':' + m.state).join('|') + '@' + $('ph-marks').parentElement.clientHeight;
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
  // Marks sit at their value; labels closer than 24 px are pushed apart.
  const height = $('ph-marks').parentElement.clientHeight || 120, sorted = [...marks].sort((a, b) => b.value - a.value);
  let previous = -Infinity;
  $('ph-marks').replaceChildren(...sorted.map(m => {
    const mark = M.el('div', 'ph-mark'), at = (hi - m.value) / span * height, top = Math.max(at, previous + 24);
    previous = top;
    mark.dataset.state = m.state;
    mark.style.top = top + 'px';
    mark.append(M.el('span', '', String(m.num)), M.el('span', '', M.number(m.value, 2)));
    return mark;
  }));
  $('ph-list').replaceChildren(...sorted.map(m => {
    const item = M.el('li');
    item.dataset.state = m.state;
    item.append(M.el('span', 'mini-num', String(m.num)), M.el('span', 'ph-name', m.name), M.el('strong', '', M.number(m.value, 2)));
    if (m.state === 'late') item.append(M.el('em', '', 'atrasado'));
    return item;
  }));
  // On short screens show only the rows that fit, never half a row.
  const list = $('ph-list'), items = [...list.children];
  for (let i = items.length - 1; i >= 0 && list.scrollHeight > list.clientHeight + 1; i--) items[i].hidden = true;
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
  const measurements = Object.fromEntries(M.readings(d.latest?.measurements));
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
    forgetCharts(c);
    if (!keys) c.metrics.replaceChildren(M.el('p', 'spark-empty', 'Sin mediciones todavía'));
    else c.metrics.replaceChildren(...Object.keys(measurements).map(k => {
      const tile = M.el('div', 'metric'), top = M.el('div', 'metric-top'), name = M.el('div');
      const value = M.el('span', 'metric-value'), range = M.el('span', 'metric-range'), view = chartView(d._id + '|' + k, true), wait = M.el('span', 'spark-empty');
      name.append(M.el('span', 'metric-label', M.label(k)), value);
      top.append(name, range);
      view.plot.append(wait);
      tile.append(top, view.plot);
      c.tiles.set(k, { value, range, view, wait });
      return tile;
    }));
  }
  for (const [k, m] of Object.entries(measurements)) {
    const tile = c.tiles.get(k);
    if (m.quality === 'invalid') tile.value.replaceChildren(M.el('span', 'invalid', 'Sin lectura válida'));
    else tile.value.replaceChildren(M.el('strong', '', M.number(m.value, M.decimals(k))), M.el('span', '', m.unit || ''));
    const r = range24(rows, k), trend = (rows || []).filter(row => row.measurements[k]);
    tile.range.textContent = r ? 'Últimas 24 h: ' + M.number(r.min, M.decimals(k)) + ' – ' + M.number(r.max, M.decimals(k)) + (m.unit && m.unit !== 'pH' ? ' ' + m.unit : '') : '';
    tile.wait.textContent = !rows ? 'Cargando tendencia…' : trend.length ? '' : 'Sin datos en las últimas 24 h';
    tile.wait.hidden = !!trend.length;
    if (trend.length) {
      const end = Date.now();
      setChart(tile.view, trend, k, null, 'hour', true, { start: (Math.floor(end / HOUR) - 23) * HOUR, end });
      drawChart(tile.view);
    }
  }
}

function forgetCharts(c) {
  for (const t of c.tiles.values()) chartObserver?.unobserve(t.view.plot);
  c.tiles.clear();
}

function setColumns() {
  const box = $('devices'), count = visible().length;
  let cols = count <= 1 ? 1 : count <= 4 ? count : count <= 6 ? 3 : 4;
  cols = Math.max(1, Math.min(cols, Math.floor((box.clientWidth || window.innerWidth) / 300)));
  box.style.setProperty('--cols', String(cols));
}

function renderCards() {
  const list = visible(), box = $('devices'), ids = new Set(list.map(d => d._id));
  for (const [id, c] of cards) if (!ids.has(id)) { forgetCharts(c); c.root.remove(); cards.delete(id); }
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
    renderNet(states);
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

// Resolución and Vista are segmented radio groups.
const picked = name => document.querySelector('input[name="' + name + '"]:checked')?.value;

function params() {
  const selected = devices.find(d => d._id === $('device').value);
  if (!selected || !$('start').value || !$('end').value) return null;
  const endDay = new Date($('end').value + 'T12:00:00Z');
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  const p = new URLSearchParams({ gateway: selected.gateway_id, device: selected.device_id, start: midnightChile($('start').value),
    end: midnightChile(endDay.toISOString().slice(0, 10)), resolution: picked('resolution'), mode: picked('mode') });
  if ($('context').value) p.set('context', $('context').value);
  return p;
}

// ---------- Gráficos del historial ----------
// Each chart is drawn at its box's real pixel size (redrawn on resize), so axis
// text stays crisp. Views persist across the 10 s reloads, keeping the hover.
const chartViews = new Map();
const tipDay = new Intl.DateTimeFormat('es-CL', { timeZone: M.TZ, weekday: 'short', day: 'numeric', month: 'short' });
const tickDay = new Intl.DateTimeFormat('es-CL', { timeZone: M.TZ, day: 'numeric', month: 'short' });
const hourMinute = new Intl.DateTimeFormat('es-CL', { timeZone: M.TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hourParts = new Intl.DateTimeFormat('en-GB', { timeZone: M.TZ, hour: '2-digit', hourCycle: 'h23' });
const chartObserver = window.ResizeObserver ? new ResizeObserver(entries => { for (const e of entries) if (e.target.view) drawChart(e.target.view); }) : null;
const HOUR = 3600000, MINUTE = 60000;

function chartView(key, compact) {
  const card = M.el('section', 'chart'), head = M.el('div', 'chart-head'), titles = M.el('div', 'chart-titles');
  const title = M.el('h3', 'chart-title'), ctx = M.el('span', 'tag'), stats = M.el('dl', 'chart-stats');
  titles.append(title, ctx);
  head.append(titles, stats);
  const plot = M.el('div', 'chart-plot'), svg = M.svg('svg', { class: 'chart-svg', role: 'img' }), tip = M.el('div', 'chart-tip');
  plot.tabIndex = 0;
  tip.hidden = true;
  tip.setAttribute('aria-live', 'polite');
  plot.append(svg, tip);
  const foot = M.el('div', 'chart-foot'), legend = M.el('div', 'chart-legend'), span = M.el('span', 'chart-span');
  foot.append(legend, span);
  card.append(head, plot, foot);
  const view = { key, compact: !!compact, card, title, ctx, stats, plot, svg, tip, legend, span, rows: [], xs: [], hover: null };
  plot.view = view;
  plot.addEventListener('pointermove', e => {
    if (!view.xs.length) return;
    const x = e.clientX - plot.getBoundingClientRect().left;
    let lo = 0, hi = view.xs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (view.xs[mid] < x) lo = mid; else hi = mid; }
    setHover(view, Math.abs(view.xs[lo] - x) <= Math.abs(view.xs[hi] - x) ? lo : hi);
  });
  plot.addEventListener('pointerleave', () => setHover(view, null));
  plot.addEventListener('blur', () => setHover(view, null));
  plot.addEventListener('keydown', e => {
    const last = view.rows.length - 1, at = view.hover == null ? null : view.rows.findIndex(r => r.t === view.hover);
    const next = { ArrowLeft: at == null ? last : Math.max(0, at - 1), ArrowRight: at == null ? last : Math.min(last, at + 1), Home: 0, End: last }[e.key];
    if (next === undefined || last < 0) return;
    e.preventDefault();
    setHover(view, next);
  });
  chartObserver?.observe(plot);
  return view;
}

function setChart(view, records, sensor, context, resolution, summary, range) {
  const hourly = resolution === 'hour';
  view.rows = records.filter(r => (context == null || r.context === context) && r.measurements[sensor]).map(r => {
    const m = r.measurements[sensor], s = r.summary?.[sensor], t = Date.parse(r.timestamp);
    // Hourly rows describe a whole hour: draw them at its middle.
    return { t, x: hourly ? t + HOUR / 2 : t, v: m.value, min: s?.min, max: s?.max, count: hourly ? (s?.count ?? 0) : 1, closed: r.closed !== false };
  });
  Object.assign(view, { sensor, context, hourly, summary, band: hourly && summary && view.rows.some(r => r.min != null) });
  view.unit = records.find(r => r.measurements[sensor])?.measurements[sensor].unit || '';
  const last = view.rows.at(-1)?.x ?? range.end;
  view.t0 = range.start;
  view.t1 = Math.max(Math.min(range.end, Date.now()), last + (hourly ? HOUR / 2 : MINUTE));
  const digits = M.decimals(sensor), values = view.rows.map(r => r.v);
  const weights = view.rows.map(r => hourly && summary ? r.count || 1 : 1), total = weights.reduce((a, b) => a + b, 0);
  const mean = view.rows.reduce((a, r, i) => a + r.v * weights[i], 0) / total;
  const lows = view.rows.map(r => r.min ?? r.v), highs = view.rows.map(r => r.max ?? r.v);
  const unit = view.unit && view.unit !== 'pH' ? ' ' + view.unit : '';
  view.title.textContent = M.label(sensor);
  view.ctx.textContent = context == null ? 'Todos los contextos' : CONTEXT_LABELS[context] || context;
  const stat = (name, value) => [M.el('dt', '', name), M.el('dd', '', M.number(value, digits) + unit)];
  view.stats.replaceChildren(...stat('Última', values.at(-1)), ...stat('Mín', Math.min(...lows)), ...stat('Máx', Math.max(...highs)), ...stat(summary && hourly ? 'Promedio' : 'Media', mean));
  const legend = [['line', hourly ? (summary ? 'promedio por hora' : 'lectura puntual de cada hora') : 'lectura por minuto']];
  if (view.band) legend.push(['band', 'mínimo a máximo de la hora']);
  view.legend.replaceChildren(...legend.map(([cls, text]) => { const item = M.el('span'); item.append(M.el('i', cls), text); return item; }));
  view.span.textContent = dateTime.format(new Date(view.rows[0].t)) + ' → ' + dateTime.format(new Date(view.rows.at(-1).t));
  view.svg.setAttribute('aria-label', M.label(sensor) + ', ' + view.ctx.textContent.toLowerCase() + ': ' + view.rows.length + (hourly ? ' horas' : ' minutos') +
    ' con datos, entre ' + M.number(Math.min(...lows), digits) + ' y ' + M.number(Math.max(...highs), digits) + unit + '. Los huecos son intervalos sin señal.');
  view.plot.setAttribute('aria-label', 'Gráfico de ' + M.label(sensor) + '. Usa las flechas para recorrer los valores.');
}

// About `count` round steps between lo and hi: 1, 2, 2.5 or 5 times a power of ten.
function niceTicks(lo, hi, count) {
  if (hi - lo < 1e-9) { const pad = Math.abs(hi) * 0.02 || 0.5; lo -= pad; hi += pad; }
  const raw = (hi - lo) / count, power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(f => f * power).find(s => s >= raw);
  const first = Math.floor(lo / step + 1e-9) * step, last = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = first; v <= last + step / 2; v += step) ticks.push(+v.toFixed(10));
  const digits = Math.max(0, (String(+step.toPrecision(6)).split('.')[1] || '').length);
  return { ticks, lo: first, hi: last, digits };
}

// Round Chilean clock times: every 10 min up to every week, as many as fit.
function timeTicks(t0, t1, fit) {
  const steps = [10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];
  const step = steps.find(s => (t1 - t0) / (s * MINUTE) <= fit) || 10080;
  const ticks = [];
  if (step <= 60) {
    for (let t = Math.ceil(t0 / (step * MINUTE)) * step * MINUTE; t <= t1; t += step * MINUTE) ticks.push(t);
  } else {
    // Chile's offset is whole hours, so UTC hour starts are also Chilean hour starts.
    let day = 0;
    for (let t = Math.ceil(t0 / HOUR) * HOUR; t <= t1; t += HOUR) {
      const hour = +hourParts.format(t) % 24;
      if (step < 1440 ? hour % (step / 60) === 0 : hour === 0 && day++ % (step / 1440) === 0) ticks.push(t);
    }
  }
  return { ticks, daily: step >= 1440 };
}

function drawChart(view) {
  const W = view.plot.clientWidth, H = view.plot.clientHeight, rows = view.rows;
  if (!W || !H || !rows.length) return;
  const small = view.compact, pad = small ? { l: 40, r: 6, t: 8, b: 22 } : { l: 48, r: 14, t: 12, b: 40 }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const y = niceTicks(Math.min(...rows.map(r => view.band ? r.min ?? r.v : r.v)), Math.max(...rows.map(r => view.band ? r.max ?? r.v : r.v)), Math.max(2, Math.min(6, Math.floor(ih / (small ? 30 : 46)))));
  const X = t => pad.l + iw * (t - view.t0) / (view.t1 - view.t0), Y = v => pad.t + ih * (1 - (v - y.lo) / (y.hi - y.lo));
  const svg = view.svg, parts = [];
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const grid = M.svg('g', { class: 'chart-grid' }), labels = M.svg('g', { class: 'chart-axis' });
  for (const v of y.ticks) {
    const py = Y(v).toFixed(1);
    grid.append(M.svg('line', { x1: pad.l, x2: W - pad.r, y1: py, y2: py }));
    labels.append(svgText('chart-ylabel', pad.l - (small ? 7 : 10), +py + 4, M.number(v, y.digits)));
  }
  const x = timeTicks(view.t0, view.t1, Math.max(2, Math.floor(iw / (small ? 56 : 78))));
  let previousDay = null;
  for (const t of x.ticks) {
    const px = X(t).toFixed(1), day = dateChile(new Date(t)), newDay = day !== previousDay;
    const midnight = !x.daily && +hourParts.format(t) % 24 === 0 && hourMinute.format(t).endsWith('00');
    grid.append(M.svg('line', { class: midnight ? 'day' : '', x1: px, x2: px, y1: pad.t, y2: pad.t + ih }));
    // Labels at the very edges hang inwards instead of over the Y axis or the border.
    const anchor = +px < pad.l + 20 ? 'start' : +px > W - pad.r - 20 ? 'end' : 'middle';
    const label = svgText('chart-xlabel', px, H - pad.b + (small ? 15 : 19), x.daily ? tickDay.format(t) : hourMinute.format(t));
    label.setAttribute('text-anchor', anchor);
    labels.append(label);
    if (!small && !x.daily && newDay && (midnight || previousDay === null)) {
      const dayLabel = svgText('chart-xday', px, H - pad.b + 33, tickDay.format(t));
      dayLabel.setAttribute('text-anchor', anchor);
      labels.append(dayLabel);
    }
    previousDay = day;
  }
  grid.append(M.svg('line', { class: 'base', x1: pad.l, x2: W - pad.r, y1: pad.t + ih, y2: pad.t + ih }));
  parts.push(grid, labels);
  // Line and band break where samples are missing, so gaps stay visible.
  const gap = (view.hourly ? HOUR : MINUTE) * 1.1;
  let line = '', band = '', top = [], bottom = [], prev = null;
  const flush = () => { if (top.length > 1) band += 'M' + top.join(' L') + ' L' + bottom.reverse().join(' L') + ' Z '; top = []; bottom = []; };
  view.xs = rows.map(r => {
    const px = X(r.x), joined = prev !== null && r.t - prev <= gap;
    if (!joined) flush();
    line += (joined ? ' L' : ' M') + px.toFixed(1) + ' ' + Y(r.v).toFixed(1);
    if (view.band && r.min != null) { top.push(px.toFixed(1) + ' ' + Y(r.max).toFixed(1)); bottom.push(px.toFixed(1) + ' ' + Y(r.min).toFixed(1)); }
    prev = r.t;
    return px;
  });
  flush();
  if (band) parts.push(M.svg('path', { class: 'chart-band', d: band.trim() }));
  parts.push(M.svg('path', { class: 'chart-line', d: line.trim() }));
  // Lone samples have no segment, so they always get a dot; the rest only when sparse.
  const dots = M.svg('g', { class: 'chart-dots' });
  rows.forEach((r, i) => {
    const alone = (i === 0 || r.t - rows[i - 1].t > gap) && (i === rows.length - 1 || rows[i + 1].t - r.t > gap);
    if (alone || iw / rows.length > (small ? 14 : 9)) dots.append(M.svg('circle', { cx: view.xs[i].toFixed(1), cy: Y(r.v).toFixed(1), r: alone ? 3 : 2.2 }));
  });
  parts.push(dots);
  view.cross = M.svg('line', { class: 'chart-cross', y1: pad.t, y2: pad.t + ih, visibility: 'hidden' });
  view.mark = M.svg('circle', { class: 'chart-mark', r: 5, visibility: 'hidden' });
  view.Y = Y;
  parts.push(view.cross, view.mark);
  svg.replaceChildren(...parts);
  setHover(view, view.hover == null ? null : rows.findIndex(r => r.t === view.hover));
}

function setHover(view, index) {
  const row = index == null || index < 0 ? null : view.rows[index];
  view.hover = row ? row.t : null;
  if (!row || !view.cross) { view.tip.hidden = true; view.cross?.setAttribute('visibility', 'hidden'); view.mark?.setAttribute('visibility', 'hidden'); return; }
  const px = view.xs[index], py = view.Y(row.v), digits = M.decimals(view.sensor);
  const unit = view.unit && view.unit !== 'pH' ? ' ' + view.unit : '';
  view.cross.setAttribute('x1', px.toFixed(1));
  view.cross.setAttribute('x2', px.toFixed(1));
  view.cross.setAttribute('visibility', 'visible');
  view.mark.setAttribute('cx', px.toFixed(1));
  view.mark.setAttribute('cy', py.toFixed(1));
  view.mark.setAttribute('visibility', 'visible');
  const day = tipDay.format(row.t), when = day.charAt(0).toUpperCase() + day.slice(1) + ' · ' + hourMinute.format(row.t) + (view.hourly ? '–' + hourMinute.format(row.t + HOUR) : '');
  const value = M.el('div', 'tip-value');
  value.append(M.el('strong', '', M.number(row.v, digits)), M.el('span', '', (unit || ' pH').trim() + ' · ' + (view.hourly ? (view.summary ? 'promedio' : 'lectura puntual') : 'lectura')));
  const lines = [M.el('div', 'tip-time', when), value];
  const pair = (name, text) => { const item = M.el('div', 'tip-row'); item.append(M.el('span', '', name), M.el('b', '', text)); return item; };
  if (row.min != null) lines.push(pair('Mín – máx', M.number(row.min, digits) + ' – ' + M.number(row.max, digits) + unit));
  if (view.hourly) lines.push(pair('Minutos con datos', row.count + ' de 60'));
  if (view.hourly && !row.closed) lines.push(M.el('div', 'tip-note', 'Hora en curso: puede cambiar'));
  view.tip.replaceChildren(...lines);
  view.tip.hidden = false;
  const W = view.plot.clientWidth, tw = view.tip.offsetWidth, th = view.tip.offsetHeight;
  view.tip.style.left = (px + 14 + tw > W ? px - 14 - tw : px + 14) + 'px';
  view.tip.style.top = Math.max(0, Math.min(view.plot.clientHeight - th, py - th / 2)) + 'px';
}

// One column per sensor on screen, the hour's range under each value.
function renderTable(records, resolution) {
  const sensors = [...new Set(records.flatMap(r => M.readings(r.measurements).map(([k]) => k)))];
  const head = M.el('tr');
  head.append(M.el('th', '', 'Fecha · Chile'), M.el('th', '', 'Contexto'), ...sensors.map(k => M.el('th', 'num', M.label(k))),
    M.el('th', 'num', resolution === 'hour' ? 'Minutos' : 'Muestra'));
  $('rows-head').replaceChildren(head);
  $('rows').replaceChildren(...records.slice(-200).reverse().map(r => {
    const tr = M.el('tr'), when = M.el('td', 'when', dateTime.format(new Date(r.timestamp)));
    if (resolution === 'hour' && !r.closed) when.append(M.el('small', '', 'en curso'));
    const ctx = M.el('td');
    ctx.append(M.el('span', 'tag', CONTEXT_LABELS[r.context] || r.context));
    tr.append(when, ctx, ...sensors.map(k => {
      const cell = M.el('td', 'num'), m = r.measurements[k], s = r.summary?.[k];
      if (!m) { cell.append(M.el('span', 'none', '—')); return cell; }
      cell.append(M.el('strong', '', M.number(m.value, M.decimals(k)) + (m.unit && m.unit !== 'pH' ? ' ' + m.unit : '')));
      if (s && resolution === 'hour') cell.append(M.el('small', '', M.number(s.min, M.decimals(k)) + ' – ' + M.number(s.max, M.decimals(k))));
      return cell;
    }));
    const cover = M.el('td', 'num');
    if (resolution === 'hour') {
      cover.append(M.el('strong', r.complete ? '' : 'partial', r.sample_count + '/60'));
      if (!r.complete) cover.append(M.el('small', '', 'parcial'));
    } else cover.append(M.el('span', 'none', '1'));
    tr.append(cover);
    return tr;
  }));
}

function renderCharts(records, resolution, p) {
  const box = $('charts'), summary = picked('mode') === 'summary';
  const range = { start: Date.parse(p.get('start')), end: Date.parse(p.get('end')) };
  const sensors = new Set(records.flatMap(r => M.readings(r.measurements).map(([k]) => k)));
  const contexts = new Set(records.map(r => r.context)), keep = [];
  for (const sensor of sensors) for (const context of contexts) {
    if (!records.some(r => r.context === context && r.measurements[sensor])) continue;
    const key = sensor + '|' + context, view = chartViews.get(key) || chartView(key);
    chartViews.set(key, view);
    setChart(view, records, sensor, context, resolution, summary, range);
    keep.push(view);
  }
  for (const [key, view] of chartViews) if (!keep.includes(view)) { chartObserver?.unobserve(view.plot); view.card.remove(); chartViews.delete(key); }
  const empty = keep.length ? [] : [M.el('p', 'charts-empty', 'Sin mediciones de temperatura ni pH en este rango.')];
  box.replaceChildren(...keep.map(v => v.card), ...empty);
  box.dataset.count = String(keep.length);
  for (const view of keep) drawChart(view);
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
  for (const radio of document.getElementsByName('mode')) radio.disabled = picked('resolution') === 'minute';
  try {
    const d = await M.json('/api/v1/history?' + p, { signal: historyAbort.signal });
    if (request !== historyRequest) return;
    $('download').href = '/api/v1/export.csv?' + p;
    $('download').removeAttribute('aria-disabled');
    $('rows').replaceChildren();
    $('history-status').textContent = d.records.length
      ? d.records.length + ' registros · los contextos se muestran por separado. La hora actual puede estar incompleta.'
      : 'Sin datos en este rango. No se rellenan intervalos sin señal.';
    if (d.records.length > 200) $('history-status').textContent += ' Tabla: últimos 200 registros; el CSV incluye todos.';
    renderTable(d.records, d.resolution);
    renderCharts(d.records, d.resolution, p);
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
  for (const id of ['device', 'context', 'start', 'end']) $(id).onchange = loadHistory;
  for (const radio of document.querySelectorAll('input[name=resolution], input[name=mode]')) radio.onchange = loadHistory;
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
