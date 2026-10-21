import { createEffect, createResource, createSignal, For, Match, Show, Switch, type JSX } from 'solid-js';
import {
  api,
  collection,
  forgetCollection,
  prefetch,
  thumb,
  type ArtistPage,
  type Card,
  type Collection,
  type SearchType,
  type Shelf,
  type Track,
} from './api';
import { Icon } from './icons';
import { playCollection, playTracks, player, toggle } from './player';
import { href, navigate } from './router';
import { toast } from './save';
import { afterLogin, library, me, refreshLibrary } from './state';
import { Artists, TrackList } from './TrackList';

// ---------- shared bits ----------

export function Cover(p: { src?: string; size: number; liked?: boolean; round?: boolean; class?: string }) {
  const cls = () => `cover ${p.round ? 'cover-round' : ''} ${p.class ?? ''}`;
  return (
    <Show
      when={!p.liked && p.src}
      fallback={
        <div class={`${cls()} cover-liked`} style={{ width: `${p.size}px`, height: `${p.size}px` }}>
          <Icon name={p.liked ? 'like' : 'music'} size={Math.round(p.size * 0.36)} />
        </div>
      }
    >
      <img class={cls()} src={thumb(p.src, p.size)} width={p.size} height={p.size} loading="lazy" decoding="async" alt="" />
    </Show>
  );
}

const cardHref = (c: Card) =>
  c.kind === 'album' ? href.album(c.id) : c.kind === 'artist' ? href.artist(c.id) : href.playlist(c.id);

function CardGrid(p: { cards: Card[] }) {
  return (
    <div class="grid">
      <For each={p.cards}>
        {(c) => (
          <a
            class="card"
            classList={{ 'card-artist': c.kind === 'artist' }}
            href={cardHref(c)}
            onPointerEnter={() => c.kind !== 'artist' && collection(c.kind, c.id)}
          >
            <Cover src={c.thumb} size={180} liked={c.id === 'LM'} round={c.kind === 'artist'} />
            <div class="card-title" title={c.title}>
              {c.title}
            </div>
            <div class="card-sub">{c.subtitle}</div>
          </a>
        )}
      </For>
    </div>
  );
}

function SectionHead(p: { title: string; children?: JSX.Element }) {
  return (
    <div class="section-head">
      <h2 class="section-title">{p.title}</h2>
      {p.children}
    </div>
  );
}

const Spinner = () => <div class="spinner" aria-label="Loading" />;

// ---------- home / library ----------

export function Home() {
  return (
    <div class="page">
      <Show when={!me.loading} fallback={<Spinner />}>
        <Show when={me()?.loggedIn} fallback={<Login />}>
          <h2 class="section-title">Library</h2>
          <Show when={library()} fallback={<Spinner />}>
            {(l) => <CardGrid cards={l()} />}
          </Show>
        </Show>
      </Show>
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
      <h1>Connect your YouTube Music account</h1>
      <ol>
        <li>
          Open <a href="https://music.youtube.com" target="_blank" rel="noreferrer">music.youtube.com</a> in this
          browser while signed in.
        </li>
        <li>
          Open DevTools (<kbd>F12</kbd>) → <b>Network</b>, filter by <code>browse</code>, and click any request.
        </li>
        <li>
          Under <b>Request Headers</b>, copy the whole value of <code>cookie</code> and paste it below.
        </li>
      </ol>
      <textarea
        placeholder="VISITOR_INFO1_LIVE=…; SAPISID=…; __Secure-3PSID=…"
        value={cookie()}
        onInput={(e) => setCookie(e.currentTarget.value)}
        rows="5"
        spellcheck={false}
      />
      <p class="login-note">The cookie is stored only on this machine (cookie.txt next to the server).</p>
      <Show when={err()}>
        <p class="login-err">{err()}</p>
      </Show>
      <button class="btn btn-primary" disabled={busy() || !cookie().includes('SAPISID')}>
        {busy() ? 'Connecting…' : 'Connect'}
      </button>
      <p class="login-note">Search and playback work without signing in.</p>
    </form>
  );
}

// ---------- playlist / album ----------

