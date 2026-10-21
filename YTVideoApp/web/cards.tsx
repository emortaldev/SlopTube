import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { pickVideo } from '../shared/formats';
import { api, avatar, prefetch, type Card, type Page } from './api';
import { Icon } from './icons';
import { codec } from './prefs';
import { href } from './router';
import { inWatchLater, me, toggleWatchLater } from './state';

export const watchHref = (c: Card, list?: string) =>
  c.kind === 'playlist' ? href.watch(c.videoId!, c.id) : href.watch(c.id, list);

/** Delegated hover-intent prefetch: any element with data-v inside the container. */
export function hoverPrefetch(): (e: PointerEvent) => void {
  let timer = 0;
  let last = '';
  return (e) => {
    if (e.pointerType !== 'mouse') return;
    const v = (e.target as HTMLElement).closest<HTMLElement>('[data-v]')?.dataset.v ?? '';
    if (v === last) return;
    last = v;
    clearTimeout(timer);
    if (v) timer = window.setTimeout(() => prefetch(v), 120);
  };
}

/** Muted low-res playback over the thumbnail after hovering for a moment. */
function HoverPreview(p: { id: string }) {
  const [src, setSrc] = createSignal<string>();
  const [playing, setPlaying] = createSignal(false);
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    api
      .play(p.id, { codec: codec().codec, maxHeight: 360 }, ctrl.signal)
      .then((r) => {
        const f = pickVideo(r.formats, { codec: codec().codec, maxHeight: 360 });
        if (f) setSrc(`/api/stream/${p.id}/${f.itag}`);
      })
      .catch(() => {});
  }, 500);
  onCleanup(() => {
    clearTimeout(timer);
    ctrl.abort();
  });
  return (
    <Show when={src()}>
      <video
        ref={(el) =>
          onCleanup(() => {
            // Drop the connection, not just the element.
            el.removeAttribute('src');
            el.load();
          })
        }
        class="thumb-preview"
        classList={{ on: playing() }}
        src={src()}
        muted
        autoplay
        playsinline
        disablepictureinpicture
        onPlaying={() => setPlaying(true)}
      />
    </Show>
  );
}

function Thumb(p: { c: Card; class?: string; preview?: boolean }) {
  const [hover, setHover] = createSignal(false);
  const id = () => (p.preview && p.c.kind === 'video' ? p.c.id : undefined);
  return (
    <div
      class={`thumb ${p.class ?? ''}`}
      classList={{ 'thumb-stack': p.c.kind === 'playlist' }}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <img src={p.c.thumb} loading="lazy" decoding="async" alt="" />
      <Show when={hover() && id()} keyed>
        {(v) => <HoverPreview id={v} />}
      </Show>
      <Show when={p.c.duration ?? p.c.badge}>
        <span class="badge">{p.c.duration ?? p.c.badge}</span>
      </Show>
    </div>
  );
}

const Meta = (p: { c: Card }) => (
  <>
    {p.c.views}
    {p.c.views && p.c.published ? ' • ' : ''}
    {p.c.published}
  </>
);

function ChannelLink(p: { c: Card }) {
  return (
    <Show when={p.c.channel} fallback={null}>
      {(ch) => (ch().id ? <a class="ch-link" href={href.channel(ch().id!)}>{ch().name}</a> : <span>{ch().name}</span>)}
    </Show>
  );
}

/** Hover button on thumbnails (kept outside the link so it never navigates). */
function WatchLaterButton(p: { c: Card }) {
  return (
    <Show when={p.c.kind === 'video' && me()?.loggedIn}>
      <button
        class="wl-btn"
        classList={{ on: inWatchLater(p.c.id) }}
        title={inWatchLater(p.c.id) ? 'Remove from Watch later' : 'Watch later'}
        onClick={() => toggleWatchLater(p.c.id)}
      >
        <Icon name={inWatchLater(p.c.id) ? 'check' : 'clock'} size={20} />
      </button>
    </Show>
  );
}

