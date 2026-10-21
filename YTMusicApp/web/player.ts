import { batch, createEffect, createMemo, createRoot, createSignal, untrack } from 'solid-js';
import { api, prefetch, thumb, type Collection, type Track } from './api';
import * as engine from './engine';

/**
 * Queue + transport state on top of the gapless engine (engine.ts). Time
 * updates are dropped while the tab is hidden so a backgrounded tab does no
 * DOM work.
 */
const audio = engine.audio;

const store = (k: string, v?: string) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {}
  return null;
};

export type Repeat = 'off' | 'all' | 'one';

const [queue, setQueue] = createSignal<Track[]>([]);
const [index, setIndex] = createSignal(-1);
const [playing, setPlaying] = createSignal(false);
const [loading, setLoading] = createSignal(false);
const [time, setTime] = createSignal(0);
const [duration, setDuration] = createSignal(0);
/** Slider position 0..1; the actual gain is logarithmic (see gain()). */
const [volume, setVolumeSig] = createSignal(Number(store('volpos') ?? 0.75));
const [muted, setMuted] = createSignal(false);
const [repeat, setRepeat] = createSignal<Repeat>((store('repeat') as Repeat) ?? 'off');
const [shuffled, setShuffled] = createSignal(false);
/** Where the queue came from, so continuation pages can be appended to it. */
const [source, setSource] = createSignal<{ col?: Collection; radio?: boolean } | null>(null);

const current = createRoot(() => createMemo(() => queue()[index()]));

/** 0..1 slider position → amplitude over a 50 dB range, so each step sounds equally loud. */
const gain = (pos: number) => (pos <= 0 ? 0 : Math.pow(10, ((pos - 1) * 50) / 20));
audio.volume = gain(volume());

audio.addEventListener('playing', () => batch(() => (setPlaying(true), setLoading(false))));
audio.addEventListener('pause', () => setPlaying(false));
audio.addEventListener('waiting', () => setLoading(true));
audio.addEventListener('canplay', () => setLoading(false));
const syncTime = () => {
  if (document.hidden) return;
  batch(() => {
    setTime(engine.time());
    setDuration(engine.duration() || current()?.duration || 0);
  });
};
audio.addEventListener('timeupdate', syncTime);
audio.addEventListener('durationchange', syncTime);
document.addEventListener('visibilitychange', syncTime);
audio.addEventListener('ended', () => {
  // With MSE, repeat-one is handled gaplessly by the engine; this is the fallback path.
  if (repeat() === 'one') {
    engine.seek(0);
    audio.play();
  } else next(true);
});
audio.addEventListener('error', () => {
  setLoading(false);
  // Skip unplayable tracks instead of stalling the queue.
  if (audio.src && audio.error?.code !== MediaError.MEDIA_ERR_ABORTED) setTimeout(() => next(true), 400);
});

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function load(i: number) {
  const t = queue()[i];
  if (!t) return;
  batch(() => {
    setIndex(i);
    setTime(0);
    setDuration(t.duration);
    setLoading(true);
  });
  engine.start(t, i);
  onTrack(t, i);
}

function onTrack(t: Track, i: number) {
  updateSession(t);
  // Warm the next tracks so skipping (and the gapless hand-over) is instant too.
  const q = queue();
  for (let k = 1; k <= 2; k++) {
    const n = q[i + k];
    if (n) prefetch(n.id);
  }
  maybeExtend();
}

engine.setHooks({
  next(qi) {
    const q = queue();
    if (repeat() === 'one' && q[qi]) return { track: q[qi]!, qi };
    if (qi + 1 < q.length) return { track: q[qi + 1]!, qi: qi + 1 };
    if (repeat() === 'all' && q.length) return { track: q[0]!, qi: 0 };
    return undefined;
  },
  advanced({ track, qi }) {
    batch(() => {
      setIndex(qi);
      setTime(0);
      setDuration(engine.duration() || track.duration);
    });
    onTrack(track, qi);
  },
  failed({ qi }) {
    setLoading(false);
    if (qi === index()) setTimeout(() => next(true), 400);
  },
});

// Whenever the queue, position or repeat mode changes, let the engine re-check
// which track it has lined up after the current one.
createRoot(() =>
  createEffect(() => {
    queue();
    repeat();
    const i = index();
    untrack(() => engine.sync(i));
  }),
);

/** Keep the queue fed: pull more playlist pages or radio suggestions near the end. */
function maybeExtend() {
  const src = source();
  const left = queue().length - index();
  if (left > 5 || !src) return;
  if (src.col?.hasMore()) src.col.loadMore();
  else if (src.radio && left <= 2) {
    const last = queue()[queue().length - 1];
    if (last)
      api.upNext(last.id).then((more) => {
        const have = new Set(queue().map((t) => t.id));
        setQueue((q) => q.concat(more.filter((t) => !have.has(t.id))));
      });
  }
}

