/* Cody Maps — SVG map UI wired to the real Cody backend. No libraries, no CDN. */
'use strict';
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const svg = $('map');

function el(t, attrs, parent) {
  const e = document.createElementNS(NS, t);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  (parent || svg).appendChild(e);
  return e;
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 1800);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- state ---------------- */
let NODES = [], EDGES = [], byId = {}, LIBS = [];
let repoId = '', repoName = '…', homeId = null, fullSeq = [];
let selected = null, touring = false, stopIx = -1, tourStops = [];
let showLibs = true, showLabels = true, hideTests = true;
let explainCache = {}, chatHist = {}, chatNode = null;
let pos = {};            // nodeId -> {x, y}
let districtRects = [];
let edgePath = {};       // "a>b" -> path element (main direction found)
let incident = {}, longEdges = new Set(), paintId = null, paintHov = null, edgeD = {};
let miniRect = null, miniPin = null;
let labelEls = {}, MAJORS = new Set(), lastZoom = -1;
let histBack = [], histFwd = [];
let world = { x: 0, y: 0, w: 100, h: 100 };
let extBox = null;

/* ---------------- api ---------------- */
function apiUrl(path, extra) {
  const p = new URLSearchParams(extra || {});
  if (repoId) p.set('repo_id', repoId);
  const qs = p.toString();
  return qs ? path + '?' + qs : path;
}
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------------- model ---------------- */
function normPath(fp) { return String(fp || '').replace(/\\/g, '/'); }
function isTestPath(fp) {
  return /(^|\/)(tests?|examples?|docs?|testing|test)(\/|$)/i.test(normPath(fp));
}
function shortFile(fp) {
  const parts = normPath(fp).split('/');
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}
function visibleNodes() {
  return NODES.filter((n) => !hideTests || !isTestPath(n.filepath));
}
function buildModel(nodes, edges) {
  NODES = nodes || []; EDGES = edges || []; byId = {};
  NODES.forEach((n) => { byId[n.id] = n; });
  const freq = {};
  EDGES.forEach((e) => {
    if (String(e.to).startsWith('library_entity:')) freq[e.to] = (freq[e.to] || 0) + 1;
  });
  LIBS = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([id, c]) => ({ id, name: id.split(':').slice(1).join(':') || id, count: c }));
  LIBS.forEach((l) => {
    byId[l.id] = { id: l.id, name: l.name, type: 'library_call', filepath: 'external', kind: 'lib' };
  });
  explainCache = {};
}

/* ---------------- layout: files become districts ---------------- */
/* ---------------- layout: force-directed map ----------------
   Roads are springs (callers/callees pull together), places repel each
   other (even spread), gravity holds the city together. Result: related
   places end up near each other instead of gridded by folder. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function forceLayout(nodes, adj) {
  const n = nodes.length;
  if (!n) return {};
  const rnd = mulberry32(42); // deterministic: same repo, same map, every load
  const idx = new Map();
  nodes.forEach((nd, i) => idx.set(nd.id, i));
  const x = new Float64Array(n), y = new Float64Array(n);
  // init: file groups spaced around a ring so the sim starts unfolded
  const order = new Map();
  nodes.forEach((nd, i) => {
    if (!order.has(nd.filepath)) order.set(nd.filepath, []);
    order.get(nd.filepath).push(i);
  });
  const files = [...order.keys()];
  const R0 = 300 + Math.sqrt(n) * 30;
  files.forEach((fp, fi) => {
    const ang = (fi / Math.max(1, files.length)) * Math.PI * 2;
    const cx = Math.cos(ang) * R0, cy = Math.sin(ang) * R0;
    order.get(fp).forEach((i) => {
      x[i] = cx + (rnd() - 0.5) * 240;
      y[i] = cy + (rnd() - 0.5) * 240;
    });
  });
  // int-pair adjacency for the hot loop
  const AJ = [];
  adj.forEach(([a, b]) => {
    const i = idx.get(a), j = idx.get(b);
    if (i !== undefined && j !== undefined && i !== j) AJ.push(i, j);
  });
  const k = 140 + Math.min(70, Math.sqrt(n) * 2.2); // ideal road length
  const iters = Math.max(25, Math.min(85, Math.round(20000 / Math.max(1, n)) + 20));
  const fullPairs = n <= 250, K = 48; // big maps: sampled repulsion, still deterministic
  const dx = new Float64Array(n), dy = new Float64Array(n);
  let temp = k * 0.9;
  const cool = Math.pow(0.06 / (k * 0.9), 1 / Math.max(1, iters));
  const repel = (i, j) => {
    let ddx = x[i] - x[j], ddy = y[i] - y[j];
    let d2 = ddx * ddx + ddy * ddy;
    if (d2 < 0.01) { ddx = rnd() - 0.5; ddy = rnd() - 0.5; d2 = ddx * ddx + ddy * ddy; }
    const d = Math.sqrt(d2);
    let f = (k * k) / d;
    if (d < 70) f += (70 - d) * 0.6;
    if (f > temp * 4) f = temp * 4;
    const fx = (ddx / d) * f, fy = (ddy / d) * f;
    dx[i] += fx; dy[i] += fy; dx[j] -= fx; dy[j] -= fy;
  };
  for (let it = 0; it < iters; it++) {
    dx.fill(0); dy.fill(0);
    if (fullPairs) {
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) repel(i, j);
    } else {
      for (let i = 0; i < n; i++)
        for (let s = 0; s < K; s++) {
          const j = (rnd() * n) | 0;
          if (j !== i) repel(i, j);
        }
    }
    // springs: roads pull their two places together
    for (let a = 0; a < AJ.length; a += 2) {
      const i = AJ[a], j = AJ[a + 1];
      const ddx = x[i] - x[j], ddy = y[i] - y[j];
      const d = Math.max(0.01, Math.hypot(ddx, ddy));
      let f = ((d * d) / k) * 0.5;
      if (f > temp * 4) f = temp * 4;
      const fx = (ddx / d) * f, fy = (ddy / d) * f;
      dx[i] -= fx; dy[i] -= fy; dx[j] += fx; dy[j] += fy;
    }
    // gravity to center + cooled step
    for (let i = 0; i < n; i++) {
      const ddx = dx[i] - x[i] * 0.02, ddy = dy[i] - y[i] * 0.02;
      const m = Math.hypot(ddx, ddy) || 1;
      const step = m < temp ? m : temp;
      x[i] += (ddx / m) * step; y[i] += (ddy / m) * step;
    }
    temp *= cool;
  }
  const out = {};
  nodes.forEach((nd, i) => { out[nd.id] = { x: x[i], y: y[i] }; });
  return out;
}

/* file outlines: convex hull per file, outline-only (fills were the old mess).
   Always faint; the hovered/selected place's file lights up. */
