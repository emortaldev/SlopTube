import type { Fmt, Prefs } from '../shared/formats';

export type Channel = { name: string; id?: string; avatar?: string };
export type Card = {
  kind: 'video' | 'playlist';
  id: string;
  videoId?: string;
  title: string;
  thumb?: string;
  duration?: string;
  channel?: Channel;
  views?: string;
  published?: string;
  badge?: string;
  snippet?: string;
};
export type Page = { items: Card[]; cont?: string };
export type Storyboard = { url: string; w: number; h: number; count: number; cols: number; rows: number; interval: number };
export type Details = {
  title: string;
  author: string;
  channelId: string;
  lengthSeconds: number;
  viewCount: string;
  storyboard?: Storyboard;
};
export type Rating = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';
export type DownloadOption = { key: string; label: string; detail: string; ext: string; size: number };
export type Watch = {
  id: string;
  title: string;
  views: string;
  date: string;
  relativeDate: string;
  likes?: string;
  rating: Rating;
  channel: Channel & { subscribers?: string };
  description: string;
  related: Card[];
  relatedCont?: string;
  playlist?: { id: string; title: string; author: string; index: number; items: Card[] };
};
export type Comment = {
  id: string;
  author: string;
  authorId?: string;
  avatar?: string;
  text: string;
  published: string;
  likes: string;
  replies: number;
  repliesKey?: string;
  pinned: boolean;
  byOwner: boolean;
};
export type ChannelPage = {
  id: string;
  name: string;
  description: string;
  avatar?: string;
  banner?: string;
  meta: string[];
  videos: Card[];
  cont?: string;
};

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  return res.json();
}
const enc = encodeURIComponent;

export const api = {
  me: () => get<{ loggedIn: boolean }>('/api/me'),
  home: () => get<Page>('/api/home'),
  subscriptions: () => get<Page>('/api/subscriptions'),
  guide: () => get<Channel[]>('/api/guide'),
  browseMore: (t: string) => get<Page>(`/api/browse/more?t=${enc(t)}`),
  search: (q: string) => get<Page>(`/api/search?q=${enc(q)}`),
  searchMore: (t: string) => get<Page>(`/api/search/more?t=${enc(t)}`),
  suggest: (q: string) => get<string[]>(`/api/suggest?q=${enc(q)}`),
  watch: (id: string, list?: string) => get<Watch>(`/api/watch/${id}${list ? `?list=${enc(list)}` : ''}`),
  relatedMore: (t: string) => get<Page>(`/api/related/more?t=${enc(t)}`),
  comments: (id: string) => get<{ count?: string; items: Comment[]; cursor?: string }>(`/api/comments/${id}`),
  commentsMore: (c: string) => get<{ items: Comment[]; cursor?: string }>(`/api/comments/more/${c}`),
  replies: (k: string) => get<{ items: Comment[]; more: boolean }>(`/api/replies/${k}`),
  channel: (id: string) => get<ChannelPage>(`/api/channel/${enc(id)}`),
  channelSearch: (id: string, q: string) => get<Page>(`/api/channel/${enc(id)}/search?q=${enc(q)}`),
  play: (id: string, p: Prefs, signal?: AbortSignal) =>
    get<{ formats: Fmt[]; details: Details }>(`/api/play/${id}?codec=${p.codec}&h=${p.maxHeight}`, { signal }),
  rate: (id: string, rating: Rating) => get<{ rating: Rating }>(`/api/like/${id}?rating=${rating}`, { method: 'PUT' }),
  downloadOptions: (id: string) => get<DownloadOption[]>(`/api/download/${id}/options`),
  downloadUrl: (id: string, key: string) => `/api/download/${id}?opt=${key}`,
  watchLater: () => get<Page>('/api/watchlater'),
  watchLaterIds: () => get<string[]>('/api/watchlater/ids'),
  setWatchLater: (id: string, on: boolean) => get<{ saved: boolean }>(`/api/watchlater/${id}`, { method: on ? 'PUT' : 'DELETE' }),
  watched: (id: string) => fetch(`/api/watched/${id}`, { method: 'POST' }).catch(() => {}),
  async auth(cookie: string) {
    const res = await fetch('/api/auth', { method: 'POST', body: JSON.stringify({ cookie }) });
    if (!res.ok) throw new Error((await res.json()).error);
  },
};

let prefsForPrefetch: Prefs = { codec: 'vp9', maxHeight: 1080 };
export const setPrefetchPrefs = (p: Prefs) => (prefsForPrefetch = p);

const prefetched = new Set<string>();
/** Resolve + warm the streams and watch-page data for a video (hover intent). */
export function prefetch(id: string) {
  if (prefetched.has(id)) return;
  prefetched.add(id);
  if (prefetched.size > 300) prefetched.clear();
  const p = prefsForPrefetch;
  fetch(`/api/prefetch/${id}?codec=${p.codec}&h=${p.maxHeight}`, { priority: 'low' } as RequestInit).catch(() => {});
}

/** ytimg/ggpht avatar URLs carry their size; request what we display. */
export function avatar(url: string | undefined, px: number) {
  if (!url) return undefined;
  const s = Math.round(px * Math.min(2, devicePixelRatio || 1));
  return url.replace(/=s\d+-/, `=s${s}-`);
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
