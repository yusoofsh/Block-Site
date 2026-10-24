/* global tld, lockedUrl */
'use strict';

// localization
[...document.querySelectorAll('[data-i18n]')].forEach(e => {
  e[e.dataset.i18nValue || 'textContent'] = chrome.i18n.getMessage(e.dataset.i18n);
});
const t = (id, value = '') => chrome.i18n.getMessage(id).replace('##', value);
const $ = id => document.getElementById(id);

// show a worker error (like a wrong password) under the button for a few seconds
let errorTimer = 0;
const showError = message => {
  $('warning').textContent = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    $('warning').textContent = '';
  }, 3000);
};

// the worker answers {error} when a password was wrong: show it and resolve false
const send = o => new Promise(resolve => chrome.runtime.sendMessage(o, r => {
  if (r?.error) {
    showError(r.error);
    resolve(false);
  }
  else {
    resolve(r);
  }
}));

const regExp = source => {
  try {
    return new RegExp(source, 'i');
  }
  catch (e) {
    return null;
  }
};
// whether one of these declarativeNetRequest rules applies to a url
const covers = (rules, url) => rules.some(r => regExp(r.condition.regexFilter)?.test(url));

// when the current tab is our own lock screen, act on the site it stands for
const BLOCKED_BASE = chrome.runtime.getURL('/data/blocked/');
const pageOf = tab => {
  const u = tab?.url || '';
  return u.startsWith(BLOCKED_BASE) ? {url: lockedUrl(u), onBlockedPage: true} : {url: u, onBlockedPage: false};
};
const isWeb = url => /^https?:/.test(url);

// the registrable domain (eTLD+1) of a url, or the hostname where the
// public-suffix list has no answer (localhost, IP addresses)
const domainFor = url => tld.getDomain(url) || new URL(url).hostname;
// a rule for one page: its path on this host (the homepage path "/" covers the site)
const ruleForUrl = url => {
  const u = new URL(url);
  return '*://' + u.hostname + u.pathname + '*';
};

// the blocking rules that apply to a url, compiled by the worker like the blocker does
const matchesFor = async (blocked, url) => {
  if (blocked.length === 0) {
    return [];
  }
  const rules = await send({method: 'convert', hosts: blocked});
  return blocked.filter((h, i) => regExp(rules[i].expression)?.test(url));
};

// the site's icon: the tab's own, the copy the worker keeps for the lock screen, or the first letter
const showIcon = async tab => {
  const {url, onBlockedPage} = pageOf(tab);
  if (isWeb(url) === false) {
    return;
  }
  $('monogram').textContent = (domainFor(url).match(/[a-z0-9]/i) || ['?'])[0].toUpperCase();
  let src = onBlockedPage ? '' : tab.favIconUrl;
  if (!src) {
    const key = 'favicon:' + new URL(url).hostname.replace(/^www\./, '');
    src = (await chrome.storage.local.get(key))[key];
  }
  if (src) {
    $('favicon').onload = () => {
      $('favicon').hidden = false;
      $('monogram').hidden = true;
    };
    $('favicon').src = src;
  }
};

// add or remove rules (storage.onChanged repaints). Close when the worker is about to move the tab
// to or from the lock screen
const change = async (request, close) => {
  if (await send(request) && close) {
    window.close();
  }
};

let tab = null;

const render = async () => {
  const {url, onBlockedPage} = pageOf(tab);
  // allow rules: "once" holds the unlocks, "schedules" the pause and schedule windows
  // (and, in reverse mode, the list itself)
  const [prefs, rules] = await Promise.all([
    chrome.storage.local.get({blocked: [], reverse: false, 'popup-domain': true}),
    send({method: 'get-rules'})
  ]);
  // sites unlocked right now: how many, with a one-click way to lock them all again
  $('unlocked').hidden = rules.once.length === 0;
  $('unlocked-count').textContent = t('popup_unlocked_count', rules.once.length);

  if (isWeb(url) === false) {
    document.body.dataset.state = 'none';
    $('host').textContent = t('popup_no_site');
    return;
  }

  const matches = await matchesFor(prefs.blocked, url);
  const listed = matches.length > 0;
  const domain = domainFor(url);
  $('host').textContent = domain;

  // in reverse mode the list holds the allowed sites
  const blocked = prefs.reverse ? !listed : listed;
  let state = prefs.reverse ? 'allowed' : 'open';
  if (blocked) {
    state = covers(rules.once, url) ? 'unlocked' : (covers(rules.schedules, url) ? 'paused' : 'blocked');
  }
  document.body.dataset.state = state;
  $('status').textContent = t('popup_status_' + state);

  const action = $('action');
  action.hidden = false;
  action.disabled = false;
  action.title = '';
  // unblocking is offered, not pushed: it gets the plain button
  action.className = listed && !prefs.reverse ? '' : 'btn-primary';
  $('scope').hidden = prefs.reverse || listed;
  if (listed) {
    // drop the site's entries: that unblocks it, or in reverse mode blocks it
    action.textContent = t(prefs.reverse ? 'popup_block_site' : 'popup_unblock_site', domain);
    action.onclick = () => change({method: 'remove-hosts', hosts: matches}, prefs.reverse || onBlockedPage);
  }
  else if (prefs.reverse) {
    // blocked by default: allowing it happens on the lock screen
    action.textContent = t('popup_status_blocked');
    action.disabled = true;
    action.title = t('popup_reverse_hint');
  }
  else {
    const site = prefs['popup-domain'];
    $('scope').querySelector(`input[value=${site ? 'site' : 'page'}]`).checked = true;
    action.textContent = site ? t('popup_block_site', domain) : t('popup_block_page');
    action.onclick = () => change({method: 'block-host', host: site ? domain : ruleForUrl(url)}, true);
  }
};

// whole site or this page, remembered for next time
$('scope').addEventListener('change', e => {
  chrome.storage.local.set({'popup-domain': e.target.value === 'site'}, render);
});

// auto-lock status, a shortcut to the Lock page of the settings
const renderIdle = value => {
  const minutes = Math.max(0, Number(value) || 0);
  $('autolock-text').textContent = minutes ? t('popup_autolock_on', minutes) : t('popup_autolock_off');
};
$('autolock').addEventListener('click', () => {
  chrome.tabs.create({url: chrome.runtime.getURL('/data/options/index.html#/lock')}, () => window.close());
});

$('lock-now').addEventListener('click', async () => {
  await send({method: 'relock-all'});
  render();
});

chrome.storage.onChanged.addListener(ps => {
  if (ps.blocked || ps.reverse) {
    render();
  }
  if (ps['idle-lock']) {
    renderIdle(ps['idle-lock'].newValue);
  }
});

chrome.storage.local.get({'idle-lock': 0}, prefs => renderIdle(prefs['idle-lock']));
chrome.tabs.query({active: true, currentWindow: true}, tabs => {
  tab = tabs?.[0];
  showIcon(tab);
  render();
});