export function CollectionView(p: { kind: 'playlist' | 'album'; id: string; scroller: HTMLElement }) {
  const [col] = createResource(
    () => [p.kind, p.id] as const,
    ([k, id]) => collection(k, id),
  );
  // Warm the first track: the Play button is the most likely next click.
  createEffect(() => {
    const t = col()?.tracks()[0];
    if (t) prefetch(t.id);
  });

  return (
    <Switch>
      <Match when={col.error}>
        <div class="page empty">Couldn't load this {p.kind}. {String(col.error?.message ?? '')}</div>
      </Match>
      <Match when={col.loading && !col.latest}>
        <div class="page">
          <Spinner />
        </div>
      </Match>
      <Match when={col()}>{(c) => <CollectionBody col={c()} scroller={p.scroller} />}</Match>
    </Switch>
  );
}

function CollectionBody(p: { col: Collection; scroller: HTMLElement }) {
  const c = p.col;
  const isLiked = c.id === 'LM';
  const playingHere = () => {
    const cur = player.current();
    return !!cur && c.tracks().some((t) => t.id === cur.id);
  };
  const removeTrack = async (t: Track) => {
    try {
      await api.removeFromPlaylist(c.id, t.id);
      c.dropTrack(t.id);
      forgetCollection(c.id);
      toast(`Removed from ${c.title}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const [confirming, setConfirming] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const remove = async () => {
    setDeleting(true);
    try {
      await api.deletePlaylist(c.id);
      forgetCollection(c.id);
      refreshLibrary();
      navigate(href.home());
      toast(`Deleted ${c.title}`);
    } catch (e) {
      setDeleting(false);
      setConfirming(false);
      toast((e as Error).message);
    }
  };

  return (
    <div class="page">
      <header class="col-header">
        <Cover src={c.thumb} size={264} liked={isLiked} class="col-cover" />
        <div class="col-info">
          <h1 class="col-title">{c.title}</h1>
          <div class="col-sub">
            {c.subtitle}
            <Show when={c.artists?.length}>
              {c.subtitle && ' • '}
              <Artists list={c.artists!} />
            </Show>
          </div>
          <div class="col-meta">{c.meta}</div>
          <Show when={c.description}>
            <p class="col-desc">{c.description}</p>
          </Show>
          <div class="col-actions">
            <button
              class="btn btn-primary btn-play"
              onPointerEnter={() => c.tracks()[0] && prefetch(c.tracks()[0]!.id)}
              onClick={() => (playingHere() ? toggle() : playCollection(c, 0))}
            >
              <Icon name={playingHere() && player.playing() ? 'pause' : 'play'} />
              {playingHere() && player.playing() ? 'Pause' : 'Play'}
            </button>
            <button class="btn btn-outline" onClick={() => playCollection(c, 0, true)}>
              <Icon name="shuffle" />
              Shuffle
            </button>
            <Show when={c.editable}>
              <button class="btn btn-outline" onClick={() => setConfirming(true)}>
                <Icon name="trash" />
                Delete
              </button>
            </Show>
          </div>
        </div>
      </header>
      <Show when={confirming()}>
        <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !deleting() && setConfirming(false)}>
          <div class="modal" role="alertdialog" aria-labelledby="del-title">
            <h3 id="del-title">Delete playlist?</h3>
            <p>
              “{c.title}” will be permanently deleted from your YouTube account. This can't be undone.
            </p>
            <div class="modal-actions">
              <button class="btn btn-outline" disabled={deleting()} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button class="btn btn-primary" disabled={deleting()} onClick={remove}>
                {deleting() ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      </Show>
      <Show when={c.tracks().length} fallback={<div class="empty">This {c.kind} is empty.</div>}>
        <TrackList
          tracks={c.tracks}
          scroller={p.scroller}
          numbered={c.kind === 'album'}
          hideAlbum={c.kind === 'album'}
          onPlay={(i) => playCollection(c, i)}
          onNearEnd={() => c.hasMore() && c.loadMore()}
          onRemove={c.editable ? removeTrack : undefined}
        />
        <Show when={c.hasMore()}>
          <div class="list-more">
            <Spinner />
          </div>
        </Show>
      </Show>
    </div>
  );
}

// ---------- artist ----------

export function ArtistView(p: { id: string; scroller: HTMLElement }) {
  const [artist] = createResource(() => p.id, api.artist);
  createEffect(() => {
    const t = artist()?.topSongs[0];
    if (t) prefetch(t.id);
  });
  return (
    <Switch>
      <Match when={artist.error}>
        <div class="page empty">Couldn't load this artist. {String(artist.error?.message ?? '')}</div>
      </Match>
      <Match when={artist.loading}>
        <div class="page">
          <Spinner />
        </div>
      </Match>
      <Match when={artist()}>{(a) => <ArtistBody a={a()} scroller={p.scroller} />}</Match>
    </Switch>
  );
}

function ArtistBody(p: { a: ArtistPage; scroller: HTMLElement }) {
  const a = p.a;
  const songs = () => a.topSongs;
  const playingHere = () => {
    const cur = player.current();
    return !!cur && a.topSongs.some((t) => t.id === cur.id);
  };
  const play = (i: number, shuffle = false) => {
    if (a.allSongs) {
      // Play the artist's full song list, like YT Music does.
      collection('playlist', a.allSongs).then((c) => {
        const at = c.tracks().findIndex((t) => t.id === a.topSongs[i]?.id);
        if (at >= 0 || shuffle) playCollection(c, Math.max(0, at), shuffle);
        else playTracks(a.topSongs, i);
      });
    } else playTracks(a.topSongs, i, { shuffle });
  };
  // Start the clicked song immediately; when the top songs run out the queue continues as artist radio.
  const playRow = (i: number) => playTracks(a.topSongs, i, { radio: true });

  return (
    <div class="artist">
      <div class="artist-hero">
        <Show when={a.thumb}>
          <img class="artist-banner" src={thumb(a.thumb, 720)} alt="" decoding="async" />
        </Show>
        <div class="artist-hero-fade" />
        <div class="artist-hero-text">
          <h1 class="artist-name">{a.name}</h1>
          <Show when={a.subscribers}>
            <div class="col-meta">{a.subscribers}</div>
          </Show>
          <Show when={a.description}>
            <p class="col-desc">{a.description}</p>
          </Show>
          <div class="col-actions">
            <button
              class="btn btn-primary btn-play"
              onPointerEnter={() => a.topSongs[0] && prefetch(a.topSongs[0].id)}
              onClick={() => (playingHere() ? toggle() : playRow(0))}
            >
              <Icon name={playingHere() && player.playing() ? 'pause' : 'play'} />
              {playingHere() && player.playing() ? 'Pause' : 'Play'}
            </button>
            <button class="btn btn-outline" onClick={() => play(0, true)}>
              <Icon name="shuffle" />
              Shuffle
            </button>
          </div>
        </div>
      </div>
      <div class="page artist-page">
        <Show when={songs().length}>
          <SectionHead title="Top songs">
            <Show when={a.allSongs}>
              <a class="btn btn-outline btn-sm" href={href.playlist(a.allSongs!)}>
                Show all
              </a>
            </Show>
          </SectionHead>
          <TrackList tracks={songs} scroller={p.scroller} onPlay={playRow} />
        </Show>
        <For each={a.shelves}>{(s) => <ShelfView shelf={s} />}</For>
      </div>
    </div>
  );
}

function ShelfView(p: { shelf: Shelf }) {
  const [items, setItems] = createSignal(p.shelf.items);
  const [state, setState] = createSignal<'idle' | 'loading' | 'all'>(p.shelf.more ? 'idle' : 'all');
  const showAll = async () => {
    setState('loading');
    try {
      const all = await api.browse(p.shelf.more!);
      if (all.length) setItems(all);
      setState('all');
    } catch {
      setState('idle');
    }
  };
  return (
    <>
      <SectionHead title={p.shelf.title}>
        <Show when={state() !== 'all'}>
          <button class="btn btn-outline btn-sm" disabled={state() === 'loading'} onClick={showAll}>
            {state() === 'loading' ? 'Loading…' : 'Show all'}
          </button>
        </Show>
      </SectionHead>
      <CardGrid cards={items()} />
    </>
  );
}

// ---------- search ----------

const TYPE_LABEL: Record<SearchType, string> = { songs: 'Songs', albums: 'Albums', artists: 'Artists', playlists: 'Playlists' };
export const SEARCH_TYPES = Object.keys(TYPE_LABEL) as SearchType[];
export const typeLabel = (t: SearchType) => TYPE_LABEL[t];

export function SearchView(p: { q: string; type?: SearchType; scroller: HTMLElement }) {
  return (
    <div class="page">
      <Show when={p.q.trim()} fallback={<div class="empty">Search for songs, albums, artists and playlists.</div>}>
        <div class="chips">
          <a class="chip" classList={{ on: !p.type }} href={href.search(p.q)}>
            All
          </a>
          <For each={SEARCH_TYPES}>
            {(t) => (
              <a class="chip" classList={{ on: p.type === t }} href={href.search(p.q, t)}>
                {TYPE_LABEL[t]}
              </a>
            )}
          </For>
        </div>
        <Show when={p.type} fallback={<SearchAllView q={p.q} scroller={p.scroller} />} keyed>
          {(t) => <SearchTypeView q={p.q} type={t} scroller={p.scroller} />}
        </Show>
      </Show>
    </div>
  );
}

function SearchAllView(p: { q: string; scroller: HTMLElement }) {
  const [res] = createResource(() => p.q.trim(), api.search);
  return (
    <Show when={!res.loading || res.latest} fallback={<Spinner />}>
      <Show when={res()}>
        {(r) => (
          <>
            <Show when={r().songs.length}>
              <SectionHead title="Songs">
                <a class="btn btn-outline btn-sm" href={href.search(p.q, 'songs')}>
                  Show all
                </a>
              </SectionHead>
              <TrackList
                tracks={() => r().songs}
                scroller={p.scroller}
                onPlay={(i) => playTracks([r().songs[i]!], 0, { radio: true })}
              />
            </Show>
            <For each={['artists', 'albums', 'playlists'] as const}>
              {(t) => (
                <Show when={r()[t].length}>
                  <SectionHead title={TYPE_LABEL[t]}>
                    <a class="btn btn-outline btn-sm" href={href.search(p.q, t)}>
                      Show all
                    </a>
                  </SectionHead>
                  <CardGrid cards={r()[t]} />
                </Show>
              )}
            </For>
            <Show when={SEARCH_TYPES.every((t) => !r()[t].length)}>
              <div class="empty">No results for “{p.q}”.</div>
            </Show>
          </>
        )}
      </Show>
    </Show>
  );
}

function SearchTypeView(p: { q: string; type: SearchType; scroller: HTMLElement }) {
  const [items, setItems] = createSignal<(Track | Card)[]>([]);
  const [cursor, setCursor] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);
  createEffect(() => {
    const q = p.q.trim();
    setLoading(true);
    setItems([]);
    api.searchType<Track | Card>(q, p.type).then(
      (r) => {
        setItems(r.items);
        setCursor(r.cursor);
        setLoading(false);
      },
      () => setLoading(false),
    );
  });
  let busy = false;
  const more = () => {
    const c = cursor();
    if (!c || busy) return;
    busy = true;
    api
      .searchMore<Track | Card>(c, p.type)
      .then((r) => {
        setItems((x) => x.concat(r.items));
        setCursor(r.cursor);
      })
      .finally(() => (busy = false));
  };
  const songs = () => items() as Track[];
  return (
    <Show when={!loading()} fallback={<Spinner />}>
      <Show when={items().length} fallback={<div class="empty">No {p.type} for “{p.q}”.</div>}>
        <Show
          when={p.type === 'songs'}
          fallback={
            <>
              <CardGrid cards={items() as Card[]} />
              <Show when={cursor()}>
                <div class="list-more">
                  <button class="btn btn-outline" onClick={more}>
                    Load more
                  </button>
                </div>
              </Show>
            </>
          }
        >
          <TrackList
            tracks={songs}
            scroller={p.scroller}
            onPlay={(i) => playTracks([songs()[i]!], 0, { radio: true })}
            onNearEnd={more}
          />
        </Show>
      </Show>
    </Show>
  );
}
