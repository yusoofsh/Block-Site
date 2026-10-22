/*
  dynamic rules:
    1-997: blocking rules
    998: (legacy) one-time browsing — superseded by the session ruleset below
    999: pause blocking
    1000-: schedules
  session rules (own id space, dropped automatically on browser restart):
    1-: temporary "open once" unlocks
*/
/* global translate, notify, browser, idleWatch */

/* imports */
if (typeof importScripts !== 'undefined') {
  self.importScripts('helper.js');
  self.importScripts('blocker.js');
  self.importScripts('schedule.js');
  self.importScripts('contextmenu.js');
  self.importScripts('idle.js');
  self.importScripts('managed.js');
}

if (typeof browser === 'object' && browser.declarativeNetRequest) {
  chrome.declarativeNetRequest = browser.declarativeNetRequest;
}

/* helper; check sw-blocker and block/index.js for compatibility checks */
const convert = (h = '') => {
  if (h.startsWith('R:') === false) {
    if (h.indexOf('://') === -1 && h.indexOf('*') === -1) {
      // Firefox needs the RegExp to include the full address to provide it on "\\0"
      return `^https*:\\/\\/([^/]+\\.)*` + convert.escape(h) + '.*';
    }
    else {
      return '^' + h.split('*').map(convert.escape).join('.*');
    }
  }
  if (h.startsWith('R:^')) {
    return h.substr(2);
  }
  return '^.*' + h.substr(2);
};
convert.escape = str => {
  const specials = [
    // order matters for these
    '-', '[', ']',
    // order doesn't matter for any of these
    '/', '{', '}', '(', ')', '*', '+', '?', '.', '\\', '^', '$', '|'
  ];
  const regex = RegExp('[' + specials.join('\\') + ']', 'g');
  return str.replace(regex, '\\$&');
};
// temporary "open once" unlocks: the session ruleset's allow rules
const getUnlocks = async () => (await chrome.declarativeNetRequest.getSessionRules())
  .filter(r => r.action?.type === 'allow');
// a case-insensitive RegExp, or null when the source does not compile
const regExp = source => {
  try {
    return new RegExp(source, 'i');
  }
  catch (e) {
    return null;
  }
};
const ruleRegExp = rule => regExp(rule.condition.regexFilter);
const sha256 = async (message = '') => {
  const msgBuffer = new TextEncoder('utf-8').encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => ('00' + b.toString(16)).slice(-2)).join('');
  return hashHex;
};
sha256.validate = ({password}, resolve, reject) => chrome.storage.local.get({
  'sha256': '', // sha256 hash code of the user password
  'password': '', // deprecated
  'wrong': 1, // minutes,
  'retries': {
    'count': 0,
    'first': 0
  }
}).then(prefs => {
  if (prefs.retries.first < ( Date.now() - prefs.wrong * 60 * 1000)) {
    prefs.retries = {
      'count': 0,
      'first': Date.now()
    };
  }
  if (prefs.retries.count >= 5) {
    return reject(translate('bg_msg_4').replace('##', prefs.wrong));
  }

  const f = () => {
    if (prefs.retries.count === 0) {
      prefs.retries.first = Date.now();
    }
    prefs.retries.count += 1;

    chrome.storage.local.set({
      retries: prefs.retries
    });

    reject(translate('bg_msg_2'));
  };
  const s = () => {
    chrome.storage.local.set({
      'retries': {
        'count': 0,
        'first': 0
      }
    });
    resolve();
  };

  if (password && password === prefs.password) {/* deprecated */
    s();
  }
  else if (prefs.sha256) {
    sha256(password).then(hash => {
      if (hash === prefs.sha256) {
        s();
      }
      else {
        f();
      }
    });
  }
  else {
    f();
  }
});
// answer a page's password-gated request: true on success, {error} to show on the page
const failWith = response => msg => response({error: msg});

