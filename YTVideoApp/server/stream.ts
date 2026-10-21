import { pickAudio, pickVideo, type Fmt, type Prefs } from '../shared/formats';
import { visitorData } from './yt';

/**
 * Stream resolution + proxy.
 *  - One raw InnerTube /player call with the VISIONOS client returns direct,
 *    unciphered DASH URLs for every quality (no PO token), in ~80ms.
 *  - Resolutions are cached until shortly before they expire and shared by
 *    concurrent callers.
 *  - prefetch() also caches the first bytes of the streams the client will pick
 *    (init segment, index and the start of the first media segment), so a click
 *    starts without waiting on googlevideo.
 */

export type Details = {
  title: string;
  author: string;
  channelId: string;
  lengthSeconds: number;
  viewCount: string;
  isLive: boolean;
  isShort?: boolean;
  storyboard?: Storyboard;
};
/** One sprite-sheet level: `url` has $M for the sheet number; frames run left→right, top→bottom. */
export type Storyboard = { url: string; w: number; h: number; count: number; cols: number; rows: number; interval: number };
type Resolved = { formats: Fmt[]; urls: Map<number, string>; details: Details; expires: number };

const HEAD = { video: 1024 * 1024, audio: 256 * 1024 };
const HEAD_LRU = 16;

const VISIONOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const VISIONOS = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  userAgent: VISIONOS_UA,
  osName: 'visionOS',
  osVersion: '26.5.23O471',
  hl: 'en',
};

const resolved = new Map<string, Resolved>();
const pending = new Map<string, Promise<Resolved>>();
/** key id:itag → first bytes; `buf` is set once the download completes. */
const heads = new Map<string, { p: Promise<unknown>; buf?: Uint8Array }>();

function codecOf(mime: string) {
  const c = /codecs="([^"]+)"/.exec(mime)?.[1] ?? '';
  return c.split('.')[0]!;
}

/**
 * Spec: `baseUrl|w#h#count#cols#rows#intervalMs#name#sigh|…`, one level per
 * part, smallest first. Use the largest; level 0 (interval 0) is too tiny.
 */
function storyboardOf(spec: string | undefined): Storyboard | undefined {
  const [base, ...levels] = spec?.split('|') ?? [];
  if (!base?.startsWith('http') || !levels.length) return;
  const L = levels.length - 1;
  const [w, h, count, cols, rows, interval, name, sigh] = levels[L]!.split('#');
  const url = new URL(base.replace('$L', String(L)).replace('$N', name!));
  url.searchParams.set('sigh', sigh!);
  return {
    url: url.toString().replace('%24M', '$M'),
    w: +w!,
    h: +h!,
    count: +count!,
    cols: +cols!,
    rows: +rows!,
    interval: +interval!,
  };
}

