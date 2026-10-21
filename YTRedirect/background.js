// Clicking the toolbar icon turns the redirects on and off.
const show = (on) => {
  chrome.action.setBadgeText({ text: on ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#666' });
  chrome.action.setTitle({ title: `Redirect YouTube: ${on ? 'on' : 'off'}` });
};

chrome.action.onClicked.addListener(async () => {
  const on = (await chrome.declarativeNetRequest.getEnabledRulesets()).includes('redirects');
  await chrome.declarativeNetRequest.updateEnabledRulesets(on ? { disableRulesetIds: ['redirects'] } : { enableRulesetIds: ['redirects'] });
  show(!on);
});

const sync = async () => show((await chrome.declarativeNetRequest.getEnabledRulesets()).includes('redirects'));
chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onInstalled.addListener(sync);
