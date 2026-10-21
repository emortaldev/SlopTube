// Search filters, shared by the server (encodes them for YouTube) and the web
// app (filter panel + URL). Values double as YouTube's filter names.
// Shorts and live streams are left out: the app hides them everywhere.

export const DATES = { today: 'Today', week: 'This week', month: 'This month', year: 'This year' } as const;
export const TYPES = { video: 'Video', channel: 'Channel', playlist: 'Playlist', movie: 'Movie' } as const;
export const DURATIONS = {
  under_three_mins: 'Under 3 minutes',
  three_to_twenty_mins: '3 - 20 minutes',
  over_twenty_mins: 'Over 20 minutes',
} as const;
// YouTube dropped its "View count" sort; "Popularity" is the closest it offers and isn't a strict view order.
export const SORTS = { popularity: 'Popularity' } as const;
export const FEATURES = {
  '4k': '4K',
  hd: 'HD',
  subtitles: 'Subtitles/CC',
  creative_commons: 'Creative Commons',
  '360': '360°',
  vr180: 'VR180',
  '3d': '3D',
  hdr: 'HDR',
  location: 'Location',
  purchased: 'Purchased',
} as const;

export type SearchFilters = {
  date?: keyof typeof DATES;
  /** Custom range, YYYY-MM-DD. Sent as YouTube's after:/before: query operators. */
  after?: string;
  before?: string;
  type?: keyof typeof TYPES;
  duration?: keyof typeof DURATIONS;
  sort?: keyof typeof SORTS;
  features?: (keyof typeof FEATURES)[];
};

const isDay = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const pick = <T extends object>(table: T, v: string | null) => (v && v in table ? (v as keyof T) : undefined);

export function parseFilters(p: URLSearchParams): SearchFilters {
  const f: SearchFilters = {
    date: pick(DATES, p.get('date')),
    after: isDay(p.get('after')) ? p.get('after')! : undefined,
    before: isDay(p.get('before')) ? p.get('before')! : undefined,
    type: pick(TYPES, p.get('type')),
    duration: pick(DURATIONS, p.get('dur')),
    sort: pick(SORTS, p.get('sort')),
    features: (p.get('feat') ?? '').split(',').filter((x): x is keyof typeof FEATURES => x in FEATURES),
  };
  if (f.after || f.before) f.date = undefined;
  return f;
}

/** Query string (no leading '&'), empty when no filter is set. */
export function filterQuery(f: SearchFilters): string {
  const p = new URLSearchParams();
  if (f.date) p.set('date', f.date);
  if (f.after) p.set('after', f.after);
  if (f.before) p.set('before', f.before);
  if (f.type) p.set('type', f.type);
  if (f.duration) p.set('dur', f.duration);
  if (f.sort) p.set('sort', f.sort);
  if (f.features?.length) p.set('feat', f.features.join(','));
  return p.toString();
}

export const filterCount = (f: SearchFilters) =>
  +!!(f.date || f.after || f.before) + +!!f.type + +!!f.duration + +!!f.sort + (f.features?.length ?? 0);
