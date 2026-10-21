import { Innertube, Log, YTNodes, YTMusic } from 'youtubei.js';

Log.setLevel(Log.Level.NONE);

const COOKIE_FILE = new URL('../cookie.txt', import.meta.url).pathname;

export type Artist = { name: string; id?: string };
export type Track = {
  id: string;
  title: string;
  artists: Artist[];
  album?: { name: string; id?: string };
  duration: number;
  thumb?: string;
};
export type PlaylistCard = {
  id: string;
  kind: 'playlist' | 'album' | 'artist';
  title: string;
  subtitle: string;
  thumb?: string;
};

let authed: Innertube | null = null;
let anon: Innertube | null = null;

async function readCookie(): Promise<string> {
  if (process.env.YTM_COOKIE) return process.env.YTM_COOKIE;
  const f = Bun.file(COOKIE_FILE);
  return (await f.exists()) ? (await f.text()).trim() : '';
}

export async function init() {
  const cookie = await readCookie();
  [anon, authed] = await Promise.all([
    // Real (server-issued) visitor data is required by the VISIONOS player client.
    Innertube.create({ retrieve_player: false }),
    cookie ? Innertube.create({ cookie, retrieve_player: false }) : Promise.resolve(null),
  ]);
}

export async function setCookie(cookie: string) {
  cookie = cookie.trim().replace(/^cookie:\s*/i, '');
  const yt = await Innertube.create({ cookie, retrieve_player: false });
  if (!yt.session.logged_in) throw new Error('Cookie was not accepted');
  await Bun.write(COOKIE_FILE, cookie);
  authed = yt;
}

export const loggedIn = () => !!authed?.session.logged_in;
/** Authenticated client when available, otherwise anonymous (public data only). */
const api = () => authed ?? anon!;
export const visitorData = () => anon!.session.context.client.visitorData ?? '';

// ---------- normalisation ----------

const text = (t: any): string => (t ? (typeof t === 'string' ? t : (t.toString?.() ?? '')) : '');

function thumbOf(node: any): string | undefined {
  const list = node?.thumbnail?.contents ?? node?.thumbnail ?? node?.thumbnails;
  if (!Array.isArray(list) || !list.length) return undefined;
  return list[list.length - 1].url;
}

function artistsFromRuns(runs: any[] | undefined): Artist[] {
  if (!runs) return [];
  const out: Artist[] = [];
  for (const r of runs) {
    const id = r.endpoint?.payload?.browseId;
    if (id?.startsWith('UC')) out.push({ name: r.text, id });
  }
  return out;
}

function toTrack(it: any, fallback?: Partial<Track>): Track | null {
  const id = it.id ?? it.video_id;
  if (!id || typeof id !== 'string' || id.length !== 11) return null;
  let artists: Artist[] = (it.artists ?? it.authors ?? [])
    .map((a: any) => ({ name: a.name, id: a.channel_id }))
    .filter((a: Artist) => a.name);
  if (!artists.length) artists = artistsFromRuns(it.flex_columns?.[1]?.title?.runs);
  if (!artists.length && fallback?.artists) artists = fallback.artists;
  return {
    id,
    title: it.title?.toString?.() ?? text(it.title),
    artists,
    album: it.album?.name ? { name: it.album.name, id: it.album.id } : fallback?.album,
    duration: it.duration?.seconds ?? 0,
    thumb: thumbOf(it) ?? fallback?.thumb,
  };
}

function toCard(it: any): PlaylistCard | null {
  let id: string | undefined = it.id ?? it.endpoint?.payload?.browseId;
  if (!id) return null;
  const type = it.item_type;
  let kind: PlaylistCard['kind'];
  if (type === 'album' || id.startsWith('MPRE')) kind = 'album';
  else if (type === 'artist' || type === 'library_artist' || id.startsWith('UC')) kind = 'artist';
  else if (type === 'playlist' || id.startsWith('VL') || id === 'LM') kind = 'playlist';
  else return null;
  if (kind === 'playlist' && id.startsWith('VL')) id = id.slice(2);
  return {
    id,
    kind,
    title: text(it.title) || it.name || '',
    subtitle: text(it.subtitle) || [it.author?.name, it.item_count].filter(Boolean).join(' • '),
    thumb: thumbOf(it),
  };
}