/** Home / subscriptions / channel grid card. */
export function GridCard(p: { c: Card }) {
  const c = p.c;
  return (
    <div class="gcard" data-v={c.videoId ?? c.id}>
      <div class="thumb-wrap">
        <a href={watchHref(c)} class="gcard-thumb">
          <Thumb c={c} preview />
        </a>
        <WatchLaterButton c={c} />
      </div>
      <div class="gcard-info">
        <Show when={c.channel?.avatar && c.channel.id}>
          <a href={href.channel(c.channel!.id!)} class="avatar-link">
            <img class="avatar" src={avatar(c.channel!.avatar, 36)} width="36" height="36" loading="lazy" alt="" />
          </a>
        </Show>
        <div class="gcard-text">
          <a href={watchHref(c)} class="title2" title={c.title}>
            {c.title}
          </a>
          <div class="meta">
            <ChannelLink c={c} />
          </div>
          <div class="meta">
            <Meta c={c} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Watch-page sidebar card. */
export function CompactCard(p: { c: Card; list?: string; active?: boolean; index?: number }) {
  const c = p.c;
  return (
    <a href={watchHref(c, p.list)} class="ccard" classList={{ active: p.active }} data-v={c.videoId ?? c.id}>
      <Show when={p.index !== undefined}>
        <span class="ccard-idx">{p.active ? '▶' : p.index! + 1}</span>
      </Show>
      <Thumb c={c} class="thumb-sm" />
      <div class="ccard-text">
        <div class="title2 small" title={c.title}>
          {c.title}
        </div>
        <div class="meta small">{c.channel?.name}</div>
        <Show when={c.views || c.published}>
          <div class="meta small">
            <Meta c={c} />
          </div>
        </Show>
      </div>
    </a>
  );
}

/** Search-results row. */
export function ListCard(p: { c: Card }) {
  const c = p.c;
  return (
    <div class="lcard" data-v={c.videoId ?? c.id}>
      <div class="thumb-wrap lcard-thumb">
        <a href={watchHref(c)}>
          <Thumb c={c} preview />
        </a>
        <WatchLaterButton c={c} />
      </div>
      <div class="lcard-text">
        <a href={watchHref(c)} class="title2 large" title={c.title}>
          {c.title}
        </a>
        <div class="meta small">
          <Meta c={c} />
        </div>
        <div class="lcard-ch">
          <Show when={c.channel?.avatar}>
            <img class="avatar" src={avatar(c.channel!.avatar, 24)} width="24" height="24" loading="lazy" alt="" />
          </Show>
          <span class="meta">
            <ChannelLink c={c} />
          </span>
        </div>
        <Show when={c.snippet}>
          <div class="meta small snippet">{c.snippet}</div>
        </Show>
      </div>
    </div>
  );
}

/** Calls `onVisible` whenever this element comes within `margin` of the viewport. */
export function Sentinel(p: { onVisible: () => void; margin?: string }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && p.onVisible(), {
      rootMargin: p.margin ?? '1200px 0px',
    });
    io.observe(el);
    onCleanup(() => io.disconnect());
  });
  return <div ref={el} class="sentinel" />;
}

export const Spinner = () => <div class="spinner" aria-label="Loading" />;

/** A continuation-paged list of cards. */
export function createFeed(first: () => Promise<Page>, more: (t: string) => Promise<Page>) {
  const [items, setItems] = createSignal<Card[]>([]);
  const [cont, setCont] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  let busy = false;
  let seen = new Set<string>();
  const add = (p: Page) => {
    const fresh = p.items.filter((c) => !seen.has(c.id) && seen.add(c.id));
    setItems((x) => x.concat(fresh));
    setCont(p.cont);
  };
  first()
    .then(add, (e) => setError(e.message))
    .finally(() => setLoading(false));
  const loadMore = () => {
    const t = cont();
    if (!t || busy) return;
    busy = true;
    setLoading(true);
    more(t)
      .then(add, () => setCont(undefined))
      .finally(() => {
        busy = false;
        setLoading(false);
      });
  };
  return { items, cont, loading, error, loadMore };
}

export function FeedGrid(p: { feed: ReturnType<typeof createFeed>; empty?: JSX.Element }) {
  return (
    <>
      <Show when={p.feed.error()}>
        <div class="empty">{p.feed.error()}</div>
      </Show>
      <div class="grid" onPointerOver={hoverPrefetch()}>
        <For each={p.feed.items()}>{(c) => <GridCard c={c} />}</For>
      </div>
      <Show when={!p.feed.loading() && !p.feed.items().length && !p.feed.error()}>{p.empty}</Show>
      <Show when={p.feed.loading()}>
        <Spinner />
      </Show>
      <Show when={p.feed.cont()}>
        <Sentinel onVisible={p.feed.loadMore} />
      </Show>
    </>
  );
}
