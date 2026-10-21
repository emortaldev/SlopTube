# YT Music (fast frontend)

A lightweight YouTube Music client: **Bun** server + **SolidJS** UI (~16 KB gzipped JS).
It shows your Liked Music and library playlists like music.youtube.com, plus artist pages (albums, singles, top songs), search filtered by type (songs, albums, artists, playlists), radio/up next and a queue.
Tracks play back to back with no gap between them.

## Run

```sh
bun install
bun start            # builds the UI and serves http://127.0.0.1:8787
```

Open the page and paste your music.youtube.com `cookie` request header to sign in (instructions are on the page).
It is saved to `cookie.txt` (git-ignored); you can also set `YTM_COOKIE`. Search and playback work without signing in.
The server listens on 127.0.0.1 only.

Dev mode: `bun run dev:server` and `bun run dev:web` (Vite on :5173 proxies `/api`).

## Why it's fast

**Click-to-audio**
- Stream URLs come from a single raw InnerTube `/player` call with the VISIONOS client, which returns direct URLs without signature deciphering or a PO token, in about 80ms. yt-dlp is the fallback (about 2.4s).
- Hovering a track, opening a playlist, or starting a track (the next 2 in the queue) resolves the URL and caches the first 256 KB of audio on the server. A click then gets its first byte from memory in under 1ms.
- Mouse playback starts on `pointerdown`, not `click`.
- Measured in Chrome from mouse press to the `playing` event: about 35ms when prefetched.

**Gapless playback** (`web/engine.ts`)
- Every track is appended to one MediaSource timeline. The next track goes right where the current one's audio ends, so the decoder never stops between songs. This also covers repeat-one.
- `web/container.ts` reads the WebM Cues or MP4 `sidx` index from the first 256 KB of each file, so the engine can fetch audio segment by segment and seek straight to any time.
- Only about 45s ahead and 20s behind the playhead stay buffered (about 2 MB). Browsers without MediaSource fall back to a plain `<audio>` element.

**Memory / background**
- Track lists are virtualized and reuse their rows: about 33 rows are in the DOM whether a list has 50 or 5,000 songs.
- Thumbnails are requested at the size they're shown.
- While the tab is hidden, progress updates stop, so a background tab does no DOM work. The only animations are loading spinners.
- No blur, filters or shadows.
- Volume is logarithmic: the slider covers 50 dB, so each step sounds like the same change in loudness.
- A small LRU cache (6 collections) keeps back/forward navigation instant without growing without limit.

## Shortcuts
`Space` play/pause · `←/→` seek 5s · `Shift+←/→` previous/next · `/` search