async function viaVisionOS(id: string): Promise<Resolved> {
  const vd = visitorData();
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': VISIONOS_UA,
      'x-youtube-client-name': '101',
      'x-youtube-client-version': VISIONOS.clientVersion,
      'x-goog-visitor-id': vd,
      origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({
      context: { client: { ...VISIONOS, visitorData: vd } },
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  const j: any = await res.json();
  const vdt = j.videoDetails ?? {};
  const details: Details = {
    title: vdt.title ?? '',
    author: vdt.author ?? '',
    channelId: vdt.channelId ?? '',
    lengthSeconds: Number(vdt.lengthSeconds) || 0,
    viewCount: vdt.viewCount ?? '',
    isLive: !!vdt.isLive || !!vdt.isUpcoming,
    storyboard: storyboardOf(j.storyboards?.playerStoryboardSpecRenderer?.spec),
  };
  if (details.isLive) throw Object.assign(new Error('Live streams are not supported'), { status: 422 });
  const urls = new Map<number, string>();
  const formats: Fmt[] = [];
  // An itag can appear several times (DRC "stable volume" variants, dubbed audio
  // tracks) with different files. Keep one per itag, preferring the plain default
  // track, so the URL and size/index always describe the same file.
  const rank = (f: any) => (f.isDrc ? 1 : 0) + (f.audioTrack && !f.audioTrack.audioIsDefault ? 2 : 0);
  const adaptive = [...(j.streamingData?.adaptiveFormats ?? [])].sort((a, b) => rank(a) - rank(b));
  for (const f of adaptive) {
    if (!f.url || !f.contentLength || !f.indexRange) continue; // only proper DASH representations
    if (urls.has(f.itag)) continue;
    const kind = f.mimeType.startsWith('video') ? 'video' : 'audio';
    urls.set(f.itag, f.url);
    formats.push({
      itag: f.itag,
      kind,
      mime: f.mimeType.replace(/\s+/g, ' '),
      codec: codecOf(f.mimeType),
      height: f.height ?? 0,
      fps: f.fps ?? 0,
      bitrate: f.bitrate ?? 0,
      size: Number(f.contentLength),
    });
  }
  if (!formats.some((f) => f.kind === 'video')) {
    throw Object.assign(new Error(j.playabilityStatus?.reason ?? 'Video unavailable'), { status: 404 });
  }
  const first = urls.values().next().value!;
  const exp = Number(new URL(first).searchParams.get('expire')) * 1000 || Date.now() + 3600_000;
  return { formats, urls, details, expires: exp - 5 * 60_000 };
}

export function resolve(id: string): Promise<Resolved> {
  const hit = resolved.get(id);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit);
  let p = pending.get(id);
  if (!p) {
    p = viaVisionOS(id)
      .then((r) => {
        resolved.set(id, r);
        if (resolved.size > 300) resolved.delete(resolved.keys().next().value!);
        return r;
      })
      .finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

function warmHead(id: string, r: Resolved, f: Fmt) {
  const key = `${id}:${f.itag}`;
  if (heads.has(key)) return;
  const url = r.urls.get(f.itag)!;
  const n = Math.min(HEAD[f.kind], f.size);
  const entry: { p: Promise<unknown>; buf?: Uint8Array } = { p: Promise.resolve() };
  entry.p = fetch(url, { headers: { range: `bytes=0-${n - 1}` } })
    .then(async (res) => {
      if (res.status === 206) entry.buf = new Uint8Array(await res.arrayBuffer());
    })
    .catch(() => {});
  heads.set(key, entry);
  while (heads.size > HEAD_LRU * 2) heads.delete(heads.keys().next().value!);
}

/** Resolve and warm the streams `prefs` would select. Fire-and-forget. */
export function prefetch(id: string, prefs: Prefs) {
  resolve(id)
    .then((r) => {
      const v = pickVideo(r.formats, prefs);
      const a = pickAudio(r.formats);
      if (v) warmHead(id, r, v);
      if (a) warmHead(id, r, a);
    })
    .catch(() => {});
}

/**
 * Whole file via parallel 4 MB range requests. googlevideo throttles a single
 * long request to roughly 2x playback speed; several short ones in flight run
 * at full line speed. Chunks are emitted in order.
 */
export async function fast(id: string, itag: number): Promise<Response> {
  const r = await resolve(id);
  const f = r.formats.find((x) => x.itag === itag);
  if (!f) return new Response('no such format', { status: 404 });
  const CHUNK = 4 * 1024 * 1024;
  const PARALLEL = 4;
  const total = Math.ceil(f.size / CHUNK);
  const get = async (i: number): Promise<Uint8Array> => {
    const start = i * CHUNK;
    const end = Math.min(f.size, start + CHUNK) - 1;
    for (let attempt = 0; ; attempt++) {
      const cur = await resolve(id);
      const res = await fetch(cur.urls.get(itag)!, { headers: { range: `bytes=${start}-${end}` } }).catch(() => null);
      if (res?.status === 206) return new Uint8Array(await res.arrayBuffer());
      await res?.body?.cancel();
      if (attempt >= 2) throw new Error('upstream ' + res?.status);
      resolved.delete(id);
    }
  };
  const inflight: Promise<Uint8Array>[] = [];
  let next = 0;
  const fill = () => {
    while (inflight.length < PARALLEL && next < total) inflight.push(get(next++));
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(ctl) {
        fill();
        const p = inflight.shift();
        if (!p) return ctl.close();
        try {
          ctl.enqueue(await p);
        } catch (e) {
          ctl.error(e);
        }
      },
      cancel() {
        next = total;
        inflight.length = 0;
      },
    }),
    { headers: { 'content-type': f.mime, 'content-length': String(f.size) } },
  );
}

function parseRange(h: string | null): [number, number | undefined] {
  const m = h && /bytes=(\d*)-(\d*)/.exec(h);
  if (!m) return [0, undefined];
  return [Number(m[1] || 0), m[2] ? Number(m[2]) : undefined];
}

/** Emit `head`, then pipe `rest` through without buffering. */
function splice(head: Uint8Array, rest: Promise<Response> | null) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(head);
      if (!rest) ctl.close();
    },
    async pull(ctl) {
      if (!reader) {
        const res = await rest!.catch(() => null);
        if (res?.status !== 206 || !res.body) return ctl.error(new Error('upstream ' + res?.status));
        reader = res.body.getReader();
      }
      const { done, value } = await reader.read();
      if (done) ctl.close();
      else ctl.enqueue(value);
    },
    cancel() {
      if (reader) reader.cancel();
      else rest?.then((r) => r.body?.cancel()).catch(() => {});
    },
  });
}

export async function stream(id: string, itag: number, req: Request): Promise<Response> {
  const [start, endReq] = parseRange(req.headers.get('range'));
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: Resolved;
    try {
      r = await resolve(id);
    } catch {
      return new Response('unavailable', { status: 502 });
    }
    const f = r.formats.find((x) => x.itag === itag);
    const url = r.urls.get(itag);
    if (!f || !url) return new Response('no such format', { status: 404 });
    const end = Math.min(endReq ?? f.size - 1, f.size - 1);
    const headers = new Headers({
      'content-type': f.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${f.size}`,
    });

    // Only use the cache once it's complete; never make a request wait on it.
    const head = heads.get(`${id}:${itag}`)?.buf;
    if (head && head.length > start) {
      const part = head.subarray(start, Math.min(head.length, end + 1));
      const from = start + part.length;
      const rest = from <= end ? fetch(url, { headers: { range: `bytes=${from}-${end}` } }) : null;
      return new Response(splice(part, rest), { status: 206, headers });
    }

    const res = await fetch(url, { headers: { range: `bytes=${start}-${end}` } }).catch(() => null);
    if (!res || res.status === 403 || res.status >= 500) {
      await res?.body?.cancel();
      resolved.delete(id); // expired or rejected URL: re-resolve once
      continue;
    }
    return new Response(res.body, { status: res.status, headers });
  }
  return new Response('upstream refused', { status: 502 });
}
