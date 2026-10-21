/**
 * Minimal DASH container index parsing for YouTube audio (WebM/Opus and
 * fragmented MP4/AAC). Yields the init segment and a time→byte segment table,
 * which is all MSE needs to append, seek and chain tracks.
 */

export type Seg = { t: number; start: number; end: number }; // t: seconds from track start; bytes [start, end)
export type Index = { initEnd: number; segs: Seg[]; duration: number };
/** `need`: parsing requires the first `need` bytes of the file. */
export type ParseResult = Index | { need: number };

export function parseIndex(b: Uint8Array, size: number, mime: string): ParseResult {
  return mime.includes('webm') ? parseWebm(b, size) : parseMp4(b, size);
}

// ---------- WebM (EBML) ----------

const EBML = 0x1a45dfa3,
  SEGMENT = 0x18538067,
  INFO = 0x1549a966,
  TIMESCALE = 0x2ad7b1,
  DURATION = 0x4489,
  TRACKS = 0x1654ae6b,
  CUES = 0x1c53bb6b,
  CUEPOINT = 0xbb,
  CUETIME = 0xb3,
  CUEPOS = 0xb7,
  CUECLUSTER = 0xf1,
  CLUSTER = 0x1f43b675;

/** Returns [value, length]; ids keep their marker bits, sizes don't. Unknown size → -1. */
function vint(b: Uint8Array, p: number, keepMarker: boolean): [number, number] {
  const first = b[p]!;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) {
    mask >>= 1;
    len++;
  }
  if (len > 8) throw new Error('bad vint');
  let v = keepMarker ? first : first & (mask - 1);
  let allOnes = v === mask - 1;
  for (let i = 1; i < len; i++) {
    const x = b[p + i]!;
    if (x !== 0xff) allOnes = false;
    v = v * 256 + x;
  }
  return [!keepMarker && allOnes ? -1 : v, len];
}

function uint(b: Uint8Array, p: number, n: number) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[p + i]!;
  return v;
}

function children(b: Uint8Array, start: number, end: number, fn: (id: number, body: number, size: number) => void) {
  let p = start;
  while (p < end) {
    const [id, il] = vint(b, p, true);
    const [size, sl] = vint(b, p + il, false);
    const body = p + il + sl;
    fn(id, body, size);
    p = body + size;
  }
}

function parseWebm(b: Uint8Array, size: number): ParseResult {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let [id, il] = vint(b, 0, true);
  if (id !== EBML) throw new Error('not webm');
  let [sz, sl] = vint(b, il, false);
  let p = il + sl + sz;
  [id, il] = vint(b, p, true);
  if (id !== SEGMENT) throw new Error('no segment');
  [, sl] = vint(b, p + il, false);
  const segStart = p + il + sl;
  p = segStart;

  let timescale = 1e6;
  let duration = 0;
  let tracksEnd = -1;
  let cues: { time: number; pos: number }[] | null = null;

  while (true) {
    if (p + 12 > b.length) return { need: p + 64 * 1024 };
    const [eid, eil] = vint(b, p, true);
    const [esz, esl] = vint(b, p + eil, false);
    const body = p + eil + esl;
    if (eid === CLUSTER) break;
    if ((eid === INFO || eid === TRACKS || eid === CUES) && body + esz > b.length) return { need: body + esz };
    if (eid === INFO) {
      children(b, body, body + esz, (cid, cb, cs) => {
        if (cid === TIMESCALE) timescale = uint(b, cb, cs);
        else if (cid === DURATION) duration = cs === 4 ? view.getFloat32(cb) : view.getFloat64(cb);
      });
    } else if (eid === TRACKS) {
      tracksEnd = body + esz;
    } else if (eid === CUES) {
      cues = [];
      children(b, body, body + esz, (cid, cb, cs) => {
        if (cid !== CUEPOINT) return;
        let time = 0;
        let pos = -1;
        children(b, cb, cb + cs, (k, kb, ks) => {
          if (k === CUETIME) time = uint(b, kb, ks);
          else if (k === CUEPOS)
            children(b, kb, kb + ks, (q, qb, qs) => {
              if (q === CUECLUSTER && pos < 0) pos = uint(b, qb, qs);
            });
        });
        if (pos >= 0) cues!.push({ time, pos });
      });
    }
    if (esz < 0) break;
    p = body + esz;
  }
  if (tracksEnd < 0 || !cues?.length) throw new Error('webm without tracks/cues');
  const s = timescale / 1e9;
  return {
    initEnd: tracksEnd,
    duration: duration * s,
    segs: cues.map((c, i) => ({
      t: c.time * s,
      start: segStart + c.pos,
      end: i + 1 < cues!.length ? segStart + cues![i + 1]!.pos : size,
    })),
  };
}

// ---------- fragmented MP4 (sidx) ----------

function parseMp4(b: Uint8Array, _size: number): ParseResult {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  let initEnd = -1;
  while (true) {
    if (p + 16 > b.length) return { need: p + 64 * 1024 };
    let size = view.getUint32(p);
    const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!);
    let hdr = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8));
      hdr = 16;
    }
    if (type === 'moov') initEnd = p + size;
    if (type === 'moof' || type === 'mdat') throw new Error('mp4 without sidx');
    if (type === 'sidx') {
      if (p + size > b.length) return { need: p + size };
      let q = p + hdr;
      const version = b[q]!;
      q += 4 + 4; // version/flags, reference_ID
      const timescale = view.getUint32(q);
      q += 4;
      let earliest: number;
      let firstOffset: number;
      if (version === 0) {
        earliest = view.getUint32(q);
        firstOffset = view.getUint32(q + 4);
        q += 8;
      } else {
        earliest = Number(view.getBigUint64(q));
        firstOffset = Number(view.getBigUint64(q + 8));
        q += 16;
      }
      const count = view.getUint16(q + 2);
      q += 4;
      let off = p + size + firstOffset;
      let t = earliest;
      const segs: Seg[] = [];
      for (let i = 0; i < count; i++, q += 12) {
        const refSize = view.getUint32(q) & 0x7fffffff;
        const dur = view.getUint32(q + 4);
        segs.push({ t: t / timescale, start: off, end: off + refSize });
        off += refSize;
        t += dur;
      }
      if (initEnd < 0) throw new Error('mp4 without moov');
      return { initEnd, segs, duration: (t - earliest) / timescale };
    }
    p += size;
  }
}