/* user action */
const userAction = async (tabId, href, frameId) => {
  // this is an internal tab, press the unblock button
  if (href.startsWith(chrome.runtime.getURL(''))) {
    return chrome.tabs.sendMessage(tabId, {
      method: 'press-exception'
    });
  }
  if (href.startsWith('http') === false) {
    return notify(translate('bg_msg_1'));
  }

  const prefs = await chrome.storage.local.get({
    'blocked': [],
    'notes': {},
    'reverse': false,
    'no-password-on-add': false,
    'sha256': '', // sha256 hash code of the user password
    'password': '' // deprecated
  });

  // is this site unblocked by a session rule
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  for (const rule of rules) {
    try {
      if (new RegExp(rule.condition.regexFilter, 'i').test(href)) {
        await prompt(chrome.i18n.getMessage('bg_msg_35'), 'true', undefined, undefined, {
          mode: 'confirm'
        });
        return;
      }
    }
    catch (e) {}
  }

  const next = () => {
    const reload = () => frameId !== 0 && chrome.tabs.reload(tabId);

    if (prefs.reverse) {
      prefs.blocked = prefs.blocked.filter(s => {
        const r = new RegExp(convert(s), 'i');
        const b = r.test(href);
        if (b) { // delete the note
          delete prefs.notes[s];
        }

        return b === false;
      });
      prefs.changed = Math.random(); // make sure the blocker gets reloaded even if prefs.blocked is not changed
      chrome.storage.local.set(prefs, reload);
    }
    else {
      chrome.tabs.sendMessage(tabId, {
        method: 'get-referrer'
      }, (referrer = '') => {
        chrome.runtime.lastError;
        prompt(translate('bg_msg_14'), href, false, 'convert-to-domain', {referrer});
      });
    }
  };

  if ((prefs.password || prefs.sha256) && prefs['no-password-on-add'] === false) {
    const password = await prompt(translate('bg_msg_17'));
    if (password) {
      sha256.validate({password}, next, notify);
    }
  }
  else {
    next();
  }
};
chrome.action.onClicked.addListener(tab => {
  userAction(tab.id, tab.url, 0);
});

/* temporary "open once" unlocks

   These live in the DNR *session* ruleset instead of the dynamic one:
   - their id space never collides with the blocking rules
   - "for this browser session" needs no bookkeeping: session rules are
     dropped automatically when the browser shuts down

   An unlock always covers the whole site (host + subdomains, both
   protocols) via the same regex the blocking rules use, so opening other
   pages/tabs of the same site works too.

   The unlock MODE is encoded in the rule id range so the state survives a
   background suspension (no separate storage.session needed):
     id <  TAB_ID_MAX : "while tabs of the site are open" — pruned on tab close
                        when no open tab matches the rule any more
     id >= TAB_ID_MAX : "for N seconds" (release.once.<id> alarm) or
                        "for this browser session" (dropped on restart)          */
const TAB_ID_MAX = 1000000;

const openOnceImpl = async ({host, mode}) => {
  // guard: an empty host would compile to a match-everything allow rule that
  // silently disables *all* blocking
  if (!host || /^[.\s]*$/.test(host)) {
    throw new Error('cannot unlock: unknown site');
  }
  const regexFilter = convert(host);
  const isTab = mode?.type === 'tab';
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  // reuse the id already allowing this exact site if it is in the right range;
  // otherwise drop it and take a fresh id from the range matching the new mode
  const same = existing.find(r => r.action?.type === 'allow' && r.condition?.regexFilter === regexFilter);
  let id = null;
  if (same) {
    if ((same.id < TAB_ID_MAX) === isTab) {
      id = same.id;
    }
    else {
      await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [same.id]});
    }
  }
  if (id === null) {
    const inRange = existing.filter(r => (r.id < TAB_ID_MAX) === isTab);
    const base = isTab ? 1 : TAB_ID_MAX;
    id = inRange.reduce((m, r) => Math.max(m, r.id), base - 1) + 1;
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 5,
      action: {type: 'allow'},
      condition: {
        regexFilter,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame', 'sub_frame']
      }
    }]
  });

  await chrome.alarms.clear('release.once.' + id);
  if (mode?.type === 'for') {
    chrome.alarms.create('release.once.' + id, {
      when: Date.now() + mode.seconds * 1000
    });
  }
  // 'tab' and 'session' modes need no per-id bookkeeping
  await idleWatch(true);
};
// serialize unlock installs: id allocation reads getSessionRules() then writes,
// so two concurrent unlocks could otherwise pick the same id and clobber each other
let openOnceLock = Promise.resolve();
const openOnce = opts => {
  const result = openOnceLock.then(() => openOnceImpl(opts));
  openOnceLock = result.catch(() => {}); // keep the chain alive on failure
  return result;
};

