import { Constants, Helpers, Innertube, Log, Parser, YTNodes } from 'youtubei.js';
import type { SearchFilters } from '../shared/search';

Log.setLevel(Log.Level.NONE);

const COOKIE_FILE = new URL('../cookie.txt', import.meta.url).pathname;
/** Set YT_HISTORY=0 to stop adding watched videos to your YouTube history. */
const HISTORY = process.env.YT_HISTORY !== '0';

let authed: Innertube | null = null;
let anon: Innertube | null = null;

async function readCookie() {
  if (process.env.YT_COOKIE) return process.env.YT_COOKIE;
  const f = Bun.file(COOKIE_FILE);
  return (await f.exists()) ? (await f.text()).trim() : '';
}

export async function init() {
  const cookie = await readCookie();
  [anon, authed] = await Promise.all([
    // Real (server-issued) visitor data is required by the VISIONOS stream client.
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
  homeCache = null;
}

export const loggedIn = () => !!authed?.session.logged_in;
export const visitorData = () => anon!.session.context.client.visitorData ?? '';
const api = () => authed ?? anon!;

// ---------- normalisation ----------

export type Channel = { name: string; id?: string; avatar?: string };
export type Card = {
  kind: 'video' | 'playlist' | 'channel';
  id: string; // video id, playlist id for playlists, channel id for channels
  videoId?: string; // first video of a playlist / mix
  title: string;
  thumb?: string;
  duration?: string;
  channel?: Channel;
  views?: string;
  published?: string;
  badge?: string; // "Mix", "24 videos"
  snippet?: string;
  progress?: number; // % watched, from the signed-in account's history
  handle?: string; // channels only: "@name"
  subscribers?: string; // channels only
};

const text = (t: any): string => (t == null ? '' : typeof t === 'string' ? t : (t.toString?.() ?? t.text ?? ''));

/** Image closest to (but not below) the wanted width. */
function pickImage(list: any[] | undefined, want = 360): string | undefined {
  if (!list?.length) return undefined;
  const sorted = list.filter((i) => i?.url).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= want) ?? sorted[sorted.length - 1])?.url;
}

const isDuration = (s: string) => /^\d+(:\d\d)+$/.test(s);
const withViews = (s: string) => (/^[\d.,]+\s?[KMB]?$/i.test(s) ? `${s} views` : s);

function find(o: any, pred: (x: any) => boolean, depth = 0): any {
  if (!o || typeof o !== 'object' || depth > 8) return undefined;
  if (pred(o)) return o;
  for (const k in o) {
    const r = find(o[k], pred, depth + 1);
    if (r) return r;
  }
  return undefined;
}

/** Resume position (%) from either thumbnail overlay shape: lockups' progress bar or classic renderers' resume overlay. */
function watchedPercent(overlays: any[] | undefined): number | undefined {
  for (const o of overlays ?? []) {
    const pct = o.progress_bar?.start_percent ?? o.percent_duration_watched;
    if (typeof pct === 'number' && pct > 0) return pct;
  }
  return undefined;
}

function fromLockup(l: any): Card | null {
  const type = l.content_type;
  if (type !== 'VIDEO' && type !== 'PLAYLIST') return null;
  const tv = l.content_image?.primary_thumbnail ?? l.content_image;
  const badges: any[] = (tv?.overlays ?? []).flatMap((o: any) => o.badges ?? (o.badge ? [o.badge] : []));
  const badgeText = badges.map((b) => text(b.text)).filter(Boolean);
  const live = badges.some((b) => /LIVE/.test(b.badge_style ?? '') || /^(LIVE|UPCOMING|PREMIERE)/i.test(text(b.text)));
  if (live) return null;
  const meta = l.metadata;
  const parts: any[] = (meta?.metadata?.metadata_rows ?? []).flatMap((r: any) => r.metadata_parts ?? []);
  let channel: Channel | undefined;
  const rest: string[] = [];
  for (const p of parts) {
    const t = text(p.text);
    const bid = (p.text?.endpoint ?? p.text?.runs?.find((r: any) => r.endpoint)?.endpoint)?.payload?.browseId;
    if (!channel && bid?.startsWith('UC')) channel = { name: t, id: bid };
    else if (t) rest.push(t);
  }
  if (channel) channel.avatar = pickImage(meta?.image?.avatar?.image ?? meta?.image?.image, 68);
  const card: Card = {
    kind: type === 'VIDEO' ? 'video' : 'playlist',
    id: l.content_id,
    title: text(meta?.title),
    thumb: pickImage(tv?.image),
    channel,
  };
  if (card.kind === 'video') {
    const dur = badgeText.find(isDuration);
    if (!dur) return null; // live/upcoming/shorts have no duration badge
    card.duration = dur;
    card.progress = watchedPercent(tv?.overlays) ?? watchedPercent(l.content_image?.overlays);
    if (!channel && rest.length > 2) card.channel = { name: rest.shift()! };
    card.views = rest[0] ? withViews(rest[0]) : undefined;
    card.published = rest[1];
  } else {
    card.badge = badgeText.find((t) => !isDuration(t));
    card.videoId = find(l.renderer_context ?? l.on_tap, (x) => typeof x?.videoId === 'string')?.videoId;
    if (!card.videoId && card.id.startsWith('RD') && card.id.length === 13) card.videoId = card.id.slice(2);
    card.views = rest.join(' • ') || undefined;
    if (!card.videoId) return null;
  }
  return card;
}

