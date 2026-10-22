/* global tld, getRelativeTime, humanDuration */
'use strict';

const toast = document.getElementById('toast');
const password = document.querySelector('[type=password]');

// localization
[...document.querySelectorAll('[data-i18n]')].forEach(e => {
  e[e.dataset.i18nValue || 'textContent'] = chrome.i18n.getMessage(e.dataset.i18n);
});

// post with health check
const post = (o, c = () => {}) => {
  const check = () => {
    if (confirm('Worker is not responding! Would you like to restart the extension?')) {
      chrome.runtime.reload();
    }
  };
  const id = setTimeout(check, 2000);

  chrome.runtime.sendMessage(o, r => {
    clearTimeout(id);
    c(r);
  });
};

const args = new URLSearchParams(location.search);
// do not use args.get('url'). It fails if the URL includes "&"
// "type=ipb" sends URIEncoded
const href = /&url=\w+:\/\//.test(location.search) ? location.search.split('&url=')[1] : args.get('url');

if (args.has('date')) {
  let d = new Date(parseInt(args.get('date')));
  if (isNaN(d)) {
    d = new Date();
    document.getElementById('date').textContent = d.toLocaleString();
  }
  else {
    document.getElementById('date').textContent = getRelativeTime(d);
  }
}
if (args.has('url')) {
  const o = new URL(href);
  o.domain = tld.getDomain(o.host);

  document.getElementById('url').href = o.href;
  if (o.domain) {
    document.getElementById('sub-domain').textContent = o.hostname.replace(o.domain, '');
    document.getElementById('domain').textContent = o.domain;
  }
  else {
    document.getElementById('domain').textContent = o.host;
  }
  document.getElementById('pathname').textContent = o.pathname;
  document.getElementById('search').textContent = o.search;
}

// a quick-select card: <label class="choice"><input type="radio"><span class="card">
const card = (parent, name, value, label, hint, extra = '') => {
  const l = document.createElement('label');
  l.className = 'choice ' + extra;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  const span = document.createElement('span');
  span.className = 'card';
  const b = document.createElement('b');
  b.textContent = label;
  span.appendChild(b);
  if (hint) {
    const small = document.createElement('small');
    small.textContent = hint;
    span.appendChild(small);
  }
  l.append(input, span);
  parent.appendChild(l);
  return input;
};
const check = (name, value) => {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) {
    input.checked = true;
  }
  return Boolean(input);
};

// populate the "unlock for" and "lock again when idle" cards
const IDLE_PRESETS = [0, 1, 5, 15, 30]; // minutes, 0 = off
chrome.storage.local.get({
  'unlock-periods': [1, 5, 15, 60], // minutes
  'unlock-default': 1, // minutes | 'tab' | 'session'
  'timeout': 60, // seconds (legacy fallback)
  'idle-lock': 0 // minutes, 0 = off
}, prefs => {
  const duration = document.getElementById('duration');
  const periods = [...prefs['unlock-periods']].filter(n => Number.isFinite(n) && n > 0);
  if (typeof prefs['unlock-default'] === 'number' && periods.includes(prefs['unlock-default']) === false) {
    periods.push(prefs['unlock-default']);
  }
  [...new Set(periods)].sort((a, b) => a - b).forEach(min => {
    card(duration, 'duration', 'for:' + (min * 60), humanDuration(min));
  });
  const t = id => chrome.i18n.getMessage(id);
  card(duration, 'duration', 'tab', t('blocked_unlock_tab_short'), t('blocked_unlock_tab_hint'));
  card(duration, 'duration', 'session', t('blocked_unlock_session_short'), t('blocked_unlock_session_hint'));
  card(duration, 'duration', 'permanent', t('blocked_unlock_permanent_short'), t('blocked_unlock_permanent_hint'),
    'danger');

  const def = prefs['unlock-default'];
  check('duration', (def === 'tab' || def === 'session') ? def : 'for:' + (Number(def) * 60)) ||
    check('duration', 'for:' + prefs.timeout) ||
    duration.querySelector('input')?.click();

  const idle = document.getElementById('idle');
  const current = Math.max(0, Number(prefs['idle-lock']) || 0);
  [...new Set([...IDLE_PRESETS, current])].sort((a, b) => a - b).forEach(min => {
    card(idle, 'idle', min, min ? t('idle_min').replace('##', min) : t('idle_off'));
  });
  check('idle', current);
});

