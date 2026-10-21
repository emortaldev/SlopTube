import type { Track } from './api';
import { parseIndex, type Seg } from './container';

/**
 * Gapless audio engine.
 *
 * All tracks are appended to ONE MediaSource timeline: when the current track
 * is fully buffered and within AHEAD seconds of its end, the next track is
 * appended directly after it (timestampOffset = end of what's buffered), so the
 * decoder never stops between songs. Only ~AHEAD seconds ahead and BEHIND
 * seconds behind the playhead stay in the SourceBuffer, so memory stays flat
 * (~2 MB of compressed audio) however long the session is.
 *
 * Browsers without MediaSource fall back to a plain <audio src> per track.
 */

const HEAD = 256 * 1024; // matches the server's prefetch head cache
const AHEAD = 45; // seconds buffered ahead of the playhead
const BEHIND = 20; // seconds kept behind it (for small rewinds)
const GROUP = 512 * 1024; // max bytes per segment fetch

type Media = { mime: string; size: number; init: Uint8Array; segs: Seg[]; duration: number; head?: Uint8Array };
type Entry = { track: Track; qi: number; offset: number; media?: Media; next: number; done: boolean };
export type Upcoming = { track: Track; qi: number };

export type Hooks = {
  /** What plays after queue position `qi` (respecting repeat), or undefined at the end. */
  next(qi: number): Upcoming | undefined;
  /** Playback crossed seamlessly into a new track. */
  advanced(u: Upcoming): void;
  /** A track couldn't be loaded at all. */
  failed(u: Upcoming): void;
};

const MSClass: typeof MediaSource | undefined =
  (globalThis as any).ManagedMediaSource ?? (globalThis as any).MediaSource;

export const audio = new Audio();
audio.preload = 'auto';
(audio as any).disableRemotePlayback = true; // required for ManagedMediaSource on Safari

export const gapless = !!MSClass;

let hooks: Hooks;
let ms: MediaSource | null = null;
let sb: SourceBuffer | null = null;
let sbMime = '';
let objectUrl = '';
let initFor: Entry | null = null;
let entries: Entry[] = [];
let cur: Entry | null = null;
let gen = 0;
let ctrl = new AbortController();
let pumping = false;
let pumpAgain = false;

export function setHooks(h: Hooks) {
  hooks = h;
}

const streamUrl = (id: string) => `/api/stream/${id}`;
const once = (t: EventTarget, ev: string) => new Promise<void>((r) => t.addEventListener(ev, () => r(), { once: true }));
const idle = async () => {
  while (sb?.updating) await once(sb, 'updateend');
};

async function loadMedia(id: string, signal: AbortSignal): Promise<Media> {
  const get = async (end: number) => {
    const res = await fetch(streamUrl(id), { headers: { range: `bytes=0-${end - 1}` }, signal });
    if (res.status !== 206) throw new Error('stream ' + res.status);
    return {
      mime: res.headers.get('content-type') ?? '',
      size: Number(res.headers.get('content-range')?.split('/')[1]) || 0,
      buf: new Uint8Array(await res.arrayBuffer()),
    };
  };
  let { mime, size, buf } = await get(HEAD);
  let idx = parseIndex(buf, size, mime);
  if ('need' in idx) {
    buf = (await get(Math.min(size, idx.need))).buf;
    idx = parseIndex(buf, size, mime);
    if ('need' in idx) throw new Error('index too large');
  }
  if (!MSClass!.isTypeSupported(mime)) throw new Error('unsupported ' + mime);
  return { mime, size, init: buf.slice(0, idx.initEnd), segs: idx.segs, duration: idx.duration, head: buf };
}

function bufferedAt(t: number): [number, number] | null {
  if (!sb) return null;
  const b = sb.buffered;
  for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.01 && t < b.end(i)) return [b.start(i), b.end(i)];
  return null;
}

const durationOf = (e: Entry) => e.media?.duration ?? e.track.duration;

// ---------- public API ----------

