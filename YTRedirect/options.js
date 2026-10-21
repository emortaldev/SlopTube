// Settings page. Saves to storage; background.js rebuilds the rules on change.

const DEFAULTS = { enabled: true, video: 'http://127.0.0.1:8788', music: 'http://127.0.0.1:8787' };
const $ = (id) => document.getElementById(id);

const say = (msg, error = false) => {
  $('status').textContent = msg;
  $('status').className = error ? 'error' : '';
};

/** "192.168.1.5:8788" or "http://host:port/" → "http://host:port". Only an origin can be redirected to. */
function origin(label, value) {
  const v = value.trim();
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `http://${v}`);
  } catch {
    throw new Error(`${label}: not a valid address`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${label}: must start with http:// or https://`);
  if (u.pathname !== '/' || u.search || u.hash || u.username) throw new Error(`${label}: use just the address and port, without a path`);
  return u.origin;
}

const show = (s) => {
  $('enabled').checked = s.enabled;
  $('video').value = s.video;
  $('music').value = s.music;
};

chrome.storage.local.get(DEFAULTS).then(show);

// Saved straight away: it's the same switch as the toolbar icon.
$('enabled').addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: $('enabled').checked });
  say($('enabled').checked ? 'Redirects on.' : 'Redirects off.');
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const s = { video: origin('Video app', $('video').value), music: origin('Music app', $('music').value) };
    await chrome.storage.local.set(s);
    show({ enabled: $('enabled').checked, ...s });
    say('Saved.');
  } catch (err) {
    say(err.message, true);
  }
});

$('reset').addEventListener('click', async () => {
  await chrome.storage.local.set(DEFAULTS);
  show(DEFAULTS);
  say('Reset to defaults.');
});