// ---------- library ----------

export async function library(): Promise<PlaylistCard[]> {
  if (!authed) return [];
  const resp = await authed.actions.execute('/browse', {
    browseId: 'FEmusic_liked_playlists',
    client: 'YTMUSIC',
  });
  let lib: YTMusic.Library | YTMusic.LibraryContinuation = new YTMusic.Library(resp, authed.actions);
  const items: any[] = [...(lib.page.contents_memo?.getType(YTNodes.MusicTwoRowItem) ?? [])];
  try {
    for (let i = 0; i < 20 && lib.has_continuation; i++) {
      lib = await lib.getContinuation();
      items.push(...((lib.contents as any)?.contents ?? []));
    }
  } catch {
    // Keep whatever pages we already have.
  }
  const seen = new Set<string>();
  const cards: PlaylistCard[] = [];
  for (const it of items) {
    const c = toCard(it);
    if (c && c.kind === 'playlist' && !seen.has(c.id)) {
      seen.add(c.id);
      cards.push(c);
    }
  }
  // Liked Music always first, like the official client.
  const li = cards.findIndex((c) => c.id === 'LM');
  if (li > 0) cards.unshift(cards.splice(li, 1)[0]);
  else if (li < 0) cards.unshift({ id: 'LM', kind: 'playlist', title: 'Liked Music', subtitle: 'Auto playlist' });
  return cards;
}

// ---------- playlists / albums (with continuation cursors) ----------

type Page = { tracks: Track[]; cursor?: string };
export type Collection = Page & {
  id: string;
  kind: 'playlist' | 'album';
  title: string;
  subtitle: string;
  artists?: Artist[];
  meta: string;
  description?: string;
  thumb?: string;
  /** The signed-in account owns it (can delete it). */
  editable?: boolean;
};

type Continuable = { has_continuation: boolean; getContinuation(): Promise<any> };
const cursors = new Map<string, { obj: Continuable; expires: number }>();
function storeCursor(obj: Continuable): string | undefined {
  if (!obj.has_continuation) return undefined;
  const now = Date.now();
  for (const [k, v] of cursors) if (v.expires < now) cursors.delete(k);
  const key = crypto.randomUUID();
  cursors.set(key, { obj, expires: now + 15 * 60_000 });
  return key;
}
function takeCursor(cursor: string) {
  const c = cursors.get(cursor);
  if (!c) throw new Error('Cursor expired');
  cursors.delete(cursor);
  return c.obj;
}

const pageTracks = (pl: YTMusic.Playlist) =>
  pl.items.map((i) => toTrack(i)).filter((t): t is Track => !!t);

export async function playlist(id: string): Promise<Collection> {
  const pl = await api().music.getPlaylist(id);
  const h: any = pl.header;
  return {
    id,
    kind: 'playlist',
    title: text(h?.title) || (id === 'LM' ? 'Liked Music' : 'Playlist'),
    subtitle: [text(h?.subtitle), text(h?.strapline_text_one)].filter((s) => s && s !== 'N/A').join(' • '),
    meta: text(h?.second_subtitle),
    description: text(h?.description?.description) || undefined,
    thumb: thumbOf(h),
    tracks: pageTracks(pl),
    cursor: storeCursor(pl),
    editable: !!(pl as any).page?.contents_memo?.has('MusicEditablePlaylistDetailHeader'),
  };
}

export async function more(cursor: string): Promise<Page> {
  const next: YTMusic.Playlist = await takeCursor(cursor).getContinuation();
  return { tracks: pageTracks(next), cursor: storeCursor(next) };
}

export async function album(id: string): Promise<Collection> {
  const al = await api().music.getAlbum(id);
  const h: any = al.header;
  const thumb = thumbOf(h);
  const artists = artistsFromRuns(h?.strapline_text_one?.runs);
  const albumRef = { name: text(h?.title), id };
  return {
    id,
    kind: 'album',
    title: text(h?.title),
    subtitle: artists.length ? text(h?.subtitle) : [text(h?.subtitle), text(h?.strapline_text_one)].filter(Boolean).join(' • '),
    artists,
    meta: text(h?.second_subtitle),
    description: text(h?.description?.description) || undefined,
    thumb,
    tracks: al.contents
      .map((i) => toTrack(i, { artists, album: albumRef, thumb }))
      .filter((t): t is Track => !!t),
  };
}

