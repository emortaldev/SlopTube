import { visitorData } from './yt';

/**
 * Audio delivery tuned for click-to-audio latency:
 *  - stream URLs come from a single raw InnerTube /player call using the VISIONOS
 *    client (direct URLs, no signature deciphering, no PO token, ~80ms), with
 *    yt-dlp as a slow but robust fallback;
 *  - resolutions are cached until shortly before their `expire` timestamp and
 *    concurrent requests for the same id share one lookup;
 *  - prefetch (hover / next-in-queue) also pulls the first HEAD_BYTES of the file
 *    into a small LRU, so playback starts without waiting on googlevideo at all.
 */

type Resolved = { url: string; mime: string; size: number; expires: number };

const HEAD_BYTES = 256 * 1024;
const HEAD_LRU = 24;
const PREFERRED_ITAGS = [251, 140, 250, 249, 139]; // opus 160k, aac 128k, then low-bitrate fallbacks

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
const heads = new Map<string, Promise<Uint8Array | null>>();

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
  const formats: any[] = j.streamingData?.adaptiveFormats ?? [];
  for (const itag of PREFERRED_ITAGS) {
    const f = formats.find((f) => f.itag === itag && f.url);
    if (f) return finish(f.url, f.mimeType, Number(f.contentLength) || 0);
  }
  throw new Error(j.playabilityStatus?.reason ?? 'no audio formats');
}

async function viaYtDlp(id: string): Promise<Resolved> {
  const p = Bun.spawn(
    ['yt-dlp', '-f', 'bestaudio[ext=webm]/bestaudio', '--no-warnings', '--print', '%(url)s\n%(filesize)s\n%(ext)s',
      `https://music.youtube.com/watch?v=${id}`],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  const [url, size, ext] = (await new Response(p.stdout).text()).trim().split('\n');
  if (!url?.startsWith('http')) throw new Error('yt-dlp failed for ' + id);
  const mime = ext === 'webm' ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"';
  return finish(url, mime, Number(size) || 0);
}

function finish(url: string, mime: string, size: number): Resolved {
  const exp = Number(new URL(url).searchParams.get('expire')) * 1000 || Date.now() + 3600_000;
  // Keep the codecs parameter: the client hands it straight to MediaSource.addSourceBuffer().
  return { url, mime: mime.replace(/\s+/g, ' '), size, expires: exp - 5 * 60_000 };
}

export function resolve(id: string): Promise<Resolved> {
  const hit = resolved.get(id);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit);
  let p = pending.get(id);
  if (!p) {
    p = viaVisionOS(id)
      .catch(() => viaYtDlp(id))
      .then((r) => {
        resolved.set(id, r);
        if (resolved.size > 500) resolved.delete(resolved.keys().next().value!);
        return r;
      })
      .finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

function invalidate(id: string) {
  resolved.delete(id);
  heads.delete(id);
}

const fetchRange = (r: Resolved, start: number, end?: number) =>
  fetch(r.url, { headers: { range: `bytes=${start}-${end ?? ''}` } });

/** Resolve the URL and warm the first chunk of audio. Fire-and-forget. */
export function prefetch(id: string) {
  const existing = heads.get(id);
  if (existing) {
    heads.delete(id); // bump LRU position
    heads.set(id, existing);
    return;
  }
  const p = resolve(id)
    .then(async (r) => {
      const res = await fetchRange(r, 0, HEAD_BYTES - 1);
      if (res.status !== 206) {
        await res.body?.cancel();
        return null;
      }
      if (!r.size) r.size = Number(res.headers.get('content-range')?.split('/')[1]) || 0;
      return new Uint8Array(await res.arrayBuffer());
    })
    .catch(() => null);
  heads.set(id, p);
  while (heads.size > HEAD_LRU) heads.delete(heads.keys().next().value!);
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

export async function stream(id: string, req: Request): Promise<Response> {
  const [start, endReq] = parseRange(req.headers.get('range'));

  for (let attempt = 0; attempt < 2; attempt++) {
    let r: Resolved;
    try {
      r = await resolve(id);
    } catch {
      return new Response('unavailable', { status: 502 });
    }
    const headers = new Headers({ 'content-type': r.mime, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });

    // Fast path: answer from the prefetched head and splice in the remainder.
    const head = start < HEAD_BYTES ? await heads.get(id) : null;
    if (head && r.size && head.length > start) {
      const end = Math.min(endReq ?? r.size - 1, r.size - 1);
      const part = head.subarray(start, Math.min(head.length, end + 1));
      const restFrom = start + part.length;
      const rest = restFrom <= end ? fetchRange(r, restFrom, endReq === undefined ? undefined : end) : null;
      headers.set('content-length', String(end - start + 1));
      headers.set('content-range', `bytes ${start}-${end}/${r.size}`);
      return new Response(splice(part, rest), { status: 206, headers });
    }

    const res = await fetchRange(r, start, endReq).catch(() => null);
    if (!res || res.status === 403 || res.status >= 500) {
      await res?.body?.cancel();
      invalidate(id);
      continue;
    }
    for (const k of ['content-length', 'content-range']) {
      const v = res.headers.get(k);
      if (v) headers.set(k, v);
    }
    return new Response(res.body, { status: res.status, headers });
  }
  return new Response('upstream refused', { status: 502 });
}
