import { createSignal } from 'solid-js';

export type Route =
  | { name: 'home' }
  | { name: 'subscriptions' }
  | { name: 'watchlater' }
  | { name: 'watch'; v: string; list?: string; t?: number }
  | { name: 'results'; q: string }
  | { name: 'channel'; id: string; q?: string };

function parse(): Route {
  const [path = '', query = ''] = location.hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const p = new URLSearchParams(query);
  if (parts[0] === 'watch' && p.get('v'))
    return { name: 'watch', v: p.get('v')!, list: p.get('list') ?? undefined, t: Number(p.get('t')) || undefined };
  if (parts[0] === 'results') return { name: 'results', q: p.get('q') ?? '' };
  if (parts[0] === 'channel' && parts[1]) return { name: 'channel', id: parts[1], q: p.get('q') || undefined };
  if (parts[0] === 'subscriptions') return { name: 'subscriptions' };
  if (parts[0] === 'watchlater') return { name: 'watchlater' };
  return { name: 'home' };
}

const [route, setRoute] = createSignal<Route>(parse());
addEventListener('hashchange', () => setRoute(parse()));
export { route };

export const href = {
  home: () => '#/',
  subscriptions: () => '#/subscriptions',
  watchLater: () => '#/watchlater',
  watch: (v: string, list?: string) => `#/watch?v=${v}${list ? `&list=${encodeURIComponent(list)}` : ''}`,
  results: (q: string) => `#/results?q=${encodeURIComponent(q)}`,
  channel: (id: string, q?: string) => `#/channel/${encodeURIComponent(id)}${q ? `?q=${encodeURIComponent(q)}` : ''}`,
};

export const navigate = (h: string) => {
  if (location.hash !== h) location.hash = h;
};