// the site (registrable domain, subdomains included) an unlock applies to
let unlockHost = '';
try {
  const u = new URL(href);
  unlockHost = tld.getDomain(u.hostname) || u.hostname;
}
catch (e) {}

document.addEventListener('submit', e => {
  e.preventDefault();
  const choice = document.querySelector('input[name=duration]:checked')?.value || '';
  const idle = document.querySelector('input[name=idle]:checked');
  // "permanent" reuses the existing remove-blocking / add-to-whitelist logic
  if (choice === 'permanent') {
    document.getElementById('exception').click();
    return;
  }
  let mode;
  if (choice === 'tab' || choice === 'session') {
    mode = {type: choice};
  }
  else {
    mode = {type: 'for', seconds: parseInt(choice.split(':')[1], 10)};
  }
  post({
    method: 'open-once',
    host: unlockHost,
    mode,
    idle: idle ? Number(idle.value) : undefined,
    remember: document.getElementById('remember').checked,
    password: e.target.querySelector('[type=password]')?.value || ''
  }, b => {
    if (b) {
      document.getElementById('url').click();
    }
  });
});

// theme toggle: flips whatever is showing now (the system theme by default)
document.getElementById('switch').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.classList.contains('dark') ||
    (root.classList.contains('light') === false && matchMedia('(prefers-color-scheme: dark)').matches);
  localStorage.setItem('dark', !dark);
  root.classList.toggle('dark', !dark);
  root.classList.toggle('light', dark);
});
document.getElementById('options').addEventListener('click', e => {
  e.stopPropagation();

  if (chrome.extension.inIncognitoContext) {
    toast.notify(chrome.i18n.getMessage('bg_msg_29'));
    return;
  }

  chrome.runtime.openOptionsPage();
});

const title = () => fetch(href, {
  credentials: 'omit'
}).then(r => r.text()).then(content => {
  const dom = new DOMParser().parseFromString(content, 'text/html');
  document.getElementById('title').textContent = dom.title || 'Unknown';
}).catch(() => document.getElementById('title').textContent = 'Unknown');

