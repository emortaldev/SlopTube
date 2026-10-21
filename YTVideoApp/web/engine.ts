import type { Fmt } from '../shared/formats';
import { parseIndex, type Seg } from './container';

/**
 * DASH playback over MediaSource with one SourceBuffer per stream.
 *
 *  - Segment table comes from the WebM Cues / MP4 sidx at the start of each
 *    file, so seeking fetches exactly the segment needed.
 *  - Bytes are appended as they arrive (not per whole segment), so the first
 *    frame shows as soon as the first ~100 KB of video is in.
 *  - Only AHEAD seconds ahead / BEHIND seconds behind the playhead are kept,
 *    bounding memory regardless of video length.
 *  - Quality can change mid-play: either at the buffer's end (cheap, used when
 *    the tab is hidden) or replacing everything ahead of the playhead.
 */

const AHEAD = 30;
/** Media errors (e.g. a decoder failing on a mid-stream resolution change) rebuild the pipeline this many times per video. */
const MAX_RECOVERIES = 3;
const BEHIND = 15;
const APPEND_CHUNK = 192 * 1024;
/** Enough for init + index of almost any file; parseIndex asks for more if needed. */
const HEAD = { video: 96 * 1024, audio: 64 * 1024 };
/** Smaller appends until playback starts, so the first frame decodes sooner. */
const FIRST_CHUNK = 32 * 1024;

type Media = { fmt: Fmt; init: Uint8Array; segs: Seg[]; duration: number; head?: Uint8Array };

class Lane {
  sb!: SourceBuffer;
  media!: Media;
  mime = '';
  next = 0;
  initDone = false;
  done = false;
  gen = 0;
  ctrl = new AbortController();
  pumping = false;
  again = false;
  failures = 0;
  constructor(readonly kind: 'video' | 'audio') {}
}

const once = (t: EventTarget, ev: string) => new Promise<void>((r) => t.addEventListener(ev, () => r(), { once: true }));

export class Engine {
  private ms = new MediaSource();
  private url = URL.createObjectURL(this.ms);
  private recoveries = 0;
  /** Whether playback should be running. el.paused can already be true when 'error' fires, with no 'pause' event. */
  private wantPlay = false;
  private onPlay = () => (this.wantPlay = true);
  private onPause = () => (this.wantPlay = false);
  private video = new Lane('video');
  private audio = new Lane('audio');
  private dead = false;
  private onTime = () => this.pumpAll();
  /** Any seek (ours, media keys, devtools) lands here: refetch if the target isn't buffered. */
  private onSeeking = () => {
    const t = this.el.currentTime;
    if (!this.video.media || (this.buffered(this.video, t) && this.buffered(this.audio, t))) return this.pumpAll();
    for (const lane of [this.video, this.audio]) {
      this.reset(lane);
      lane.next = segAt(lane.media.segs, t);
    }
    this.pumpAll();
  };
  /**
   * Once the element has errored every append throws, so playback can't continue
   * on this MediaSource. Rebuild it and resume from the same position, refetching
   * only what's needed (the HTTP cache usually has it).
   */
  private onMediaError = () => {
    if (this.dead || !this.video.media || !this.el.error) return;
    if (++this.recoveries > MAX_RECOVERIES) {
      this.onError?.(new Error(this.el.error.message || 'Playback failed'));
      return;
    }
    const t = this.el.currentTime;
    const resume = this.wantPlay;
    for (const lane of [this.video, this.audio]) {
      lane.gen++;
      lane.ctrl.abort();
      lane.ctrl = new AbortController();
      lane.initDone = false;
      lane.done = false;
      lane.failures = 0;
    }
    URL.revokeObjectURL(this.url);
    this.ms = new MediaSource();
    this.url = URL.createObjectURL(this.ms);
    this.el.src = this.url;
    once(this.ms, 'sourceopen').then(() => {
      if (this.dead) return;
      this.ms.duration = Math.max(this.video.media.duration, this.audio.media.duration);
      for (const lane of [this.video, this.audio]) {
        lane.sb = this.ms.addSourceBuffer(lane.mime);
        lane.next = segAt(lane.media.segs, t);
      }
      this.el.currentTime = t;
      this.pumpAll();
      if (resume) this.el.play().catch(() => {});
    });
  };
  onError?: (e: Error) => void;

  constructor(
    readonly el: HTMLVideoElement,
    readonly id: string,
  ) {
    el.src = this.url;
    el.addEventListener('timeupdate', this.onTime);
    el.addEventListener('seeking', this.onSeeking);
    el.addEventListener('error', this.onMediaError);
    el.addEventListener('play', this.onPlay);
    el.addEventListener('pause', this.onPause);
  }