function hullOf(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 2) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  pts.forEach((p) => {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  });
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
function smoothClosed(pts) {
  const n = pts.length;
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += ` C ${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d + ' Z';
}
let outlineEls = {};
function paintOutlines(focusFp) {
  // inline styles: they outrank the .foutline CSS rule; '' falls back to it
  Object.entries(outlineEls).forEach(([fp, info]) => {
    const on = !!(focusFp && fp === focusFp);
    info.path.style.stroke = on ? '#6366f1' : '';
    info.path.style.strokeWidth = on ? '3' : '';
    info.path.style.strokeDasharray = on ? 'none' : '';
    info.path.style.opacity = on ? '1' : '';
    info.label.style.fill = on ? '#4338ca' : '';
  });
}
function layout() {
  pos = {}; districtRects = [];
  const nodes = visibleNodes();
  const inSet = new Set(nodes.map((nd) => nd.id));
  const adj = [];
  EDGES.forEach((e) => {
    if (inSet.has(e.from) && inSet.has(e.to) && !String(e.to).startsWith('library_entity:')) adj.push([e.from, e.to]);
  });
  const raw = forceLayout(nodes, adj);
  // shift to positive coords
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  Object.values(raw).forEach((p) => {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  });
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 300; maxY = 300; }
  const ox = 90 - minX, oy = 90 - minY;
  Object.entries(raw).forEach(([id, p]) => { pos[id] = { x: p.x + ox, y: p.y + oy }; });
  // neighborhoods: file centroids become floating labels (no boxes to overlap)
  const groups = new Map();
  nodes.forEach((nd) => {
    if (!groups.has(nd.filepath)) groups.set(nd.filepath, []);
    groups.get(nd.filepath).push(nd.id);
  });
  groups.forEach((ids, fp) => {
    let sx = 0, sy = 0, c = 0;
    ids.forEach((id) => { if (pos[id]) { sx += pos[id].x; sy += pos[id].y; c++; } });
    if (c) districtRects.push({ name: shortFile(fp).toUpperCase(), x: sx / c, y: sy / c - 34 });
  });
  world = { x: 0, y: 0, w: (maxX - minX) + 340, h: (maxY - minY) + 340 };
  // external libraries live on a smaller offshore island (water between)
  const exX = world.x + world.w + 700;
  const exH = Math.max(320, LIBS.length * 56 + 130);
  extBox = { x: exX, y: world.y, w: 300, h: exH };
  LIBS.forEach((l, i) => { pos[l.id] = { x: exX + 150, y: extBox.y + 90 + i * 56 }; });
}

/* ---------------- render ---------------- */
let gDist, gRC, gR, gRouteCase, gRouteBlue, gRouteWalk, gDot, gLab, gStops, gPin, traveler, dotEls = {};
function clearSvg() { svg.innerHTML = ''; dotEls = {}; labelEls = {}; edgePath = {}; edgeD = {}; lastZoom = -1; }

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
/* organic island coastline: seeded wobbly blob through ring points */
function blobPathD(cx, cy, rx, ry, wobble, rnd, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 1 + (rnd() - 0.5) * wobble;
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += ` C ${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d + ' Z';
}
/* roads curve like streets: both directions of one pair share a corridor
   (reversed direction auto-mirrors the arc), different pairs/corridors get
   different bends, so dense zones stop drawing over themselves */
function roadD(a, b, key, kind) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const pair = String(key).split('>').sort().join('>');
  const hh = hashStr(pair + '|' + kind);
  const mag = Math.min(24 + len * 0.14, 120, len * 0.5) * (0.45 + 0.55 * (((hh >> 4) % 100) / 100));
  return `M ${a.x} ${a.y} Q ${mx - (dy / len) * mag} ${my + (dx / len) * mag} ${b.x} ${b.y}`;
}
function edgeKind(e) {
  if (e.type === 'callback' || e.type === 'thread_target') return 'foot';
  return 'road';
}
function render() {
  clearSvg();
  el('rect', { x: world.x - 4000, y: world.y - 4000, width: world.w + 9000, height: world.h + 9000, class: 'water' });
  // the mainland: one confined island, water on every side
  el('path', { d: blobPathD(world.x + world.w / 2, world.y + world.h / 2, world.w / 2 + 250, world.h / 2 + 250, 0.28, mulberry32(99), 14), class: 'island' });
  // topographic ridges + parks so the land feels alive
  const rndR = mulberry32(7);
  const gRidge = el('g', {});
  for (let i = 0; i < 22; i++) {
    const cx = world.x + rndR() * world.w, cy = world.y + rndR() * world.h;
    const base = 60 + rndR() * 130, rot = rndR() * 180;
    [1, 0.72, 0.46].forEach((s) => {
      el('ellipse', { cx, cy, rx: base * s, ry: base * s * (0.55 + rndR() * 0.3), transform: `rotate(${rot} ${cx} ${cy})`, class: 'ridge' }, gRidge);
    });
  }
  for (let i = 0; i < 9; i++) {
    const cx = world.x + rndR() * world.w, cy = world.y + rndR() * world.h;
    el('ellipse', { cx, cy, rx: 50 + rndR() * 90, ry: 35 + rndR() * 60, transform: `rotate(${rndR() * 180} ${cx} ${cy})`, class: 'park' }, gRidge);
  }
  // external libraries: a smaller offshore island across the water
  const gExt = el('g', { id: 'extland', style: showLibs ? '' : 'display:none' });
  el('path', { d: blobPathD(extBox.x + 150, extBox.y + extBox.h / 2, 235, extBox.h / 2 + 80, 0.3, mulberry32(31), 12), class: 'island' }, gExt);
  const extT = el('text', { x: extBox.x + 150, y: extBox.y + 34, 'text-anchor': 'middle', class: 'dlab' }, gExt);
  extT.textContent = 'EXTERNAL';
  // districts
  // file neighborhoods: one outline + filename label per file (outline-only,
  // fills were the old mess; hover/selection lights up the active file)
  gDist = el('g', {});
  outlineEls = {};
  {
    const members = new Map();
    visibleNodes().forEach((nd) => {
      if (!pos[nd.id]) return;
      if (!members.has(nd.filepath)) members.set(nd.filepath, []);
      members.get(nd.filepath).push(nd.id);
    });
    members.forEach((ids, fp) => {
      const pts = ids.map((id) => [pos[id].x, pos[id].y]);
      let cx = 0, cy = 0;
      pts.forEach((p) => { cx += p[0]; cy += p[1]; });
      cx /= pts.length; cy /= pts.length;
      const padded = pts.map(([x, y]) => {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
        const k = (d + 38) / d;
        return [cx + dx * k, cy + dy * k];
      });
      const hull = hullOf(padded);
      let dAttr, topY;
      if (hull.length >= 3) {
        dAttr = smoothClosed(hull);
        topY = Math.min(...hull.map((p) => p[1]));
      } else {
        const a = hull[0], b = hull[1] || hull[0];
        const r = Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 + 38;
        cx = (a[0] + b[0]) / 2; cy = (a[1] + b[1]) / 2;
        dAttr = `M ${cx - r},${cy} A ${r},${r} 0 1 0 ${cx + r},${cy} A ${r},${r} 0 1 0 ${cx - r},${cy} Z`;
        topY = cy - r;
      }
      const path = el('path', { d: dAttr, fill: 'none', class: 'foutline' }, gDist);
      const t = el('text', { x: cx, y: topY - 10, 'text-anchor': 'middle', class: 'dlab' }, gDist);
      t.textContent = shortFile(fp).toUpperCase();
      outlineEls[fp] = { path, label: t };
    });
  }
  // roads (internal first, then crossings; cap for perf)
  gRC = el('g', { class: 'minor' }); gR = el('g', { class: 'minor' });
  const gHC = el('g', {}), gHR = el('g', {});
  gRouteCase = el('g', {}); gRouteBlue = el('g', {}); gRouteWalk = el('g', {});
  const inPos = (id) => !!pos[id];
  const internal = EDGES.filter((e) => inPos(e.from) && inPos(e.to) && !String(e.to).startsWith('library_entity:'));
  const crossing = EDGES.filter((e) => inPos(e.from) && String(e.to).startsWith('library_entity:') && inPos(e.to) && showLibs);
  // highways: the ~18 busiest junctions stay visible at every zoom, like real maps
  const indeg = {}, outdeg = {};
  internal.forEach((e) => { outdeg[e.from] = (outdeg[e.from] || 0) + 1; indeg[e.to] = (indeg[e.to] || 0) + 1; });
  const HW = new Set(internal
    .map((e) => ({ k: e.from + '>' + e.to, s: (outdeg[e.from] || 0) + (indeg[e.to] || 0) }))
    .sort((a, b) => b.s - a.s).slice(0, 18).map((x) => x.k));
  incident = {}; longEdges = new Set();
  const noteIncident = (id, key) => { (incident[id] = incident[id] || []).push(key); };
  const LONG_PX = 640;
  // Geometry first (cheap), DOM insertion streamed (expensive): districts +
  // highways + places paint instantly, local streets flow in per frame.
  function insertRoad(job) {
    const { key, d, kind, isExt, hw } = job;
    if (kind === 'foot' && !isExt) {
      edgePath[key] = el('path', { d, class: 'foot' }, gR);
    } else if (isExt) {
      edgePath[key] = el('path', { d, fill: 'none', stroke: '#b9c4b2', 'stroke-width': 2.5, 'stroke-dasharray': '7 6', opacity: .8 }, gExt);
    } else if (hw) {
      el('path', { d, class: 'artcase', 'stroke-width': 13 }, gHC);
      edgePath[key] = el('path', { d, class: 'artcore', 'stroke-width': 8 }, gHR);
    } else {
      el('path', { d, class: 'roadcase', 'stroke-width': 10 }, gRC);
      edgePath[key] = el('path', { d, class: 'roadcore', 'stroke-width': 5.5 }, gR);
    }
  }
  const all = internal.concat(crossing).slice(0, 4000);
  const roadJobs = [];
  all.forEach((e) => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return;
    const key = e.from + '>' + e.to;
    const kind = edgeKind(e);
    const d = roadD(a, b, key, kind);
    const isExt = String(e.to).startsWith('library_entity:');
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    noteIncident(e.from, key); noteIncident(e.to, key);
    edgeD[key] = d;
    // teleport-roads (long cross-map strands) stay hidden until you select a place
    if (!isExt && len > LONG_PX && !HW.has(key)) longEdges.add(key);
    const job = { key, d, kind, isExt, hw: HW.has(key) };
    if (job.hw || isExt) insertRoad(job);
    else roadJobs.push(job);
  });
  let roadIx = 0;
  (function pumpRoads() {
    const end = Math.min(roadIx + 600, roadJobs.length);
    for (; roadIx < end; roadIx++) insertRoad(roadJobs[roadIx]);
    if (roadIx < roadJobs.length) requestAnimationFrame(pumpRoads);
    else paintRoads();
  })();
  // dots + labels
  // landmarks: top hubs by degree stay big + labeled at every zoom (like cities)
  MAJORS = new Set();
  {
    const deg = {};
    EDGES.forEach((e) => {
      if (!pos[e.from]) return;
      deg[e.from] = (deg[e.from] || 0) + 1;
      if (pos[e.to] && !String(e.to).startsWith('library_entity:')) deg[e.to] = (deg[e.to] || 0) + 1;
    });
    Object.entries(deg).sort((a, b) => b[1] - a[1]).slice(0, 24).forEach(([id]) => MAJORS.add(id));
    if (homeId && pos[homeId]) MAJORS.add(homeId);
    LIBS.forEach((l) => { if (pos[l.id]) MAJORS.add(l.id); });
  }
  gDot = el('g', {}); gLab = el('g', {});
  const showIds = new Set([...visibleNodes().map((n) => n.id), ...(showLibs ? LIBS.map((l) => l.id) : [])]);
  showIds.forEach((id) => {
    const n = byId[id], p = pos[id];
    if (!n || !p) return;
    const isCls = n.type === 'class_definition';
    const isLib = String(id).startsWith('library_entity:');
    // places are little buildings: houses for functions, towers for classes, sheds for libs
    const g = el('g', { class: 'place', transform: `translate(${p.x},${p.y})`, 'data-id': id }, gDot);
    const wall = isLib ? '#9aa0a6' : '#5f6368';
    const roof = isLib ? '#bdc1c6' : (isCls ? '#fbbc04' : '#6366f1');
    if (isCls) {
      el('rect', { x: -8, y: -16, width: 16, height: 27, rx: 2, fill: '#fffbeb', stroke: wall, 'stroke-width': 2, class: 'bld bhouse' }, g);
      el('rect', { x: -8, y: -16, width: 16, height: 5, fill: roof }, g);
      [[-4.5, -7], [0.5, -7], [-4.5, -1], [0.5, -1], [-4.5, 5], [0.5, 5]].forEach(([wx, wy]) => {
        el('rect', { x: wx, y: wy, width: 4, height: 4, fill: '#c7d0e0' }, g);
      });
    } else {
      el('rect', { x: -8, y: -2, width: 16, height: 13, rx: 1.5, fill: isLib ? '#e8eaed' : '#eef2ff', stroke: wall, 'stroke-width': 2, class: 'bld bhouse' }, g);
      el('polygon', { points: '-10.5,-2 0,-12 10.5,-2', fill: roof, stroke: wall, 'stroke-width': 2, 'stroke-linejoin': 'round', class: 'bld' }, g);
      el('rect', { x: -2.5, y: 3, width: 5, height: 8, fill: isLib ? '#bdc1c6' : '#8ea0c2' }, g);
    }
    dotEls[id] = g;
    const t = el('text', { x: p.x, y: p.y - 20, 'text-anchor': 'middle', class: 'flab', 'data-id': id }, gLab);
    t.textContent = n.name + (isLib ? ' ⊞' : '');
    t.style.cursor = 'pointer';
    labelEls[id] = t;
    g.addEventListener('mouseenter', (ev) => hover(id, true, ev));
    g.addEventListener('mouseleave', () => hover(id, false));
    t.addEventListener('mouseenter', (ev) => hover(id, true, ev));
    t.addEventListener('mouseleave', () => hover(id, false));
    g.addEventListener('click', (ev) => { ev.stopPropagation(); openPlace(id, true); });
    t.addEventListener('click', (ev) => { ev.stopPropagation(); openPlace(id, true); });
  });
  // selection pin + stops + traveler
  gStops = el('g', {});
  gPin = el('g', { opacity: 0 });
  el('ellipse', { cx: 0, cy: 2, rx: 10, ry: 3.5, fill: 'rgba(0,0,0,.25)' }, gPin);
  el('path', { d: 'M 0 -34 C -9 -34 -15 -27 -15 -19 C -15 -9 0 0 0 0 C 0 0 15 -9 15 -19 C 15 -27 9 -34 0 -34 Z', fill: '#ea4335' }, gPin);
  el('circle', { cx: 0, cy: -19, r: 6, fill: '#fff' }, gPin);
  traveler = el('circle', { r: 6.5, fill: '#1a73e8', stroke: '#fff', 'stroke-width': 2.5, opacity: 0 }, svg);
  buildMini();
  paintRoads();
  applyView();
  updateWordmark();
}

