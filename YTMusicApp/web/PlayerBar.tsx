import { createSignal, Show } from 'solid-js';
import { fmtTime, thumb } from './api';
import { Icon } from './icons';
import {
  cycleRepeat,
  jump,
  next,
  player,
  prev,
  seek,
  setVolume,
  toggle,
  toggleMute,
  toggleShuffle,
} from './player';
import { href } from './router';
import { LikeButtons, SaveButton } from './save';
import { Artists, TrackList } from './TrackList';

export function PlayerBar(p: { queueOpen: boolean; onToggleQueue: () => void }) {
  const [drag, setDrag] = createSignal<number | null>(null);
  let bar!: HTMLDivElement;

  const dur = () => player.duration() || player.current()?.duration || 0;
  const frac = () => drag() ?? (dur() ? Math.min(1, player.time() / dur()) : 0);
  const fracAt = (x: number) => {
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / r.width));
  };

  return (
    <footer class="player" classList={{ idle: !player.current() }}>
      <div
        ref={bar}
        class="progress"
        classList={{ dragging: drag() !== null }}
        onPointerDown={(e) => {
          if (!player.current()) return;
          bar.setPointerCapture(e.pointerId);
          setDrag(fracAt(e.clientX));
        }}
        onPointerMove={(e) => drag() !== null && setDrag(fracAt(e.clientX))}
        onPointerUp={() => {
          const f = drag();
          if (f !== null) seek(f * dur());
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <div class="progress-track" />
        <div class="progress-fill" style={{ transform: `scaleX(${frac()})` }} />
        <div class="progress-knob-pos" style={{ transform: `translateX(${frac() * 100}%)` }}>
          <div class="progress-knob" />
        </div>
      </div>

      <div class="pl-left">
        <button class="ibtn" onClick={prev} aria-label="Previous">
          <Icon name="prev" />
        </button>
        <button class="ibtn ibtn-play" onClick={toggle} aria-label={player.playing() ? 'Pause' : 'Play'}>
          <Show when={player.loading() && player.current()} fallback={<Icon name={player.playing() ? 'pause' : 'play'} size={36} />}>
            <div class="spinner spinner-sm" />
          </Show>
        </button>
        <button class="ibtn" onClick={() => next()} aria-label="Next">
          <Icon name="next" />
        </button>
        <span class="pl-time">
          {fmtTime(drag() !== null ? drag()! * dur() : player.time())} / {fmtTime(dur())}
        </span>
      </div>

      <div class="pl-mid">
        <Show when={player.current()}>
          {(t) => (
            <>
              <img class="pl-art" src={thumb(t().thumb, 40)} width="40" height="40" alt="" />
              <div class="pl-meta">
                <div class="pl-title" title={t().title}>
                  {t().title}
                </div>
                <div class="pl-sub">
                  <Artists list={t().artists} />
                  <Show when={t().album}>
                    {(al) => (
                      <>
                        {' • '}
                        {al().id ? <a href={href.album(al().id!)}>{al().name}</a> : al().name}
                      </>
                    )}
                  </Show>
                </div>
              </div>
              <div class="pl-actions">
                <LikeButtons id={t().id} />
                <SaveButton id={t().id} />
              </div>
            </>
          )}
        </Show>
      </div>

      <div class="pl-right">
        <div class="vol">
          <button class="ibtn" onClick={toggleMute} aria-label="Mute">
            <Icon name={player.muted() || player.volume() === 0 ? 'volumeOff' : 'volume'} />
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={player.muted() ? 0 : player.volume()}
            style={{ '--v': `${(player.muted() ? 0 : player.volume()) * 100}%` }}
            onInput={(e) => setVolume(Number(e.currentTarget.value))}
            aria-label="Volume"
          />
        </div>
        <button
          class="ibtn"
          classList={{ on: player.repeat() !== 'off' }}
          onClick={cycleRepeat}
          aria-label={`Repeat ${player.repeat()}`}
        >
          <Icon name={player.repeat() === 'one' ? 'repeatOne' : 'repeat'} />
        </button>
        <button class="ibtn" classList={{ on: player.shuffled() }} onClick={toggleShuffle} aria-label="Shuffle">
          <Icon name="shuffle" />
        </button>
        <button class="ibtn" classList={{ on: p.queueOpen }} onClick={p.onToggleQueue} aria-label="Queue">
          <Icon name="queue" />
        </button>
      </div>
    </footer>
  );
}

export function QueuePanel(p: { onClose: () => void }) {
  const [el, setEl] = createSignal<HTMLElement>();
  return (
    <aside class="queue" ref={setEl}>
      <div class="queue-head">
        <h3>Up next</h3>
        <button class="ibtn" onClick={p.onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <Show when={player.queue().length} fallback={<div class="empty">Nothing queued.</div>}>
        <Show when={el()}>
          {(s) => <TrackList tracks={player.queue} scroller={s()} hideAlbum onPlay={jump} />}
        </Show>
      </Show>
    </aside>
  );
}
