// Blockzustände, Modelle und Mesh-Erzeugung nach dem Minecraft-Modellformat.
// Datenquelle: mc-assets (dist/blockStatesModels.json und blocksAtlasLatest.png), MIT-Lizenz.
// Texturen und Modelle sind Eigentum der Mojang AB.

const DEG = Math.PI / 180;

// Gesichter eines Elements: Ecke (a,b) über from/to, Standard-UV wie in Minecraft
const FACE = {
  up:    { dir: [0, 1, 0],  pos: (f, t, a, b) => [a ? t[0] : f[0], t[1], b ? t[2] : f[2]], def: (f, t) => [f[0], f[2], t[0], t[2]] },
  down:  { dir: [0, -1, 0], pos: (f, t, a, b) => [a ? t[0] : f[0], f[1], b ? f[2] : t[2]], def: (f, t) => [f[0], 16 - t[2], t[0], 16 - f[2]] },
  north: { dir: [0, 0, -1], pos: (f, t, a, b) => [a ? f[0] : t[0], b ? f[1] : t[1], f[2]], def: (f, t) => [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]] },
  south: { dir: [0, 0, 1],  pos: (f, t, a, b) => [a ? t[0] : f[0], b ? f[1] : t[1], t[2]], def: (f, t) => [f[0], 16 - t[1], t[0], 16 - f[1]] },
  west:  { dir: [-1, 0, 0], pos: (f, t, a, b) => [f[0], b ? f[1] : t[1], a ? t[2] : f[2]], def: (f, t) => [f[2], 16 - t[1], t[2], 16 - f[1]] },
  east:  { dir: [1, 0, 0],  pos: (f, t, a, b) => [t[0], b ? f[1] : t[1], a ? f[2] : t[2]], def: (f, t) => [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]] },
};
const DIR = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const NAME_OF = Object.fromEntries(Object.entries(DIR).map(([k, v]) => [v.join(','), k]));
const CORNERS = [[0, 1], [0, 0], [1, 0], [1, 1]];

const TINT_WATER = [0.247, 0.463, 0.894];
const TINT_LEAVES = [0.35, 0.68, 0.2];
const TINT_PLANT = [0.5, 0.74, 0.22];

// ---------- Vektor-Hilfen ----------
function rotX(v, deg) {
  const r = deg * DEG, c = Math.cos(r), s = Math.sin(r);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
function rotY(v, deg) {
  const r = deg * DEG, c = Math.cos(r), s = Math.sin(r);
  return [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c];
}
function rotVariant(v, rx, ry) {
  return rotY(rotX(v, rx), ry);
}
function nameOfVec(v) {
  return NAME_OF[v.map(c => Math.round(c)).join(',')] || null;
}
function rotateElement(p, r) {
  const o = r.origin;
  const rad = r.angle * DEG, c = Math.cos(rad), s = Math.sin(rad);
  const x = p[0] - o[0], y = p[1] - o[1], z = p[2] - o[2];
  let nx = x, ny = y, nz = z;
  if (r.axis === 'x') { ny = y * c - z * s; nz = y * s + z * c; }
  else if (r.axis === 'y') { nx = x * c - z * s; nz = x * s + z * c; }
  else { nx = x * c - y * s; ny = x * s + y * c; }
  if (r.rescale) {
    const f = 1 / Math.max(Math.abs(c), 1e-6);
    if (r.axis === 'x') { ny *= f; nz *= f; }
    else if (r.axis === 'y') { nx *= f; nz *= f; }
    else { nx *= f; ny *= f; }
  }
  return [nx + o[0], ny + o[1], nz + o[2]];
}

// ---------- Zustands-Matching ----------
function matchKey(key, props) {
  if (key === '') return true;
  for (const pair of key.split(',')) {
    const [k, v] = pair.split('=');
    if (props[k] !== v) return false;
  }
  return true;
}
function matchWhen(w, props) {
  if (w.OR) return w.OR.some(x => matchWhen(x, props));
  if (w.AND) return w.AND.every(x => matchWhen(x, props));
  return Object.keys(w).every(k => String(w[k]).split('|').includes(props[k]));
}
function collectWhen(w, add) {
  if (w.OR || w.AND) { for (const x of (w.OR || w.AND)) collectWhen(x, add); return; }
  for (const k of Object.keys(w)) for (const v of String(w[k]).split('|')) add(k, v);
}

function isFullCube(quads) {
  if (quads.length !== 6) return false;
  const seen = new Set();
  for (const q of quads) {
    if (q.layer !== 'solid' || !q.n) return false;
    const name = nameOfVec(q.n);
    if (!name) return false;
    seen.add(name);
    const axis = q.n.findIndex(c => c !== 0);
    const target = q.n[axis] > 0 ? 1 : 0;
    for (const p of q.p) {
      for (let i = 0; i < 3; i++) {
        const v = p[i];
        if (i === axis) { if (Math.abs(v - target) > 1e-6) return false; }
        else if (Math.abs(v) > 1e-6 && Math.abs(v - 1) > 1e-6) return false;
      }
    }
  }
  return seen.size === 6;
}

// ---------- Atlas-Transparenz ----------
// Liefert die Namen aller Atlas-Kacheln mit transparenten Pixeln (Laub, Glas, Pflanzen).
export function transparentTiles(img, tex, W, H, S) {
  const out = new Set();
  try {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, W, H).data;
    const size = Math.round(S * W);
    for (const [name, t] of Object.entries(tex)) {
      const x0 = Math.round(t.u * W), y0 = Math.round(t.v * H);
      let hit = false;
      for (let y = 0; y < size && !hit; y++) for (let x = 0; x < size && !hit; x++) {
        const i = ((y0 + y) * W + (x0 + x)) * 4 + 3;
        if (data[i] < 255) hit = true;
      }
      if (hit) out.add(name);
    }
  } catch (e) {
    // Canvas ist nicht lesbar: alle Kacheln gelten als undurchsichtig
  }
  return out;
}