/* minimap inset: whole city, live viewport box, click to travel */
function buildMini() {
  const mini = $('minimap');
  mini.innerHTML = '';
  const fullW = (extBox.x + 380) - (world.x - 40), fullH = world.h + 120;
  mini.setAttribute('viewBox', `${world.x - 40} ${world.y - 60} ${fullW} ${fullH}`);
  visibleNodes().forEach((nd) => {
    const p = pos[nd.id];
    if (!p) return;
    el('circle', { cx: p.x, cy: p.y, r: 14, fill: nd.type === 'class_definition' ? '#fbbc04' : '#6366f1' }, mini);
  });
  if (showLibs) LIBS.forEach((l) => {
    const p = pos[l.id];
    if (p) el('circle', { cx: p.x, cy: p.y, r: 14, fill: '#9aa0a6' }, mini);
  });
  miniRect = el('rect', { x: view.x, y: view.y, width: view.w, height: view.h,
    fill: 'rgba(26,115,232,.08)', stroke: '#1a73e8', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', rx: 4 }, mini);
  miniPin = el('circle', { cx: 0, cy: 0, r: 16, fill: '#ea4335', stroke: '#fff',
    'stroke-width': 3, 'vector-effect': 'non-scaling-stroke', opacity: 0 }, mini);
  updateMini();
}
function updateMini() {
  if (miniRect) {
    miniRect.setAttribute('x', view.x); miniRect.setAttribute('y', view.y);
    miniRect.setAttribute('width', view.w); miniRect.setAttribute('height', view.h);
  }
}
$('minimap').addEventListener('click', (ev) => {
  if (miniDragged) { miniDragged = false; return; } // was a reposition drag, not travel
  const mini = $('minimap'), r = mini.getBoundingClientRect(), vb = mini.viewBox.baseVal;
  if (!vb || !r.width) return;
  const wx = vb.x + ((ev.clientX - r.left) / r.width) * vb.width;
  const wy = vb.y + ((ev.clientY - r.top) / r.height) * vb.height;
  view.x = wx - view.w / 2; view.y = wy - view.h / 2; applyView();
});
/* draggable inset: grab anywhere and park it where it covers nothing */
let miniDrag = null, miniDragged = false;
const miniEl = $('minimap');
miniEl.addEventListener('pointerdown', (ev) => {
  const r = miniEl.getBoundingClientRect();
  miniDrag = { x: ev.clientX, y: ev.clientY, l: r.left, t: r.top, w: r.width, h: r.height, moved: false };
  miniDragged = false;
  try { miniEl.setPointerCapture(ev.pointerId); } catch (e) {}
});
miniEl.addEventListener('pointermove', (ev) => {
  if (!miniDrag) return;
  const dx = ev.clientX - miniDrag.x, dy = ev.clientY - miniDrag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) { miniDrag.moved = true; miniDragged = true; }
  if (!miniDrag.moved) return;
  miniEl.classList.add('dragging');
  const nl = Math.min(Math.max(0, miniDrag.l + dx), window.innerWidth - miniDrag.w);
  const nt = Math.min(Math.max(0, miniDrag.t + dy), window.innerHeight - miniDrag.h);
  miniEl.style.left = nl + 'px'; miniEl.style.top = nt + 'px';
  miniEl.style.right = 'auto'; miniEl.style.bottom = 'auto';
});
miniEl.addEventListener('pointerup', () => {
  miniEl.classList.remove('dragging');
  if (miniDrag && miniDrag.moved) {
    try { localStorage.setItem('codyMiniPos', JSON.stringify({ l: miniEl.style.left, t: miniEl.style.top })); } catch (e) {}
  }
  miniDrag = null;
});
// remember inset position + visibility across reloads
try {
  const mp = JSON.parse(localStorage.getItem('codyMiniPos') || 'null');
  if (mp && mp.l) {
    miniEl.style.left = mp.l; miniEl.style.top = mp.t;
    miniEl.style.right = 'auto'; miniEl.style.bottom = 'auto';
  }
  if (localStorage.getItem('codyMiniHidden') === '1') {
    miniEl.style.display = 'none';
    const cb = $('layMini');
    if (cb) cb.checked = false;
  }
} catch (e) {}
$('layMini').onchange = (e) => {
  miniEl.style.display = e.target.checked ? '' : 'none';
  try { localStorage.setItem('codyMiniHidden', e.target.checked ? '0' : '1'); } catch (err) {}
};
function updateWordmark() {
  const libCount = EDGES.filter((e) => String(e.to).startsWith('library_entity:')).length;
  $('wordmark').textContent = `Cody · ${visibleNodes().length} places · ${EDGES.length} roads`;
  void libCount;
}

/* ---------------- camera ---------------- */
let view = { x: 0, y: 0, w: 560, h: 392 }, scale = 1;
const BASE_W = 560;
function applyView() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  svg.classList.toggle('far', scale < 0.62);
  svg.classList.toggle('nolabels', !showLabels);
  const steps = [[0.12, '2k fn'], [0.4, '500 fn'], [0.62, '250 fn'], [1, '100 fn'], [1.6, '50 fn'], [9, '25 fn']];
  const found = steps.find((s) => scale < s[0]);
  $('scalelabel').textContent = found ? found[1] : '25 fn';
  sizeIcons();
  updateMini();
}
/* zoom semantics, like real maps: every place shares one size and one scale
   (no favorites). Tiers only decide *visibility*: landmarks + districts stay
   on the map far out; minor places and their labels bow out below readability
   instead of decaying into pimples. */
