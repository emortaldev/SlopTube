// Translate real YouTube URLs (from the redirect extension) into hash routes.
// Imported before the router so the first parse already sees the new hash.

/** "90", "90s", "1m30s", "1h2m3s" → seconds. */
const seconds = (t: string | null) => {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
};

function translate(path: string, p: URLSearchParams): string {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const watch = (v: string) => {
    const q = new URLSearchParams({ v });
    if (p.get('list')) q.set('list', p.get('list')!);
    const t = seconds(p.get('t') ?? p.get('start'));
    if (t) q.set('t', String(t));
    return `#/watch?${q}`;
  };
  if (parts[0] === 'watch' && p.get('v')) return watch(p.get('v')!);
  if (parts.length === 1 && /^[\w-]{11}$/.test(parts[0]!)) return watch(parts[0]!); // youtu.be/ID
  if (parts[0] === 'results') return `#/results?q=${encodeURIComponent(p.get('search_query') ?? p.get('q') ?? '')}`;
  const channel = (id: string, tab?: string) => {
    const q = tab === 'search' ? p.get('query') : null;
    return `#/channel/${encodeURIComponent(id)}${q ? `?q=${encodeURIComponent(q)}` : ''}`;
  };
  if (parts[0] === 'channel' && parts[1]) return channel(parts[1], parts[2]);
  if (parts[0]?.startsWith('@')) return channel(parts[0], parts[1]);
  if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) return channel(`/${parts[0]}/${parts[1]}`, parts[2]);
  if (parts[0] === 'feed' && parts[1] === 'subscriptions') return '#/subscriptions';
  if (parts[0] === 'playlist' && p.get('list') === 'WL') return '#/watchlater';
  return '#/';
}

if (location.pathname !== '/') {
  history.replaceState(null, '', '/' + translate(location.pathname, new URLSearchParams(location.search)));
}
