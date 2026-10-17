// Lesen und Schreiben von .litematic (Litematica) und .schem (Sponge v2/v3).
// Alles läuft im Browser: Gzip über CompressionStream, NBT und Bit-Packing hier.

export const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};

// ---------- Gzip ----------

async function streamThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipIfNeeded(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return streamThrough(bytes, new DecompressionStream('gzip'));
  }
  return bytes;
}

export function gzip(bytes) {
  return streamThrough(bytes, new CompressionStream('gzip'));
}

// ---------- NBT lesen ----------

const decoder = new TextDecoder();

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
  }
  u8() { return this.v.getUint8(this.p++); }
  i8() { return this.v.getInt8(this.p++); }
  i16() { const x = this.v.getInt16(this.p); this.p += 2; return x; }
  i32() { const x = this.v.getInt32(this.p); this.p += 4; return x; }
  i64() { const x = this.v.getBigInt64(this.p); this.p += 8; return x; }
  f32() { const x = this.v.getFloat32(this.p); this.p += 4; return x; }
  f64() { const x = this.v.getFloat64(this.p); this.p += 8; return x; }
  str() {
    const n = this.v.getUint16(this.p);
    this.p += 2;
    const s = decoder.decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
}

function readPayload(r, type) {
  switch (type) {
    case TAG.BYTE: return r.i8();
    case TAG.SHORT: return r.i16();
    case TAG.INT: return r.i32();
    case TAG.LONG: return r.i64();
    case TAG.FLOAT: return r.f32();
    case TAG.DOUBLE: return r.f64();
    case TAG.BYTE_ARRAY: {
      const n = r.i32();
      const a = new Int8Array(r.b.buffer, r.b.byteOffset + r.p, n).slice();
      r.p += n;
      return a;
    }
    case TAG.STRING: return r.str();
    case TAG.LIST: {
      const et = r.u8();
      const n = r.i32();
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = readPayload(r, et);
      Object.defineProperty(arr, '__elem', { value: et });
      return arr;
    }
    case TAG.COMPOUND: {
      const obj = {};
      const types = new Map();
      for (;;) {
        const t = r.u8();
        if (t === TAG.END) break;
        const name = r.str();
        types.set(name, t);
        obj[name] = readPayload(r, t);
      }
      Object.defineProperty(obj, '__t', { value: types });
      return obj;
    }
    case TAG.INT_ARRAY: {
      const n = r.i32();
      const a = new Int32Array(n);
      for (let i = 0; i < n; i++) a[i] = r.i32();
      return a;
    }
    case TAG.LONG_ARRAY: {
      const n = r.i32();
      const a = new BigInt64Array(n);
      for (let i = 0; i < n; i++) a[i] = r.i64();
      return a;
    }
    default:
      throw new Error('Unbekannter NBT-Tag: ' + type);
  }
}

export function parseNbt(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TAG.COMPOUND) throw new Error('NBT-Wurzel ist kein Compound');
  r.str();
  return readPayload(r, TAG.COMPOUND);
}

// ---------- NBT schreiben ----------

class Writer {
  constructor() {
    this.buf = new Uint8Array(1 << 16);
    this.v = new DataView(this.buf.buffer);
    this.p = 0;
  }
  ensure(n) {
    if (this.p + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.p + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.p));
    this.buf = nb;
    this.v = new DataView(nb.buffer);
  }
  u8(x) { this.ensure(1); this.v.setUint8(this.p++, x); }
  i8(x) { this.ensure(1); this.v.setInt8(this.p++, x); }
  i16(x) { this.ensure(2); this.v.setInt16(this.p, x); this.p += 2; }
  u16(x) { this.ensure(2); this.v.setUint16(this.p, x); this.p += 2; }
  i32(x) { this.ensure(4); this.v.setInt32(this.p, x); this.p += 4; }
  i64(x) { this.ensure(8); this.v.setBigInt64(this.p, BigInt(x)); this.p += 8; }
  f32(x) { this.ensure(4); this.v.setFloat32(this.p, x); this.p += 4; }
  f64(x) { this.ensure(8); this.v.setFloat64(this.p, x); this.p += 8; }
  str(s) {
    const b = new TextEncoder().encode(s);
    this.u16(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.p);
    this.p += b.length;
  }
  result() { return this.buf.slice(0, this.p); }
}