function sizeIcons() {
  if (Math.abs(scale - lastZoom) < 0.002) return;
  lastZoom = scale;
  const cs = Math.min(1.5, Math.max(0.12, Math.pow(scale, 0.65))).toFixed(3);
  for (const id in dotEls) {
    const p = pos[id];
    if (!p) continue;
    const major = MAJORS.has(id);
    dotEls[id].setAttribute('transform', `translate(${p.x},${p.y}) scale(${cs})`);
    if (!major && scale < 0.3) dotEls[id].setAttribute('visibility', 'hidden');
    else dotEls[id].setAttribute('visibility', 'visible');
    const lab = labelEls[id];
    if (!lab) continue;
    if (scale < 0.62 && !major) lab.setAttribute('visibility', 'hidden');
    else {
      lab.setAttribute('visibility', 'visible');
      lab.setAttribute('font-size', (major && scale < 0.62) ? Math.min(90, 15 / scale) : 13);
    }
  }
}
function zoomAt(f) {
  scale = Math.min(3.2, Math.max(0.05, scale * f));
  view.w = BASE_W / scale; view.h = view.w * 0.7; applyView();
}
function fitWorld() {
  scale = Math.min(1.4, Math.max(0.35, Math.min(1600 / world.w, 1000 / world.h)));
  view.w = BASE_W / scale; view.h = view.w * 0.7;
  view.x = world.x + world.w / 2 - view.w / 2;
  view.y = world.y + world.h / 2 - view.h / 2;
  applyView();
}
function flyTo(p, s, done) {
  if (s) scale = s;
  const tw = BASE_W / scale, th = tw * 0.7;
  const from = { ...view }, to = { x: p.x - tw / 2, y: p.y - th / 2, w: tw, h: th };
  const t0 = performance.now(), dur = 650;
  (function step(t) {
    const k = Math.min(1, (t - t0) / dur), ez = 1 - Math.pow(1 - k, 3);
    view = {
      x: from.x + (to.x - from.x) * ez, y: from.y + (to.y - from.y) * ez,
      w: from.w + (to.w - from.w) * ez, h: from.h + (to.h - from.h) * ez,
    };
    applyView();
    if (k < 1) requestAnimationFrame(step); else if (done) done();
  })(t0);
}
$('zin').onclick = () => zoomAt(1.3);
$('zout').onclick = () => zoomAt(1 / 1.3);
$('zhome').onclick = () => { if (homeId && pos[homeId]) flyTo(pos[homeId], 1); else fitWorld(); };
svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
svg.addEventListener('dblclick', (e) => { e.preventDefault(); zoomAt(1.5); });
let drag = null;
svg.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  svg.classList.add('drag');
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  const r = svg.getBoundingClientRect(), k = view.w / r.width;
  view.x = drag.vx - dx * k; view.y = drag.vy - dy * k; applyView();
});
window.addEventListener('pointerup', (ev) => {
  const wasDrag = drag && drag.moved;
  drag = null; svg.classList.remove('drag');
  if (!wasDrag && ev && ev.target === svg) closePanel();
});