/** Hard start: new timeline beginning with `track`. */
export function start(track: Track, qi: number) {
  gen++;
  ctrl.abort();
  ctrl = new AbortController();
  cur = { track, qi, offset: 0, next: 0, done: false };
  entries = [cur];
  initFor = null;
  sb = null;
  sbMime = '';
  if (objectUrl) URL.revokeObjectURL(objectUrl);

  if (!gapless) {
    audio.src = streamUrl(track.id);
    audio.play().catch(() => {});
    return;
  }
  const m = new MSClass!();
  ms = m;
  objectUrl = URL.createObjectURL(m);
  audio.src = objectUrl;
  audio.play().catch(() => {});
  const myGen = gen;
  const entry = cur;
  // Fetch the head while the MediaSource opens.
  const media = loadMedia(track.id, ctrl.signal);
  media.catch(() => {});
  once(m, 'sourceopen').then(async () => {
    try {
      entry.media = await media;
    } catch (e) {
      if (myGen === gen && (e as Error).name !== 'AbortError') hooks.failed({ track, qi });
      return;
    }
    if (myGen === gen) pump();
  });
}

/** Seek within the current track (seconds from its start). */
export function seek(t: number) {
  const e = cur;
  if (!e) return;
  if (!gapless) {
    audio.currentTime = t;
    return;
  }
  const abs = e.offset + Math.max(0, Math.min(t, durationOf(e) - 0.05));
  if (bufferedAt(abs) || !e.media) {
    audio.currentTime = abs;
    return;
  }
  // Unbuffered: restart feeding the current track from the segment containing t.
  const segs = e.media.segs;
  let i = segs.length - 1;
  while (i > 0 && segs[i]!.t > t) i--;
  resetFeed();
  e.next = i;
  e.done = false;
  // The timeline only grows as data is appended; extend it first or the seek gets clamped.
  ensureDuration(e.offset + e.media.duration);
  audio.currentTime = abs;
  pump();
}

function ensureDuration(end: number) {
  if (!ms || ms.readyState !== 'open' || sb?.updating) return;
  if (!(ms.duration >= end)) ms.duration = end;
}

/** Re-validate tracks queued after the current one (queue edited, repeat changed…). */
export function sync(curQi: number) {
  if (!gapless || !cur) return;
  cur.qi = curQi;
  const ci = entries.indexOf(cur);
  let prev = cur;
  for (let k = ci + 1; k < entries.length; k++) {
    const want = hooks.next(prev.qi);
    const e = entries[k]!;
    if (!want || want.track.id !== e.track.id) {
      dropFrom(k);
      break;
    }
    e.qi = want.qi;
    prev = e;
  }
  pump();
}

export const time = () => (cur ? Math.max(0, audio.currentTime - cur.offset) : 0);
export const duration = () => (cur ? durationOf(cur) : 0);

// ---------- internals ----------

function resetFeed() {
  gen++;
  ctrl.abort();
  ctrl = new AbortController();
  initFor = null; // sb.abort() resets the parser: the init segment must be re-sent
  if (sb && ms?.readyState === 'open') {
    try {
      sb.abort();
    } catch {}
  }
}

function dropFrom(k: number) {
  const from = entries[k]!.offset;
  entries.length = k;
  resetFeed();
  const myGen = gen;
  (async () => {
    await idle();
    if (myGen !== gen || !sb || !ms) return;
    const end = isFinite(ms.duration) ? ms.duration : from + 1e5;
    if (end > from) {
      sb.remove(from, end);
      await idle();
    }
    if (myGen === gen) pump();
  })();
}

/** Detect playback crossing into the next timeline entry. Called on timeupdate. */
function checkAdvance() {
  if (!cur) return;
  const t = audio.currentTime;
  let ci = entries.indexOf(cur);
  let moved = false;
  while (ci + 1 < entries.length && t >= entries[ci + 1]!.offset - 0.05 && entries[ci + 1]!.media) {
    ci++;
    moved = true;
  }
  if (!moved) return;
  cur = entries[ci]!;
  entries = entries.slice(ci); // forget finished tracks
  hooks.advanced({ track: cur.track, qi: cur.qi });
}

async function append(buf: Uint8Array, myGen: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await idle();
    if (myGen !== gen || !sb) return false;
    try {
      sb.appendBuffer(buf as BufferSource);
      await idle();
      return myGen === gen;
    } catch (e) {
      if ((e as Error).name !== 'QuotaExceededError') throw e;
      await trimBehind(myGen, 5);
    }
  }
  return false;
}

async function trimBehind(myGen: number, keep = BEHIND) {
  if (!sb || !sb.buffered.length) return;
  const cut = audio.currentTime - keep;
  if (cut - sb.buffered.start(0) < 10) return;
  await idle();
  if (myGen !== gen) return;
  sb.remove(0, cut);
  await idle();
}

export function pump() {
  if (!gapless || !ms) return;
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  feed(gen)
    .catch((e) => {
      if ((e as Error).name !== 'AbortError') console.warn('[engine]', e);
    })
    .finally(() => {
      pumping = false;
      if (pumpAgain) {
        pumpAgain = false;
        pump();
      }
    });
}

