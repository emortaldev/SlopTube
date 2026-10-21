# YouTube (fast frontend)

A lightweight YouTube client: **Bun** server + **SolidJS** UI (~22 KB gzipped JS). Separate from the music app.
It runs on http://127.0.0.1:8788.

It covers:
- your home recommendations, Subscriptions feed and subscribed channels, all in YouTube's own order
- search
- channel pages
- a watch page with the related sidebar, Mix/playlist panel, autoplay with an up-next countdown, description, and comments

It also has:
- **Like / dislike:** synced to your account.
- **Watch later:** a button on the watch page, a clock button on hovered thumbnails, and a **Watch later** page in the sidebar under Subscriptions.
- **Downloads:** MP4 (H.264) up to 1080p, WebM (VP9) above that, and audio-only as M4A, Opus or MP3.

There are no Shorts or live streams.

```sh
bun install
bun start            # builds the UI and serves http://127.0.0.1:8788
```

To sign in, paste your youtube.com `cookie` request header on the home page. It's saved to `cookie.txt` (git-ignored); `YT_COOKIE` also works.

**Watch history:** videos you watch for 5 seconds are added to your YouTube history, like on youtube.com, so recommendations keep learning. Set `YT_HISTORY=0` to turn this off.

## Codec / GPU decode

The site asks the browser which codecs it can decode in hardware (`navigator.mediaCapabilities`):
- It never picks AV1, because Turing GPUs like the RTX 2060 Super have no AV1 decoder.
- It prefers VP9, which gives better quality and is the only option above 1080p, when the GPU decodes it.
- If the browser reports no hardware decode at all, it uses H.264, the cheapest codec to decode on the CPU.

You can override this under ⚙ → Codec in the player. The menu also shows what's playing and whether the GPU is decoding it.

On Linux with an NVIDIA card, Chrome only decodes video on the GPU through VA-API:
1. Install `nvidia-vaapi-driver` (Fedora: `sudo dnf install nvidia-vaapi-driver`).
2. Launch Chrome with `--enable-features=VaapiVideoDecoder,VaapiOnNvidiaGPUs,VaapiIgnoreDriverChecks`.
3. Check `chrome://gpu`: "Video Decode" should say hardware accelerated.

Firefox works too: with `nvidia-vaapi-driver` installed, set `media.ffmpeg.vaapi.enabled = true`. Once the browser reports hardware VP9, the site switches to VP9 automatically.

## Downloads

ffmpeg muxes the separate video and audio streams and the result is streamed to the browser as it's produced, so the download starts right away.

googlevideo throttles one long request to about twice playback speed, so the server fetches each stream as four 4 MB range requests in parallel. A 1080p, 3.5-minute video (84 MB) takes about 6 seconds, compared with about 108 seconds the naive way.

MP4 and M4A are written as fragmented MP4. That lets them stream, and VLC, mpv, browsers and most editors play them.

## Why it's fast

**Click to video**
- Stream URLs come from one InnerTube `/player` call with the VISIONOS client, which returns direct links for every quality without signature deciphering or a PO token, in about 80ms.
- Hovering a thumbnail resolves the video, caches the first 1 MB of the chosen video stream and 256 KB of audio on the server, and pre-fetches the watch-page data.
- Mouse navigation happens on `pointerdown`.
- The player appends the first bytes in 32 KB pieces as they arrive, instead of waiting for a whole segment.
- Measured in Chrome from mouse press: **first frame at about 80ms** (1080p, prefetched).

**Memory / background**
- The player keeps about 30s buffered ahead and 15s behind, whatever the video length.
- After 5s in a background tab, new video data is fetched at 144p while audio continues; full quality is restored when you return.
- Auto quality follows the player's on-screen size, and full screen upgrades it.
- Comments aren't requested until you scroll the page and the section comes into view.
- Feed cards outside the viewport aren't rendered (`content-visibility: auto`).
- No blur, filters or shadows.
- The home feed loads ahead in the background, so after the first visit it opens instantly and is still fresh.

## Shortcuts
`k`/`Space` play/pause · `j`/`l` ±10s · `←/→` ±5s · `↑/↓` volume · `m` mute · `f` full screen · `0–9` jump to 0–90% · `Shift+N` next
