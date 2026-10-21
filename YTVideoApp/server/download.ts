import type { Fmt } from '../shared/formats';
import { resolve } from './stream';

/**
 * Downloads are muxed by ffmpeg straight from the local stream proxy and
 * streamed to the browser as they're produced, so the download starts at once
 * instead of after the whole file has been fetched. Containers are written in
 * streaming-friendly form (fragmented MP4, WebM, Ogg/Opus, MP3).
 */

export type DownloadOption = {
  key: string;
  label: string;
  detail: string;
  ext: string;
  size: number; // approximate bytes
};

type Plan = { inputs: Fmt[]; args: string[]; ext: string; mime: string };

const SELF = `http://127.0.0.1:${process.env.PORT ?? 8788}`;

function videoChoices(fmts: Fmt[]) {
  // One entry per height: H.264 (MP4) where it exists, otherwise VP9 (WebM).
  const byHeight = new Map<number, Fmt>();
  for (const f of fmts) {
    if (f.kind !== 'video' || f.codec === 'av01') continue;
    const cur = byHeight.get(f.height);
    const better =
      !cur ||
      (f.codec === 'avc1' && cur.codec !== 'avc1') ||
      (f.codec === cur.codec && (f.fps > cur.fps || (f.fps === cur.fps && f.bitrate > cur.bitrate)));
    if (better) byHeight.set(f.height, f);
  }
  return [...byHeight.values()].sort((a, b) => b.height - a.height);
}

const audio = (fmts: Fmt[], codec: 'mp4a' | 'opus') =>
  fmts.filter((f) => f.kind === 'audio' && f.codec === codec).sort((a, b) => b.bitrate - a.bitrate)[0];

export async function options(id: string): Promise<DownloadOption[]> {
  const { formats } = await resolve(id);
  const out: DownloadOption[] = [];
  const aac = audio(formats, 'mp4a');
  const opus = audio(formats, 'opus');
  for (const v of videoChoices(formats)) {
    const mp4 = v.codec === 'avc1';
    const a = mp4 ? aac : opus;
    if (!a) continue;
    out.push({
      key: `v${v.itag}`,
      label: `${v.height}p${v.fps > 30 ? v.fps : ''}`,
      detail: mp4 ? 'MP4 · H.264' : 'WebM · VP9',
      ext: mp4 ? 'mp4' : 'webm',
      size: v.size + a.size,
    });
  }
  if (aac) out.push({ key: 'm4a', label: 'Audio only', detail: 'M4A · AAC', ext: 'm4a', size: aac.size });
  if (opus) out.push({ key: 'opus', label: 'Audio only', detail: 'Opus', ext: 'opus', size: opus.size });
  if (opus ?? aac) out.push({ key: 'mp3', label: 'Audio only', detail: 'MP3 · converted', ext: 'mp3', size: Math.round(((opus ?? aac)!.size * 320) / 160) });
  return out;
}

function plan(fmts: Fmt[], key: string): Plan | null {
  const aac = audio(fmts, 'mp4a');
  const opus = audio(fmts, 'opus');
  const frag = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'];
  if (key.startsWith('v')) {
    const v = fmts.find((f) => f.itag === Number(key.slice(1)) && f.kind === 'video');
    if (!v) return null;
    const mp4 = v.codec === 'avc1';
    const a = mp4 ? aac : opus;
    if (!a) return null;
    return {
      inputs: [v, a],
      args: ['-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...(mp4 ? [...frag, '-f', 'mp4'] : ['-f', 'webm'])],
      ext: mp4 ? 'mp4' : 'webm',
      mime: mp4 ? 'video/mp4' : 'video/webm',
    };
  }
  if (key === 'm4a' && aac) return { inputs: [aac], args: ['-c', 'copy', ...frag, '-f', 'ipod'], ext: 'm4a', mime: 'audio/mp4' };
  if (key === 'opus' && opus) return { inputs: [opus], args: ['-c', 'copy', '-f', 'opus'], ext: 'opus', mime: 'audio/ogg' };
  const src = opus ?? aac;
  if (key === 'mp3' && src)
    return { inputs: [src], args: ['-vn', '-c:a', 'libmp3lame', '-q:a', '0', '-f', 'mp3'], ext: 'mp3', mime: 'audio/mpeg' };
  return null;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video';

export async function download(id: string, key: string, req: Request): Promise<Response> {
  const { formats, details } = await resolve(id);
  const p = plan(formats, key);
  if (!p) return new Response('unknown option', { status: 400 });
  const args = ['ffmpeg', '-hide_banner', '-loglevel', 'error'];
  for (const f of p.inputs) args.push('-i', `${SELF}/api/fast/${id}/${f.itag}`);
  args.push('-metadata', `title=${details.title}`, '-metadata', `artist=${details.author}`, ...p.args, 'pipe:1');
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
  req.signal.addEventListener('abort', () => proc.kill());
  const name = `${safeName(details.title)}.${p.ext}`;
  return new Response(proc.stdout, {
    headers: {
      'content-type': p.mime,
      'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
    },
  });
}
