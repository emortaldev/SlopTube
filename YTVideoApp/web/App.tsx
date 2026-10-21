import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { SearchFilters } from '../shared/search';
import { api, avatar } from './api';
import { Icon } from './icons';
import { href, navigate, route } from './router';
import { guide, me } from './state';
import { ChannelView, Home, Results, Subscriptions, Watch, WatchLaterView } from './views';

export function App() {
  let main!: HTMLElement;
  const isWatch = () => route().name === 'watch';
  const [sidebar, setSidebar] = createSignal(true);

  createEffect(on(route, (r, prev) => {
    // Keep scroll position only when staying on the same feed.
    if (!prev || r.name !== prev.name || r.name === 'watch' || r.name === 'results' || r.name === 'channel') main.scrollTo(0, 0);
    if (r.name !== 'watch') document.title = 'YouTube';
  }));

  onMount(() => {
    // Mouse: navigate to a video on press, not release (saves ~80ms of click time).
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#/watch"]');
      if (a) navigate(a.getAttribute('href')!);
    };
    document.addEventListener('pointerdown', onDown, true);
    onCleanup(() => document.removeEventListener('pointerdown', onDown, true));
  });

  return (
    <div class="app" classList={{ 'no-side': isWatch() || !sidebar() }}>
      <TopBar onMenu={() => setSidebar(!sidebar())} />
      <Show when={!isWatch() && sidebar()}>
        <Sidebar />
      </Show>
      <main ref={main} class="main">
        <Switch>
          <Match when={route().name === 'home'}>
            <Home />
          </Match>
          <Match when={route().name === 'subscriptions'}>
            <Subscriptions />
          </Match>
          <Match when={route().name === 'watchlater'}>
            <WatchLaterView />
          </Match>
          <Match when={route().name === 'watch' && (route() as { v: string; list?: string; t?: number })}>
            {(r) => <Watch v={r().v} list={r().list} t={r().t} />}
          </Match>
          <Match when={route().name === 'results' && (route() as { q: string; f: SearchFilters })}>
            {(r) => <Results q={r().q} f={r().f} />}
          </Match>
          <Match when={route().name === 'channel' && (route() as { id: string; q?: string })}>
            {(r) => <ChannelView id={r().id} q={r().q} />}
          </Match>
        </Switch>
      </main>
    </div>
  );
}

function TopBar(p: { onMenu: () => void }) {
  const [q, setQ] = createSignal(route().name === 'results' ? (route() as { q: string }).q : '');
  const [sugg, setSugg] = createSignal<string[]>([]);
  const [open, setOpen] = createSignal(false);
  const [sel, setSel] = createSignal(-1);
  let timer = 0;
  let seq = 0;
  createEffect(() => {
    const r = route();
    if (r.name === 'results') setQ(r.q);
  });
  const onInput = (v: string) => {
    setQ(v);
    setSel(-1);
    clearTimeout(timer);
    if (!v.trim()) return setSugg([]);
    timer = window.setTimeout(() => {
      const my = ++seq;
      api.suggest(v).then((s) => my === seq && setSugg(s.slice(0, 10)), () => {});
    }, 100);
  };
  const submit = (v: string) => {
    if (!v.trim()) return;
    setQ(v);
    setOpen(false);
    navigate(href.results(v.trim()));
    (document.activeElement as HTMLElement)?.blur();
  };

  return (
    <header class="topbar">
      <div class="tb-start">
        <button class="icon-btn" onClick={p.onMenu} aria-label="Menu">
          <Icon name="menu" />
        </button>
        <a class="logo" href={href.home()} aria-label="Home">
          <svg width="29" height="20" viewBox="0 0 28 20" aria-hidden="true">
            <rect width="28" height="20" rx="5" fill="#f00" />
            <path d="M11 6v8l7-4z" fill="#fff" />
          </svg>
          <span>YouTube</span>
        </a>
      </div>
      <form
        class="search"
        classList={{ open: open() && sugg().length > 0 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit(sel() >= 0 ? sugg()[sel()]! : q());
        }}
      >
        <div class="search-box">
          <input
            type="search"
            placeholder="Search"
            value={q()}
            onInput={(e) => onInput(e.currentTarget.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              const n = sugg().length;
              if (e.key === 'ArrowDown' && n) (e.preventDefault(), setSel((s) => (s + 1) % n));
              else if (e.key === 'ArrowUp' && n) (e.preventDefault(), setSel((s) => (s <= 0 ? n - 1 : s - 1)));
              else if (e.key === 'Escape') (e.currentTarget.blur(), setOpen(false));
            }}
          />
          <Show when={open() && sugg().length}>
            <ul class="suggest">
              <For each={sugg()}>
                {(s, i) => (
                  <li classList={{ sel: sel() === i() }} onMouseDown={(e) => (e.preventDefault(), submit(s))}>
                    <Icon name="search" size={20} />
                    {s}
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
        <button class="search-btn" aria-label="Search">
          <Icon name="search" />
        </button>
      </form>
      <div class="tb-end" />
    </header>
  );
}

function Sidebar() {
  const [all, setAll] = createSignal(false);
  const subs = () => guide() ?? [];
  const r = () => route();
  return (
    <nav class="sidebar">
      <a class="side-item" classList={{ on: r().name === 'home' }} href={href.home()}>
        <Icon name="home" />
        <span>Home</span>
      </a>
      <a class="side-item" classList={{ on: r().name === 'subscriptions' }} href={href.subscriptions()}>
        <Icon name="subscriptions" />
        <span>Subscriptions</span>
      </a>
      <Show when={me()?.loggedIn}>
        <a class="side-item" classList={{ on: r().name === 'watchlater' }} href={href.watchLater()}>
          <Icon name="clock" />
          <span>Watch later</span>
        </a>
      </Show>
      <Show when={me()?.loggedIn && subs().length}>
        <div class="side-sep" />
        <div class="side-head">Subscriptions</div>
        <For each={all() ? subs() : subs().slice(0, 7)}>
          {(c) => (
            <a
              class="side-item"
              classList={{ on: r().name === 'channel' && (r() as { id: string }).id === c.id }}
              href={href.channel(c.id!)}
            >
              <img class="avatar" src={avatar(c.avatar, 24)} width="24" height="24" loading="lazy" alt="" />
              <span>{c.name}</span>
            </a>
          )}
        </For>
        <Show when={subs().length > 7}>
          <button class="side-item" onClick={() => setAll(!all())}>
            <Icon name="chevronDown" />
            <span>{all() ? 'Show fewer' : `Show ${subs().length - 7} more`}</span>
          </button>
        </Show>
      </Show>
    </nav>
  );
}