// ---------- Bibliothek ----------
export class BlockLibrary {
  constructor(data, atlas) {
    this.bs = data.blockstates;
    this.models = data.models;
    this.atlas = atlas;             // {tex, S, W, H, img, alpha: Set}
    this.modelCache = new Map();
    this.stateCache = new Map();
    this.validCache = new Map();
    this.white = atlas.tex['white_concrete'] ? { u: atlas.tex['white_concrete'].u, v: atlas.tex['white_concrete'].v } : { u: 0, v: 0 };
  }

  hasBlock(name) {
    return !!(this.bs[name] || this.models['block/' + name]);
  }

  resolveModel(name) {
    if (this.modelCache.has(name)) return this.modelCache.get(name);
    const chain = [];
    const seen = new Set();
    let cur = name;
    while (cur && this.models[cur] && !seen.has(cur)) {
      seen.add(cur);
      chain.push(this.models[cur]);
      cur = this.models[cur].parent;
    }
    const textures = {};
    for (const m of chain) for (const k of Object.keys(m.textures || {})) if (!(k in textures)) textures[k] = m.textures[k];
    let elements = [];
    for (const m of chain) if (m.elements) { elements = m.elements; break; }
    const res = { textures, elements };
    this.modelCache.set(name, res);
    return res;
  }