function inferType(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? TAG.INT : TAG.DOUBLE;
  if (typeof v === 'bigint') return TAG.LONG;
  if (typeof v === 'string') return TAG.STRING;
  if (typeof v === 'boolean') return TAG.BYTE;
  if (v instanceof Int8Array) return TAG.BYTE_ARRAY;
  if (v instanceof Int32Array) return TAG.INT_ARRAY;
  if (v instanceof BigInt64Array) return TAG.LONG_ARRAY;
  if (Array.isArray(v)) return TAG.LIST;
  return TAG.COMPOUND;
}

function writePayload(w, type, value) {
  switch (type) {
    case TAG.BYTE: w.i8(typeof value === 'boolean' ? (value ? 1 : 0) : value); return;
    case TAG.SHORT: w.i16(value); return;
    case TAG.INT: w.i32(value); return;
    case TAG.LONG: w.i64(value); return;
    case TAG.FLOAT: w.f32(value); return;
    case TAG.DOUBLE: w.f64(value); return;
    case TAG.BYTE_ARRAY:
      w.i32(value.length);
      w.ensure(value.length);
      w.buf.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), w.p);
      w.p += value.length;
      return;
    case TAG.STRING: w.str(value); return;
    case TAG.LIST: {
      const et = value.__elem ?? (value.length ? inferType(value[0]) : TAG.END);
      w.u8(et);
      w.i32(value.length);
      for (const item of value) writePayload(w, et, item);
      return;
    }
    case TAG.COMPOUND: {
      for (const key of Object.keys(value)) {
        const t = value.__t?.get(key) ?? inferType(value[key]);
        w.u8(t);
        w.str(key);
        writePayload(w, t, value[key]);
      }
      w.u8(TAG.END);
      return;
    }
    case TAG.INT_ARRAY:
      w.i32(value.length);
      for (const x of value) w.i32(x);
      return;
    case TAG.LONG_ARRAY:
      w.i32(value.length);
      for (const x of value) w.i64(x);
      return;
    default:
      throw new Error('Nicht schreibbarer NBT-Tag: ' + type);
  }
}

export function writeNbt(root) {
  const w = new Writer();
  w.u8(TAG.COMPOUND);
  w.str('');
  writePayload(w, TAG.COMPOUND, root);
  return w.result();
}

function makeList(items, elemType) {
  const a = [...items];
  Object.defineProperty(a, '__elem', { value: elemType });
  return a;
}

// ---------- Bit-Packing (Litematica-Format) ----------

export function bitsFor(paletteSize) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(paletteSize, 1))));
}

// Einträge laufen über Long-Grenzen hinweg, wie bei Litematica.
export function unpackBits(longs, bits, count) {
  const out = new Int32Array(count);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < count; i++) {
    const off = i * bits;
    const li = off >>> 6;
    const sh = off & 63;
    let v = BigInt.asUintN(64, longs[li]) >> BigInt(sh);
    if (sh + bits > 64 && li + 1 < longs.length) {
      v |= BigInt.asUintN(64, longs[li + 1]) << BigInt(64 - sh);
    }
    out[i] = Number(v & mask);
  }
  return out;
}

export function packBits(idx, bits) {
  const n = Math.ceil((idx.length * bits) / 64);
  const out = new BigUint64Array(n);
  for (let i = 0; i < idx.length; i++) {
    const off = i * bits;
    const li = off >>> 6;
    const sh = off & 63;
    const v = BigInt(idx[i]);
    out[li] |= v << BigInt(sh);
    if (sh + bits > 64) out[li + 1] |= v >> BigInt(64 - sh);
  }
  return new BigInt64Array(out.buffer);
}

// ---------- Sponge-Varints (.schem) ----------

function readVarints(data, count) {
  const out = new Int32Array(count);
  let p = 0;
  for (let i = 0; i < count; i++) {
    let v = 0, shift = 0, b;
    do {
      b = data[p++] & 0xff;
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    out[i] = v;
  }
  return out;
}

function writeVarints(idx) {
  const bytes = [];
  for (const x of idx) {
    let v = x >>> 0;
    while (v >= 0x80) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v);
  }
  return Int8Array.from(bytes, b => (b << 24) >> 24);
}

// ---------- Blockzustände ----------