// the url a tab counts as — for our own blocked page it is the site it stands
// in for (via ?url=), so a "tab" unlock is not dropped mid-navigation
const tabUrl = url => {
  if (!url) {
    return '';
  }
  if (url.startsWith(chrome.runtime.getURL('/data/blocked/'))) {
    return url.split('&url=')[1] || '';
  }
  return url;
};
// a "tab" unlock lives while any open tab still matches its rule; re-check on close
chrome.tabs.onRemoved.addListener(async closedId => {
  const unlocks = (await getUnlocks()).filter(r => r.id < TAB_ID_MAX);
  if (unlocks.length === 0) {
    return;
  }
  // Firefox still lists the closing tab here, so exclude it explicitly —
  // otherwise the just-closed site tab would keep its own unlock alive
  const tabs = (await chrome.tabs.query({})).filter(t => t.id !== closedId);
  const urls = tabs.map(t => tabUrl(t.url)).filter(Boolean);

  const remove = unlocks.filter(rule => {
    const re = ruleRegExp(rule);
    return re && urls.some(u => re.test(u)) === false;
  }).map(r => r.id);
  // no reload: no open tab matches these rules any more
  await relock(remove, {reload: false});
});

/* re-lock: drop temporary unlocks (all of them, or only `ids`). Every path
   that ends an unlock goes through here: expiry, idle, "lock all", tab close
   and the blocker's stale-rule prune.
   With `reload` the open tabs they covered are reloaded, so the blocking
   rules send them back to the lock screen. Without it an expired unlock
   would leave its pages usable. Discarded tabs re-check on activation. */
const relock = async (ids, {reload = true} = {}) => {
  const unlocks = await getUnlocks();
  const drop = ids ? unlocks.filter(r => ids.includes(r.id)) : unlocks;
  if (drop.length === 0) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: drop.map(r => r.id)});
  await Promise.all(drop.map(r => chrome.alarms.clear('release.once.' + r.id)));

  if (reload) {
    const res = drop.map(ruleRegExp).filter(Boolean);
    for (const tab of await chrome.tabs.query({discarded: false, url: ['http://*/*', 'https://*/*']})) {
      if (res.some(re => re.test(tab.url))) {
        chrome.tabs.reload(tab.id);
      }
    }
  }
  await idleWatch(unlocks.length > drop.length);
};

/* site icons for the lock screen

   The lock screen shows the locked site's own icon without contacting the
   site. The icon is copied from an open tab instead: when the site gets
   blocked while a tab shows it, and whenever an unlocked tab of it loads a
   new icon. Each one is kept as a data: URL under "favicon:<host>" (the
   hostname without "www."), so an edited rule keeps its icon and the lock
   screen reads only its own key. Icons of hosts no rule blocks are dropped. */
const FAVICON_MAX = 32 * 1024; // characters of data: URL kept per host
const faviconKey = url => 'favicon:' + new URL(url).hostname.replace(/^www\./, '');

// the compiled blocking rules, rebuilt after the rules change
let blockers;
const getBlockers = async () => {
  if (!blockers) {
    const {blocked} = await chrome.storage.local.get({blocked: []});
    blockers = blocked.map(rule => regExp(convert(rule))).filter(Boolean);
  }
  return blockers;
};

