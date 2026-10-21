// Builds the redirect rules from the saved settings (options.html) and turns
// them on and off from the toolbar icon. Runs in Chrome and Firefox.

const DEFAULTS = { enabled: true, video: 'http://127.0.0.1:8788', music: 'http://127.0.0.1:8787' };

/** Redirect transform onto an origin like http://192.168.1.5:8788. An empty port clears it. */
const to = (origin) => {
  const u = new URL(origin);
  return { scheme: u.protocol.slice(0, -1), host: u.hostname, port: u.port };
};

const rules = (s) => [
  {
    id: 1,
    priority: 1,
    action: { type: 'redirect', redirect: { transform: to(s.music) } },
    condition: {
      regexFilter: '^https://music\\.youtube\\.com/(watch\\?|playlist\\?|browse/|channel/|search\\?|\\?|$)',
      resourceTypes: ['main_frame'],
    },
  },
  {
    id: 2,
    priority: 1,
    action: { type: 'redirect', redirect: { transform: to(s.video) } },
    condition: {
      regexFilter:
        '^https://(www\\.|m\\.)?youtube\\.com/(watch\\?|results\\?|channel/|c/|user/|@|feed/subscriptions|playlist\\?list=WL(&|$)|\\?|$)',
      resourceTypes: ['main_frame'],
    },
  },
  {
    id: 3,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${s.video}/\\1?\\2` } },
    condition: { regexFilter: '^https://youtu\\.be/([\\w-]{11})\\??(.*)$', resourceTypes: ['main_frame'] },
  },
];

const show = (on) => {
  chrome.action.setBadgeText({ text: on ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#666' });
  chrome.action.setTitle({ title: `Redirect YouTube: ${on ? 'on' : 'off'}` });
};

async function applyNow() {
  const s = await chrome.storage.local.get(DEFAULTS);
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: s.enabled ? rules(s) : [],
  });
  show(s.enabled);
}

// One update at a time: overlapping ones would both try to add rule ids 1-3.
let queue = Promise.resolve();
const apply = () => (queue = queue.then(applyNow).catch((e) => console.error('YTRedirect:', e)));

chrome.action.onClicked.addListener(async () => {
  const { enabled } = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ enabled: !enabled }); // → onChanged → apply
});
chrome.storage.onChanged.addListener(apply);

// Both browsers stop the background script when idle; re-sync whenever it starts.
apply();