export function stateToString(e) {
  const props = e.Properties;
  if (!props || !Object.keys(props).length) return e.Name;
  return e.Name + '[' + Object.keys(props).sort().map(k => k + '=' + props[k]).join(',') + ']';
}

export function parseState(s) {
  const m = /^([^[]+)(?:\[(.*)\])?$/.exec(s);
  const out = { Name: m[1] };
  if (m[2]) {
    const props = {};
    for (const kv of m[2].split(',')) {
      const [k, v] = kv.split('=');
      props[k] = v;
    }
    out.Properties = props;
  }
  return out;
}

// Führt doppelte Einträge zusammen und passt die Indizes an.
export function rebuildPalette(reg) {
  const map = new Map();
  const next = [];
  const remap = new Int32Array(reg.palette.length);
  reg.palette.forEach((s, i) => {
    let j = map.get(s);
    if (j === undefined) {
      j = next.length;
      map.set(s, j);
      next.push(s);
    }
    remap[i] = j;
  });
  const idx = reg.idx;
  for (let i = 0; i < idx.length; i++) idx[i] = remap[idx[i]];
  reg.palette = next;
}

// ---------- Laden ----------

export async function loadSchematic(buffer, fileName) {
  const bytes = await gunzipIfNeeded(new Uint8Array(buffer));
  const root = parseNbt(bytes);
  if (root.Regions) return fromLitematic(root, fileName);
  const s = root.Schematic || root;
  if (s.Palette || s.Blocks) return fromSchem(root, s, fileName);
  throw new Error('Unbekanntes Format: weder Litematica noch Sponge-Schematic');
}

function baseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

function fromLitematic(root, fileName) {
  const regions = Object.keys(root.Regions).map(name => {
    const src = root.Regions[name];
    const sx = src.Size.x, sy = src.Size.y, sz = src.Size.z;
    // Negative Größen zeigen in die negative Richtung; der Ursprung liegt dann um eins versetzt.
    const origin = {
      x: src.Position.x + (sx < 0 ? sx + 1 : 0),
      y: src.Position.y + (sy < 0 ? sy + 1 : 0),
      z: src.Position.z + (sz < 0 ? sz + 1 : 0),
    };
    const size = { x: Math.abs(sx), y: Math.abs(sy), z: Math.abs(sz) };
    const palette = src.BlockStatePalette.map(stateToString);
    const idx = unpackBits(src.BlockStates, bitsFor(palette.length), size.x * size.y * size.z);
    return { name, origin, size, palette, idx, src };
  });
  return {
    format: 'litematic',
    fileName,
    name: root.Metadata?.Name || baseName(fileName),
    root,
    regions,
  };
}

function fromSchem(root, s, fileName) {
  const b = s.Blocks || s;
  const w = s.Width, h = s.Height, l = s.Length;
  const palette = [];
  for (const k of Object.keys(b.Palette)) palette[b.Palette[k]] = k;
  const idx = readVarints(b.Data ?? b.BlockData, w * h * l);
  return {
    format: 'schem',
    fileName,
    name: baseName(fileName),
    root,
    regions: [{
      name: 'main',
      origin: { x: 0, y: 0, z: 0 },
      size: { x: w, y: h, z: l },
      palette,
      idx,
      src: s,
    }],
  };
}

// ---------- Speichern ----------

function writeLitematicRegion(reg) {
  rebuildPalette(reg);
  const src = reg.src;
  src.BlockStatePalette = makeList(reg.palette.map(parseState), TAG.COMPOUND);
  src.BlockStates = packBits(reg.idx, bitsFor(reg.palette.length));
}

function writeSchemRegion(model) {
  const reg = model.regions[0];
  rebuildPalette(reg);
  const s = model.root.Schematic || model.root;
  const b = s.Blocks || s;
  const pal = {};
  reg.palette.forEach((name, i) => { pal[name] = i; });
  b.Palette = pal;
  b.PaletteMax = reg.palette.length;
  if ('Data' in b) b.Data = writeVarints(reg.idx);
  else b.BlockData = writeVarints(reg.idx);
}

// Liefert die gzip-komprimierten Bytes im Originalformat.
export async function saveSchematic(model) {
  if (model.format === 'litematic') {
    for (const reg of model.regions) writeLitematicRegion(reg);
  } else {
    writeSchemRegion(model);
  }
  return gzip(writeNbt(model.root));
}