  get videoFormat() {
    return this.video.media?.fmt;
  }

  private streamUrl(f: Fmt) {
    return `/api/stream/${this.id}/${f.itag}`;
  }

  private async loadMedia(f: Fmt, headBytes: number, signal?: AbortSignal): Promise<Media> {
    const get = async (n: number) => {
      const res = await fetch(this.streamUrl(f), { headers: { range: `bytes=0-${Math.min(n, f.size) - 1}` }, signal });
      if (res.status !== 206) throw new Error('stream ' + res.status);
      return new Uint8Array(await res.arrayBuffer());
    };
    let buf = await get(headBytes);
    let idx = parseIndex(buf, f.size, f.mime);
    if ('need' in idx) {
      buf = await get(idx.need);
      idx = parseIndex(buf, f.size, f.mime);
      if ('need' in idx) throw new Error('index too large');
    }
    return { fmt: f, init: buf.slice(0, idx.initEnd), segs: idx.segs, duration: idx.duration, head: buf };
  }

  async start(v: Fmt, a: Fmt, at = 0) {
    const [vm, am] = await Promise.all([
      this.loadMedia(v, HEAD.video),
      this.loadMedia(a, HEAD.audio),
      once(this.ms, 'sourceopen'),
    ]);
    if (this.dead) return;
    this.ms.duration = Math.max(vm.duration, am.duration);
    for (const [lane, m] of [
      [this.video, vm],
      [this.audio, am],
    ] as const) {
      lane.media = m;
      lane.mime = m.fmt.mime;
      lane.sb = this.ms.addSourceBuffer(m.fmt.mime);
      lane.next = segAt(m.segs, at);
    }
    if (at) this.el.currentTime = at;
    this.pumpAll();
  }

  seek(t: number) {
    this.el.currentTime = Math.max(0, Math.min(t, (this.ms.duration || 0) - 0.1)); // → onSeeking
  }

  /**
   * Switch video quality. `replaceAhead`: drop buffered video after the
   * playhead and refetch at the new quality (visible upgrade within ~1s);
   * otherwise new data starts where the buffer currently ends.
   */
  async setVideo(f: Fmt, replaceAhead: boolean) {
    const lane = this.video;
    if (!lane.media || lane.media.fmt.itag === f.itag) return;
    const m = await this.loadMedia(f, 64 * 1024);
    if (this.dead) return;
    this.reset(lane);
    const myGen = lane.gen;
    await idle(lane.sb);
    if (myGen !== lane.gen) return;
    if (f.mime !== lane.mime) {
      lane.sb.changeType(f.mime);
      lane.mime = f.mime;
    }
    lane.media = m;
    const ct = this.el.currentTime;
    let from: number;
    if (replaceAhead) {
      from = ct + 1;
      if (this.ms.readyState === 'open' && this.ms.duration > from) {
        lane.sb.remove(from, this.ms.duration);
        await idle(lane.sb);
      }
    } else {
      from = this.bufferedEnd(lane, ct) ?? ct;
    }
    lane.next = segAt(m.segs, from);
    this.pump(lane);
  }

  destroy() {
    this.dead = true;
    for (const l of [this.video, this.audio]) {
      l.gen++;
      l.ctrl.abort();
    }
    this.el.removeEventListener('timeupdate', this.onTime);
    this.el.removeEventListener('seeking', this.onSeeking);
    this.el.removeEventListener('error', this.onMediaError);
    this.el.removeEventListener('play', this.onPlay);
    this.el.removeEventListener('pause', this.onPause);
    this.el.removeAttribute('src');
    this.el.load();
    URL.revokeObjectURL(this.url);
  }

  // ---------- internals ----------

  private reset(lane: Lane) {
    lane.gen++;
    lane.ctrl.abort();
    lane.ctrl = new AbortController();
    lane.initDone = false; // abort() resets the parser: resend the init segment
    lane.done = false;
    if (this.ms.readyState === 'open' && lane.sb) {
      try {
        lane.sb.abort();
      } catch {}
    }
  }