function fromVideo(v: any): Card | null {
  if (!v.id || v.is_live || v.is_upcoming) return null;
  const duration = text(v.length_text) || (v.duration?.text ?? '');
  if (!isDuration(duration)) return null;
  return {
    kind: 'video',
    id: v.id,
    title: text(v.title),
    thumb: pickImage(v.thumbnails, 360),
    duration,
    channel: v.author ? { name: v.author.name, id: v.author.id, avatar: pickImage(v.author.thumbnails, 68) } : undefined,
    views: text(v.short_view_count) ? withViews(text(v.short_view_count)) : text(v.view_count),
    published: text(v.published),
    snippet: text(v.description_snippet) || text(v.snippets?.[0]?.text) || undefined,
    progress: watchedPercent(v.thumbnail_overlays),
  };
}

function fromPlaylistVideo(v: any): Card | null {
  const duration = v.duration?.text ?? '';
  if (!v.id || !isDuration(duration)) return null; // deleted/private entries have no duration
  const [views, published] = text(v.video_info).split(' • ');
  return {
    kind: 'video',
    id: v.id,
    title: text(v.title),
    thumb: pickImage(v.thumbnails, 168),
    duration,
    channel: v.author ? { name: v.author.name, id: v.author.id } : undefined,
    views: views ? withViews(views) : undefined,
    published,
  };
}

/** Search channel result. YouTube puts the @handle in subscriber_count and the subscriber count in video_count, so sort the texts by content. */
function fromChannel(c: any): Card | null {
  if (!c.id) return null;
  const texts = [c.subscriber_count, c.video_count].map(text).filter(Boolean);
  const avatar = pickImage(c.author?.thumbnails, 136);
  return {
    kind: 'channel',
    id: c.id,
    title: c.author?.name ?? '',
    thumb: avatar?.startsWith('//') ? `https:${avatar}` : avatar,
    handle: texts.find((t) => t.startsWith('@')),
    subscribers: texts.find((t) => /subscriber/i.test(t)),
    snippet: text(c.description_snippet) || undefined,
  };
}

const WANT = new Set(['LockupView', 'Video', 'Channel', 'CompactVideo', 'GridVideo', 'PlaylistVideo', 'ContinuationItem']);
const STOP = new Set(['ShortsLockupView', 'ReelShelf', 'ReelItem', 'Post', 'BackstagePost', 'RelatedChipCloud', 'ChipCloud']);
const SKIP_KEYS = new Set(['endpoint', 'on_tap', 'menu', 'overlays', 'buttons', 'command', 'renderer_context', 'content_image', 'metadata', 'thumbnails', 'author', 'title']);

/** Collect cards + the continuation token from any parsed response subtree, in document order.
 *  Channel results are only kept when asked for: other feeds render every card as a video. */
