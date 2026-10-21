import { createEffect, createMemo, createResource, createSignal, For, Index, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { DATES, DURATIONS, FEATURES, filterCount, filterQuery, SORTS, TYPES, type SearchFilters } from '../shared/search';
import { api, avatar, type Card, type Comment, type Details, type DownloadOption, type Rating } from './api';
import { ChannelCard, CompactCard, createFeed, FeedGrid, hoverPrefetch, ListCard, Sentinel, Spinner, watchHref } from './cards';
import { Icon } from './icons';
import { Player } from './Player';
import { href, navigate } from './router';
import { afterLogin, inWatchLater, me, toggleWatchLater, watchLaterCount } from './state';

// ---------- home / subscriptions ----------

export function Home() {
  return (
    <div class="page">
      <Show when={!me.loading} fallback={<Spinner />}>
        <Show when={me()?.loggedIn} fallback={<Login />}>
          {(() => {
            // Created once: JSX props are lazy getters, so never construct the feed inline in a prop.
            const feed = createFeed(api.home, api.browseMore);
            return <FeedGrid feed={feed} empty={<div class="empty">No recommendations yet.</div>} />;
          })()}
        </Show>
      </Show>
    </div>
  );
}

export function Subscriptions() {
  const feed = createFeed(api.subscriptions, api.browseMore);
  return (
    <div class="page">
      <h2 class="page-title">Latest</h2>
      <FeedGrid feed={feed} empty={<div class="empty">No videos.</div>} />
    </div>
  );
}

function Login() {
  const [cookie, setCookie] = createSignal('');
  const [err, setErr] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.auth(cookie());
      afterLogin();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="login" onSubmit={submit}>
      <h1>Sign in to see your recommendations</h1>
      <ol>
        <li>
          Open <a href="https://www.youtube.com" target="_blank" rel="noreferrer">youtube.com</a> in this browser while
          signed in.
        </li>
        <li>
          Open DevTools (<kbd>F12</kbd>) → <b>Network</b>, filter by <code>browse</code>, and click any request.
        </li>
        <li>
          Under <b>Request Headers</b>, copy the whole value of <code>cookie</code> and paste it below.
        </li>
      </ol>
      <textarea value={cookie()} onInput={(e) => setCookie(e.currentTarget.value)} rows="5" spellcheck={false} />
      <p class="note">Stored only on this machine (cookie.txt next to the server). Search works without signing in.</p>
      <Show when={err()}>
        <p class="err">{err()}</p>
      </Show>
      <button class="pill pill-light" disabled={busy() || !cookie().includes('SAPISID')}>
        {busy() ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  );
}

// ---------- Watch later ----------

export function WatchLaterView() {
  const feed = createFeed(api.watchLater, api.browseMore);
  const [removed, setRemoved] = createSignal(new Set<string>());
  const items = () => feed.items().filter((c) => !removed().has(c.id));
  const remove = (id: string) => {
    setRemoved((s) => new Set(s).add(id));
    if (inWatchLater(id)) toggleWatchLater(id);
    else api.setWatchLater(id, false).catch(() => {});
  };
  const playFrom = (c?: Card) => c && navigate(href.watch(c.id, 'WL'));
  return (
    <div class="page pl-page" onPointerOver={hoverPrefetch()}>
      <aside class="pl-info">
        <Show when={items()[0]?.thumb} fallback={<div class="thumb pl-cover" />}>
          <div class="thumb pl-cover">
            <img src={items()[0]!.thumb} alt="" />
          </div>
        </Show>
        <h1 class="pl-title">Watch later</h1>
        <div class="meta">{watchLaterCount() || items().length} videos</div>
        <div class="pl-buttons">
          <button class="pill pill-light" disabled={!items().length} onClick={() => playFrom(items()[0])}>
            <Icon name="play" size={20} />
            Play all
          </button>
          <button
            class="pill"
            disabled={!items().length}
            onClick={() => playFrom(items()[(Math.random() * items().length) | 0])}
          >
            <Icon name="shuffle" size={20} />
            Shuffle
          </button>
        </div>
      </aside>
      <div class="pl-list">
        <For each={items()}>
          {(c, i) => (
            <div class="pl-row" data-v={c.id}>
              <span class="pl-idx">{i() + 1}</span>
              <a href={href.watch(c.id, 'WL')} class="pl-row-main">
                <div class="thumb thumb-pl">
                  <img src={c.thumb} loading="lazy" decoding="async" alt="" />
                  <span class="badge">{c.duration}</span>
                </div>
                <div class="pl-row-text">
                  <div class="title2" title={c.title}>
                    {c.title}
                  </div>
                  <div class="meta small">
                    {c.channel?.name}
                    {c.views ? ` • ${c.views}` : ''}
                    {c.published ? ` • ${c.published}` : ''}
                  </div>
                </div>
              </a>
              <button class="icon-btn pl-remove" title="Remove from Watch later" onClick={() => remove(c.id)}>
                <Icon name="close" size={20} />
              </button>
            </div>
          )}
        </For>
        <Show when={feed.loading()}>
          <Spinner />
        </Show>
        <Show when={!feed.loading() && !items().length}>
          <div class="empty">No videos in Watch later.</div>
        </Show>
        <Show when={feed.cont()}>
          <Sentinel onVisible={feed.loadMore} />
        </Show>
      </div>
    </div>
  );
}

// ---------- search ----------

export function Results(p: { q: string; f: SearchFilters }) {
  return (
    <div class="page results" onPointerOver={hoverPrefetch()}>
      <SearchFilterBar q={p.q} f={p.f} />
      {/* Keyed on query + filters so any change starts a fresh feed. */}
      <Show when={p.q && `${p.q}\n${filterQuery(p.f)}`} keyed>
        {(_key) => {
          const q = p.q;
          const f = p.f;
          const feed = createFeed(() => api.search(q, f), api.searchMore);
          return (
            <>
              <For each={feed.items()}>{(c) => (c.kind === 'channel' ? <ChannelCard c={c} /> : <ListCard c={c} />)}</For>
              <Show when={feed.loading()}>
                <Spinner />
              </Show>
              <Show when={!feed.loading() && !feed.items().length}>
                <div class="empty">No results for “{q}”.</div>
              </Show>
              <Show when={feed.cont()}>
                <Sentinel onVisible={feed.loadMore} />
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

type Single = 'date' | 'type' | 'duration' | 'sort';

function SearchFilterBar(p: { q: string; f: SearchFilters }) {
  const [open, setOpen] = createSignal(filterCount(p.f) > 0);
  const go = (f: SearchFilters) => navigate(href.results(p.q, f));
  const pickOne = <K extends Single>(k: K, v: SearchFilters[K]) =>
    go({ ...p.f, ...(k === 'date' && { after: undefined, before: undefined }), [k]: p.f[k] === v ? undefined : v });
  const toggleFeature = (x: keyof typeof FEATURES) => {
    const fs = p.f.features ?? [];
    go({ ...p.f, features: fs.includes(x) ? fs.filter((y) => y !== x) : [...fs, x] });
  };
  const setRange = (k: 'after' | 'before', v: string) => go({ ...p.f, date: undefined, [k]: v || undefined });

  const Col = (c: { title: string; children: JSX.Element }) => (
    <div class="sf-col">
      <div class="sf-head">{c.title}</div>
      {c.children}
    </div>
  );
  const Opt = (o: { sel: boolean; label: string; onClick: () => void }) => (
    <button class="sf-opt" classList={{ sel: o.sel }} onClick={o.onClick}>
      {o.label}
      <Show when={o.sel}>
        <Icon name="close" size={16} />
      </Show>
    </button>
  );
  const opts = <K extends Single>(k: K, table: Record<string, string>) => (
    <For each={Object.entries(table)}>
      {([v, label]) => <Opt sel={p.f[k] === v} label={label} onClick={() => pickOne(k, v as SearchFilters[K])} />}
    </For>
  );

  return (
    <div class="sf">
      <div class="sf-bar">
        <button class="pill" classList={{ on: open() }} onClick={() => setOpen(!open())}>
          <Icon name="tune" size={20} />
          Filters
          <Show when={filterCount(p.f)}>{(n) => <span class="sf-count">{n()}</span>}</Show>
        </button>
        <Show when={filterCount(p.f)}>
          <button class="pill" onClick={() => go({})}>
            Clear filters
          </button>
        </Show>
      </div>
      <Show when={open()}>
        <div class="sf-panel">
          <Col title="Upload date">
            {opts('date', DATES)}
            <label class="sf-date">
              <span>After</span>
              <input type="date" value={p.f.after ?? ''} max={p.f.before} onChange={(e) => setRange('after', e.currentTarget.value)} />
            </label>
            <label class="sf-date">
              <span>Before</span>
              <input type="date" value={p.f.before ?? ''} min={p.f.after} onChange={(e) => setRange('before', e.currentTarget.value)} />
            </label>
          </Col>
          <Col title="Type">{opts('type', TYPES)}</Col>
          <Col title="Duration">{opts('duration', DURATIONS)}</Col>
          <Col title="Features">
            <For each={Object.entries(FEATURES) as [keyof typeof FEATURES, string][]}>
              {([x, label]) => <Opt sel={!!p.f.features?.includes(x)} label={label} onClick={() => toggleFeature(x)} />}
            </For>
          </Col>
          <Col title="Prioritize">
            <Opt sel={!p.f.sort} label="Relevance" onClick={() => go({ ...p.f, sort: undefined })} />
            {opts('sort', SORTS)}
          </Col>
        </div>
      </Show>
    </div>
  );
}

// ---------- channel ----------

export function ChannelView(p: { id: string; q?: string }) {
  const [ch] = createResource(() => p.id, api.channel);
  return (
    <div class="page">
      <Show when={ch()} keyed fallback={ch.error ? <div class="empty">Couldn't load this channel.</div> : <Spinner />}>
        {(c) => {
          const feed = createFeed(async () => ({ items: c.videos, cont: c.cont }), api.browseMore);
          return (
            <>
              <Show when={c.banner}>
                <img class="ch-banner" src={c.banner} alt="" decoding="async" />
              </Show>
              <header class="ch-head">
                <Show when={c.avatar}>
                  <img class="avatar ch-avatar" src={avatar(c.avatar, 160)} alt="" />
                </Show>
                <div>
                  <h1 class="ch-name">{c.name}</h1>
                  <div class="meta">{c.meta.join(' • ')}</div>
                  <Show when={c.description}>
                    <p class="meta ch-desc">{c.description}</p>
                  </Show>
                </div>
              </header>
              <div class="tabs">
                <a class="tab" classList={{ on: !p.q }} href={href.channel(p.id)}>
                  Videos
                </a>
                <ChannelSearchBox id={p.id} q={p.q} />
              </div>
              <Show when={p.q} keyed fallback={<FeedGrid feed={feed} empty={<div class="empty">No videos.</div>} />}>
                {(q) => {
                  const found = createFeed(() => api.channelSearch(p.id, q), api.browseMore);
                  return (
                    <div class="results ch-results" onPointerOver={hoverPrefetch()}>
                      <For each={found.items()}>{(x) => <ListCard c={x} />}</For>
                      <Show when={found.loading()}>
                        <Spinner />
                      </Show>
                      <Show when={!found.loading() && !found.items().length}>
                        <div class="empty">This channel has no results for “{q}”.</div>
                      </Show>
                      <Show when={found.cont()}>
                        <Sentinel onVisible={found.loadMore} />
                      </Show>
                    </div>
                  );
                }}
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

/** YouTube-style search icon in the channel tab bar that expands into an input. */
function ChannelSearchBox(p: { id: string; q?: string }) {
  const [open, setOpen] = createSignal(!!p.q);
  let input!: HTMLInputElement;
  const submit = () => {
    const v = input.value.trim();
    if (v) navigate(href.channel(p.id, v));
  };
  return (
    <form
      class="ch-search"
      classList={{ on: !!p.q, open: open() }}
      onSubmit={(e) => (e.preventDefault(), submit())}
    >
      <button
        type="button"
        class="icon-btn"
        aria-label="Search channel"
        onClick={() => (open() && input.value.trim() ? submit() : (setOpen(true), input.focus()))}
      >
        <Icon name="search" size={20} />
      </button>
      <input
        ref={input}
        type="search"
        placeholder="Search"
        value={p.q ?? ''}
        onBlur={() => !input.value && setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && (input.value = '', input.blur())}
      />
    </form>
  );
}

// ---------- watch ----------

export function Watch(p: { v: string; list?: string; t?: number }) {
  const [details, setDetails] = createSignal<Details>();
  const [w] = createResource(
    () => [p.v, p.list] as const,
    ([v, l]) => api.watch(v, l),
  );
  const [related, setRelated] = createSignal<Card[]>([]);
  const [relCont, setRelCont] = createSignal<string>();
  let relBusy = false;
  createEffect(
    on(w, (x) => {
      setRelated(x?.related ?? []);
      setRelCont(x?.relatedCont);
    }),
  );
  createEffect(on(() => p.v, () => setDetails(undefined), { defer: true }));
  const moreRelated = () => {
    const t = relCont();
    if (!t || relBusy) return;
    relBusy = true;
    api
      .relatedMore(t)
      .then((r) => {
        const have = new Set(related().map((c) => c.id));
        setRelated((x) => x.concat(r.items.filter((c) => !have.has(c.id))));
        setRelCont(r.cont);
      })
      .catch(() => setRelCont(undefined))
      .finally(() => (relBusy = false));
  };

  const data = () => (w()?.id === p.v ? w() : undefined);
  const upNext = createMemo<Card | undefined>(() => {
    const d = data();
    const pl = d?.playlist;
    if (pl) {
      const i = pl.items.findIndex((c) => c.id === p.v);
      const n = pl.items[i + 1];
      if (n) return n;
    }
    return related().find((c) => c.kind === 'video');
  });
  const goNext = () => {
    const n = upNext();
    if (!n) return;
    const pl = data()?.playlist;
    navigate(pl && pl.items.some((c) => c.id === n.id) ? href.watch(n.id, pl.id) : watchHref(n));
  };

  const title = () => data()?.title || details()?.title || '';
  createEffect(() => title() && (document.title = title()));

  return (
    <div class="watch">
      <div class="watch-main">
        <Player id={p.v} startAt={p.t} upNext={upNext()} onNext={goNext} onDetails={setDetails} />
        <h1 class="w-title">{title()}</h1>
        <Show
          when={data()}
          fallback={
            <Show when={details()}>
              <div class="w-owner">
                <div class="w-owner-text">
                  <a class="w-owner-name" href={href.channel(details()!.channelId)}>
                    {details()!.author}
                  </a>
                </div>
              </div>
            </Show>
          }
        >
          {(d) => (
            <>
              <div class="w-owner">
                <Show when={d().channel.avatar}>
                  <a href={href.channel(d().channel.id ?? '')}>
                    <img class="avatar" src={avatar(d().channel.avatar, 40)} width="40" height="40" alt="" />
                  </a>
                </Show>
                <div class="w-owner-text">
                  <a class="w-owner-name" href={href.channel(d().channel.id ?? '')}>
                    {d().channel.name}
                  </a>
                  <div class="meta small">{d().channel.subscribers}</div>
                </div>
                <span class="p-spacer" />
                <Actions id={p.v} likes={d().likes} rating={d().rating} />
              </div>
              <Description views={d().views} date={d().relativeDate || d().date} text={d().description} />
            </>
          )}
        </Show>
        <Show when={p.v} keyed>
          {(v) => <Comments id={v} />}
        </Show>
      </div>
      <aside class="watch-side" onPointerOver={hoverPrefetch()}>
        <Show when={data()?.playlist}>{(pl) => <PlaylistPanel pl={pl()} current={p.v} />}</Show>
        <Show when={related().length} fallback={w.loading ? <Spinner /> : null}>
          <For each={related()}>{(c) => <CompactCard c={c} />}</For>
        </Show>
        <Show when={relCont()}>
          <Sentinel onVisible={moreRelated} />
        </Show>
      </aside>
    </div>
  );
}

/** Like / dislike, Download and Watch later, next to the channel row like on YouTube. */
function Actions(p: { id: string; likes?: string; rating: Rating }) {
  const [rating, setRating] = createSignal<Rating>(p.rating);
  createEffect(on(() => [p.id, p.rating] as const, ([, r]) => setRating(r)));
  const signedIn = () => !!me()?.loggedIn;
  const rate = (r: Rating) => {
    const prev = rating();
    const next = prev === r ? 'INDIFFERENT' : r;
    setRating(next); // optimistic
    api.rate(p.id, next).catch(() => setRating(prev));
  };
  const saved = () => inWatchLater(p.id);
  return (
    <div class="w-actions">
      <Show when={signedIn()}>
        <div class="seg">
          <button class="pill seg-l" classList={{ on: rating() === 'LIKE' }} onClick={() => rate('LIKE')} title="I like this">
            <Icon name={rating() === 'LIKE' ? 'likeFilled' : 'like'} size={20} />
            {p.likes ?? 'Like'}
          </button>
          <button class="pill seg-r" classList={{ on: rating() === 'DISLIKE' }} onClick={() => rate('DISLIKE')} title="I dislike this">
            <Icon name={rating() === 'DISLIKE' ? 'dislikeFilled' : 'dislike'} size={20} />
          </button>
        </div>
      </Show>
      <DownloadMenu id={p.id} />
      <CopyTime id={p.id} />
      <Show when={signedIn()}>
        <button class="pill" classList={{ on: saved() }} onClick={() => toggleWatchLater(p.id)}>
          <Icon name={saved() ? 'check' : 'clock'} size={20} />
          {saved() ? 'Saved' : 'Watch later'}
        </button>
      </Show>
    </div>
  );
}

/** Copies a youtu.be share link starting at the player's current position. */
function CopyTime(p: { id: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer = 0;
  onCleanup(() => clearTimeout(timer));
  const copy = () => {
    const t = Math.floor(document.querySelector<HTMLVideoElement>('.player video')?.currentTime ?? 0);
    navigator.clipboard.writeText(`https://youtu.be/${p.id}?t=${t}`).then(() => {
      setCopied(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button class="pill" onClick={copy} title="Copy link at current time">
      <Icon name={copied() ? 'check' : 'link'} size={20} />
      {copied() ? 'Copied' : 'Copy time'}
    </button>
  );
}

const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`);

function DownloadMenu(p: { id: string }) {
  const [open, setOpen] = createSignal(false);
  const [opts, setOpts] = createSignal<DownloadOption[] | null>(null);
  const [err, setErr] = createSignal('');
  let wrap!: HTMLDivElement;
  createEffect(on(() => p.id, () => (setOpts(null), setOpen(false))));
  const toggle = () => {
    const o = !open();
    setOpen(o);
    if (o && !opts()) api.downloadOptions(p.id).then(setOpts, (e) => setErr(e.message));
  };
  onMount(() => {
    const close = (e: PointerEvent) => open() && !wrap.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', close);
    onCleanup(() => document.removeEventListener('pointerdown', close));
  });
  const video = () => opts()?.filter((o) => o.key.startsWith('v')) ?? [];
  const audio = () => opts()?.filter((o) => !o.key.startsWith('v')) ?? [];
  return (
    <div class="dl" ref={wrap}>
      <button class="pill" classList={{ on: open() }} onClick={toggle}>
        <Icon name="download" size={20} />
        Download
      </button>
      <Show when={open()}>
        <div class="dl-menu">
          <Show when={opts()} fallback={err() ? <div class="dl-head">{err()}</div> : <Spinner />}>
            <div class="dl-head">Video</div>
            <For each={video()}>
              {(o) => (
                <a class="dl-item" href={api.downloadUrl(p.id, o.key)} download="" onClick={() => setOpen(false)}>
                  <span>{o.label}</span>
                  <span class="dim">{o.detail}</span>
                  <span class="dim dl-size">{fmtSize(o.size)}</span>
                </a>
              )}
            </For>
            <div class="dl-head">Audio only</div>
            <For each={audio()}>
              {(o) => (
                <a class="dl-item" href={api.downloadUrl(p.id, o.key)} download="" onClick={() => setOpen(false)}>
                  <span>{o.detail.split(' · ')[0]}</span>
                  <span class="dim">{o.detail.split(' · ')[1] ?? ''}</span>
                  <span class="dim dl-size">~{fmtSize(o.size)}</span>
                </a>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function PlaylistPanel(p: { pl: NonNullable<import('./api').Watch['playlist']>; current: string }) {
  let list!: HTMLDivElement;
  const idx = () => p.pl.items.findIndex((c) => c.id === p.current);
  onMount(() => {
    const el = list.children[idx()] as HTMLElement | undefined;
    if (el) list.scrollTop = el.offsetTop - list.offsetTop - 8;
  });
  return (
    <div class="plpanel">
      <div class="plpanel-head">
        <div class="plpanel-title">{p.pl.title}</div>
        <div class="meta small">
          {p.pl.author} – {idx() + 1}/{p.pl.items.length}
        </div>
      </div>
      <div class="plpanel-list" ref={list}>
        <Index each={p.pl.items}>
          {(c, i) => <CompactCard c={c()} list={p.pl.id} index={i} active={c().id === p.current} />}
        </Index>
      </div>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

function Description(p: { views: string; date: string; text: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="desc" classList={{ open: open() }} onClick={() => !open() && setOpen(true)}>
      <div class="desc-meta">
        {p.views} &nbsp;{p.date}
      </div>
      <div class="desc-text">
        <For each={p.text.split(URL_RE)}>
          {(part, i) =>
            i() % 2 ? (
              <a href={part} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                {part}
              </a>
            ) : (
              part
            )
          }
        </For>
      </div>
      <button
        class="desc-toggle"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open());
        }}
      >
        {open() ? 'Show less' : '...more'}
      </button>
    </div>
  );
}

/** Comments are only requested after the user scrolls the page and the section comes near the viewport. */
function Comments(p: { id: string }) {
  const [armed, setArmed] = createSignal(false);
  onMount(() => {
    const main = document.querySelector('.main');
    const arm = () => main!.scrollTop > 0 && setArmed(true);
    main?.addEventListener('scroll', arm, { passive: true });
    onCleanup(() => main?.removeEventListener('scroll', arm));
  });
  const [items, setItems] = createSignal<Comment[]>([]);
  const [count, setCount] = createSignal<string>();
  const [cursor, setCursor] = createSignal<string>();
  const [state, setState] = createSignal<'idle' | 'loading' | 'more' | 'done' | 'error'>('idle');
  const load = () => {
    const s = state();
    if (s === 'loading' || s === 'done' || s === 'error') return;
    const c = cursor();
    if (s === 'more' && !c) return setState('done');
    setState('loading');
    (c ? api.commentsMore(c) : api.comments(p.id))
      .then((r) => {
        if ('count' in r) setCount(r.count as string | undefined);
        setItems((x) => x.concat(r.items));
        setCursor(r.cursor);
        setState(r.cursor ? 'more' : 'done');
      })
      .catch(() => setState('error'));
  };
  return (
    <section class="comments">
      <Show when={count()}>
        <h2 class="comments-count">{count()}</h2>
      </Show>
      <For each={items()}>{(c) => <CommentItem c={c} />}</For>
      <Show when={state() === 'loading'}>
        <Spinner />
      </Show>
      <Show when={state() === 'error'}>
        <div class="empty">Comments are turned off or couldn't be loaded.</div>
      </Show>
      <Show when={armed() && (state() === 'idle' || state() === 'more')}>
        <Sentinel onVisible={load} margin="300px 0px" />
      </Show>
    </section>
  );
}

function CommentItem(p: { c: Comment; reply?: boolean }) {
  const c = p.c;
  const [replies, setReplies] = createSignal<Comment[]>([]);
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [more, setMore] = createSignal(false);
  const fetchReplies = () => {
    if (!c.repliesKey || loading()) return;
    setLoading(true);
    api
      .replies(c.repliesKey)
      .then((r) => {
        setReplies((x) => x.concat(r.items));
        setMore(r.more);
      })
      .finally(() => setLoading(false));
  };
  return (
    <div class="comment" classList={{ reply: p.reply }}>
      <a href={c.authorId ? href.channel(c.authorId) : undefined}>
        <img class="avatar" src={avatar(c.avatar, p.reply ? 24 : 40)} width={p.reply ? 24 : 40} height={p.reply ? 24 : 40} loading="lazy" alt="" />
      </a>
      <div class="comment-body">
        <div class="comment-head">
          <Show when={c.pinned}>
            <span class="meta small">📌 Pinned</span>
          </Show>
          <span class="comment-author" classList={{ owner: c.byOwner }}>
            {c.author}
          </span>
          <span class="meta small">{c.published}</span>
        </div>
        <div class="comment-text">{c.text}</div>
        <div class="comment-actions meta small">
          <Icon name="like" size={16} />
          {c.likes}
        </div>
        <Show when={c.replies > 0 && c.repliesKey}>
          <button
            class="replies-toggle"
            onClick={() => {
              const o = !open();
              setOpen(o);
              if (o && !replies().length) fetchReplies();
            }}
          >
            <Icon name="chevronDown" size={20} />
            {c.replies} {c.replies === 1 ? 'reply' : 'replies'}
          </button>
          <Show when={open()}>
            <For each={replies()}>{(r) => <CommentItem c={r} reply />}</For>
            <Show when={loading()}>
              <Spinner />
            </Show>
            <Show when={more() && !loading()}>
              <button class="replies-toggle" onClick={fetchReplies}>
                Show more replies
              </button>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
