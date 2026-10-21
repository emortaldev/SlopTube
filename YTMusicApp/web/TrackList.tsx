import { createMemo, createSignal, Index, onCleanup, onMount, Show, type Accessor } from 'solid-js';
import { fmtTime, prefetch, thumb, type Track } from './api';
import { Icon } from './icons';
import { player } from './player';
import { href } from './router';
import { SaveButton } from './save';

const ROW = 56;
const OVERSCAN = 6;

/**
 * Virtualised track list: only the rows in (or near) the viewport exist in the
 * DOM, and the row slots are reused as you scroll (Solid <Index>), so a
 * 5,000-song Liked Music list costs about as much as a 30-song one.
 * Events are delegated to the container — no per-row closures.
 */
export function TrackList(p: {
  tracks: Accessor<Track[]>;
  scroller: HTMLElement;
  onPlay: (i: number) => void;
  numbered?: boolean;
  hideAlbum?: boolean;
  onNearEnd?: () => void;
  /** Shows a "Remove from playlist" button on hover. */
  onRemove?: (t: Track) => void;
}) {
  let el!: HTMLDivElement;
  let offset = 0;
  const [range, setRange] = createSignal({ start: 0, end: 30 });

  const update = () => {
    const s = p.scroller;
    const n = p.tracks().length;
    const viewTop = s.scrollTop - offset;
    const start = Math.max(0, Math.floor(viewTop / ROW) - OVERSCAN);
    const end = Math.min(n, Math.ceil((viewTop + s.clientHeight) / ROW) + OVERSCAN);
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    if (p.onNearEnd && end >= n - 25) p.onNearEnd();
  };
  const measure = () => {
    offset = el.getBoundingClientRect().top - p.scroller.getBoundingClientRect().top + p.scroller.scrollTop;
    update();
  };

  onMount(() => {
    measure();
    p.scroller.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(p.scroller);
    if (el.parentElement) ro.observe(el.parentElement);
    onCleanup(() => {
      p.scroller.removeEventListener('scroll', update);
      ro.disconnect();
    });
  });

  const visible = createMemo(() => {
    const { start, end } = range();
    return p.tracks().slice(start, end);
  });

  const rowIndex = (e: Event) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
    return row ? Number(row.dataset.i) : -1;
  };

  let hoverTimer = 0;
  const onOver = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const i = rowIndex(e);
    clearTimeout(hoverTimer);
    if (i < 0) return;
    // Short dwell so a mouse sweeping across the list doesn't fire dozens of prefetches.
    hoverTimer = window.setTimeout(() => {
      const t = p.tracks()[i];
      if (t) prefetch(t.id);
    }, 70);
  };
  // Mouse: start on press rather than release — saves the ~80ms a click takes.
  // Touch/pen keep using click so scrolling never triggers playback.
  let pressed = -1;
  const onDown = (e: PointerEvent) => {
    pressed = -1;
    if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('a, button')) return;
    const i = rowIndex(e);
    if (i >= 0) {
      pressed = i;
      p.onPlay(i);
    }
  };
  const onClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    const i = rowIndex(e);
    if (i >= 0 && i !== pressed) p.onPlay(i);
    pressed = -1;
  };

  const activeId = () => player.current()?.id;

  return (
    <div
      ref={el}
      class="tracklist"
      classList={{ 'no-album': p.hideAlbum }}
      style={{ height: `${p.tracks().length * ROW}px` }}
      onPointerOver={onOver}
      onPointerDown={onDown}
      onClick={onClick}
    >
      <Index each={visible()}>
        {(t, k) => {
          const i = () => range().start + k;
          const active = () => activeId() === t().id;
          return (
            <div
              class="row"
              classList={{ active: active() }}
              data-i={i()}
              style={{ transform: `translateY(${i() * ROW}px)` }}
            >
              <div class="row-lead">
                <Show
                  when={!p.numbered}
                  fallback={<span class="row-num">{active() ? <Icon name="speaker" size={18} /> : i() + 1}</span>}
                >
                  <img src={thumb(t().thumb, 40)} width="40" height="40" loading="lazy" decoding="async" alt="" />
                  <span class="row-overlay">
                    <Icon name={active() && player.playing() ? 'speaker' : 'play'} size={20} />
                  </span>
                </Show>
              </div>
              <div class="row-title" title={t().title}>
                {t().title}
              </div>
              <div class="row-artists">
                <Artists list={t().artists} />
              </div>
              <Show when={!p.hideAlbum}>
                <div class="row-album">
                  <Show when={t().album}>
                    {(al) => (al().id ? <a href={href.album(al().id!)}>{al().name}</a> : al().name)}
                  </Show>
                </div>
              </Show>
              <div class="row-dur">
                <span>{t().duration ? fmtTime(t().duration) : ''}</span>
                <SaveButton id={t().id} size={20} class="ibtn row-save" />
                <Show when={p.onRemove}>
                  <button
                    class="ibtn row-save"
                    aria-label="Remove from playlist"
                    title="Remove from playlist"
                    onClick={() => p.onRemove!(t())}
                  >
                    <Icon name="playlistRemove" size={20} />
                  </button>
                </Show>
              </div>
            </div>
          );
        }}
      </Index>
    </div>
  );
}

export function Artists(p: { list: { name: string; id?: string }[] }) {
  return (
    <Index each={p.list}>
      {(a, k) => (
        <>
          {k > 0 && ', '}
          {a().id ? <a href={href.artist(a().id!)}>{a().name}</a> : <span>{a().name}</span>}
        </>
      )}
    </Index>
  );
}