  quadsForModel(modelName, rx, ry) {
    const M = this.resolveModel(modelName);
    const out = [];
    for (const el of M.elements) {
      const from = el.from, to = el.to;
      for (const fname of Object.keys(el.faces || {})) {
        const def = FACE[fname];
        const face = el.faces[fname];
        if (!def) continue;
        const ref = this.resolveRef(M.textures, face.texture);
        const key = ref ? ref.replace(/^(block|item)\//, '') : null;
        const tile = key && this.atlas.tex[key] ? this.atlas.tex[key] : null;
        const uv = face.uv || def.def(from, to);
        const rot = (Math.round((face.rotation || 0) / 90) % 4 + 4) % 4;

        let pts = CORNERS.map(([a, b]) => def.pos(from, to, a, b));
        const pix = CORNERS.map(([a, b]) => [uv[0] + a * (uv[2] - uv[0]), uv[1] + b * (uv[3] - uv[1])]);
        const pixRot = pix.map((_, i) => pix[(i + rot) % 4]);
        if (el.rotation) pts = pts.map(p => rotateElement(p, el.rotation));

        let dir = rotVariant(def.dir, rx, ry);
        pts = pts.map(p => rotVariant([p[0] / 16 - 0.5, p[1] / 16 - 0.5, p[2] / 16 - 0.5], rx, ry).map(c => c + 0.5));

        // Außenseite prüfen, Reihenfolge ggf. umkehren
        let uvs = pixRot;
        const e1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
        const e2 = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (cr[0] * dir[0] + cr[1] * dir[1] + cr[2] * dir[2] < 0) {
          pts = [pts[0], pts[3], pts[2], pts[1]];
          uvs = [uvs[0], uvs[3], uvs[2], uvs[1]];
        }

        const base = tile || this.white;
        const S = this.atlas.S;
        const atlasUV = uvs.map(([u, v]) => [base.u + (u / 16) * S, base.v + (v / 16) * S]);

        let color;
        if (!tile) color = [0.6, 0.6, 0.6];
        else if (face.tintindex !== undefined) color = TINT_PLANT;
        else color = [1, 1, 1];

        const cullName = face.cullface ? nameOfVec(rotVariant(DIR[face.cullface], rx, ry)) : null;
        const layer = tile && this.atlas.alpha.has(key) ? 'cut' : 'solid';
        out.push({ p: pts, uv: atlasUV, n: dir, cull: cullName, layer, color, fluid: null });
      }
    }
    return out;
  }

  resolveRef(textures, ref) {
    let r = ref;
    for (let i = 0; i < 10 && r && r[0] === '#'; i++) r = textures[r.slice(1)];
    return r || null;
  }

  fallbackQuads(name) {
    const h = colorOf(name);
    const out = [];
    for (const fname of Object.keys(FACE)) {
      const def = FACE[fname];
      let pts = CORNERS.map(([a, b]) => def.pos([0, 0, 0], [16, 16, 16], a, b).map(c => c / 16));
      const mid = this.atlas.S / 2;
      const uv = CORNERS.map(() => [this.white.u + mid, this.white.v + mid]);
      out.push({ p: pts, uv, n: def.dir, cull: fname, layer: 'solid', color: h, fluid: null });
    }
    return out;
  }

  fluidQuads(name) {
    const key = name + '_still';
    const tile = this.atlas.tex[key] || this.white;
    const S = this.atlas.S;
    const out = [];
    for (const fname of Object.keys(FACE)) {
      const def = FACE[fname];
      const pts = CORNERS.map(([a, b]) => def.pos([0, 0, 0], [16, 16, 16], a, b).map(c => c / 16));
      const uv = CORNERS.map(([a, b]) => [tile.u + a * S, tile.v + b * S]);
      out.push({
        p: pts.map(p => p.map(c => c)),
        uv,
        n: def.dir,
        cull: fname,
        layer: name === 'water' ? 'water' : 'solid',
        color: name === 'water' ? TINT_WATER : [1, 1, 1],
        fluid: name,
      });
    }
    return out;
  }

  selectApplies(name, props) {
    const def = this.bs[name];
    if (!def) return [];
    if (def.variants) {
      let best = null, bestN = -1;
      for (const key of Object.keys(def.variants)) {
        if (!matchKey(key, props)) continue;
        const n = key ? key.split(',').length : 0;
        if (n > bestN) { best = def.variants[key]; bestN = n; }
      }
      // Ohne passenden Zustand: erster Eintrag als Standard (z. B. für Miniaturen)
      if (!best) best = def.variants[Object.keys(def.variants)[0]];
      if (!best) return [];
      const v = Array.isArray(best) ? best[0] : best;
      return [{ model: v.model, x: v.x || 0, y: v.y || 0 }];
    }
    if (def.multipart) {
      const out = [];
      for (const part of def.multipart) {
        if (part.when && !matchWhen(part.when, props)) continue;
        const a = Array.isArray(part.apply) ? part.apply[0] : part.apply;
        out.push({ model: a.model, x: a.x || 0, y: a.y || 0 });
      }
      return out;
    }
    return [];
  }

  // Zustand als String, z. B. "minecraft:oak_stairs[facing=north,half=bottom]"
  stateInfo(str) {
    if (this.stateCache.has(str)) return this.stateCache.get(str);
    const m = /^([^[]+)(?:\[(.*)\])?$/.exec(str);
    const name = m[1].replace(/^minecraft:/, '');
    const props = {};
    if (m[2]) for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); props[k] = v; }
    let info;
    if (name === 'air' || name === 'cave_air' || name === 'void_air') {
      info = { air: true, quads: [], fullCube: false, fluid: null };
    } else if (name === 'water' || name === 'lava') {
      info = { air: false, quads: this.fluidQuads(name), fullCube: false, fluid: name };
    } else {
      const applies = this.selectApplies(name, props);
      let quads = [];
      if (applies.length) {
        for (const a of applies) quads = quads.concat(this.quadsForModel(a.model, a.x, a.y));
      } else {
        quads = this.fallbackQuads(name);
      }
      info = { air: false, quads, fullCube: isFullCube(quads), fluid: null };
    }
    this.stateCache.set(str, info);
    return info;
  }