const toDataUrl = async url => {
  if (url.startsWith('data:image/')) {
    return url;
  }
  const blob = await (await fetch(url, {credentials: 'omit'})).blob();
  // base64 grows 4/3: skip what cannot fit before encoding it
  if (blob.type.startsWith('image/') === false || blob.size > FAVICON_MAX * 3 / 4) {
    return '';
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

const seen = new Map(); // key -> icon URL already stored in this background session
const rememberFavicons = async tabs => {
  const res = await getBlockers();
  for (const tab of tabs) {
    if (!tab.favIconUrl || /^(https?|data):/.test(tab.favIconUrl) === false || !res.some(re => re.test(tab.url))) {
      continue;
    }
    const key = faviconKey(tab.url);
    if (seen.get(key) === tab.favIconUrl) {
      continue;
    }
    try {
      const data = await toDataUrl(tab.favIconUrl);
      if (data && data.length <= FAVICON_MAX) {
        await chrome.storage.local.set({[key]: data});
        seen.set(key, tab.favIconUrl);
      }
    }
    catch (e) {}
  }
};

const webTabs = () => chrome.tabs.query({url: ['http://*/*', 'https://*/*']});

chrome.storage.onChanged.addListener(async ps => {
  if (ps.blocked === undefined) {
    return;
  }
  blockers = undefined;
  const before = new Set(ps.blocked.oldValue || []);
  const now = new Set(ps.blocked.newValue || []);
  if ([...now].some(rule => before.has(rule) === false)) {
    // the tabs still show the site here, the blocker reloads them right after
    rememberFavicons(await webTabs());
  }
  if ([...before].some(rule => now.has(rule) === false)) {
    const res = await getBlockers();
    const stored = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('favicon:'));
    const gone = stored.filter(k => res.some(re => re.test('https://' + k.slice(8) + '/')) === false);
    if (gone.length) {
      chrome.storage.local.remove(gone);
      gone.forEach(k => seen.delete(k));
    }
  }
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // a new icon on a page. A blocked site only loads one while it is unlocked
  if (info.favIconUrl && /^https?:/.test(tab.url || '')) {
    rememberFavicons([tab]);
  }
});

/* messaging */
chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.method === 'convert') {
    response(request.hosts.map(host => ({
      expression: convert(host),
      host
    })));
  }
  else if (request.method === 'check-password') {
    // the asking page shows the error itself
    sha256.validate(request, () => response(true), failWith(response));
    return true;
  }
  else if (request.method === 'ask-for-password') {
    prompt(translate('bg_msg_17')).then(response);
    return true;
  }
  else if (request.method === 'convert-to-sha256') {
    sha256(request.password).then(response);
    return true;
  }
  else if (request.method === 'open-once') {
    chrome.storage.local.get({
      'unlock-default': 1, // minutes | 'tab' | 'session' (settings page, "Lock")
      'timeout': 60, // seconds; legacy default unlock duration
      'no-password-on-unlock': false,
      'sha256': '', // sha256 hash code of the user password
      'password': '' // deprecated
    }).then(prefs => {
      // the lock screen sends no mode: use the "stay unlocked for" setting,
      // then the legacy seconds
      const def = prefs['unlock-default'];
      let mode = request.mode;
      if (!mode) {
        mode = (def === 'tab' || def === 'session') ? {type: def} : {type: 'for', seconds: Number(def) * 60};
      }
      if (mode.type === 'for' && !(mode.seconds >= 1)) {
        mode = {type: 'for', seconds: prefs.timeout};
      }
      const next = async () => {
        try {
          await openOnce({host: request.host, mode});
          response(true);
        }
        catch (e) {
          response({error: e.message});
        }
      };

      // the master password is optional: unlock straight away when none is
      // set, or when the user opted out of the unlock prompt
      if ((prefs.password === '' && prefs.sha256 === '') || prefs['no-password-on-unlock']) {
        next();
      }
      else {
        // {error} instead of a desktop notification: the lock screen shows it
        sha256.validate(request, next, failWith(response));
      }
    });

    return true;
  }
  else if (request.method === 'block') {
    if (request.redirect) {
      chrome.tabs.update(sender.tab.id, {
        url: request.redirect
      });
    }
    else {
      const args = new URLSearchParams();
      args.set('date', request.date);
      args.set('host', request.host);
      args.set('type', 'ipb'); // inline page blocker
      args.set('url', sender.tab.url);
      chrome.tabs.update(sender.tab.id, {
        url: chrome.runtime.getURL('/data/blocked/index.html') + '?' + args.toString()
      });
    }
  }
  else if (request.method === 'get-rules') {
    Promise.all([
      chrome.declarativeNetRequest.getDynamicRules(),
      chrome.declarativeNetRequest.getSessionRules()
    ]).then(([rules, session]) => {
      response({
        schedules: rules.filter(r => r.action?.type === 'allow'),
        // temporary "open once" unlocks now live in the session ruleset
        once: session.filter(r => r.action?.type === 'allow')
      });
    });

    return true;
  }
  else if (request.method === 'relock-all') {
    // locking needs no password: it can only make blocking stricter
    relock().then(() => response(true), () => response(false));

    return true;
  }
  else if (request.method === 'block-host') {
    // block a site straight from the popup: add it and let update() reload the
    // tab onto the blocked page immediately (no domain-confirmation prompt),
    // honoring the master password unless the user opted out
    chrome.storage.local.get({
      'blocked': [],
      'notes': {},
      'no-password-on-add': false,
      'sha256': '',
      'password': ''
    }).then(prefs => {
      const host = (request.host || '').trim();
      if (!host) {
        response(false);
        return;
      }

      const doAdd = () => {
        if (prefs.blocked.includes(host) === false) {
          prefs.blocked.push(host);
          prefs.notes[host] = {date: Date.now(), origin: 'popup', count: 0};
        }
        chrome.storage.local.set({
          blocked: prefs.blocked,
          notes: prefs.notes,
          changed: Math.random() // make sure the blocker reloads matching tabs
        }, () => response(true));
      };
      if ((prefs.password || prefs.sha256) && prefs['no-password-on-add'] === false) {
        prompt(translate('bg_msg_17')).then(password => {
          if (password) {
            sha256.validate({password}, doAdd, failWith(response));
          }
          else {
            response(false);
          }
        });
      }
      else {
        doAdd();
      }
    });

    return true;
  }
  else if (request.method === 'remove-hosts') {
    // remove one or more blocked hostnames from the popup, honoring the
    // master password unless the user opted out for adding/removing rules
    chrome.storage.local.get({
      'blocked': [],
      'notes': {},
      'no-password-on-add': false,
      'sha256': '',
      'password': ''
    }).then(prefs => {
      const doRemove = () => {
        const drop = new Set(request.hosts);
        const blocked = prefs.blocked.filter(h => drop.has(h) === false);
        for (const h of request.hosts) {
          delete prefs.notes[h];
        }
        chrome.storage.local.set({
          blocked,
          notes: prefs.notes,
          changed: Math.random() // make sure the blocker reloads
        }, () => response(true));
      };
      if ((prefs.password || prefs.sha256) && prefs['no-password-on-add'] === false) {
        prompt(translate('bg_msg_17')).then(password => {
          if (password) {
            sha256.validate({password}, doRemove, failWith(response));
          }
          else {
            response(false);
          }
        });
      }
      else {
        doRemove();
      }
    });

    return true;
  }
  else if (request.method === 'close-page') {
    if (sender.frameId === 0) {
      chrome.tabs.remove(sender.tab.id);
    }
  }
  else if (request.method === 'change-icon') {
    chrome.action.setIcon({
      tabId: sender.tab.id,
      path: {
        '16': '/data/icons/' + request.value + '/16.png',
        '32': '/data/icons/' + request.value + '/32.png'
      }
    });
    if (request.value === 'blocked') {
      chrome.action.setTitle({
        tabId: sender.tab.id,
        title: chrome.i18n.getMessage('bg_msg_33')
      });
    }
  }
});

