import * as yt from './yt';
import { prefetch, stream } from './stream';

const PORT = Number(process.env.PORT ?? 8787);
const DIST = new URL('../dist/', import.meta.url).pathname;

await yt.init();

const json = (data: unknown, maxAge = 0) =>
  Response.json(data, { headers: { 'cache-control': maxAge ? `private, max-age=${maxAge}` : 'no-store' } });

const guard =
  <T extends Request>(fn: (req: T) => Promise<Response>) =>
  async (req: T) => {
    try {
      return await fn(req);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  };

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  idleTimeout: 0,
  routes: {
    '/api/me': () => json({ loggedIn: yt.loggedIn() }),
    '/api/auth': {
      POST: guard(async (req) => {
        const { cookie } = (await req.json()) as { cookie: string };
        await yt.setCookie(cookie);
        return json({ loggedIn: true });
      }),
    },
    '/api/library': guard(async () => json(await yt.library())),
    '/api/playlist/:id': {
      GET: guard(async (req) => json(await yt.playlist(req.params.id))),
      DELETE: guard(async (req) => {
        await yt.deletePlaylist(req.params.id);
        return json({ deleted: true });
      }),
    },
    '/api/more/:cursor': guard(async (req) => json(await yt.more(req.params.cursor))),
    '/api/album/:id': guard(async (req) => json(await yt.album(req.params.id), 3600)),
    '/api/search': guard(async (req) => {
      const p = new URL(req.url).searchParams;
      const q = p.get('q') ?? '';
      const type = p.get('type') as yt.SearchType | null;
      return json(type ? await yt.searchType(q, type) : await yt.search(q), 300);
    }),
    '/api/search/more/:cursor': guard(async (req) =>
      json(await yt.searchMore(req.params.cursor, new URL(req.url).searchParams.get('type') as yt.SearchType)),
    ),
    '/api/artist/:id': guard(async (req) => json(await yt.artist(req.params.id), 3600)),
    '/api/browse': guard(async (req) => {
      const p = new URL(req.url).searchParams;
      return json(await yt.browseMore(p.get('id') ?? '', p.get('params') ?? ''), 3600);
    }),
    '/api/suggest': guard(async (req) => json(await yt.suggestions(new URL(req.url).searchParams.get('q') ?? ''), 300)),
    '/api/rating/:id': guard(async (req) => json(await yt.rating(req.params.id))),
    '/api/like/:id': {
      PUT: guard(async (req) => {
        const r = new URL(req.url).searchParams.get('rating') as yt.Rating;
        if (!['LIKE', 'DISLIKE', 'INDIFFERENT'].includes(r)) return Response.json({ error: 'bad rating' }, { status: 400 });
        await yt.rate(req.params.id, r);
        return json({ rating: r });
      }),
    },
    '/api/save/:id': guard(async (req) => json(await yt.saveTargets(req.params.id))),
    '/api/playlist/:pid/add/:id': {
      POST: guard(async (req) => json(await yt.addToPlaylist(req.params.pid, req.params.id))),
    },
    '/api/playlist/:pid/track/:id': {
      DELETE: guard(async (req) => {
        await yt.removeFromPlaylist(req.params.pid, req.params.id);
        return json({ removed: true });
      }),
    },
    '/api/playlists': {
      POST: guard(async (req) => {
        const b = (await req.json()) as { title: string; privacy: string; videoId?: string };
        if (!b.title?.trim()) return Response.json({ error: 'title required' }, { status: 400 });
        return json(await yt.createPlaylist(b.title.trim(), b.privacy, b.videoId));
      }),
    },
    '/api/track/:id': guard(async (req) => json(await yt.track(req.params.id), 3600)),
    '/api/upnext/:id': guard(async (req) => json(await yt.upNext(req.params.id))),
    '/api/prefetch/:id': (req) => {
      prefetch(req.params.id);
      return new Response(null, { status: 204 });
    },
    '/api/stream/:id': (req) => stream(req.params.id, req),
  },
  async fetch(req) {
    // Static frontend (production build). Hashed assets are immutable.
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/')) {
      const f = Bun.file(DIST + path.slice(1));
      if (await f.exists())
        return new Response(f, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } });
    }
    const f = Bun.file(DIST + (path === '/' ? 'index.html' : path.slice(1)));
    if (path !== '/' && (await f.exists())) return new Response(f);
    return new Response(Bun.file(DIST + 'index.html'), { headers: { 'content-type': 'text/html' } });
  },
});

console.log(`YT Music running at http://${server.hostname}:${server.port}  (signed in: ${yt.loggedIn()})`);