/* ---------------- hover ---------------- */
const tip = $('tip');
function linkedIds(id) {
  const s = new Set();
  EDGES.forEach((e) => {
    if (e.from === id && pos[e.to]) s.add(e.to);
    if (e.to === id && pos[e.from]) s.add(e.from);
  });
  return s;
}
/* Road painting: long teleport-roads stay hidden by default (uniformity).
   Selecting or hovering a place reveals its roads, like a route preview. */
function paintRoads() {
  const focus = paintHov || paintId;
  const focusSet = focus && incident[focus] ? new Set(incident[focus]) : null;
  Object.entries(edgePath).forEach(([key, p]) => {
    if (!p || !p.getAttribute) return;
    const cls = p.getAttribute('class');
    const isFoot = cls === 'foot';
    const isDash = !!p.getAttribute('stroke-dasharray');
    const isLong = longEdges.has(key);
    const hit = focusSet ? focusSet.has(key) : false;
    if (isLong && !hit) { p.setAttribute('visibility', 'hidden'); return; }
    p.setAttribute('visibility', 'visible');
    if (isFoot || isDash) {
      p.setAttribute('opacity', focusSet && !hit ? 0.15 : (isFoot ? 1 : 0.8));
      return;
    }
    if (hit && focus) {
      p.style.stroke = focus === paintId ? '#fbbc04' : '#1a73e8';
      p.style.strokeWidth = '7';
      p.setAttribute('opacity', 1);
    } else {
      p.style.stroke = ''; p.style.strokeWidth = '';
      p.setAttribute('opacity', focusSet ? 0.18 : 1);
    }
  });
  Object.entries(dotEls).forEach(([nid, d]) => {
    if (!focusSet || nid === focus) { d.setAttribute('opacity', 1); return; }
    const near = (incident[focus] || []).some((k) => {
      const parts = k.split('>');
      return parts[0] === nid || parts[1] === nid;
    });
    d.setAttribute('opacity', near ? 1 : 0.3);
  });
}
function hover(id, on, ev) {
  paintHov = on ? id : (paintHov === id ? null : paintHov);
  paintRoads();
  paintOutlines(on ? (byId[id] || {}).filepath
                   : (selected && byId[selected] ? byId[selected].filepath : null));
  if (on && ev) {
    tip.style.display = 'block';
    tip.textContent = (byId[id] || {}).name || id;
    tip.style.left = (ev.clientX + 14) + 'px';
    tip.style.top = (ev.clientY + 8) + 'px';
  } else tip.style.display = 'none';
}

/* ---------------- pin ---------------- */
function dropPin(x, y) {
  gPin.setAttribute('opacity', 1);
  if (miniPin) {
    miniPin.setAttribute('cx', x); miniPin.setAttribute('cy', y);
    miniPin.setAttribute('opacity', 1);
  }
  const t0 = performance.now(), dur = 420;
  (function step(t) {
    const k = Math.min(1, (t - t0) / dur);
    const ez = 1 - Math.pow(1 - k, 3);
    const bounce = k > 0.62 ? Math.sin(((k - 0.62) / 0.38) * Math.PI) * -7 * (1 - k) : 0;
    gPin.setAttribute('transform', `translate(${x},${y - 34 * (1 - ez) + bounce})`);
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

/* ---------------- panel ---------------- */
const panel = $('panel');
let lastView = 'analyze';
function showView(name) {
  lastView = name;
  $('aview').style.display = name === 'analyze' ? '' : 'none';
  $('pview').style.display = name === 'place' ? '' : 'none';
  $('tview').style.display = name === 'trip' ? '' : 'none';
  panel.classList.add('open');
}
// hamburger: hide the panel, or bring back whatever was showing
$('menuBtn').onclick = () => {
  if (panel.classList.contains('open')) panel.classList.remove('open');
  else showView(selected ? 'place' : (touring ? 'trip' : lastView));
};
function closePanel() {
  panel.classList.remove('open');
  selected = null;
  paintId = null; paintHov = null;
  paintRoads();
  paintOutlines(null);
  if (gPin) gPin.setAttribute('opacity', 0);
  if (miniPin) miniPin.setAttribute('opacity', 0);
}
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === name));
  document.querySelectorAll('.tabpage').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + name));
}
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.t); });