function collect(root: any, opts: { channels?: boolean } = {}): { items: Card[]; cont?: string } {
  const nodes: any[] = [];
  const walk = (n: any, depth: number) => {
    if (!n || typeof n !== 'object' || depth > 24) return;
    if (n instanceof Helpers.SuperParsedResult) {
      // Wrapper with private storage: unwrap to the node or array it holds.
      if (n.is_array) walk(n.array(), depth + 1);
      else if (n.is_node) walk(n.item(), depth + 1);
      return;
    }
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1);
      return;
    }
    if (n.type && STOP.has(n.type)) return;
    if (n.type && WANT.has(n.type)) {
      nodes.push(n);
      return;
    }
    for (const k in n) if (!SKIP_KEYS.has(k) && k !== 'contents_memo') walk(n[k], depth + 1);
  };
  walk(root, 0);
  const items: Card[] = [];
  const seen = new Set<string>();
  let cont: string | undefined;
  for (const n of nodes) {
    if (n.type === 'ContinuationItem') {
      // Usually a plain continuationCommand; playlists wrap it in a commandExecutorCommand.
      cont =
        n.endpoint?.payload?.token ??
        find(n.endpoint?.payload, (x) => typeof x?.continuationCommand?.token === 'string')?.continuationCommand.token ??
        cont;
      continue;
    }
    const c =
      n.type === 'Channel'
        ? opts.channels
          ? fromChannel(n)
          : null
        : n.type === 'LockupView'
          ? fromLockup(n)
          : n.type === 'PlaylistVideo'
            ? fromPlaylistVideo(n)
            : fromVideo(n);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      items.push(c);
    }
  }
  return { items, cont };
}

// ---------- feeds ----------

/**
 * Home is served stale-while-revalidate: the first request waits for YouTube
 * (~1.5s); afterwards each visit gets the feed fetched in the background after
 * the previous visit, so it renders instantly and is still fresh.
 */
let homeCache: { data: Promise<{ items: Card[]; cont?: string }>; at: number } | null = null;
const fetchHome = () =>
  api()
    .actions.execute('/browse', { browseId: 'FEwhat_to_watch', client: 'WEB', parse: true })
    .then((r: any) => collect(r.contents));

export async function home() {
  if (!authed) return { items: [], cont: undefined };
  const fresh = homeCache && Date.now() - homeCache.at < 10 * 60_000;
  const p = fresh ? homeCache!.data : fetchHome();
  const next = fetchHome();
  next.catch(() => {});
  homeCache = { data: next, at: Date.now() };
  return p;
}
export function warmHome() {
  if (authed && !homeCache) homeCache = { data: fetchHome(), at: Date.now() };
  homeCache?.data.catch(() => (homeCache = null));
}

export async function subscriptions() {
  if (!authed) return { items: [], cont: undefined };
  const r: any = await authed.actions.execute('/browse', { browseId: 'FEsubscriptions', client: 'WEB', parse: true });
  return collect(r.contents);
}

/** Continuation for any browse feed (home, subscriptions, channel videos). */
export async function browseMore(token: string) {
  const r: any = await api().actions.execute('/browse', { continuation: token, client: 'WEB', parse: true });
  return collect([r.on_response_received_actions, r.on_response_received_endpoints, r.continuation_contents]);
}

// SearchFilter protobuf field numbers / enum values (youtubei.js doesn't export its encoder).
const DATE_ENUM = { today: 2, week: 3, month: 4, year: 5 };
const TYPE_ENUM = { video: 1, channel: 2, playlist: 3, movie: 4 };
const DURATION_ENUM = { over_twenty_mins: 2, under_three_mins: 4, three_to_twenty_mins: 5 };
const FEATURE_FIELD = { hd: 4, subtitles: 5, creative_commons: 6, '3d': 7, purchased: 9, '4k': 14, '360': 15, location: 23, hdr: 25, vr180: 26 };

const varint = (n: number) => {
  const out: number[] = [];
  for (; n > 0x7f; n >>>= 7) out.push((n & 0x7f) | 0x80);
  out.push(n);
  return out;
};
const field = (num: number, v: number) => [...varint(num << 3), ...varint(v)];

/** The `params` blob YouTube's search filter menu sends, or undefined when no filter is set. */
function searchParams(f: SearchFilters) {
  const inner = [
    ...(f.date ? field(1, DATE_ENUM[f.date]) : []),
    ...(f.type ? field(2, TYPE_ENUM[f.type]) : []),
    ...(f.duration ? field(3, DURATION_ENUM[f.duration]) : []),
    ...(f.features ?? []).flatMap((x) => field(FEATURE_FIELD[x], 1)),
  ];
  if (!inner.length && !f.sort) return undefined;
  const bytes = [
    ...(f.sort ? field(1, 3) : []),
    ...(inner.length ? [...varint((2 << 3) | 2), ...varint(inner.length), ...inner] : []),
  ];
  return btoa(String.fromCharCode(...bytes));
}