/* release open once */
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name.startsWith('release.once.')) {
    const id = Number(alarm.name.slice('release.once.'.length));
    await relock([id]);
  }
  else if (alarm.name === 'release.open.once') { // legacy dynamic rule
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [998]
    });
  }
});

/* toolbar popup: show the blocked-sites overview, or fall back to the
   one-click "block current site" action when the popup is disabled */
const applyPopup = () => chrome.storage.local.get({popup: true}, prefs => {
  chrome.action.setPopup({
    popup: prefs.popup ? '/data/popup/index.html' : ''
  });
});
{
  const once = () => {
    if (once.done) {
      return;
    }
    once.done = true;
    applyPopup();
  };
  chrome.runtime.onStartup.addListener(once);
  chrome.runtime.onInstalled.addListener(once);
}
chrome.storage.onChanged.addListener(ps => {
  if (ps.popup) {
    applyPopup();
  }
});

/* FAQs & Feedback */
{
  const {management, runtime: {onInstalled, setUninstallURL, getManifest}, storage, tabs} = chrome;
  if (navigator.webdriver !== true) {
    const page = getManifest().homepage_url;
    const {name, version} = getManifest();
    onInstalled.addListener(({reason, previousVersion}) => {
      management.getSelf(({installType}) => installType === 'normal' && storage.local.get({
        'faqs': true,
        'last-update': 0
      }, prefs => {
        if (reason === 'install' || (prefs.faqs && reason === 'update')) {
          const doUpdate = (Date.now() - prefs['last-update']) / 1000 / 60 / 60 / 24 > 45;
          if (doUpdate && previousVersion !== version) {
            tabs.query({active: true, currentWindow: true}, tbs => tabs.create({
              url: page + '?version=' + version + (previousVersion ? '&p=' + previousVersion : '') + '&type=' + reason,
              active: reason === 'install',
              ...(tbs && tbs.length && {index: tbs[0].index + 1})
            }));
            storage.local.set({'last-update': Date.now()});
          }
        }
      }));
    });
    setUninstallURL(page + '?rd=feedback&name=' + encodeURIComponent(name) + '&version=' + version);
  }
}