function displayName(n) { return n.name; }
async function openPlace(id, fly, noHist) {
  const n = byId[id];
  if (!n || !pos[id]) return;
  const prev = (selected && selected !== id && pos[selected]) ? selected : null;
  selected = id;
  if (prev && !noHist) pushHist(prev);
  dropPin(pos[id].x, pos[id].y);
  paintId = id; paintHov = null;
  paintRoads();
  paintOutlines(n.filepath);
  showView('place');
  const isLib = String(id).startsWith('library_entity:');
  const isCls = n.type === 'class_definition';
  $('ccat').textContent = isLib ? 'External library' : (isCls ? 'Class' : 'Function');
  $('cname').textContent = n.name;
  $('cstats').textContent = 'loading…';
  $('cabout').textContent = 'Generating plain-English explanation…';
  $('ccode').textContent = 'Loading source…';
  $('frow-file').textContent = isLib ? 'not in this repo' : shortFile(n.filepath);
  $('frow-lines').textContent = '';
  $('c-callers').innerHTML = ''; $('c-callees').innerHTML = '';
  $('chatlog').innerHTML = '';
  showTab('overview');
  if (fly) flyTo(pos[id], Math.max(scale, 1));
  try {
    const [det, rel] = await Promise.all([
      isLib ? Promise.resolve(null) : getJSON(apiUrl('/api/node/details', { node_id: id })).catch(() => null),
      getJSON(apiUrl('/api/node/relations', { node_id: id })).catch(() => ({ inbound: [], outbound: [] })),
    ]);
    if (selected !== id) return;
    // hide-tests applies to relations too, so chips match the counts
    const relFilter = (arr) => (hideTests ? arr.filter((r) => !isTestPath(r.other_file)) : arr);
    const inn = relFilter(rel.inbound || []).slice(0, 30), out = relFilter(rel.outbound || []).slice(0, 30);
    $('cstats').innerHTML = `<b>&larr; ${inn.length}</b> callers &middot; <b>&rarr; ${out.length}</b> calls &middot; ${esc(isLib ? 'external' : shortFile(n.filepath))}`;
    if (det) {
      $('ccode').innerHTML = pyHighlight(det.code || '# unavailable');
      $('frow-lines').textContent = `Lines ${det.start_row + 1}–${det.end_row + 1}`;
    } else {
      $('ccode').textContent = '# external — no source on this map';
      $('frow-lines').textContent = n.lines || 'stdlib';
    }
    const mk = (arr, boxId, arrow) => {
      const box = $(boxId); box.innerHTML = '';
      const seen = new Set();
      arr.forEach((r) => {
        const oid = r.other_id;
        if (!oid || seen.has(oid)) return;
        seen.add(oid);
        const s = document.createElement('button');
        s.className = 'chip';
        s.textContent = (arrow === 'in' ? '← ' : '') + (r.other_name || oid) + (arrow === 'out' ? ' →' : '');
        s.title = r.other_file || '';
        if (pos[oid]) s.onclick = () => openPlace(oid, true);
        else { s.disabled = true; s.style.opacity = 0.55; s.style.cursor = 'default'; }
        box.appendChild(s);
      });
      if (!box.children.length) box.innerHTML = '<span style="font-size:12px;color:var(--mut)">None</span>';
    };
    mk(inn, 'c-callers', 'in'); mk(out, 'c-callees', 'out');
  } catch (e) { $('cstats').textContent = 'Could not load relations.'; }
  try {
    if (explainCache[id]) { $('cabout').innerHTML = renderMarkdown(explainCache[id]); return; }
    const d = await getJSON(apiUrl('/api/node/explain', { node_id: id }));
    if (selected !== id) return;
    explainCache[id] = d.explanation || 'No explanation available.';
    $('cabout').innerHTML = renderMarkdown(explainCache[id]);
  } catch (e) {
    if (selected !== id) return;
    $('cabout').textContent = 'AI offline — start Ollama (`ollama serve`). On office/VPN Wi-Fi also bypass the proxy for 127.0.0.1,localhost. Code and map still work.';
  }
}
$('btnRoute').onclick = () => {
  if (!selected) return;
  const ix = tourStops.indexOf(selected);
  startTour(ix >= 0 ? ix : 0, selected);
};
$('btnNear').onclick = () => {
  if (!selected) return;
  showTab('overview');
  linkedIds(selected).forEach((oid) => {
    const d = dotEls[oid];
    if (!d) return;
    d.classList.add('near');
    setTimeout(() => d.classList.remove('near'), 1300);
  });
  toast('Blue rings = directly connected');
};
$('btnAsk').onclick = () => { showTab('qa'); $('askinput').focus(); };
$('btnCopy').onclick = async () => {
  if (!selected) return;
  try { await navigator.clipboard.writeText(byId[selected].name); toast('Copied to clipboard'); }
  catch { toast(byId[selected].name); }
};

/* Q&A — grounded in the open place, history kept per place */
function renderMsg(role, text) {
  const log = $('chatlog');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'you') div.textContent = text;
  else div.innerHTML = renderMarkdown(text);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

/* mini-markdown: fences, inline code, bold/italic, headers, lists.
   Everything escaped first, so model output can never inject HTML. */
function renderMarkdown(src) {
  const parts = String(src).split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      let code = parts[i].replace(/^\n/, '');
      const nl = code.indexOf('\n');
      if (nl >= 0 && /^[a-zA-Z+#-]+$/.test(code.slice(0, nl).trim())) code = code.slice(nl + 1);
      html += '<pre class="code">' + pyHighlight(code.replace(/\n$/, '')) + '</pre>';
    } else {
      html += mdBlock(parts[i]);
    }
  }
  return html;
}

