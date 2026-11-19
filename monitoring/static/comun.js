'use strict';
// Shared by the desktop panel (app.js) and the wall display (pared.js).
// Everything here is pure presentation: states are derived from the API's
// age_seconds and expected_interval_seconds, never from invented samples.
(function () {
  const TZ = 'America/Santiago';
  const POLL_SECONDS = 10;
  const DEFAULT_INTERVAL = 4; // Same default the API uses to compute `recent`.
  const NAMES = { temperatura: 'Temperatura', temperature: 'Temperatura', ph: 'pH', oxygen: 'Oxígeno disuelto', oxigeno: 'Oxígeno disuelto', o2: 'Oxígeno disuelto' };
  const SHORT = { temperatura: 'temp', temperature: 'temp', ph: 'ph', oxygen: 'o2', oxigeno: 'o2', o2: 'o2' };
  const CONTEXTS = { dry_test: 'Prueba en seco', culture: 'En cultivo', unknown: 'Contexto desconocido' };
  const STATES = { ok: 'Recibiendo', late: 'Atrasado', stale: 'Sin datos recientes', waiting: 'Esperando señal' };
  const HIDDEN_KEY = 'microalgas.nodosOcultos';
  // Sensors the panel shows, in this order. Only temperature and pH are installed
  // for now; add 'oxygen' here when the digital module arrives. Storage and the
  // CSV keep every measurement regardless of this list.
  const SHOWN = ['temperatura', 'temperature', 'ph'];

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  async function json(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw Error(typeof detail.detail === 'string' ? detail.detail : 'No se pudo completar la solicitud');
    }
    return response.json();
  }

  function number(value, digits) {
    return Number(value).toLocaleString('es-CL', { minimumFractionDigits: digits ?? 0, maximumFractionDigits: digits ?? 2 });
  }

  function decimals(key) { return key === 'ph' ? 2 : 1; }
  function label(key) { return NAMES[key] || key; }
  function short(key) { return SHORT[key] || key; }
  function isTemperature(key) { return key === 'temperatura' || key === 'temperature'; }
  // [key, measurement] pairs of the sensors on screen, temperature first.
  function readings(measurements) {
    return Object.entries(measurements || {}).filter(([k]) => SHOWN.includes(k))
      .sort((a, b) => SHOWN.indexOf(a[0]) - SHOWN.indexOf(b[0]));
  }
  function shownSensor(key) { return SHOWN.includes(key); }
  function context(value) { return CONTEXTS[value] || value || 'Sin contexto'; }
  function name(device) { return device.alias || device.device_id; }

  function source(device) {
    const value = device.latest?.source || '';
    if (value.startsWith('analog')) return 'Analógico · ESP32';
    if (value === 'digital') return 'Digital · ESP32';
    if (value.startsWith('legacy')) return 'Historial importado';
    return 'ESP32';
  }

  const clockFormat = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  function clock(date) { return clockFormat.format(date); }

  function ageText(seconds) {
    if (seconds < 90) return Math.max(0, Math.floor(seconds)) + ' s';
    if (seconds < 5400) return Math.floor(seconds / 60) + ' min';
    if (seconds < 172800) return Math.floor(seconds / 3600) + ' h';
    return Math.floor(seconds / 86400) + ' d';
  }

  // `elapsed` is the time since the devices response arrived, so ages keep
  // moving between polls without trusting the browser clock against the server.
  function status(device, elapsed) {
    const interval = device.expected_interval_seconds || DEFAULT_INTERVAL;
    const limit = Math.max(30, 3 * interval);
    if (!device.latest || device.age_seconds == null) return { state: 'waiting', age: null, interval, limit };
    const age = device.age_seconds + elapsed;
    let state = 'ok';
    if (age > limit) state = 'stale';
    else if (age > interval * 1.5 + POLL_SECONDS + 2) state = 'late';
    return { state, age, interval, limit };
  }

  // Ring meaning: for slow publishers, a countdown to the next expected reading;
  // for fast ones (faster than the poll), how close the module is to "sin datos".
  function ring(st) {
    if (st.state === 'waiting') return { progress: 0, text: '—', aria: 'Todavía no llega ninguna lectura' };
    if (st.state === 'stale') return { progress: 0, text: ageText(st.age), aria: 'Sin señal hace ' + ageText(st.age) };
    if (st.interval >= 20) {
      if (st.age <= st.interval) {
        const left = Math.ceil(st.interval - st.age);
        return { progress: st.age / st.interval, text: left + ' s', aria: 'Próxima lectura esperada en ' + left + ' segundos' };
      }
      const over = Math.floor(st.age - st.interval);
      return { progress: 1, text: '+' + over + ' s', aria: 'Lectura atrasada ' + over + ' segundos' };
    }
    return { progress: Math.min(1, st.age / st.limit), text: Math.floor(st.age) + ' s', aria: 'Última lectura hace ' + Math.floor(st.age) + ' segundos; sin datos a los ' + st.limit };
  }

  function counts(list) {
    const result = { ok: 0, late: 0, stale: 0, waiting: 0 };
    for (const item of list) result[item.state]++;
    return result;
  }

  function summary(c) {
    const parts = [c.ok + ' al día'];
    if (c.late) parts.push(c.late + (c.late === 1 ? ' atrasado' : ' atrasados'));
    if (c.stale) parts.push(c.stale + ' sin datos');
    if (c.waiting) parts.push(c.waiting + ' esperando');
    return parts.join(' · ');
  }

  function loadHidden() {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); } catch (e) { return new Set(); }
  }

  function saveHidden(set) {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])); } catch (e) { /* Private mode: selection lasts for this visit. */ }
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  function hash(a, b, c) {
    const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
    return h - Math.floor(h);
  }

  // A rotating microalga drawn with characters. `energy` follows node health:
  // 1 breathing and spinning, ~0.45 slow and pale, <0.2 coming apart.
  function alga(t, cols, rows, energy, dark) {
    const ramp = ' .,:;-=+*ox%#@', top = ramp.length - 1, e = energy;
    const tt = t * (0.25 + 0.75 * e), cx = cols / 2, cy = rows / 2, sc = rows / 2;
    const R = 0.62 * (1 + 0.03 * e * Math.sin(tt * 1.6)), ringR = 0.84;
    const rot = tt * 0.45, cr = Math.cos(rot), sr = Math.sin(rot);
    const Lx = -0.45, Ly = -0.6, Lz = 0.66, head = (t * 0.9 * (0.3 + 0.7 * e)) % 6.2832;
    const bubbles = {};
    for (let b = 0; b < 14; b++) {
      const speed = 0.07 + 0.12 * hash(b, 3, 4), y = 1.1 - ((tt * speed + hash(b, 1, 2) * 2.2) % 2.2);
      const x = (hash(b, 5, 6) * 2 - 1) * 1.15 + 0.04 * Math.sin(tt * 1.2 + b);
      const bi = Math.round(2 * x * sc + cx - 0.5), bj = Math.round(y * sc + cy - 0.5);
      if (bi >= 0 && bi < cols && bj >= 0 && bj < rows) bubbles[bj * cols + bi] = y < -0.55 ? '.' : (hash(b, 7, 8) > 0.6 ? 'O' : 'o');
    }
    const lines = [];
    for (let j = 0; j < rows; j++) {
      let row = '';
      const v = (j + 0.5 - cy) / sc;
      for (let i = 0; i < cols; i++) {
        const u = (i + 0.5 - cx) * 0.5 / sc, d = Math.sqrt(u * u + v * v), a = Math.atan2(v, u);
        let rr = R * (1 + 0.035 * e * Math.sin(5 * a + tt * 2.2) + 0.02 * Math.sin(3 * a - tt * 1.4));
        if (e < 0.2) rr *= 1 + 0.12 * (hash(i, j, 1) - 0.5);
        let ch = ' ';
        if (d < rr) {
          const nx = Math.max(-1, Math.min(1, u / rr)), ny = Math.max(-1, Math.min(1, v / rr));
          const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          const px = nx * cr + nz * sr, pz = -nx * sr + nz * cr, py = ny;
          const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz), rim = Math.pow(1 - nz, 2.2);
          const chl = (px * 0.55 + py * 0.35 + pz * 0.75) > 0.05 ? 1 : 0.22;
          const pyr = Math.hypot(px - 0.15, py + 0.25, pz - 0.55) < 0.3 ? 1 : 0;
          const gran = hash(Math.floor(px * 7), Math.floor(py * 7), Math.floor(pz * 7)) > 0.86 ? 0.3 : 0;
          let dens = dark
            ? 0.12 + 0.45 * diff + 0.35 * chl * (0.4 + 0.6 * e) + 0.4 * rim + gran * e + 0.35 * pyr + 0.6 * Math.pow(diff, 10)
            : 0.2 + 0.22 * (1 - diff) + 0.36 * chl * (0.4 + 0.6 * e) + 0.42 * rim + gran * e + 0.4 * pyr - Math.pow(diff, 28);
          if (e < 0.2 && hash(i, j, Math.floor(t * 3)) < 0.55) dens *= 0.15;
          ch = ramp.charAt(Math.round(Math.max(0, Math.min(1, dens)) * top));
        } else if (bubbles[j * cols + i] && e > 0.15) {
          ch = bubbles[j * cols + i];
        } else if (e < 0.2 && d < 0.8 && hash(i, j, Math.floor(t * 1.5)) > 0.95) {
          ch = '.';
        } else if (Math.abs(d - ringR) < 0.03 && e > 0.15) {
          const behind = ((head - a) % 6.2832 + 6.2832) % 6.2832;
          if (behind < 0.09) ch = '@'; else if (behind < 0.4) ch = 'o'; else if (behind < 0.8) ch = ':'; else ch = (i + j) % 3 === 0 ? '.' : ' ';
        }
        row += ch;
      }
      lines.push(row);
    }
    return lines.join('\n');
  }

  // Three-row ASCII heartbeat: one peak per received reading inside the window.
  function beat(arrivals, nowMs, width, windowSeconds, state) {
    const step = windowSeconds / (width - 4);
    const r0 = Array(width).fill(' '), r1 = Array(width).fill(' ');
    const flat = state === 'stale' || state === 'waiting';
    const r2 = Array.from({ length: width }, (_, i) => flat ? (i % 2 ? ' ' : '.') : '_');
    for (const at of arrivals) {
      const p = width - 3 - Math.floor((nowMs - at) / 1000 / step);
      if (p < 2 || p > width - 3) continue;
      r0[p] = '^'; r1[p - 1] = '/'; r1[p + 1] = '\\';
      r2[p - 2] = '/'; r2[p - 1] = ' '; r2[p] = ' '; r2[p + 1] = ' '; r2[p + 2] = '\\';
    }
    if (state === 'late') r1[width - 2] = '?';
    return r0.join('') + '\n' + r1.join('') + '\n' + r2.join('');
  }

  window.Monitor = {
    TZ, POLL_SECONDS, STATES, el, svg, json, number, decimals, label, short, isTemperature, readings, shownSensor, context, name, source,
    clock, ageText, status, ring, counts, summary, loadHidden, saveHidden, reducedMotion, alga, beat
  };
})();