  private range(lane: Lane, t: number): [number, number] | null {
    const b = lane.sb?.buffered;
    if (!b) return null;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.05 && t < b.end(i)) return [b.start(i), b.end(i)];
    return null;
  }
  private buffered = (lane: Lane, t: number) => !!this.range(lane, t);
  private bufferedEnd = (lane: Lane, t: number) => this.range(lane, t)?.[1];

  private pumpAll() {
    if (this.dead || !this.video.media) return;
    this.pump(this.video);
    this.pump(this.audio);
  }

  private pump(lane: Lane) {
    if (lane.pumping) {
      lane.again = true;
      return;
    }
    lane.pumping = true;
    this.feed(lane, lane.gen)
      .then(() => (lane.failures = 0))
      .catch((e) => {
        if ((e as Error).name === 'AbortError' || this.dead || this.el.error) return;
        // Network blips / server restarts: retry with backoff before giving up.
        if (++lane.failures <= 6) setTimeout(() => this.pump(lane), 500 * lane.failures);
        else this.onError?.(e as Error);
      })
      .finally(() => {
        lane.pumping = false;
        if (lane.again) {
          lane.again = false;
          this.pump(lane);
        }
      });
  }

  private async append(lane: Lane, data: Uint8Array, gen: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await idle(lane.sb);
      if (gen !== lane.gen || this.dead) return false;
      try {
        lane.sb.appendBuffer(data as BufferSource);
        await idle(lane.sb);
        return gen === lane.gen;
      } catch (e) {
        if ((e as Error).name !== 'QuotaExceededError') throw e;
        await this.trim(lane, gen, 3);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return false;
  }

  private async trim(lane: Lane, gen: number, keep = BEHIND) {
    const b = lane.sb.buffered;
    if (!b.length) return;
    const cut = this.el.currentTime - keep;
    if (cut - b.start(0) < 5) return;
    await idle(lane.sb);
    if (gen !== lane.gen) return;
    lane.sb.remove(0, cut);
    await idle(lane.sb);
  }

  private async feed(lane: Lane, gen: number) {
    while (gen === lane.gen && !this.dead) {
      if (this.ms.readyState === 'closed') return;
      await this.trim(lane, gen);
      const m = lane.media;
      const seg = m.segs[lane.next];
      if (!seg) {
        lane.done = true;
        await this.maybeEnd();
        return;
      }
      if (seg.t - this.el.currentTime > AHEAD) return;
      if (!lane.initDone) {
        if (!(await this.append(lane, m.init, gen))) return;
        lane.initDone = true;
      }
      const end = m.segs[lane.next + 1]?.t ?? m.duration;
      const r = this.range(lane, seg.t + 0.05);
      if (r && r[1] >= end - 0.05) {
        lane.next++;
        continue;
      }
      if (!(await this.stream(lane, seg.start, seg.end, gen))) return;
      lane.next++;
    }
  }

  /** Append bytes [from, to): cached head first, then the network, chunk by chunk as it arrives. */
  private async stream(lane: Lane, from: number, to: number, gen: number): Promise<boolean> {
    const head = lane.media.head;
    let pos = from;
    if (head && pos < head.length) {
      const end = Math.min(head.length, to);
      if (!(await this.append(lane, head.subarray(pos, end), gen))) return false;
      pos = end;
    }
    if (pos >= to) return true;
    const res = await fetch(this.streamUrl(lane.media.fmt), {
      headers: { range: `bytes=${pos}-${to - 1}` },
      signal: lane.ctrl.signal,
    });
    if (res.status !== 206 || !res.body) throw new Error('segment ' + res.status);
    const reader = res.body.getReader();
    let parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        parts.push(value);
        n += value.length;
      }
      const threshold = this.el.readyState >= 3 ? APPEND_CHUNK : FIRST_CHUNK;
      if (n && (done || n >= threshold)) {
        const buf = parts.length === 1 ? parts[0]! : concat(parts, n);
        parts = [];
        n = 0;
        if (!(await this.append(lane, buf, gen))) {
          reader.cancel().catch(() => {});
          return false;
        }
      }
      if (done) return true;
    }
  }

  private async maybeEnd() {
    if (!this.video.done || !this.audio.done || this.ms.readyState !== 'open') return;
    await Promise.all([idle(this.video.sb), idle(this.audio.sb)]);
    if (this.ms.readyState === 'open' && this.video.done && this.audio.done) {
      try {
        this.ms.endOfStream();
      } catch {}
    }
  }
}

function segAt(segs: Seg[], t: number) {
  let i = segs.length - 1;
  while (i > 0 && segs[i]!.t > t + 0.01) i--;
  return i;
}

async function idle(sb: SourceBuffer | undefined) {
  while (sb?.updating) await once(sb, 'updateend');
}

function concat(parts: Uint8Array[], n: number) {
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