  // Gültige Eigenschaften und Werte eines Blocks, z. B. Map(facing -> Set(north, ...))
  validProps(name) {
    if (this.validCache.has(name)) return this.validCache.get(name);
    const map = new Map();
    const add = (k, v) => {
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(v);
    };
    const def = this.bs[name];
    if (def && def.variants) {
      for (const key of Object.keys(def.variants)) {
        if (!key) continue;
        for (const pair of key.split(',')) { const [k, v] = pair.split('='); add(k, v); }
      }
    }
    if (def && def.multipart) {
      for (const part of def.multipart) if (part.when) collectWhen(part.when, add);
    }
    this.validCache.set(name, map);
    return map;
  }

  // Atlas-Ausschnitt für die Materialliste: {u, v, size} in Atlaskoordinaten
  thumbRect(name) {
    const info = this.stateInfo(name);
    const q = info.quads.find(qq => qq.layer !== 'water') || info.quads[0];
    if (!q) return null;
    const us = q.uv.map(p => p[0]), vs = q.uv.map(p => p[1]);
    const u = Math.min(...us), v = Math.min(...vs);
    return { u, v, size: Math.max(...us) - u };
  }
}

// Ersatzfarbe für Blöcke ohne Modell: ruhiger Farbton aus dem Namen
function colorOf(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = (h % 360) / 360;
  const sat = 0.3, light = 0.5;
  const f = n => {
    const k = (n + hue * 12) % 12;
    const a = sat * Math.min(light, 1 - light);
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// ---------- Mesh ----------
function newBuf() {
  return { P: [], N: [], UV: [], C: [], I: [], base: 0 };
}

export function buildMeshData(model, lib) {
  const layers = { solid: newBuf(), cut: newBuf(), water: newBuf() };
  for (const reg of model.regions) {
    const { x: sx, y: sy, z: sz } = reg.size;
    const plane = sx * sz;
    const infos = reg.palette.map(s => lib.stateInfo(s));
    const idx = reg.idx;
    const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) ? null : infos[idx[y * plane + z * sx + x]];
    for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      const info = infos[idx[y * plane + z * sx + x]];
      if (info.air) continue;
      for (const q of info.quads) {
        if (q.cull) {
          const d = DIR[q.cull];
          const n = at(x + d[0], y + d[1], z + d[2]);
          if (n && !n.air) {
            if (n.fullCube) continue;
            if (info.fluid && n.fluid === info.fluid) continue;
          }
        }
        const buf = layers[q.layer] || layers.solid;
        for (let c = 0; c < 4; c++) {
          const p = q.p[c];
          buf.P.push(reg.origin.x + x + p[0], reg.origin.y + y + p[1], reg.origin.z + z + p[2]);
          buf.N.push(q.n[0], q.n[1], q.n[2]);
          buf.UV.push(q.uv[c][0], q.uv[c][1]);
          buf.C.push(q.color[0], q.color[1], q.color[2]);
        }
        buf.I.push(buf.base, buf.base + 1, buf.base + 2, buf.base, buf.base + 2, buf.base + 3);
        buf.base += 4;
      }
    }
  }
  return layers;
}
