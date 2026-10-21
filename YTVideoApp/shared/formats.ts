/** Stream selection shared by the server (prefetch) and the browser (playback). */

export type Fmt = {
  itag: number;
  kind: 'video' | 'audio';
  mime: string; // full type incl. codecs, e.g. video/webm; codecs="vp9"
  codec: string; // vp9 | avc1 | av01 | opus | mp4a
  height: number;
  fps: number;
  bitrate: number;
  size: number;
};

export type Codec = 'vp9' | 'avc1';
export type Prefs = { codec: Codec; maxHeight: number };

/**
 * AV1 is never chosen: Turing GPUs (e.g. RTX 2060 Super) have no AV1 decoder,
 * so it would run on the CPU. HDR VP9 (profile 2, mime codecs="vp9.2") is
 * skipped too: Chrome's MSE rejects that codec string, and HDR uploads always
 * have an SDR VP9 track as well.
 */
const playable = (f: Fmt) => f.kind === 'video' && f.codec !== 'av01' && !f.mime.includes('vp9.2');

/**
 * Best video stream at or below maxHeight. The preferred codec wins unless the
 * other one reaches a higher resolution: some uploads only have VP9 up to 360p
 * but H.264 up to 1080p.
 */
export function pickVideo(fmts: Fmt[], p: Prefs): Fmt | undefined {
  const usable = fmts.filter(playable);
  const best = (list: Fmt[]) => {
    const fit = list.filter((f) => f.height <= p.maxHeight);
    const pool = fit.length ? fit : list.slice().sort((a, b) => a.height - b.height).slice(0, 1);
    return pool.sort((a, b) => b.height - a.height || b.fps - a.fps || b.bitrate - a.bitrate)[0];
  };
  const preferred = best(usable.filter((f) => f.codec === p.codec));
  const other = best(usable.filter((f) => f.codec !== p.codec));
  if (!preferred) return other;
  if (!other) return preferred;
  // Within the limit, higher is better; over it (a codec with nothing small enough), lower is better.
  const rank = (f: Fmt) => (f.height <= p.maxHeight ? f.height : -f.height);
  const ro = rank(other);
  const rp = rank(preferred);
  return ro > rp || (ro === rp && other.fps > preferred.fps) ? other : preferred;
}

/** Opus (itag 251) when available, otherwise the best AAC. */
export function pickAudio(fmts: Fmt[]): Fmt | undefined {
  const a = fmts.filter((f) => f.kind === 'audio');
  return a.find((f) => f.codec === 'opus' && f.itag === 251) ?? a.sort((x, y) => y.bitrate - x.bitrate)[0];
}

export const lowestVideo = (fmts: Fmt[], codec: Codec) => pickVideo(fmts, { codec, maxHeight: 144 });

/** Distinct heights available in any usable codec (for the quality menu). */
export function heights(fmts: Fmt[]): number[] {
  const pool = fmts.filter(playable);
  return [...new Set(pool.map((f) => f.height))].sort((a, b) => b - a);
}
