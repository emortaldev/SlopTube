import { createSignal } from 'solid-js';
import type { Codec } from '../shared/formats';
import { setPrefetchPrefs } from './api';
import { detectCodec, type CodecChoice } from './codec';

const store = (k: string, v?: string) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {}
  return null;
};

/** What the browser reports it can hardware-decode. */
export const [detected, setDetected] = createSignal<CodecChoice>({ codec: 'vp9', hardware: false });
/** User override: 'auto' follows detection. */
export type CodecMode = 'auto' | Codec;
const [codecMode, setCodecModeSig] = createSignal<CodecMode>((store('codec') as CodecMode) || 'auto');
export { codecMode };
export const codec = () => {
  const m = codecMode();
  return m === 'auto' ? detected() : { codec: m, hardware: detected().hardware && detected().codec === m };
};
export const setCodecMode = (m: CodecMode) => {
  setCodecModeSig(m);
  store('codec', m === 'auto' ? '' : m);
  setPrefetchPrefs({ codec: codec().codec, maxHeight: 1080 });
};
export const codecReady: Promise<CodecChoice> = detectCodec().then((c) => {
  setDetected(c);
  setPrefetchPrefs({ codec: codec().codec, maxHeight: 1080 });
  return c;
});

/** 'auto' or a fixed height. */
export type Quality = 'auto' | number;
const [quality, setQualitySig] = createSignal<Quality>(Number(store('quality')) || 'auto');
export { quality };
export const setQuality = (q: Quality) => {
  setQualitySig(q);
  store('quality', q === 'auto' ? '' : String(q));
};

const [autoplay, setAutoplaySig] = createSignal(store('autoplay') !== '0');
export { autoplay };
export const setAutoplay = (v: boolean) => {
  setAutoplaySig(v);
  store('autoplay', v ? '1' : '0');
};

/** Slider position 0..1; gain is logarithmic over 50 dB. */
const [volume, setVolumeSig] = createSignal(Number(store('volpos') ?? 0.8));
export { volume };
export const setVolume = (v: number) => {
  v = Math.min(1, Math.max(0, v));
  setVolumeSig(v);
  store('volpos', String(v));
};
export const gain = (pos: number) => (pos <= 0 ? 0 : Math.pow(10, ((pos - 1) * 50) / 20));

const LADDER = [144, 240, 360, 480, 720, 1080, 1440, 2160];
/** Auto quality: a step above the player's pixel height, capped at the screen's. */
export function autoHeight(playerCssHeight: number) {
  const dpr = devicePixelRatio || 1;
  const want = playerCssHeight * dpr * 1.25;
  const cap = screen.height * dpr;
  const h = LADDER.find((x) => x >= want) ?? 2160;
  return Math.max(360, Math.min(h, LADDER.filter((x) => x <= Math.max(cap, 720)).pop() ?? 1080));
}
