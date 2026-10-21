import { createSignal, type Accessor } from 'solid-js';

export type Artist = { name: string; id?: string };
export type Track = {
  id: string;
  title: string;
  artists: Artist[];
  album?: { name: string; id?: string };
  duration: number;
  thumb?: string;
};
export type Rating = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';
export type SaveTarget = { id: string; title: string; subtitle: string; thumb?: string };
export type Card = { id: string; kind: 'playlist' | 'album' | 'artist'; title: string; subtitle: string; thumb?: string };

export type Shelf = { title: string; items: Card[]; more?: { browseId: string; params: string } };
export type ArtistPage = {
  id: string;
  name: string;
  thumb?: string;
  description?: string;
  subscribers?: string;
  topSongs: Track[];
  allSongs?: string;
  shelves: Shelf[];
};
export type SearchType = 'songs' | 'albums' | 'artists' | 'playlists';
export type SearchAll = { songs: Track[]; albums: Card[]; artists: Card[]; playlists: Card[] };
export type SearchPage<T> = { items: T[]; cursor?: string };

type CollectionData = {
  id: string;
  kind: 'playlist' | 'album';
  title: string;
  subtitle: string;
  artists?: Artist[];
  meta: string;
  description?: string;
  thumb?: string;
  editable?: boolean;
  tracks: Track[];
  cursor?: string;
};

/** A playlist/album whose track list grows as continuation pages arrive. */
export type Collection = Omit<CollectionData, 'tracks' | 'cursor'> & {
  tracks: Accessor<Track[]>;
  hasMore: Accessor<boolean>;
  loadMore(): Promise<void>;
  loadAll(): Promise<void>;
  /** Drop a song from the loaded list (after removing it on the server). */
  dropTrack(id: string): void;
};

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  return res.json();
}

function toCollection(d: CollectionData): Collection {
  const [tracks, setTracks] = createSignal(d.tracks);
  const [cursor, setCursor] = createSignal(d.cursor);
  let inflight: Promise<void> | null = null;
  const loadMore = () => {
    const c = cursor();
    if (!c) return Promise.resolve();
    return (inflight ??= get<{ tracks: Track[]; cursor?: string }>(`/api/more/${c}`)
      .then((p) => {
        setTracks((t) => t.concat(p.tracks));
        setCursor(p.cursor);
      })
      .finally(() => (inflight = null)));
  };
  const { tracks: _, cursor: __, ...meta } = d;
  return {
    ...meta,
    tracks,
    hasMore: () => !!cursor(),
    loadMore,
    async loadAll() {
      while (cursor()) await loadMore();
    },
    dropTrack: (id: string) => setTracks((t) => t.filter((x) => x.id !== id)),
  };
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

/** Drop a cached playlist so the next visit refetches it (after adding songs). */
export const forgetCollection = (id: string) => collections.delete('playlist:' + id);

// Small in-memory cache so back/forward navigation is instant. Collections
// are capped to keep the tab's footprint small.
const collections = new Map<string, Promise<Collection>>();
const MAX_COLLECTIONS = 6;

export function collection(kind: 'playlist' | 'album', id: string): Promise<Collection> {
  const key = kind + ':' + id;
  let p = collections.get(key);
  if (p) {
    collections.delete(key);
  } else {
    p = get<CollectionData>(`/api/${kind}/${encodeURIComponent(id)}`).then(toCollection);
    p.catch(() => collections.delete(key));
  }
  collections.set(key, p);
  while (collections.size > MAX_COLLECTIONS) collections.delete(collections.keys().next().value!);
  return p;
}

export const api = {
  me: () => get<{ loggedIn: boolean }>('/api/me'),
  library: () => get<Card[]>('/api/library'),
  search: (q: string) => get<SearchAll>(`/api/search?q=${encodeURIComponent(q)}`),
  searchType: <T>(q: string, type: SearchType) =>
    get<SearchPage<T>>(`/api/search?q=${encodeURIComponent(q)}&type=${type}`),
  searchMore: <T>(cursor: string, type: SearchType) => get<SearchPage<T>>(`/api/search/more/${cursor}?type=${type}`),
  artist: (id: string) => get<ArtistPage>(`/api/artist/${encodeURIComponent(id)}`),
  browse: (m: { browseId: string; params: string }) =>
    get<Card[]>(`/api/browse?id=${encodeURIComponent(m.browseId)}&params=${encodeURIComponent(m.params)}`),
  suggest: (q: string) => get<string[]>(`/api/suggest?q=${encodeURIComponent(q)}`),
  track: (id: string) => get<Track>(`/api/track/${id}`),
  rating: (id: string) => get<Rating>(`/api/rating/${id}`),
  rate: (id: string, r: Rating) => send<{ rating: Rating }>('PUT', `/api/like/${id}?rating=${r}`),
  saveTargets: (id: string) => get<SaveTarget[]>(`/api/save/${id}`),
  addToPlaylist: (pid: string, id: string) =>
    send<{ added: boolean }>('POST', `/api/playlist/${encodeURIComponent(pid)}/add/${id}`),
  removeFromPlaylist: (pid: string, id: string) =>
    send<{ removed: boolean }>('DELETE', `/api/playlist/${encodeURIComponent(pid)}/track/${id}`),
  deletePlaylist: (id: string) => send<{ deleted: boolean }>('DELETE', `/api/playlist/${encodeURIComponent(id)}`),
  createPlaylist: (title: string, privacy: string, videoId?: string) =>
    send<{ id: string }>('POST', '/api/playlists', { title, privacy, videoId }),
  upNext: (id: string) => get<Track[]>(`/api/upnext/${id}`),
  async auth(cookie: string) {
    const res = await fetch('/api/auth', { method: 'POST', body: JSON.stringify({ cookie }) });
    if (!res.ok) throw new Error((await res.json()).error);
  },
};

const prefetched = new Set<string>();
/** Ask the server to resolve + warm the first chunk of a track. Cheap and idempotent. */
export function prefetch(id: string) {
  if (prefetched.has(id)) return;
  prefetched.add(id);
  if (prefetched.size > 200) prefetched.clear();
  fetch(`/api/prefetch/${id}`, { priority: 'low' } as RequestInit).catch(() => {});
}

/** Rewrite a thumbnail URL to the smallest size that still looks sharp at `px` CSS pixels. */
export function thumb(url: string | undefined, px: number): string | undefined {
  if (!url) return undefined;
  const s = Math.round(px * Math.min(2, devicePixelRatio || 1));
  if (url.includes('googleusercontent.com') || url.includes('ggpht.com')) {
    return url.replace(/=(w\d+-h\d+|s\d+)[^/]*$/, `=w${s}-h${s}-l90-rj`);
  }
  const m = /i\.ytimg\.com\/vi\/([\w-]{11})\//.exec(url);
  if (m) return `https://i.ytimg.com/vi/${m[1]}/${s <= 120 ? 'default' : s <= 320 ? 'mqdefault' : 'hqdefault'}.jpg`;
  return url;
}

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
