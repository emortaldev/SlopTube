// Translate real YouTube Music URLs (from the redirect extension) into hash routes.
// Imported before the router so the first parse already sees the new hash.

/** Song to start as a radio once the app is up (music.youtube.com/watch?v=…). */
export let pendingPlay: string | undefined;

function translate(path: string, p: URLSearchParams): string {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const list = p.get('list');
  const playlist = (id: string) => `#/playlist/${encodeURIComponent(id)}`;
  if (parts[0] === 'watch' && p.get('v')) {
    pendingPlay = p.get('v')!;
    // Auto-generated radios (RD…) have no page; real playlists open alongside.
    return list && !list.startsWith('RD') ? playlist(list) : '#/';
  }
  if (parts[0] === 'playlist' && list) return playlist(list);
  if ((parts[0] === 'browse' || parts[0] === 'channel') && parts[1]) {
    const id = parts[1];
    if (id.startsWith('MPREb_')) return `#/album/${encodeURIComponent(id)}`;
    if (id.startsWith('VL')) return playlist(id.slice(2));
    if (id.startsWith('UC')) return `#/artist/${encodeURIComponent(id)}`;
  }
  if (parts[0] === 'search') return `#/search?q=${encodeURIComponent(p.get('q') ?? '')}`;
  return '#/';
}

if (location.pathname !== '/') {
  history.replaceState(null, '', '/' + translate(location.pathname, new URLSearchParams(location.search)));
}
