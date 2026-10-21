import { batch, createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { heights, lowestVideo, pickAudio, pickVideo, type Fmt, type Prefs } from '../shared/formats';
import { api, fmtTime, type Card, type Details, type Storyboard } from './api';
import { Engine } from './engine';
import { Icon } from './icons';
import {
  autoHeight,
  autoplay,
  codec,
  codecMode,
  codecReady,
  detected,
  gain,
  quality,
  setAutoplay,
  setCodecMode,
  setQuality,
  setVolume,
  volume,
  type CodecMode,
} from './prefs';

const UP_NEXT_SECONDS = 5;

export function Player(p: {
  id: string;
  startAt?: number;
  upNext?: Card;
  onNext: () => void;
  onDetails?: (d: Details) => void;
}) {
  let el!: HTMLVideoElement;
  let box!: HTMLDivElement;
  let bar!: HTMLDivElement;
  let menuWrap!: HTMLDivElement;
  let engine: Engine | null = null;

  const [formats, setFormats] = createSignal<Fmt[]>([]);
  const [current, setCurrent] = createSignal<Fmt>();
  const [playing, setPlaying] = createSignal(false);
  const [waiting, setWaiting] = createSignal(true);
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [bufEnd, setBufEnd] = createSignal(0);
  const [muted, setMuted] = createSignal(false);
  const [error, setError] = createSignal('');
  const [needsTap, setNeedsTap] = createSignal(false);
  const [active, setActive] = createSignal(true);
  const [menu, setMenu] = createSignal(false);
  const [fs, setFs] = createSignal(false);
  const [drag, setDrag] = createSignal<number | null>(null);
  const [hover, setHover] = createSignal<number | null>(null);
  const [board, setBoard] = createSignal<Storyboard>();
  const [countdown, setCountdown] = createSignal<number | null>(null);
  const [flash, setFlash] = createSignal<{ icon: 'play' | 'pause' } | null>(null);

  const prefs = (): Prefs => {
    const q = quality();
    return { codec: codec().codec, maxHeight: q === 'auto' ? autoHeight(box?.clientHeight || 720) : q };
  };

  // ---------- lifecycle per video ----------

  createEffect(
    on(
      () => p.id,
      (id) => {
        const ctrl = new AbortController();
        batch(() => {
          setFormats([]);
          setBoard(undefined);
          setCurrent(undefined);
          setError('');
          setTime(0);
          setBufEnd(0);
          setWaiting(true);
          setCountdown(null);
          setNeedsTap(false);
        });
        // A view counts after 5s played from wherever playback started (set once known).
        let marked = false;
        let markAt = Infinity;
        const mark = () => {
          if (!marked && el.currentTime >= markAt) {
            marked = true;
            api.watched(id);
          }
        };
        // Watch progress for YouTube's resume point / red bar, once the view counts.
        // Each report covers only what was actually played since the last one.
        let spanStart = 0;
        let lastPos = 0; // last position before any seek
        let sentEnd = -1;
        const report = (end = el.currentTime, ended = false) => {
          if (!marked || end < spanStart || (!ended && end === sentEnd)) return;
          api.progress(id, spanStart, end, ended);
          sentEnd = end;
          spanStart = end;
        };
        const track = () => !el.seeking && (lastPos = el.currentTime);
        const reportNow = () => report();
        const onSeeking = () => {
          report(lastPos); // close the span played before the jump
          spanStart = lastPos = el.currentTime;
        };
        const reportEnd = () => report(el.duration || duration(), true);
        const tick = setInterval(() => !el.paused && report(), 30_000);
        el.addEventListener('timeupdate', mark);
        el.addEventListener('timeupdate', track);
        el.addEventListener('pause', reportNow);
        el.addEventListener('seeking', onSeeking);
        el.addEventListener('seeked', reportNow);
        el.addEventListener('ended', reportEnd);
        addEventListener('pagehide', reportNow);
        codecReady
          .then(() => api.play(id, prefs(), ctrl.signal))
          .then(async ({ formats: fmts, details, resume }) => {
            if (ctrl.signal.aborted) return;
            const v = pickVideo(fmts, prefs());
            const a = pickAudio(fmts);
            if (!v || !a) throw new Error('No playable streams for this video');
            p.onDetails?.(details);
            setFormats(fmts);
            setCurrent(v);
            setDuration(details.lengthSeconds);
            setBoard(details.storyboard);
            const e = new Engine(el, id);
            engine = e;
            e.onError = (err) => setError(err.message);
            // An explicit ?t= wins; otherwise resume like youtube.com, unless (nearly) finished.
            const at = p.startAt ?? (resume && resume < details.lengthSeconds - 10 ? resume : 0);
            spanStart = lastPos = at;
            markAt = at + 5;
            el.play().catch((err) => err.name === 'NotAllowedError' && setNeedsTap(true));
            await e.start(v, a, at);
          })
          .catch((err) => !ctrl.signal.aborted && setError(err.message));
        onCleanup(() => {
          report(); // leaving this video
          clearInterval(tick);
          el.removeEventListener('timeupdate', track);
          el.removeEventListener('pause', reportNow);
          el.removeEventListener('seeking', onSeeking);
          el.removeEventListener('seeked', reportNow);
          el.removeEventListener('ended', reportEnd);
          removeEventListener('pagehide', reportNow);
          ctrl.abort();
          el.removeEventListener('timeupdate', mark);
          engine?.destroy();
          engine = null;
        });
      },
    ),
  );

  const switchTo = (f: Fmt | undefined, replaceAhead: boolean) => {
    if (!f || !engine || current()?.itag === f.itag) return;
    setCurrent(f);
    engine.setVideo(f, replaceAhead).catch(() => {});
  };

  // Auto quality follows player size (e.g. entering fullscreen upgrades).
  const reevaluate = () => {
    if (quality() !== 'auto' || !formats().length || document.hidden) return;
    const want = pickVideo(formats(), prefs());
    const cur = current();
    if (want && cur && want.height !== cur.height) switchTo(want, want.height > cur.height);
  };

  // Background tab: after 5s hidden, fetch 144p video (audio unaffected). Restore on return.
  let hiddenTimer = 0;
  let lowered = false;
  const onVisibility = () => {
    clearTimeout(hiddenTimer);
    if (document.hidden) {
      hiddenTimer = window.setTimeout(() => {
        if (!formats().length) return;
        lowered = true;
        switchTo(lowestVideo(formats(), codec().codec), false);
      }, 5000);
    } else {
      setTime(el.currentTime);
      if (lowered) {
        lowered = false;
        switchTo(pickVideo(formats(), prefs()), true);
      }
    }
  };

  // ---------- element events ----------

  onMount(() => {
    el.volume = gain(volume());
    const on_ = (ev: string, fn: () => void) => el.addEventListener(ev, fn);
    on_('play', () => setPlaying(true));
    on_('pause', () => setPlaying(false));
    on_('playing', () => batch(() => (setWaiting(false), setNeedsTap(false))));
    on_('waiting', () => setWaiting(true));
    on_('canplay', () => setWaiting(false));
    on_('durationchange', () => isFinite(el.duration) && setDuration(el.duration));
    on_('timeupdate', () => {
      if (document.hidden) return;
      batch(() => {
        setTime(el.currentTime);
        const b = el.buffered;
        for (let i = 0; i < b.length; i++) if (el.currentTime >= b.start(i) - 0.1 && el.currentTime <= b.end(i)) setBufEnd(b.end(i));
      });
    });
    on_('ended', () => {
      setPlaying(false);
      if (autoplay() && p.upNext) setCountdown(UP_NEXT_SECONDS);
    });
    on_('volumechange', () => setMuted(el.muted));

    const onFs = () => {
      setFs(document.fullscreenElement === box);
      requestAnimationFrame(reevaluate);
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('visibilitychange', onVisibility);
    const ro = new ResizeObserver(() => reevaluate());
    ro.observe(box);

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'k') toggle();
      else if (k === 'j') seekBy(-10);
      else if (k === 'l') seekBy(10);
      else if (e.key === 'ArrowLeft') seekBy(-5);
      else if (e.key === 'ArrowRight') seekBy(5);
      else if (e.key === 'ArrowUp') setVol(volume() + 0.05);
      else if (e.key === 'ArrowDown') setVol(volume() - 0.05);
      else if (k === 'f') toggleFs();
      else if (k === 'm') el.muted = !el.muted;
      else if (e.key === 'N' && e.shiftKey) p.onNext();
      else if (/^[0-9]$/.test(e.key)) seekTo((Number(e.key) / 10) * dur());
      else return;
      e.preventDefault();
      poke();
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onKey);
      ro.disconnect();
      clearTimeout(hiddenTimer);
      clearTimeout(idleTimer);
    });
  });

  // Close the settings menu on any press outside it. The video's own click handler
  // closes it there, so playback doesn't also toggle.
  createEffect(() => {
    if (!menu()) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuWrap.contains(t) && t !== el) setMenu(false);
    };
    document.addEventListener('pointerdown', onDown);
    onCleanup(() => document.removeEventListener('pointerdown', onDown));
  });

  // Up-next countdown.
  createEffect(() => {
    const c = countdown();
    if (c === null) return;
    if (c <= 0) {
      setCountdown(null);
      p.onNext();
      return;
    }
    const t = setTimeout(() => setCountdown(c - 1), 1000);
    onCleanup(() => clearTimeout(t));
  });

  // ---------- actions ----------

  const dur = () => duration() || el?.duration || 0;
  const toggle = () => {
    // Fresh object each time so the keyed <Show> remounts and restarts the animation.
    setFlash({ icon: el.paused ? 'play' : 'pause' });
    if (el.paused) {
      setCountdown(null);
      el.play().catch(() => {});
    } else el.pause();
  };
  const seekTo = (t: number) => {
    setTime(t);
    engine?.seek(t);
  };
  const seekBy = (d: number) => seekTo(Math.max(0, Math.min(dur(), el.currentTime + d)));
  const setVol = (v: number) => {
    setVolume(v);
    el.volume = gain(volume());
    el.muted = false;
  };
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else box.requestFullscreen().catch(() => {});
  };

  let idleTimer = 0;
  const poke = () => {
    setActive(true);
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => !menu() && setActive(false), 2500);
  };

  /** Tip x within the bar, kept inside it so the frame never overflows the player. */
  const tipLeft = () => {
    const w = bar?.clientWidth ?? 0;
    const half = (board()?.w ?? 40) / 2;
    return Math.max(half, Math.min(w - half, hover()! * w));
  };
  const frameStyle = (b: Storyboard, t: number) => {
    const i = Math.min(b.count - 1, Math.max(0, Math.floor(b.interval ? (t * 1000) / b.interval : (t / (dur() || 1)) * b.count)));
    const per = b.cols * b.rows;
    const n = i % per;
    return {
      width: `${b.w}px`,
      height: `${b.h}px`,
      'background-image': `url("${b.url.replace('$M', String(Math.floor(i / per)))}")`,
      'background-position': `-${(n % b.cols) * b.w}px -${Math.floor(n / b.cols) * b.h}px`,
    };
  };
  const fracAt = (x: number) => {
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / r.width));
  };
  const shown = () => drag() ?? (dur() ? time() / dur() : 0);

  const qualityLabel = (f?: Fmt) => (f ? `${f.height}p${f.fps > 30 ? f.fps : ''}` : '');

  return (
    <div
      ref={box}
      class="player"
      classList={{ idle: playing() && !active() && !menu(), fs: fs() }}
      onPointerMove={poke}
      onPointerLeave={() => playing() && setActive(false)}
    >
      <video
        ref={el}
        class="video"
        playsinline
        onClick={() => (menu() ? setMenu(false) : toggle())}
        onDblClick={toggleFs}
      />

      <Show when={waiting() && !error() && !needsTap() && countdown() === null}>
        <div class="p-spinner" />
      </Show>
      <Show when={flash()} keyed>
        {(f) => (
          <div class="p-flash" onAnimationEnd={() => setFlash(null)}>
            <Icon name={f.icon} size={36} />
          </div>
        )}
      </Show>
      <Show when={needsTap()}>
        <button class="p-bigplay" onClick={toggle} aria-label="Play">
          <Icon name="play" size={40} />
        </button>
      </Show>
      <Show when={error()}>
        <div class="p-error">
          <p>{error()}</p>
        </div>
      </Show>
      <Show when={countdown() !== null && p.upNext}>
        <div class="p-upnext">
          <div class="p-upnext-label">Up next in {countdown()}</div>
          <img src={p.upNext!.thumb} alt="" />
          <div class="p-upnext-title">{p.upNext!.title}</div>
          <div class="p-upnext-ch">{p.upNext!.channel?.name}</div>
          <div class="p-upnext-actions">
            <button class="pill" onClick={() => setCountdown(null)}>
              Cancel
            </button>
            <button class="pill pill-light" onClick={() => (setCountdown(null), p.onNext())}>
              Play now
            </button>
          </div>
        </div>
      </Show>

      <div class="p-controls" onClick={(e) => e.stopPropagation()}>
        <div
          ref={bar}
          class="p-bar"
          classList={{ dragging: drag() !== null }}
          onPointerDown={(e) => {
            bar.setPointerCapture(e.pointerId);
            setDrag(fracAt(e.clientX));
          }}
          onPointerMove={(e) => {
            setHover(fracAt(e.clientX));
            if (drag() !== null) setDrag(fracAt(e.clientX));
          }}
          onPointerLeave={() => setHover(null)}
          onPointerUp={() => {
            const f = drag();
            if (f !== null) seekTo(f * dur());
            setDrag(null);
          }}
          onPointerCancel={() => setDrag(null)}
        >
          <div class="p-bar-track" />
          <div class="p-bar-buf" style={{ transform: `scaleX(${dur() ? Math.min(1, bufEnd() / dur()) : 0})` }} />
          <Show when={hover() !== null}>
            <div class="p-bar-hover" style={{ transform: `scaleX(${hover()})` }} />
            <div class="p-bar-tip" style={{ left: `${tipLeft()}px` }}>
              <Show when={board()}>{(b) => <div class="p-bar-frame" style={frameStyle(b(), hover()! * dur())} />}</Show>
              <span>{fmtTime(hover()! * dur())}</span>
            </div>
          </Show>
          <div class="p-bar-play" style={{ transform: `scaleX(${shown()})` }} />
          <div class="p-bar-knob-pos" style={{ transform: `translateX(${shown() * 100}%)` }}>
            <div class="p-bar-knob" />
          </div>
        </div>
        <div class="p-row">
          <button class="p-btn" onClick={toggle} aria-label={playing() ? 'Pause (k)' : 'Play (k)'}>
            <Icon name={playing() ? 'pause' : 'play'} size={28} />
          </button>
          <button class="p-btn" onClick={p.onNext} disabled={!p.upNext} aria-label="Next (Shift+N)">
            <Icon name="next" size={26} />
          </button>
          <div class="p-vol">
            <button class="p-btn" onClick={() => (el.muted = !el.muted)} aria-label="Mute (m)">
              <Icon name={muted() || volume() === 0 ? 'volumeOff' : 'volume'} size={26} />
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={muted() ? 0 : volume()}
              style={{ '--v': `${(muted() ? 0 : volume()) * 100}%` }}
              onInput={(e) => setVol(Number(e.currentTarget.value))}
              aria-label="Volume"
            />
          </div>
          <span class="p-time">
            {fmtTime(drag() !== null ? drag()! * dur() : time())} / {fmtTime(dur())}
          </span>
          <span class="p-spacer" />
          <button
            class="p-toggle"
            classList={{ on: autoplay() }}
            onClick={() => setAutoplay(!autoplay())}
            aria-label={`Autoplay is ${autoplay() ? 'on' : 'off'}`}
            title={`Autoplay is ${autoplay() ? 'on' : 'off'}`}
          >
            <span class="p-toggle-knob" />
          </button>
          <div ref={menuWrap} class="p-menu-wrap">
            <button class="p-btn" onClick={() => setMenu(!menu())} aria-label="Settings">
              <Icon name="settings" size={24} />
              <Show when={(current()?.height ?? 0) >= 720}>
                <span class="p-hd">HD</span>
              </Show>
            </button>
            <Show when={menu()}>
              <div class="p-menu">
                <div class="p-menu-head">Quality</div>
                <button classList={{ sel: quality() === 'auto' }} onClick={() => (setQuality('auto'), switchTo(pickVideo(formats(), prefs()), true), setMenu(false))}>
                  Auto <span class="dim">{quality() === 'auto' ? qualityLabel(current()) : ''}</span>
                </button>
                <For each={heights(formats())}>
                  {(h) => (
                    <button
                      classList={{ sel: quality() === h }}
                      onClick={() => {
                        setQuality(h);
                        switchTo(pickVideo(formats(), prefs()), true);
                        setMenu(false);
                      }}
                    >
                      {h}p
                    </button>
                  )}
                </For>
                <div class="p-menu-head">Codec</div>
                <For each={['auto', 'vp9', 'avc1'] as CodecMode[]}>
                  {(m) => (
                    <button
                      classList={{ sel: codecMode() === m }}
                      onClick={() => {
                        setCodecMode(m);
                        switchTo(pickVideo(formats(), prefs()), true);
                        setMenu(false);
                      }}
                    >
                      {m === 'auto' ? 'Auto' : m === 'vp9' ? 'VP9' : 'H.264'}
                      <span class="dim">{m === 'auto' ? (detected().codec === 'vp9' ? 'VP9' : 'H.264') : ''}</span>
                    </button>
                  )}
                </For>
                <div class="p-menu-foot">
                  Playing {current()?.codec === 'vp9' ? 'VP9' : 'H.264'} {qualityLabel(current())} ·{' '}
                  {codec().hardware ? 'GPU decode' : 'browser reports no GPU decode'}
                </div>
              </div>
            </Show>
          </div>
          <button class="p-btn" onClick={toggleFs} aria-label="Full screen (f)">
            <Icon name={fs() ? 'fullscreenExit' : 'fullscreen'} size={26} />
          </button>
        </div>
      </div>
    </div>
  );
}