// Mirror newly loaded playlist pages into the queue.
createRoot(() => {
  let col: Collection | undefined;
  let seen = 0;
  createEffect(() => {
    const c = source()?.col;
    const tracks = c?.tracks() ?? [];
    if (c !== col) {
      col = c;
      seen = tracks.length;
      return;
    }
    if (tracks.length <= seen) return;
    const added = tracks.slice(seen);
    seen = tracks.length;
    untrack(() => setQueue((q) => q.concat(shuffled() ? shuffle(added.slice()) : added)));
  });
});

export function playTracks(tracks: Track[], start = 0, opts: { col?: Collection; shuffle?: boolean; radio?: boolean } = {}) {
  let q = tracks.slice();
  let i = start;
  if (opts.shuffle) {
    const first = q.splice(start, 1)[0]!;
    q = [first, ...shuffle(q)];
    i = 0;
  }
  batch(() => {
    setShuffled(!!opts.shuffle);
    setSource({ col: opts.col, radio: opts.radio });
    setQueue(q);
  });
  load(i);
  if (opts.radio && tracks.length === 1) {
    api.upNext(tracks[0]!.id).then((more) => {
      if (queue()[0]?.id !== tracks[0]!.id) return;
      setQueue((q) => q.concat(more.filter((t) => t.id !== tracks[0]!.id)));
      const n = queue()[index() + 1];
      if (n) prefetch(n.id);
    });
  }
}

export function playCollection(col: Collection, start = 0, shuffleOn = false) {
  const tracks = col.tracks();
  if (!tracks.length) return;
  if (shuffleOn) start = (Math.random() * tracks.length) | 0;
  playTracks(tracks, start, { col, shuffle: shuffleOn });
  // Let shuffle draw from the whole playlist, not just the first page.
  if (shuffleOn) col.loadAll();
}

export const jump = (i: number) => load(i);

export function toggle() {
  if (!current()) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

export function next(auto = false) {
  const q = queue();
  if (index() + 1 < q.length) load(index() + 1);
  else if (repeat() === 'all' && q.length) load(0);
  else if (auto) {
    audio.pause();
    setPlaying(false);
  }
}

export function prev() {
  if (engine.time() > 3 || index() <= 0) seek(0);
  else load(index() - 1);
}

export function seek(t: number) {
  if (!isFinite(t)) return;
  engine.seek(Math.max(0, t));
  setTime(Math.max(0, t));
}

export function setVolume(v: number) {
  v = Math.min(1, Math.max(0, v));
  audio.volume = gain(v);
  audio.muted = false;
  batch(() => (setVolumeSig(v), setMuted(false)));
  store('volpos', String(v));
}

export function toggleMute() {
  audio.muted = !audio.muted;
  setMuted(audio.muted);
}

export function cycleRepeat() {
  const n: Repeat = repeat() === 'off' ? 'all' : repeat() === 'all' ? 'one' : 'off';
  setRepeat(n);
  store('repeat', n);
}

export function toggleShuffle() {
  const q = queue();
  const i = index();
  if (!q.length) return;
  if (!shuffled()) {
    const rest = shuffle(q.slice(i + 1));
    setQueue(q.slice(0, i + 1).concat(rest));
    setShuffled(true);
  } else {
    // Restore the source order, continuing from the current track.
    const base = source()?.col?.tracks();
    const cur = q[i];
    const at = base && cur ? base.findIndex((t) => t.id === cur.id) : -1;
    if (base && at >= 0) {
      batch(() => {
        setQueue(base.slice());
        setIndex(at);
      });
    }
    setShuffled(false);
  }
}

export function removeFromQueue(i: number) {
  if (i === index()) return;
  setQueue((q) => q.filter((_, k) => k !== i));
  if (i < index()) setIndex(index() - 1);
}

// ---------- Media Session (OS media keys, lock screen, notifications) ----------

function updateSession(t: Track) {
  if (!('mediaSession' in navigator)) return;
  const art = thumb(t.thumb, 256);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artists.map((a) => a.name).join(', '),
    album: t.album?.name ?? '',
    artwork: art ? [{ src: art, sizes: '512x512' }] : [],
  });
  document.title = `${t.title} • ${t.artists[0]?.name ?? ''}`;
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('nexttrack', () => next());
  ms.setActionHandler('previoustrack', () => prev());
  ms.setActionHandler('seekto', (d) => d.seekTime != null && seek(d.seekTime));
}

export const player = {
  queue,
  index,
  current,
  playing,
  loading,
  time,
  duration,
  volume,
  muted,
  repeat,
  shuffled,
};