function mdBlock(text) {
  const codes = [];
  let t = esc(text);
  t = t.replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(c);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[+i] + '</code>');
  const lines = t.split('\n');
  let html = '', list = null;
  const close = () => { if (list) { html += list === 'ul' ? '</ul>' : '</ol>'; list = null; } };
  lines.forEach((ln) => {
    const line = ln.trim();
    if (!line) { close(); return; }
    let m;
    const hashes = line.match(/^#+/);
    if (hashes && /^#+\s/.test(line)) {
      close();
      const lvl = Math.min(4, hashes[0].length) + 2;
      html += `<h${lvl}>` + line.replace(/^#+\s+/, '') + `</h${lvl}>`;
    } else if ((m = line.match(/^[-*]\s+(.*)/))) {
      if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
      html += `<li>${m[1]}</li>`;
    } else if ((m = line.match(/^\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; }
      html += `<li>${m[1]}</li>`;
    } else {
      close();
      html += `<p>${line}</p>`;
    }
  });
  close();
  return html;
}

function pyHighlight(code) {
  const re = /(#[^\n]*)|('''[\s\S]*?'''|"""[\s\S]*?"""|f'[^'\n]*'|f"[^"\n]*"|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|\b(\d[\d_]*(?:\.\d+)?)\b|\b(import|from|def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|with|as|try|except|finally|raise|lambda|pass|break|continue|yield|global|nonlocal|assert|del|async|await)\b|(@[A-Za-z_]\w*)|([A-Za-z_]\w*)(?=\s*\()/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const full = m[0];
    const cls = m[1] !== undefined ? 'tok-c' : m[2] !== undefined ? 'tok-s'
      : m[3] !== undefined ? 'tok-n' : m[4] !== undefined ? 'tok-k'
      : m[5] !== undefined ? 'tok-d' : m[6] !== undefined ? 'tok-f' : '';
    out += cls ? `<span class="${cls}">${esc(full)}</span>` : esc(full);
    last = m.index + full.length;
  }
  return out + esc(code.slice(last));
}
async function ask() {
  const inp = $('askinput');
  const q = inp.value.trim();
  if (!q || !selected) return;
  inp.value = '';
  if (chatNode !== selected) { chatNode = selected; chatHist = {}; }
  const hist = chatHist[selected] || [];
  renderMsg('you', q);
  renderMsg('cody', '…');
  const log = $('chatlog');
  $('askbtn').disabled = true;
  try {
    const d = await getJSON('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: selected, message: q, history: hist.slice(-10), repo_id: repoId || undefined }),
    });
    log.removeChild(log.lastChild);
    renderMsg('cody', d.answer || '(empty reply)');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: d.answer || '' });
    chatHist[selected] = hist;
  } catch (e) {
    log.removeChild(log.lastChild);
    renderMsg('cody', 'AI offline — run `ollama serve` + `ollama pull qwen2.5-coder:3b`. On office/VPN Wi-Fi also bypass the proxy for 127.0.0.1,localhost.');
  }
  $('askbtn').disabled = false;
}
$('askbtn').onclick = ask;
$('askinput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });

/* ---------------- tour = directions over the real walkthrough ---------------- */
function legGeometry(aId, bId) {
  const fwd = edgePath[aId + '>' + bId], rev = edgePath[bId + '>' + aId];
  if (fwd) return { d: fwd.getAttribute('d'), walk: false, fwd: true };
  if (rev) return { d: rev.getAttribute('d'), walk: false, fwd: false };
  // road not in DOM yet (still streaming) — geometry was precomputed
  const fd = edgeD[aId + '>' + bId], rd = edgeD[bId + '>' + aId];
  if (fd) return { d: fd, walk: false, fwd: true };
  if (rd) return { d: rd, walk: false, fwd: false };
  const a = pos[aId], b = pos[bId];
  if (!a || !b) return null;
  return { d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, walk: true, fwd: true };
}
function buildRoute() {
  gRouteCase.innerHTML = ''; gRouteBlue.innerHTML = ''; gRouteWalk.innerHTML = '';
  for (let i = 0; i < tourStops.length - 1; i++) {
    const leg = legGeometry(tourStops[i], tourStops[i + 1]);
    if (!leg) continue;
    if (leg.walk) {
      el('path', { d: leg.d, fill: 'none', stroke: '#5f6368', 'stroke-width': 3, 'stroke-dasharray': '2 7', 'stroke-linecap': 'round' }, gRouteWalk);
    } else {
      el('path', { d: leg.d, fill: 'none', stroke: '#fff', 'stroke-width': 9, 'stroke-linecap': 'round', opacity: 0.95 }, gRouteCase);
      el('path', { d: leg.d, fill: 'none', stroke: '#1a73e8', 'stroke-width': 5.5, 'stroke-linecap': 'round' }, gRouteBlue);
    }
  }
}
function clearStops() { gStops.innerHTML = ''; }
function addStopPin(p, num) {
  const g = el('g', { transform: `translate(${p.x},${p.y})` }, gStops);
  el('ellipse', { cx: 0, cy: 2, rx: 9, ry: 3, fill: 'rgba(0,0,0,.22)' }, g);
  el('path', { d: 'M 0 -30 C -8 -30 -13 -24 -13 -17 C -13 -8 0 0 0 0 C 0 0 13 -8 13 -17 C 13 -24 8 -30 0 -30 Z', fill: '#1a73e8' }, g);
  const t = el('text', { x: 0, y: -13, 'text-anchor': 'middle', fill: '#fff', 'font-size': 11, 'font-weight': 700 }, g);
  t.textContent = num;
}
function renderTripList() {
  const ol = $('triplist'); ol.innerHTML = '';
  tourStops.forEach((id, i) => {
    const n = byId[id];
    if (!n) return;
    const li = document.createElement('li');
    if (i === stopIx) li.className = 'cur';
    li.innerHTML = `<span class="n">${i + 1}</span><span class="t"><b>${esc(n.name)}</b><small>${esc(shortFile(n.filepath || 'external'))}</small></span>`;
    li.onclick = () => goStop(i);
    ol.appendChild(li);
  });
  $('tsum').textContent = `${tourStops.length} stops on this trip · ${fullSeq.length} in full walkthrough`;
  $('tcount').textContent = touring ? `${stopIx + 1} / ${tourStops.length}` : '';
  $('tprev').disabled = !touring || stopIx <= 0;
  $('tnext').textContent = !touring ? 'Start →' : (stopIx >= tourStops.length - 1 ? 'Finish ✔' : 'Next →');
  if (touring && tourStops.length && stopIx >= 0) {
    const sn = byId[tourStops[stopIx]];
    $('tnowLabel').textContent = sn ? `Stop ${stopIx + 1}/${tourStops.length} · ${sn.name}` : '';
    $('tnowPrev').disabled = stopIx <= 0;
    $('tnowNext').textContent = stopIx >= tourStops.length - 1 ? 'Finish ✔' : 'Next →';
  }
}
async function startTour(ix, focusId) {
  try {
    const d = await getJSON(apiUrl('/api/walkthrough'));
    fullSeq = (d.sequence || []).filter((id) => pos[id]);
    if (!fullSeq.length) { toast('Nothing to tour yet — analyze a repo first.'); return; }
  } catch (e) { toast('Tour unavailable.'); return; }
  let stops = fullSeq.slice(0, 10);
  if (focusId && pos[focusId]) {
    const at = fullSeq.indexOf(focusId);
    stops = (at >= 0 ? fullSeq.slice(at, at + 10) : [focusId, ...fullSeq.slice(0, 9)]);
  }
  tourStops = stops.filter((id) => pos[id]);
  touring = true; clearStops();
  $('tripstrip').style.display = 'flex';
  tourStops.forEach((id, i) => addStopPin(pos[id], i + 1));
  buildRoute();
  showView('trip');
  goStop(ix || 0);
}
function endTour(doneMsg) {
  touring = false; stopIx = -1; tourStops = [];
  clearStops();
  gRouteCase.innerHTML = ''; gRouteBlue.innerHTML = ''; gRouteWalk.innerHTML = '';
  traveler.setAttribute('opacity', 0);
  renderTripList();
  closePanel();
  lastView = 'analyze';
  $('tripstrip').style.display = 'none';
  if (doneMsg) toast('Trip complete 🎉');
}
function goStop(ix) {
  if (ix < 0 || ix >= tourStops.length) return;
  const prevId = (touring && stopIx >= 0) ? tourStops[stopIx] : null;
  stopIx = ix; renderTripList();
  const target = tourStops[ix];
  const arrive = () => {
    const prevA = (selected && selected !== target && pos[selected]) ? selected : null;
    dropPin(pos[target].x, pos[target].y);
    selected = target;
    if (prevA) pushHist(prevA);
    paintId = target; paintHov = null;
    paintRoads();
    paintOutlines(byId[target] ? byId[target].filepath : null);
    renderTripList();
    // the stop IS a place visit: full explanation card + Q&A, like a click
    openPlace(target, false, true);
  };
  if (prevId && prevId !== target && pos[prevId]) {
    const leg = legGeometry(prevId, target);
    if (!leg) { flyTo(pos[target], 1, arrive); return; }
    const tmp = el('path', { d: leg.d, fill: 'none', stroke: 'none' }, svg);
    let L = 0;
    try { L = tmp.getTotalLength(); } catch (e) { tmp.remove(); flyTo(pos[target], 1, arrive); return; }
    traveler.setAttribute('opacity', 1);
    const t0 = performance.now(), dur = 800;
    (function step(t) {
      const k = Math.min(1, (t - t0) / dur);
      let pt;
      try { pt = tmp.getPointAtLength(leg.fwd ? L * k : L * (1 - k)); }
      catch (e) { tmp.remove(); traveler.setAttribute('opacity', 0); arrive(); return; }
      traveler.setAttribute('cx', pt.x); traveler.setAttribute('cy', pt.y);
      view.x = pt.x - view.w / 2; view.y = pt.y - view.h / 2; applyView();
      if (k < 1) requestAnimationFrame(step);
      else { tmp.remove(); traveler.setAttribute('opacity', 0); arrive(); }
    })(t0);
  } else flyTo(pos[target], 1, arrive);
}
function tripNext() {
  if (!touring) startTour(0);
  else if (stopIx >= tourStops.length - 1) endTour(true);
  else goStop(stopIx + 1);
}
function tripPrev() { goStop(stopIx - 1); }
$('tnext').onclick = tripNext;
$('tprev').onclick = tripPrev;
$('tend').onclick = () => endTour(false);
$('tnowNext').onclick = tripNext;
$('tnowPrev').onclick = tripPrev;
$('tnowList').onclick = () => showView('trip');
$('tnowEnd').onclick = () => endTour(false);

/* browser-style back/forward through visited places */
function pushHist(id) {
  if (histBack[histBack.length - 1] === id) return;
  histBack.push(id);
  if (histBack.length > 100) histBack.shift();
  histFwd.length = 0;
  updateHistBtns();
}
function updateHistBtns() {
  $('navBack').disabled = !histBack.length;
  $('navFwd').disabled = !histFwd.length;
}
function jumpHist(dir) {
  const from = (selected && pos[selected]) ? selected : null;
  const id = dir < 0 ? histBack.pop() : histFwd.pop();
  if (!id || !pos[id]) { updateHistBtns(); return; }
  if (from && from !== id) {
    const arr = dir < 0 ? histFwd : histBack;
    arr.push(from);
    if (arr.length > 100) arr.shift();
  }
  updateHistBtns();
  openPlace(id, true, true);
}
$('navBack').onclick = () => jumpHist(-1);
$('navFwd').onclick = () => jumpHist(1);

/* ---------------- search ---------------- */
const sInput = $('searchinput'), sBox = $('results');
let searchTimer = null;
sInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = sInput.value.trim();
    if (!q) { sBox.style.display = 'none'; return; }
    let hits = [];
    try { hits = (await getJSON(apiUrl('/api/search', { q }))).results || []; } catch (e) { /* offline */ }
    hits = hits.filter((r) => pos[r.id]).slice(0, 7);
    sBox.innerHTML = '';
    if (!hits.length) sBox.innerHTML = '<div class="row" style="color:var(--mut)">No places found on this map</div>';
    hits.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="pin">📍</span><span>${esc(r.name)}</span><small>${esc(shortFile(r.filepath))}</small>`;
      row.onmousedown = () => {
        sBox.style.display = 'none';
        if (scale < 1) scale = 1;
        flyTo(pos[r.id], 1, () => openPlace(r.id, false));
      };
      sBox.appendChild(row);
    });
    sBox.style.display = 'block';
  }, 220);
});
sInput.addEventListener('blur', () => setTimeout(() => { sBox.style.display = 'none'; }, 150));
sInput.addEventListener('focus', () => { if (sBox.children.length) sBox.style.display = 'block'; });
sInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = sBox.querySelector('.row');
    if (first) first.onmousedown();
  }
});

/* ---------------- repo chip: analyze + recent maps ---------------- */
$('repoChip').onclick = () => { showView('analyze'); refreshRepos(); };
async function refreshRepos() {
  const box = $('repolist');
  box.innerHTML = '<div style="font-size:12px;color:var(--mut)">Loading…</div>';
  try {
    const d = await getJSON('/api/repos');
    const repos = d.repos || [];
    box.innerHTML = '';
    if (!repos.length) box.innerHTML = '<div style="font-size:12px;color:var(--mut)">No maps yet — analyze one above.</div>';
    repos.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'reporow';
      const when = r.created_at ? new Date(r.created_at * 1000).toLocaleDateString() : '';
      row.innerHTML = `<b>${esc(r.name)}</b><small>${r.node_count} places · ${esc(when)}</small>`;
      row.onclick = () => { repoId = r.id; boot(false); };
      box.appendChild(row);
    });
  } catch (e) { box.innerHTML = '<div style="font-size:12px;color:var(--mut)">Backend offline.</div>'; }
}
$('analyzeBtn').onclick = async () => {
  const src = $('srcinput').value.trim();
  if (!src) return;
  const btn = $('analyzeBtn'), st = $('jobstatus');
  btn.disabled = true;
  st.className = ''; st.textContent = 'Starting…';
  try {
    const job = await getJSON('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src, skip_llm: true }),
    });
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await getJSON('/api/analyze/status?job_id=' + encodeURIComponent(job.job_id));
      if (s.status === 'done') {
        st.textContent = 'Map ready ✔';
        repoId = s.repo_id || repoId;
        btn.disabled = false;
        await boot(false);
        return;
      }
      if (s.status === 'error') {
        st.className = 'err';
        st.textContent = 'Failed: ' + (s.error || s.detail || 'unknown');
        btn.disabled = false;
        return;
      }
      st.textContent = `Working… ${s.phase || ''} ${(s.detail || '').slice(-70)}`;
    }
    st.className = 'err'; st.textContent = 'Timed out — try a smaller repo.';
  } catch (e) {
    st.className = 'err'; st.textContent = 'Could not reach backend.';
  }
  btn.disabled = false;
};

/* ---------------- chrome ---------------- */
$('satMap').onclick = () => {
  document.body.classList.remove('sat');
  $('satMap').className = 'on'; $('satSat').className = '';
};
$('satSat').onclick = () => {
  document.body.classList.add('sat');
  $('satSat').className = 'on'; $('satMap').className = '';
};
$('layersBtn').onclick = () => {
  const m = $('layersMenu');
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
};
$('layLib').onchange = (e) => {
  showLibs = e.target.checked; layout(); render();
  if (selected && !pos[selected]) closePanel(); else { paintRoads(); if (selected && byId[selected]) paintOutlines(byId[selected].filepath); }
};
$('layLabels').onchange = (e) => { showLabels = e.target.checked; applyView(); };
$('layTests').onchange = (e) => {
  hideTests = e.target.checked;
  endTourSilent(); layout(); render(); fitOrHome();
  if (selected && !pos[selected]) closePanel(); else { paintRoads(); if (selected && byId[selected]) paintOutlines(byId[selected].filepath); }
};
function endTourSilent() {
  touring = false; stopIx = -1; tourStops = [];
  paintId = null; paintHov = null;
  clearStops();
  if (gRouteCase) { gRouteCase.innerHTML = ''; gRouteBlue.innerHTML = ''; gRouteWalk.innerHTML = ''; }
  if (traveler) traveler.setAttribute('opacity', 0);
  $('tripstrip').style.display = 'none';
  paintRoads();
}
$('hintx').onclick = () => { $('hint').style.display = 'none'; };

/* ---------------- boot ---------------- */
function fitOrHome() {
  if (homeId && pos[homeId] && visibleNodes().length > 60) flyTo(pos[homeId], 1);
  else fitWorld();
}
async function boot(openCard) {
  // Wrong-address guard: without :PORT the request hits the office proxy, not us.
  try {
    const host = window.location.hostname, port = window.location.port;
    if ((host === '127.0.0.1' || host === 'localhost') && (port === '' || port === '80')) {
      $('hint').querySelector('span').innerHTML =
        '<b>Wrong address.</b> Cody needs its port — open <b>http://127.0.0.1:5000</b> instead of this page.';
    }
    const h = await getJSON('/api/health');
    if (h && h.proxy_env) toast('Office proxy detected — if AI fails, bypass proxy for 127.0.0.1,localhost');
  } catch (e) { /* backend down; handled below */ }
  try {
    const rd = await getJSON('/api/repos');
    const repos = rd.repos || [];
    if (!repoId || !repos.some((r) => r.id === repoId)) {
      repoId = repos.length ? repos[0].id : '';
      repoName = repos.length ? repos[0].name : '…';
    } else {
      const cur = repos.find((r) => r.id === repoId);
      repoName = cur ? cur.name : repoId;
    }
  } catch (e) { repoName = 'offline'; }
  $('repoChip').textContent = '🗺 ' + repoName;
  let nodes = [], edges = [];
  try {
    const g = await getJSON(apiUrl('/api/graph'));
    nodes = g.nodes || []; edges = g.edges || [];
  } catch (e) { /* backend down */ }
  if (!nodes.length) {
    clearSvg();
    showView('analyze');
    refreshRepos();
    return;
  }
  buildModel(nodes, edges);
  try {
    const w = await getJSON(apiUrl('/api/walkthrough'));
    fullSeq = w.sequence || [];
    homeId = (w.start_node_id && byId[w.start_node_id]) ? w.start_node_id : (nodes[0] && nodes[0].id);
  } catch (e) { homeId = nodes[0] && nodes[0].id; fullSeq = []; }
  layout(); render(); fitOrHome();
  if (openCard && homeId && pos[homeId]) openPlace(homeId, false);
  else if (homeId && pos[homeId]) dropPin(pos[homeId].x, pos[homeId].y);
}
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault(); sInput.focus();
  }
  if (e.key === 'Escape') { closePanel(); sBox.style.display = 'none'; }
});
boot(true);