export async function search(q: string, f: SearchFilters = {}) {
  const query = [q, f.after && `after:${f.after}`, f.before && `before:${f.before}`].filter(Boolean).join(' ');
  const r: any = await api().actions.execute('/search', { query, params: searchParams(f), client: 'WEB', parse: true });
  return collect(r.contents, { channels: true });
}
export async function searchMore(token: string) {
  const r: any = await api().actions.execute('/search', { continuation: token, client: 'WEB', parse: true });
  return collect([r.on_response_received_commands, r.on_response_received_actions, r.continuation_contents], { channels: true });
}

export const suggest = (q: string) => api().getSearchSuggestions(q);

// ---------- watch page ----------

export type Rating = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';
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

const watchCache = new Map<string, { at: number; p: Promise<Watch> }>();

async function fetchWatch(id: string, list?: string): Promise<Watch> {
  const r: any = await api().actions.execute('/next', {
    videoId: id,
    ...(list ? { playlistId: list } : {}),
    client: 'WEB',
    parse: true,
  });
  const memo = r.contents_memo;
  const p: any = memo?.getType(YTNodes.VideoPrimaryInfo)?.[0];
  const s: any = memo?.getType(YTNodes.VideoSecondaryInfo)?.[0];
  const likeBtn = find(p?.menu, (x) => x?.type === 'LikeButtonView' || x?.type === 'SegmentedLikeDislikeButtonView');
  const likes = text(likeBtn?.like_count_text ?? likeBtn?.like_button?.toggle_button?.default_button?.title ?? '') || undefined;
  const two: any = r.contents instanceof Helpers.SuperParsedResult ? r.contents.item() : r.contents;
  const rel = collect(two?.secondary_results);
  let playlist: Watch['playlist'];
  if (two?.playlist) {
    const pl = two.playlist;
    playlist = {
      id: pl.id,
      title: text(pl.title),
      author: text(pl.author?.name ?? pl.author),
      index: pl.current_index ?? 0,
      items: (pl.contents ?? [])
        .filter((v: any) => v.video_id)
        .map(
          (v: any): Card => ({
            kind: 'video',
            id: v.video_id,
            title: text(v.title),
            thumb: pickImage(v.thumbnail, 120),
            duration: v.duration?.text,
            channel: { name: text(v.author) },
          }),
        ),
    };
  }
  return {
    id,
    title: text(p?.title),
    views: text(p?.view_count?.view_count ?? p?.view_count?.original_view_count ?? p?.view_count),
    date: text(p?.published),
    relativeDate: text(p?.relative_date),
    likes,
    rating: (memo?.getType(YTNodes.LikeButtonView)?.[0] as any)?.like_status_entity?.like_status ?? 'INDIFFERENT',
    channel: {
      name: s?.owner?.author?.name ?? '',
      id: s?.owner?.author?.id,
      avatar: pickImage(s?.owner?.author?.thumbnails, 48),
      subscribers: text(s?.owner?.subscriber_count) || undefined,
    },
    description: text(s?.description ?? s?.attributed_description),
    related: rel.items,
    relatedCont: rel.cont,
    playlist,
  };
}

export function watch(id: string, list?: string): Promise<Watch> {
  const key = id + ':' + (list ?? '');
  const hit = watchCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p;
  const p = fetchWatch(id, list);
  watchCache.set(key, { at: Date.now(), p });
  p.catch(() => watchCache.delete(key));
  if (watchCache.size > 50) watchCache.delete(watchCache.keys().next().value!);
  return p;
}

export async function relatedMore(token: string) {
  const r: any = await api().actions.execute('/next', { continuation: token, client: 'WEB', parse: true });
  return collect([r.on_response_received_endpoints, r.on_response_received_actions, r.continuation_contents]);
}

/**
 * One playback session per video: the history entry and the watch-time pings
 * must share its cpn, or YouTube doesn't tie the progress to the view.
 */
type Session = {
  info: Promise<Awaited<ReturnType<Innertube['getBasicInfo']>>>;
  started: number;
  expires: number;
};
const sessions = new Map<string, Session>();

function session(id: string) {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
  let s = sessions.get(id);
  if (!s) {
    const info = authed!.getBasicInfo(id).then(async (i) => (await i.addToWatchHistory(), i));
    info.catch(() => sessions.delete(id));
    s = { info, started: now, expires: 0 };
    sessions.set(id, s);
  }
  s.expires = now + 6 * 3600_000;
  return s;
}

