import { createSignal } from 'solid-js';
import type { SearchType } from './api';

const TYPES = ['songs', 'albums', 'artists', 'playlists'];

export type Route =
  | { name: 'home' }
  | { name: 'playlist'; id: string }
  | { name: 'album'; id: string }
  | { name: 'artist'; id: string }
  | { name: 'search'; q: string; type?: SearchType };

function parse(): Route {
  const [path = '', query = ''] = location.hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'playlist' && parts[1]) return { name: 'playlist', id: parts[1] };
  if (parts[0] === 'album' && parts[1]) return { name: 'album', id: parts[1] };
  if (parts[0] === 'artist' && parts[1]) return { name: 'artist', id: parts[1] };
  if (parts[0] === 'search') {
    const p = new URLSearchParams(query);
    const type = p.get('type') ?? '';
    return { name: 'search', q: p.get('q') ?? '', type: TYPES.includes(type) ? (type as SearchType) : undefined };
  }
  return { name: 'home' };
}

const [route, setRoute] = createSignal<Route>(parse());
addEventListener('hashchange', () => setRoute(parse()));
export { route };

export const href = {
  home: () => '#/',
  playlist: (id: string) => `#/playlist/${encodeURIComponent(id)}`,
  album: (id: string) => `#/album/${encodeURIComponent(id)}`,
  artist: (id: string) => `#/artist/${encodeURIComponent(id)}`,
  search: (q: string, type?: SearchType) => `#/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`,
};

export const navigate = (h: string) => {
  location.hash = h;
};