async function feed(myGen: number) {
  const m = ms!;
  while (myGen === gen) {
    if (m.readyState === 'closed') return;
    await trimBehind(myGen);

    // 1. Pick the first entry still needing data, or chain the next track.
    let e = entries.find((x) => !x.done);
    if (!e) {
      const last = entries[entries.length - 1]!;
      const lastEnd = last.offset + durationOf(last);
      if (lastEnd - audio.currentTime > AHEAD) return;
      const up = hooks.next(last.qi);
      if (!up) {
        await idle();
        if (myGen === gen && m.readyState === 'open' && !sb?.updating) m.endOfStream();
        return;
      }
      // Start exactly where the previous track's audio actually ends.
      const r = bufferedAt(lastEnd - 0.5);
      e = { track: up.track, qi: up.qi, offset: r && Math.abs(r[1] - lastEnd) < 0.5 ? r[1] : lastEnd, next: 0, done: false };
      entries.push(e);
    }

    // 2. Load its index.
    if (!e.media) {
      try {
        e.media = await loadMedia(e.track.id, ctrl.signal);
      } catch (err) {
        if (myGen !== gen || (err as Error).name === 'AbortError') return;
        if (e === cur) return hooks.failed({ track: e.track, qi: e.qi });
        // Unplayable upcoming track: occupy zero time so the chain skips it.
        e.media = { mime: '', size: 0, init: new Uint8Array(), segs: [], duration: 0 };
        e.done = true;
        continue;
      }
      if (myGen !== gen) return;
    }
    const md = e.media;

    // 3. Respect the look-ahead window.
    const seg = md.segs[e.next];
    if (!seg) {
      e.done = true;
      continue;
    }
    if (e.offset + seg.t - audio.currentTime > AHEAD) return;

    // 4. SourceBuffer for this codec.
    await idle();
    if (myGen !== gen) return;
    if (!sb) {
      sb = m.addSourceBuffer(md.mime);
      sb.mode = 'segments';
      sbMime = md.mime;
    } else if (sbMime !== md.mime) {
      sb.changeType(md.mime);
      sbMime = md.mime;
      initFor = null;
    }

    // 5. Init segment + placement on the timeline.
    if (initFor !== e) {
      ensureDuration(e.offset + md.duration);
      sb.appendWindowEnd = Infinity;
      sb.appendWindowStart = e.offset;
      sb.appendWindowEnd = e.offset + md.duration;
      sb.timestampOffset = e.offset;
      if (!(await append(md.init, myGen))) return;
      initFor = e;
    }

    // 6. Next group of segments (skipping ones already buffered).
    let i = e.next;
    while (i < md.segs.length && bufferedCovers(e.offset + md.segs[i]!.t, e.offset + segEnd(md, i))) i++;
    if (i >= md.segs.length) {
      e.next = i;
      continue;
    }
    const starting = !bufferedAt(audio.currentTime);
    const limit = starting ? 160 * 1024 : GROUP;
    let j = i;
    const head = md.head;
    const inHead = (k: number) => !!head && md.segs[k]!.end <= head.length;
    if (inHead(i)) while (j < md.segs.length && inHead(j)) j++;
    else while (j < md.segs.length && (j === i || md.segs[j]!.end - md.segs[i]!.start <= limit)) j++;
    const from = md.segs[i]!.start;
    const to = md.segs[j - 1]!.end;
    let data: Uint8Array;
    if (inHead(i)) data = head!.subarray(from, to);
    else {
      const res = await fetch(streamUrl(e.track.id), { headers: { range: `bytes=${from}-${to - 1}` }, signal: ctrl.signal });
      if (res.status !== 206) throw new Error('segment ' + res.status);
      data = new Uint8Array(await res.arrayBuffer());
      if (myGen !== gen) return;
    }
    if (!(await append(data, myGen))) return;
    e.next = j;
    if (j >= md.segs.length) {
      e.done = true;
      md.head = undefined; // free it
    }
  }
}

const segEnd = (md: Media, i: number) => md.segs[i + 1]?.t ?? md.duration;

function bufferedCovers(a: number, b: number) {
  const r = bufferedAt(a);
  return !!r && r[1] >= b - 0.05;
}

audio.addEventListener('timeupdate', () => {
  if (!gapless) return;
  checkAdvance();
  pump();
});
audio.addEventListener('seeking', () => gapless && pump());
