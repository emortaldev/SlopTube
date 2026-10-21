import { createEffect, on, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { api, collection, type Card, type SearchType } from './api';
import { Icon } from './icons';
import { next, prev, seek, toggle, player } from './player';
import { PlayerBar, QueuePanel } from './PlayerBar';
import { SaveLayer } from './save';
import { href, navigate, route } from './router';
import { library, me } from './state';
import { ArtistView, CollectionView, Cover, Home, SEARCH_TYPES, SearchView, typeLabel } from './views';

export function App() {
  const [scroller, setScroller] = createSignal<HTMLElement>();
  const [queueOpen, setQueueOpen] = createSignal(false);

  createEffect(on(route, () => scroller()?.scrollTo(0, 0), { defer: true }));

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowRight' && !e.shiftKey) seek(player.time() + 5);
      else if (e.key === 'ArrowLeft' && !e.shiftKey) seek(player.time() - 5);
      else if (e.key === 'N' || (e.shiftKey && e.key === 'ArrowRight')) next();
      else if (e.key === 'P' || (e.shiftKey && e.key === 'ArrowLeft')) prev();
      else if (e.key === '/') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('.search input')?.focus();
      }
    };
    addEventListener('keydown', onKey);
    onCleanup(() => removeEventListener('keydown', onKey));
  });

  return (
    <div class="app">
      <TopBar />
      <Sidebar />
      <main ref={setScroller} class="main">
        <Show when={scroller()}>
          {(s) => (
            <Switch>
              <Match when={route().name === 'home'}>
                <Home />
              </Match>
              <Match when={route().name === 'playlist' || route().name === 'album'}>
                {(() => {
                  const r = route() as { name: 'playlist' | 'album'; id: string };
                  return <CollectionView kind={r.name} id={r.id} scroller={s()} />;
                })()}
              </Match>
              <Match when={route().name === 'artist'}>
                {(() => <ArtistView id={(route() as { id: string }).id} scroller={s()} />)()}
              </Match>
              <Match when={route().name === 'search'}>
                <SearchView
                  q={(route() as { q: string }).q}
                  type={(route() as { type?: SearchType }).type}
                  scroller={s()}
                />
              </Match>
            </Switch>
          )}
        </Show>
      </main>
      <Show when={queueOpen()}>
        <QueuePanel onClose={() => setQueueOpen(false)} />
      </Show>
      <PlayerBar queueOpen={queueOpen()} onToggleQueue={() => setQueueOpen((v) => !v)} />
      <SaveLayer />
    </div>
  );
}

type Option = { q: string; type?: SearchType };
const SCOPE_ICON = { songs: 'music', albums: 'album', artists: 'person', playlists: 'queue' } as const;

function TopBar() {
  const [q, setQ] = createSignal(route().name === 'search' ? (route() as { q: string }).q : '');
  const [sugg, setSugg] = createSignal<string[]>([]);
  const [open, setOpen] = createSignal(false);
  const [sel, setSel] = createSignal(-1);
  let timer = 0;
  let seq = 0;

  // "Search in Songs / Albums / …" rows first, then text suggestions.
  const options = (): Option[] => {
    const v = q().trim();
    if (!v) return [];
    return [...SEARCH_TYPES.map((type) => ({ q: v, type })), ...sugg().map((s) => ({ q: s }))];
  };

  const onInput = (v: string) => {
    setQ(v);
    setSel(-1);
    clearTimeout(timer);
    if (!v.trim()) return setSugg([]);
    timer = window.setTimeout(() => {
      const my = ++seq;
      api.suggest(v).then((s) => my === seq && setSugg(s), () => {});
    }, 120);
  };
  const submit = (o: Option) => {
    if (!o.q.trim()) return;
    setQ(o.q);
    setOpen(false);
    navigate(href.search(o.q.trim(), o.type));
    (document.activeElement as HTMLElement)?.blur();
  };

  return (
    <header class="topbar">
      <a class="logo" href={href.home()} aria-label="Home">
        <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="12" fill="#f00" />
          <circle cx="12" cy="12" r="6.6" fill="none" stroke="#fff" stroke-width="1.1" />
          <path d="M10 9.2v5.6l4.8-2.8z" fill="#fff" />
        </svg>
        <span>Music</span>
      </a>
      <form
        class="search"
        classList={{ open: open() && options().length > 0 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit(options()[sel()] ?? { q: q() });
        }}
      >
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search songs, albums, artists, playlists"
          value={q()}
          onInput={(e) => onInput(e.currentTarget.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            const n = options().length;
            if (e.key === 'ArrowDown' && n) (e.preventDefault(), setSel((s) => (s + 1) % n));
            else if (e.key === 'ArrowUp' && n) (e.preventDefault(), setSel((s) => (s <= 0 ? n - 1 : s - 1)));
            else if (e.key === 'Escape') (e.currentTarget.blur(), setOpen(false));
          }}
        />
        <Show when={open() && options().length}>
          <ul class="suggest">
            <For each={options()}>
              {(o, i) => (
                <li
                  classList={{ sel: sel() === i(), scope: !!o.type }}
                  onMouseDown={(e) => (e.preventDefault(), submit(o))}
                >
                  <Icon name={o.type ? SCOPE_ICON[o.type] : 'search'} size={20} />
                  {o.type ? (
                    <span class="scope-text">
                      Search in <b>{typeLabel(o.type).toLowerCase()}</b>
                      <span class="scope-q">{o.q}</span>
                    </span>
                  ) : (
                    o.q
                  )}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </form>
    </header>
  );
}

function Sidebar() {
  const activeId = () => {
    const r = route();
    return r.name === 'playlist' ? r.id : null;
  };
  // Warm the playlist JSON on hover so the click renders instantly.
  const warm = (c: Card) => collection('playlist', c.id);

  return (
    <nav class="sidebar">
      <a class="nav-item" classList={{ active: route().name === 'home' }} href={href.home()}>
        <Icon name="home" />
        <span>Home</span>
      </a>
      <a class="nav-item" classList={{ active: route().name === 'search' }} href={href.search('')} onClick={(e) => {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('.search input')?.focus();
      }}>
        <Icon name="search" />
        <span>Search</span>
      </a>
      <div class="sidebar-sep" />
      <Show
        when={me()?.loggedIn}
        fallback={
          <div class="sidebar-signin">
            <p>Sign in to see your liked songs and playlists.</p>
            <a class="btn btn-outline" href={href.home()}>
              Sign in
            </a>
          </div>
        }
      >
        <div class="sidebar-list">
          <For each={library() ?? []}>
            {(c) => (
              <a
                class="side-pl"
                classList={{ active: activeId() === c.id }}
                href={href.playlist(c.id)}
                onPointerEnter={() => warm(c)}
              >
                <Cover src={c.thumb} size={40} liked={c.id === 'LM'} class="side-pl-cover" />
                <span class="side-pl-text">
                  <span class="side-pl-title">{c.title}</span>
                  <span class="side-pl-sub">
                    <Show when={c.id === 'LM'}>
                      <Icon name="pin" size={14} />
                    </Show>
                    {c.id === 'LM' ? 'Auto playlist' : c.subtitle}
                  </span>
                </span>
              </a>
            )}
          </For>
        </div>
      </Show>
    </nav>
  );
}
