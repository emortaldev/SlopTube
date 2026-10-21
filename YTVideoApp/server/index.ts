import type { Codec } from '../shared/formats';
import * as download from './download';
import { fast, prefetch, resolve, stream } from './stream';
import * as yt from './yt';

const PORT = Number(process.env.PORT ?? 8788);
const DIST = new URL('../dist/', import.meta.url).pathname;

await yt.init();
yt.warmHome();

const json = (data: unknown, maxAge = 0) =>
  Response.json(data, { headers: { 'cache-control': maxAge ? `private, max-age=${maxAge}` : 'no-store' } });

const guard =
  <T extends Request>(fn: (req: T) => Promise<Response>) =>
  async (req: T) => {
    try {
      return await fn(req);
    } catch (e) {
      const err = e as Error & { status?: number };
      return Response.json({ error: err.message }, { status: err.status ?? 500 });
    }
  };

const qp = (req: Request, k: string) => new URL(req.url).searchParams.get(k) ?? '';
const prefsOf = (req: Request) => ({
  codec: (qp(req, 'codec') === 'avc1' ? 'avc1' : 'vp9') as Codec,
  maxHeight: Number(qp(req, 'h')) || 1080,
});

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  idleTimeout: 0,
  routes: {
    '/api/me': () => json({ loggedIn: yt.loggedIn() }),
    '/api/auth': {
      POST: guard(async (req) => {
        await yt.setCookie(((await req.json()) as { cookie: string }).cookie);
        yt.warmHome();
        return json({ loggedIn: true });
      }),
    },
    '/api/home': guard(async () => json(await yt.home())),
    '/api/subscriptions': guard(async () => json(await yt.subscriptions())),
    '/api/guide': guard(async () => json(await yt.guide(), 600)),
    '/api/browse/more': guard(async (req) => json(await yt.browseMore(qp(req, 't')))),
    '/api/search': guard(async (req) => json(await yt.search(qp(req, 'q')), 300)),
    '/api/search/more': guard(async (req) => json(await yt.searchMore(qp(req, 't')))),
    '/api/suggest': guard(async (req) => json(await yt.suggest(qp(req, 'q')), 300)),
    '/api/watch/:id': guard(async (req) => json(await yt.watch(req.params.id, qp(req, 'list') || undefined))),
    '/api/related/more': guard(async (req) => json(await yt.relatedMore(qp(req, 't')))),
    '/api/comments/:id': guard(async (req) => json(await yt.comments(req.params.id))),
    '/api/comments/more/:cursor': guard(async (req) => json(await yt.commentsMore(req.params.cursor))),
    '/api/replies/:key': guard(async (req) => json(await yt.replies(req.params.key))),
    '/api/channel/:id/search': guard(async (req) =>
      json(await yt.channelSearch(req.params.id, new URL(req.url).searchParams.get('q') ?? ''), 600),
    ),
    '/api/channel/:id': guard(async (req) => json(await yt.channel(req.params.id), 600)),
    '/api/watched/:id': {
      POST: (req) => {
        yt.markWatched(req.params.id).catch(() => {});
        return new Response(null, { status: 204 });
      },
    },
    /** Formats + basic details. Also warms the streams `prefs` would pick. */
    '/api/play/:id': guard(async (req) => {
      const id = req.params.id;
      prefetch(id, prefsOf(req));
      const r = await resolve(id);
      return json({ formats: r.formats, details: r.details });
    }),
    /** Hover prefetch: streams + watch-page data. */
    '/api/prefetch/:id': (req) => {
      prefetch(req.params.id, prefsOf(req));
      yt.watch(req.params.id).catch(() => {});
      return new Response(null, { status: 204 });
    },
    '/api/stream/:id/:itag': (req) => stream(req.params.id, Number(req.params.itag), req),
    '/api/fast/:id/:itag': guard((req) => fast(req.params.id, Number(req.params.itag))),
    '/api/like/:id': {
      PUT: guard(async (req) => {
        const rating = qp(req, 'rating') as yt.Rating;
        if (!['LIKE', 'DISLIKE', 'INDIFFERENT'].includes(rating)) return Response.json({ error: 'bad rating' }, { status: 400 });
        await yt.rate(req.params.id, rating);
        return json({ rating });
      }),
    },
    '/api/download/:id/options': guard(async (req) => json(await download.options(req.params.id))),
    '/api/download/:id': guard((req) => download.download(req.params.id, qp(req, 'opt'), req)),
    '/api/watchlater': guard(async () => json(await yt.watchLater())),
    '/api/watchlater/ids': guard(async () => json([...(await yt.watchLaterIds())])),
    '/api/watchlater/:id': {
      PUT: guard(async (req) => (await yt.setWatchLater(req.params.id, true), json({ saved: true }))),
      DELETE: guard(async (req) => (await yt.setWatchLater(req.params.id, false), json({ saved: false }))),
    },
  },
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/')) {
      const f = Bun.file(DIST + path.slice(1));
      if (await f.exists()) return new Response(f, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } });
    }
    const f = Bun.file(DIST + (path === '/' ? 'index.html' : path.slice(1)));
    if (path !== '/' && (await f.exists())) return new Response(f);
    return new Response(Bun.file(DIST + 'index.html'), { headers: { 'content-type': 'text/html' } });
  },
});

console.log(`YouTube running at http://${server.hostname}:${server.port}  (signed in: ${yt.loggedIn()})`);
