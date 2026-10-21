import type { Codec } from '../shared/formats';

export type CodecChoice = { codec: Codec; hardware: boolean };

/**
 * Pick the codec the GPU decodes. On an RTX 2060 Super (Turing) NVDEC handles
 * VP9 and H.264 but not AV1, so AV1 is never considered. VP9 is preferred
 * (better quality per bit, and the only option above 1080p). If the browser
 * can't hardware-decode either, H.264 is the cheapest to decode in software.
 */
export async function detectCodec(): Promise<CodecChoice> {
  const mc = navigator.mediaCapabilities;
  const q = (contentType: string) =>
    mc
      ?.decodingInfo({
        type: 'media-source',
        video: { contentType, width: 1920, height: 1080, bitrate: 4_000_000, framerate: 30 },
      })
      .catch(() => null) ?? Promise.resolve(null);
  const [vp9, avc] = await Promise.all([q('video/webm; codecs="vp09.00.40.08"'), q('video/mp4; codecs="avc1.640028"')]);
  if (vp9?.supported && vp9.powerEfficient) return { codec: 'vp9', hardware: true };
  if (avc?.supported && avc.powerEfficient) return { codec: 'avc1', hardware: true };
  return { codec: 'avc1', hardware: false };
}