// ---------- artists ----------

export type Shelf = { title: string; items: PlaylistCard[]; more?: { browseId: string; params: string } };

export async function artist(id: string) {
  const a = await api().music.getArtist(id);
  const h: any = a.header;
  let topSongs: Track[] = [];
  let allSongs: string | undefined;
  const shelves: Shelf[] = [];
  for (const s of a.sections as any[]) {
    const title = text(s.header?.title ?? s.title);
    if (s.type === 'MusicShelf') {
      topSongs = s.contents.map((i: any) => toTrack(i)).filter(Boolean);
      const b = s.endpoint?.payload?.browseId as string | undefined;
      if (b?.startsWith('VL')) allSongs = b.slice(2);
      continue;
    }
    // Cards only: video carousels drop out here (toCard returns null for videos).
    const items = (s.contents ?? []).map(toCard).filter(Boolean) as PlaylistCard[];
    if (!items.length) continue;
    const ep = s.header?.more_content?.endpoint?.payload;
    shelves.push({ title, items, more: ep?.browseId && ep.params ? { browseId: ep.browseId, params: ep.params } : undefined });
  }
  return {
    id,
    name: text(h?.title),
    thumb: thumbOf(h),
    description: text(h?.description) || undefined,
    subscribers: text(h?.subscription_button?.subscriber_count) || undefined,
    topSongs,
    allSongs,
    shelves,
  };
}

/** "See all" for an artist shelf (full album / singles discography, etc.). */
export async function browseMore(browseId: string, params: string): Promise<PlaylistCard[]> {
  if (!/^(MPAD|UC|VL)/.test(browseId)) throw new Error('unsupported browse id');
  const r = await api().actions.execute('/browse', { browseId, params, client: 'YTMUSIC', parse: true });
  return (r.contents_memo?.getType(YTNodes.MusicTwoRowItem) ?? []).map(toCard).filter(Boolean) as PlaylistCard[];
}

// ---------- search / radio ----------

const SEARCH_TYPES = { songs: 'song', albums: 'album', artists: 'artist', playlists: 'playlist' } as const;
export type SearchType = keyof typeof SEARCH_TYPES;

const shelfItems = (s: any) => (s?.contents?.[0]?.contents ?? []) as any[];
const toResult = (type: SearchType, items: any[]) =>
  type === 'songs' ? items.map((i) => toTrack(i)).filter(Boolean) : items.map(toCard).filter(Boolean);

/** Everything at once (a few of each), like the "All" tab. */
export async function search(q: string) {
  const yt = api();
  const types = Object.keys(SEARCH_TYPES) as SearchType[];
  const res = await Promise.all(types.map((t) => yt.music.search(q, { type: SEARCH_TYPES[t] }).catch(() => null)));
  const limits = { songs: 8, albums: 12, artists: 6, playlists: 12 };
  return Object.fromEntries(types.map((t, i) => [t, toResult(t, shelfItems(res[i])).slice(0, limits[t])]));
}

/** One category, paged. */
export async function searchType(q: string, type: SearchType) {
  if (!(type in SEARCH_TYPES)) throw new Error('bad type');
  const r = await api().music.search(q, { type: SEARCH_TYPES[type] });
  return { items: toResult(type, shelfItems(r)), cursor: storeCursor(r) };
}

export async function searchMore(cursor: string, type: SearchType) {
  const r = await takeCursor(cursor).getContinuation();
  const items = (r.contents as any)?.contents ?? [];
  return { items: toResult(type, items), cursor: storeCursor(r) };
}

export async function suggestions(q: string): Promise<string[]> {
  const sections = await api().music.getSearchSuggestions(q);
  const out: string[] = [];
  for (const s of sections)
    for (const c of s.contents as any[]) {
      const t = c.suggestion?.toString?.();
      if (t) out.push(t);
    }
  return out.slice(0, 8);
}

function panelTrack(it: any): Track | null {
  if (!it.video_id) return null;
  return {
    id: it.video_id,
    title: text(it.title),
    artists: (it.artists ?? []).map((a: any) => ({ name: a.name, id: a.channel_id })),
    album: it.album ? { name: it.album.name, id: it.album.id } : undefined,
    duration: it.duration?.seconds ?? 0,
    thumb: thumbOf(it),
  } as Track;
}