/**
 * Where youtube.com would resume this video for the signed-in account (seconds),
 * from the player response's playbackStartConfig. The anonymous stream client
 * can't see it, so this is a separate, lightweight WEB /player call.
 */
export async function resumePoint(id: string): Promise<number | undefined> {
  if (!authed?.session.logged_in) return undefined;
  const r: any = await authed.actions.execute('/player', { videoId: id, client: 'WEB' });
  const s = Number(r.data?.playerConfig?.playbackStartConfig?.startSeconds);
  return s > 0 ? s : undefined;
}

/** Record a view in the signed-in account's watch history, like youtube.com does. */
export async function markWatched(id: string) {
  if (!authed || !HISTORY) return;
  await session(id).info;
}

/**
 * Report a span actually played (seconds, st..et; et is also the current
 * position) so YouTube's resume point and red progress bar follow it. Shaped
 * like the web player's watch-time ping, with the session's real time (rt):
 * YouTube appears to ignore spans longer than the time that has passed.
 * youtubei.js's updateWatchTime always sends final=1, which YouTube treats as
 * finished (100%), so that's only sent at the end. YouTube only keeps resume
 * points for longer videos; short ones stay at "started" until finished.
 */
export async function reportProgress(id: string, st: number, et: number, ended = false) {
  if (!authed || !HISTORY || !(st >= 0) || !(et >= st)) return;
  const s = session(id);
  const info: any = await s.info;
  const t = et;
  const url = info.page[0].playback_tracking.videostats_watchtime_url.replace('https://s.', 'https://www.');
  const client = { client_name: Constants.CLIENTS.WEB.NAME, client_version: Constants.CLIENTS.WEB.VERSION };
  const res: Response = await authed.actions.stats(url, client, {
    cpn: info.cpn,
    st: st.toFixed(3),
    et: t.toFixed(3),
    cmt: t.toFixed(3),
    rt: ((Date.now() - s.started) / 1000).toFixed(3),
    state: ended ? 'paused' : 'playing',
    ...(ended && { final: '1' }),
  });
  if (!res.ok) throw new Error(`watchtime ping ${res.status}`);
}

// ---------- comments (cursor-based) ----------

type Continuable = { has_continuation: boolean; getContinuation(): Promise<any> };
const cursors = new Map<string, { obj: any; expires: number }>();
function store(obj: any): string {
  const now = Date.now();
  for (const [k, v] of cursors) if (v.expires < now) cursors.delete(k);
  const key = crypto.randomUUID();
  cursors.set(key, { obj, expires: now + 30 * 60_000 });
  return key;
}
function take(key: string) {
  const c = cursors.get(key);
  if (!c) throw new Error('Cursor expired');
  return c.obj;
}

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

function toComment(thread: any): Comment | null {
  const c = thread.comment ?? thread;
  if (!c?.comment_id) return null;
  const replies = Number(String(c.reply_count ?? '0').replace(/\D/g, '')) || 0;
  return {
    id: c.comment_id,
    author: c.author?.name ?? '',
    authorId: c.author?.id,
    avatar: pickImage(c.author?.thumbnails, 40),
    text: text(c.content),
    published: text(c.published_time),
    likes: text(c.like_count) || '',
    replies,
    repliesKey: replies && thread.comment ? store(thread) : undefined,
    pinned: !!c.is_pinned,
    byOwner: !!c.author_is_channel_owner,
  };
}

const commentsPage = (c: any & Continuable) => ({
  items: (c.contents ?? []).map(toComment).filter(Boolean) as Comment[],
  cursor: c.has_continuation ? store(c) : undefined,
});

export async function comments(id: string) {
  const c = await api().getComments(id);
  return { count: text(c.header?.count) || undefined, ...commentsPage(c) };
}
export async function commentsMore(cursor: string) {
  return commentsPage(await (take(cursor) as Continuable).getContinuation());
}
export async function replies(key: string) {
  const thread = take(key);
  const t = thread.replies ? await thread.getContinuation() : await thread.getReplies();
  return {
    items: (t.replies ?? []).map(toComment).filter(Boolean) as Comment[],
    more: !!t.has_continuation,
  };
}

// ---------- channels / guide ----------

const VIDEOS_TAB = 'EgZ2aWRlb3PyBgQKAjoA';
const SEARCH_TAB = 'EgZzZWFyY2jyBgQKAloA';

