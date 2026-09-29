'use strict';

// The knowledge galaxy: every note is a star, placed by what it's about (similar notes sit
// together). Plain canvas and a little 3D math; no libraries.

const SOURCE_COLORS = {
  notes: '#ffcf70',
  files: '#6ee7b7',
  computer: '#6ee7b7',
  bsh: '#5fc8ff',
  research: '#c9a2ff',
  meetings: '#f5d0fe',
  photos: '#ff8fc7',
  mail: '#ff8a65',
  messages: '#b8f26b',
};
const SOURCE_NAMES = {
  notes: 'Apple Notes', files: 'Folders', computer: 'Files', bsh: 'BSH desk',
  research: 'Research', meetings: 'Meetings', photos: 'Photos', mail: 'Email', messages: 'Texts',
};

// Past this many stars a frame draws a fixed sample of the rest (the focused, highlighted and
// hovered ones always): a frame costs about the same at 10,000 notes as at 100,000.
const STAR_BUDGET = 8000;
const EDGE_BUDGET = 8000;
const SORT_EVERY_MS = 200; // the view turns slowly: the depth order is redone a few times a second

class Galaxy {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.nodes = [];
    this.edges = [];
    this.byId = new Map();
    this.yaw = 0.6;
    this.pitch = 0.95; // look down onto the spiral disc
    this.dist = 3.6;
    this.goalDist = 3.6;
    this.clusters = [];
    this.target = [0, 0, 0];
    this.goal = [0, 0, 0];
    this.spin = 0.06;
    this.focusId = null;
    this.highlights = new Set();
    this.hoverId = null;
    this.interactive = false;
    this.running = false;
    this.onSelect = null;
    this.sprites = {};
    this.last = 0;
    for (const [source, color] of Object.entries(SOURCE_COLORS)) this.sprites[source] = sprite(color);
    this.sprites.focus = sprite('#ffffff');
    this._bind();
  }

  setData(data) {
    this.nodes = (data.nodes || []).map((n) => ({ ...n, color: SOURCE_COLORS[n.source] || '#9fb3c8' }));
    this.edges = data.edges || [];
    this.clusters = data.clusters || [];
    this.byId = new Map(this.nodes.map((n, i) => [n.id, i]));
    if (this.focusId && !this.byId.has(this.focusId)) this.focusId = null;
  }

  counts() {
    const out = {};
    for (const n of this.nodes) out[n.source] = (out[n.source] || 0) + 1;
    return out;
  }

  flyTo(id, closeness = 0.9) {
    const i = this.byId.get(id);
    if (i === undefined) return false;
    this.goal = this.nodes[i].p.slice();
    this.goalDist = closeness;
    this.focusId = id;
    this.spin = 0.025;
    return true;
  }

  highlight(ids) {
    this.highlights = new Set(ids);
  }

  reset() {
    this.goal = [0, 0, 0];
    this.goalDist = 3.6;
    this.focusId = null;
    this.highlights = new Set();
    this.spin = 0.06;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    let tick = 0;
    const loop = (t) => {
      if (!this.running) return;
      // Behind the dashboard (ambient), 30 frames a second is plenty.
      if (this.interactive || (tick++ & 1) === 0) this.frame(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [w, h];
  }

  project(p, w, h) {
    const x = p[0] - this.target[0];
    const y = p[1] - this.target[1];
    const z = p[2] - this.target[2];
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const depth = z2 + this.dist;
    if (depth < 0.06) return null;
    const f = Math.min(w, h) * 0.95;
    return [w / 2 + (x1 * f) / depth, h / 2 + (y1 * f) / depth, depth];
  }

  frame(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const ease = 1 - Math.pow(0.02, dt);
    for (let k = 0; k < 3; k++) this.target[k] += (this.goal[k] - this.target[k]) * ease;
    this.dist += (this.goalDist - this.dist) * ease;
    if (!this.dragging) this.yaw += this.spin * dt;

    const [w, h] = this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    // Every star projected into kept typed arrays: no arrays made per star per frame.
    const nodes = this.nodes;
    const n = nodes.length;
    if (!this.px || this.px.length !== n) {
      this.px = new Float32Array(n);
      this.py = new Float32Array(n);
      this.pd = new Float32Array(n); // depth; 0 = behind the camera
    }
    const { px, py, pd } = this;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const [tx, ty, tz] = this.target;
    const f = Math.min(w, h) * 0.95;
    for (let i = 0; i < n; i++) {
      const p = nodes[i].p;
      const x = p[0] - tx, y = p[1] - ty, z = p[2] - tz;
      const x1 = x * cy - z * sy;
      const z1 = x * sy + z * cy;
      const y1 = y * cp - z1 * sp;
      const depth = y * sp + z1 * cp + this.dist;
      if (depth < 0.06) { pd[i] = 0; continue; }
      px[i] = w / 2 + (x1 * f) / depth;
      py[i] = h / 2 + (y1 * f) / depth;
      pd[i] = depth;
    }
    this.every = n > STAR_BUDGET ? Math.ceil(n / STAR_BUDGET) : 1;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(140, 190, 255, 0.05)';
    ctx.beginPath();
    const edgeStep = Math.max(1, Math.ceil(this.edges.length / EDGE_BUDGET));
    for (let k = 0; k < this.edges.length; k += edgeStep) {
      const [a, b] = this.edges[k];
      if (!pd[a] || !pd[b]) continue;
      ctx.moveTo(px[a], py[a]);
      ctx.lineTo(px[b], py[b]);
    }
    ctx.stroke();

    // Farthest first. Past the budget only the sample is drawn, so only it is sorted.
    const every = this.every;
    if (!this.order || this.orderEvery !== every || this.orderN !== n) {
      this.order = new Uint32Array(Math.ceil(n / every));
      for (let i = 0, k = 0; i < n; i += every, k++) this.order[k] = i;
      this.orderEvery = every;
      this.orderN = n;
      this.sortedAt = -1e9;
    }
    const order = this.order;
    if (t - this.sortedAt > SORT_EVERY_MS) {
      order.sort((a, b) => pd[b] - pd[a]);
      this.sortedAt = t;
    }
    const star = (i) => {
      const depth = pd[i];
      const node = nodes[i];
      const special = node.id === this.focusId || this.highlights.has(node.id) || node.id === this.hoverId;
      const size = Math.max(2.5, Math.min(40, (special ? 30 : 11) / depth));
      ctx.globalAlpha = Math.max(0.25, Math.min(1, 1.6 / depth));
      ctx.drawImage(this.sprites[node.source] || this.sprites.files, px[i] - size / 2, py[i] - size / 2, size, size);
      if (node.id === this.focusId) {
        ctx.globalAlpha = 0.9;
        ctx.drawImage(this.sprites.focus, px[i] - size / 3, py[i] - size / 3, size / 1.5, size / 1.5);
      }
    };
    for (let k = 0; k < order.length; k++) if (pd[order[k]]) star(order[k]);
    // The focused, highlighted and hovered stars that aren't in the sample: on top.
    if (every > 1) {
      for (const id of new Set([this.focusId, this.hoverId, ...this.highlights])) {
        const i = this.byId.get(id);
        if (i !== undefined && i % every && pd[i]) star(i);
      }
    }
    ctx.globalAlpha = 1;

    // Cluster names float over their star systems, biggest first, never overlapping.
    ctx.font = '600 11px "Instrument Sans", -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const placed = [];
    const clusters = [...this.clusters].filter((c) => c.label && c.size >= 6).sort((a, b) => b.size - a.size);
    for (const c of clusters) {
      const p = this.project(c.p, w, h);
      if (!p || p[2] < 0.4) continue;
      const label = c.label.toUpperCase();
      const tw = ctx.measureText(label).width + 16;
      const box = { x: p[0] - tw / 2, y: p[1] - Math.min(70, 120 / p[2]) - 9, w: tw, h: 20 };
      if (box.x < 4 || box.x + box.w > w - 4 || box.y < 70) continue;
      if (placed.some((o) => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h)) continue;
      placed.push(box);
      ctx.globalAlpha = Math.max(0.3, Math.min(0.75, 2.4 / p[2]));
      ctx.fillStyle = '#b9c9dd';
      ctx.fillText(label, p[0], box.y + 14);
      if (placed.length >= 14) break;
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';

    ctx.font = '500 13px "Instrument Sans", -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    // Labels for the few stars that have one (not a pass over every star), farthest first.
    const labelled = [...new Set([this.focusId, this.hoverId, ...this.highlights])]
      .map((id) => this.byId.get(id)).filter((i) => i !== undefined && pd[i]).sort((a, b) => pd[b] - pd[a]);
    for (const i of labelled) {
      const node = nodes[i];
      const x = px[i], y = py[i];
      const text = node.title.length > 48 ? `${node.title.slice(0, 47)}…` : node.title;
      const pad = 6;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(6, 12, 24, 0.78)';
      roundRect(ctx, x + 12, y - 12, tw + pad * 2, 24, 7);
      ctx.fill();
      ctx.fillStyle = node.id === this.focusId ? '#ffffff' : '#d7e6f5';
      ctx.fillText(text, x + 12 + pad, y);
    }
  }

  // ── hand-control API (hands.js) ──

  rotateBy(dx, dy) {
    this.yaw += dx;
    this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + dy));
    this.spin = 0;
  }

  zoomBy(factor) {
    this.goalDist = Math.max(0.35, Math.min(6, this.goalDist * factor));
  }

  // Screen point (client px) -> the star under it, within a hand-friendly radius.
  pickAtClient(x, y, radius = 36) {
    const r = this.canvas.getBoundingClientRect();
    return this.nearest(x - r.left, y - r.top, radius);
  }

  // Past the budget only a sample of the stars is drawn; only drawn ones can be picked.
  drawn(i) {
    const every = this.every || 1;
    if (every === 1 || i % every === 0) return true;
    const id = this.nodes[i].id;
    return id === this.focusId || id === this.hoverId || this.highlights.has(id);
  }

  nearest(mx, my, radius) {
    const { px, py, pd } = this;
    if (!pd) return null;
    let best = null;
    let bestD = radius * radius;
    for (let i = 0; i < pd.length && i < this.nodes.length; i++) {
      if (!pd[i]) continue;
      const d = (px[i] - mx) ** 2 + (py[i] - my) ** 2;
      // The distance first: it rules out almost every star, and drawn() costs more.
      if (d < bestD && this.drawn(i)) { bestD = d; best = this.nodes[i].id; }
    }
    return best;
  }

  hoverAtClient(x, y) {
    this.hoverId = x === null ? null : this.pickAtClient(x, y);
    return this.hoverId;
  }

  select(id) {
    if (!id) return;
    this.flyTo(id);
    if (this.onSelect) this.onSelect(id);
  }

  pick(mx, my) {
    return this.nearest(mx, my, 14);
  }

  _bind() {
    let sx = 0, sy = 0, moved = false;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.interactive) return;
      this.dragging = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.interactive) return;
      const r = this.canvas.getBoundingClientRect();
      if (this.dragging) {
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        this.yaw += dx * 0.005;
        this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + dy * 0.005));
        sx = e.clientX;
        sy = e.clientY;
      } else {
        this.hoverId = this.pick(e.clientX - r.left, e.clientY - r.top);
        this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab';
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!this.interactive) return;
      this.dragging = false;
      if (!moved) {
        const r = this.canvas.getBoundingClientRect();
        const id = this.pick(e.clientX - r.left, e.clientY - r.top);
        if (id) {
          this.flyTo(id);
          if (this.onSelect) this.onSelect(id);
        }
      }
    });
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.interactive) return;
      e.preventDefault();
      this.goalDist = Math.max(0.35, Math.min(6, this.goalDist * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
  }
}

function sprite(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.14, color);
  grad.addColorStop(0.32, hexA(color, 0.28));
  grad.addColorStop(0.7, hexA(color, 0.04));
  grad.addColorStop(1, hexA(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

window.Galaxy = Galaxy;
window.GALAXY_SOURCES = { colors: SOURCE_COLORS, names: SOURCE_NAMES };