// storage
Promise.all([
  new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve)),
  chrome.storage.local.get({
    'title': true,
    'close': 0,
    'message': '',
    'css': '',
    'password': '',
    'sha256': '',
    'no-password-on-unlock': false,
    'reverse': false,
    'blocked': [],
    'notes': {}
  }).then(prefs => {
    document.getElementById('css').textContent = prefs.css;
    document.getElementById('message').textContent = prefs.message;

    return prefs;
  })
]).then(a => a[1]).then(prefs => {
  if (prefs.title && href) {
    title();
  }
  else {
    document.getElementById('title-label').hidden = true;
    document.getElementById('title').hidden = true;
  }
  // the master password is optional (https://github.com/ray-lothian/Block-Site/issues/42).
  const hasPassword = prefs.password || prefs.sha256;
  const unlockNeedsPassword = hasPassword && !prefs['no-password-on-unlock'];
  // don't force a password on the unlock form when it isn't required...
  if (!unlockNeedsPassword) {
    password.required = false;
  }
  // ...but only fully hide the field when there is no password at all. If a
  // password exists it is still needed by the "remove blocking" button below,
  // so keep it visible even when unlocking itself is password-free.
  if (!hasPassword) {
    password.hidden = true;
  }
  if (args.has('host')) {
    const h = args.get('host');
    const o = prefs.notes[h] || {};

    const ruleEl = document.getElementById('rule');
    ruleEl.hidden = false;
    document.getElementById('rule-label').hidden = false;
    ruleEl.textContent = h;

    if (o.note) {
      document.getElementById('message').textContent = o.note;
    }

    const count = (o.count || 0) + 1;
    document.getElementById('counter').textContent = count;
    chrome.storage.local.set({
      notes: {
        ...prefs.notes,
        [h]: {
          ...o,
          count
        }
      }
    });
  }
  // https://github.com/ray-lothian/Block-Site/issues/6
  if (prefs.close && window.top === window) {
    const title = document.title;
    window.setInterval(() => {
      document.title = title + ` (${prefs.close})`;
      prefs.close -= 1;
      if (prefs.close === -1) {
        post({
          method: 'close-page'
        });
        window.close();
      }
    }, 1000);
  }
  //
  document.getElementById('exception').textContent = chrome.i18n.getMessage(
    prefs.reverse ? 'blocked_add_to_whitelist' : 'blocked_remove_blocking'
  );
  document.getElementById('exception').addEventListener('click', e => {
    e.stopPropagation();

    if (chrome.extension.inIncognitoContext) {
      toast.notify(chrome.i18n.getMessage('bg_msg_29'));
      return;
    }

    const next = () => {
      const url = document.getElementById('url').href;
      if (prefs.reverse === false) {
        chrome.storage.local.get({
          reverse: false,
          blocked: [],
          notes: {}
        }, prefs => {
          if (prefs.reverse === false) {
            post({
              method: 'convert',
              hosts: prefs.blocked
            }, resp => {
              const len = prefs.blocked.length;
              prefs.blocked = [...prefs.blocked].filter((s, i) => {
                try {
                  const r = new RegExp(resp[i].expression, 'i');
                  const b = r.test(url);

                  if (b) {
                    delete prefs.notes[s];
                  }

                  return r.test(url) === false;
                }
                catch (e) {
                  return true;
                }
              });
              document.title = `[Processing...] Removed ${len - prefs.blocked.length} rule(s)`;

              chrome.storage.local.set(prefs);
            });
          }
        });
      }
      else {
        const hostnames = [document.getElementById('domain').textContent];
        if (document.getElementById('sub-domain').textContent) {
          hostnames.push('*.' + document.getElementById('domain').textContent);
        }
        document.title = `[Processing...] Added ${hostnames.length} new rule(s)`;
        for (const hostname of hostnames) {
          if (prefs.blocked.includes(hostname) === false) {
            prefs.blocked.push(hostname);
            prefs.notes[hostname] = {
              date: Date.now(),
              origin: 'blocked',
              count: 0
            };
          }
        }

        chrome.storage.local.set(prefs);
      }
    };
    const password = document.querySelector('[type=password]');
    if (prefs.password || prefs.sha256) {
      post({
        method: 'check-password',
        password: password.value
      }, resp => {
        if (resp) {
          next();
        }
        else {
          return password.focus();
        }
      });
    }
    else {
      next();
    }
  });
});

// external commands
chrome.runtime.onMessage.addListener(request => {
  if (request.method === 'press-exception') {
    const msg = chrome.i18n.getMessage('bg_msg_13').replace('##', document.getElementById('domain').textContent);
    // Ignored call to 'confirm()'. The document is sandboxed, and the 'allow-modals' keyword is not set.
    if (window.confirm(msg) || window.top !== window) {
      document.getElementById('exception').click();
    }
  }
  else if (request.method === 'click-address') {
    document.getElementById('url').click();
  }
});

// live style editing
chrome.storage.onChanged.addListener(prefs => {
  if (prefs.css) {
    document.getElementById('css').textContent = prefs.css.newValue;
  }
});

// focus (prevent from scrolling on embedded blocking)
if (window.top === window) {
  document.addEventListener('DOMContentLoaded', () => {
    password.focus();
  });
}

chrome.storage.local.get({
  'disable-actions-page': true
}, prefs => {
  if (prefs['disable-actions-page']) {
    // disable paste
    password.onpaste = e => {
      e.preventDefault();
      toast.notify(chrome.i18n.getMessage('blocked_paste'));
    };
    password.ondrop = e => {
      e.preventDefault();
      toast.notify(chrome.i18n.getMessage('blocked_drop'));
    };

    // disable contextmenu
    document.oncontextmenu = e => {
      e.preventDefault();

      toast.notify(chrome.i18n.getMessage('blocked_context'));
    };
  }
});

// icon
post({
  method: 'change-icon',
  value: 'blocked'
});