/** The channel's own search tab (more pages via browseMore). */
export async function channelSearch(id: string, query: string) {
  id = await channelId(id);
  const raw: any = await api().actions.execute('/browse', { browseId: id, params: SEARCH_TAB, query, client: 'WEB' });
  return collect((Parser.parseResponse(raw.data) as any).contents);
}

const handles = new Map<string, string>();

/** "@handle", "/c/name" or "/user/name" → UC… browse id. */
async function channelId(id: string) {
  if (id.startsWith('UC')) return id;
  let uc = handles.get(id);
  if (!uc) {
    const url = `https://www.youtube.com/${id.startsWith('/') ? id.slice(1) : id}`;
    uc = (await api().resolveURL(url)).payload?.browseId as string | undefined;
    if (!uc) throw Object.assign(new Error('Channel not found'), { status: 404 });
    handles.set(id, uc);
  }
  return uc;
}

export async function channel(id: string) {
  id = await channelId(id);
  const raw: any = await api().actions.execute('/browse', { browseId: id, params: VIDEOS_TAB, client: 'WEB' });
  const d = raw.data;
  const m = d.metadata?.channelMetadataRenderer ?? {};
  const h = d.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;
  const metaParts: string[] = [];
  JSON.stringify(h?.metadata ?? {}, (k, v) => {
    if (k === 'content' && typeof v === 'string') metaParts.push(v);
    return v;
  });
  const banner = h?.banner?.imageBannerViewModel?.image?.sources;
  const avatar = h?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources;
  const parsed: any = Parser.parseResponse(d);
  const page = collect(parsed.contents);
  return {
    id,
    name: m.title ?? '',
    description: m.description ?? '',
    avatar: pickImage(avatar ?? m.avatar?.thumbnails, 160),
    banner: pickImage(banner, 1280),
    meta: metaParts.slice(0, 3),
    videos: page.items,
    cont: page.cont,
  };
}

export async function guide(): Promise<Channel[]> {
  if (!authed) return [];
  const raw: any = await authed.actions.execute('/guide', { client: 'WEB' });
  const out: Channel[] = [];
  JSON.stringify(raw.data, (_k, v) => {
    const e = v?.guideEntryRenderer;
    const id = e?.navigationEndpoint?.browseEndpoint?.browseId;
    if (id?.startsWith('UC') && !out.some((c) => c.id === id))
      out.push({ name: e.formattedTitle?.simpleText ?? '', id, avatar: e.thumbnail?.thumbnails?.[0]?.url });
    return v;
  });
  return out;
}

// ---------- Watch Later ----------

/** Ids currently in Watch Later; loaded lazily (all pages) and kept in sync with our own edits. */
let wl: Promise<Set<string>> | null = null;

async function loadWatchLaterIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let page = await watchLater();
  for (let i = 0; ; i++) {
    for (const c of page.items) ids.add(c.id);
    if (!page.cont || i > 60) break;
    page = await browseMore(page.cont);
  }
  return ids;
}

export function watchLaterIds(): Promise<Set<string>> {
  if (!authed) return Promise.resolve(new Set());
  if (!wl) {
    wl = loadWatchLaterIds();
    wl.catch(() => (wl = null));
  }
  return wl;
}

export async function watchLater() {
  if (!authed) return { items: [] as Card[], cont: undefined as string | undefined };
  const r: any = await authed.actions.execute('/browse', { browseId: 'VLWL', client: 'WEB', parse: true });
  return collect(r.contents);
}

export async function setWatchLater(id: string, add: boolean) {
  if (!authed) throw Object.assign(new Error('Sign in to use Watch later'), { status: 401 });
  await authed.actions.execute('/browse/edit_playlist', {
    playlistId: 'WL',
    actions: [add ? { action: 'ACTION_ADD_VIDEO', addedVideoId: id } : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: id }],
    client: 'WEB',
  });
  const ids = await watchLaterIds();
  if (add) ids.add(id);
  else ids.delete(id);
}

// ---------- ratings ----------

export async function rate(id: string, rating: Rating) {
  if (!authed) throw Object.assign(new Error('Sign in to like videos'), { status: 401 });
  // youtubei.js's interact.* uses the TV client, which rejects cookie sessions; youtube.com uses WEB.
  const path = rating === 'LIKE' ? '/like/like' : rating === 'DISLIKE' ? '/like/dislike' : '/like/removelike';
  await authed.actions.execute(path, { target: { videoId: id }, client: 'WEB' });
  for (const k of watchCache.keys()) if (k.startsWith(id + ':')) watchCache.delete(k);
}