export async function upNext(id: string): Promise<Track[]> {
  const panel = await api().music.getUpNext(id, true);
  return panel.contents.map(panelTrack).filter((t): t is Track => !!t);
}

/** One song by id (the head of its non-automix queue). */
export async function track(id: string): Promise<Track> {
  const panel = await api().music.getUpNext(id, false);
  const t = panel.contents.map(panelTrack).find((t) => t?.id === id);
  if (t) return t;
  const b = (await api().music.getInfo(id)).basic_info;
  if (!b.title) throw Object.assign(new Error('Song not found'), { status: 404 });
  return {
    id,
    title: b.title,
    artists: [{ name: b.author ?? '', id: b.channel_id }],
    duration: b.duration ?? 0,
    thumb: b.thumbnail?.[0]?.url,
  };
}

// ---------- likes & playlists ----------

export type Rating = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';

const signedIn = () => {
  if (!authed) throw Object.assign(new Error('Sign in first'), { status: 401 });
  return authed;
};

export async function rating(id: string): Promise<Rating> {
  if (!authed) return 'INDIFFERENT';
  const r: any = await authed.actions.execute('/next', { videoId: id, client: 'YTMUSIC' });
  return (JSON.stringify(r.data).match(/"likeStatus":"(LIKE|DISLIKE|INDIFFERENT)"/)?.[1] as Rating) ?? 'INDIFFERENT';
}

export async function rate(id: string, r: Rating) {
  const path = r === 'LIKE' ? '/like/like' : r === 'DISLIKE' ? '/like/dislike' : '/like/removelike';
  await signedIn().actions.execute(path, { target: { videoId: id }, client: 'YTMUSIC' });
}

export type SaveTarget = { id: string; title: string; subtitle: string; thumb?: string };

/** Playlists the account can add `id` to (Liked Music is the like button, so it's left out). */
export async function saveTargets(id: string): Promise<SaveTarget[]> {
  const r: any = await signedIn().actions.execute('/playlist/get_add_to_playlist', { videoIds: [id], client: 'YTMUSIC' });
  const list = r.data.contents?.[0]?.addToPlaylistRenderer?.playlists ?? [];
  return list
    .map((x: any) => x.playlistAddToOptionRenderer)
    .filter((o: any) => o?.playlistId && o.playlistId !== 'LM')
    .map((o: any) => ({
      id: o.playlistId,
      title: o.title?.runs?.map((t: any) => t.text).join('') ?? '',
      subtitle: o.shortBylineText?.simpleText ?? o.shortBylineText?.runs?.map((t: any) => t.text).join('') ?? '',
      thumb: thumbOf(o.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail),
    }));
}

/** Adds a song; with the dedupe check YouTube refuses songs that are already there. */
export async function addToPlaylist(playlistId: string, videoId: string): Promise<{ added: boolean }> {
  const r: any = await signedIn().actions.execute('/browse/edit_playlist', {
    playlistId,
    actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId, dedupeOption: 'DEDUPE_OPTION_CHECK' }],
    client: 'YTMUSIC',
  });
  return { added: r.data?.status === 'STATUS_SUCCEEDED' };
}

export async function createPlaylist(title: string, privacy: string, videoId?: string): Promise<{ id: string }> {
  const r: any = await signedIn().actions.execute('/playlist/create', {
    title,
    privacyStatus: ['PUBLIC', 'UNLISTED', 'PRIVATE'].includes(privacy) ? privacy : 'PRIVATE',
    videoIds: videoId ? [videoId] : [],
    client: 'YTMUSIC',
  });
  return { id: r.data.playlistId };
}

export async function deletePlaylist(id: string) {
  await signedIn().actions.execute('/playlist/delete', { playlistId: id, client: 'YTMUSIC' });
}

/** Removes every copy of a song from a playlist. */
export async function removeFromPlaylist(playlistId: string, videoId: string) {
  const r: any = await signedIn().actions.execute('/browse/edit_playlist', {
    playlistId,
    actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }],
    client: 'WEB',
  });
  if (r.data?.status !== 'STATUS_SUCCEEDED') throw new Error("Couldn't remove the song");
}
