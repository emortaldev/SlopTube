# YouTube → local apps

Browser extension for Firefox and Chrome that opens YouTube links in the local apps instead:

- music.youtube.com → music app, http://127.0.0.1:8787 by default (songs, playlists, albums, artists, search)
- youtube.com / youtu.be → video app, http://127.0.0.1:8788 by default (videos incl. list/t, search, channels incl. @handles, subscriptions, Watch later)

Shorts, live, history, account pages etc. are left on YouTube.
Click the toolbar icon to toggle (badge shows "off").

## Settings

Change the app addresses on the extension's options page (Firefox: about:addons → the add-on → Options; Chrome: right-click the icon → Options). 127.0.0.1 means the device the browser runs on, so to use apps running on another computer, e.g. from Firefox for Android, enter that computer's address, like http://192.168.1.5:8788.

## Install

Requires Firefox 140+ (desktop) or 142+ (Android), or Chrome 121+. The same folder works in both.

Firefox, temporary (removed when Firefox restarts): about:debugging#/runtime/this-firefox → Load Temporary Add-on → pick `manifest.json`.

Chrome: chrome://extensions → Developer mode → Load unpacked → pick this folder. Chrome warns about the Firefox-only manifest keys (`browser_specific_settings`, `background.scripts`); that's expected.

If redirects don't happen in Firefox, check about:addons → this add-on → Permissions, and allow access to youtube.com and youtu.be.

## YouTube only

If you only use YouTube and not YouTube Music, the Piped Redirect extension ([Chrome](https://chromewebstore.google.com/detail/piped-redirect/emocodejgchikhkgbjcegplgnoapgfgb?pli=1), [Firefox](https://addons.mozilla.org/en-GB/firefox/addon/youtube-redirect/)) with "http://127.0.0.1:8788" will be plenty.
