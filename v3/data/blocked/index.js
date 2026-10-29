/* global tld, humanDuration, lockedUrl */
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
const href = lockedUrl(location.href);

if (href) {
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
  document.getElementById('pathname').textContent = o.pathname === '/' ? '' : o.pathname;
  document.getElementById('search').textContent = o.search;
  document.querySelector('.path').hidden = (o.pathname === '/' || !o.pathname) && !o.search;
}

/* the site's icon with a lock badge, on the page and on the tab. The worker
   keeps a copy of each blocked site's icon (see "favicon:<host>"), so nothing
   is fetched from the site. Without one, Chrome's local favicon cache or the
   first letter is used */
{
  const img = document.getElementById('favicon');
  const domain = document.getElementById('domain').textContent;
  document.getElementById('monogram').textContent = (domain.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase();

  // the tab icon: the site icon with the toolbar's "blocked" icon in its corner
  const tabIcon = () => {
    const badge = new Image();
    badge.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 28, 28);
      g.drawImage(badge, 16, 16, 16, 16);
      document.getElementById('tab-icon').href = c.toDataURL('image/png');
    };
    badge.src = '/data/icons/blocked/16.png';
  };
  const show = src => {
    img.onload = () => {
      img.hidden = false;
      document.getElementById('monogram').hidden = true;
      tabIcon();
    };
    img.src = src;
  };

  try {
    const key = 'favicon:' + new URL(href).hostname.replace(/^www\./, '');
    chrome.storage.local.get(key, prefs => {
      if (prefs[key]) {
        show(prefs[key]);
      }
      else if (navigator.userAgent.includes('Firefox') === false) {
        // Chrome's _favicon endpoint reads the browser's own cache (needs the "favicon" permission)
        show(chrome.runtime.getURL('/_favicon/?size=64&pageUrl=' + encodeURIComponent(href)));
      }
    });
  }
  catch (e) {} // no usable URL: the first letter stays
}

// the unlock behavior comes from the settings page ("Lock"). The lock
// screen only asks for the password and says what will happen; the worker
// picks the unlock mode from the same setting.
chrome.storage.local.get({
  'unlock-default': 1, // minutes | 'tab' | 'session'
  'idle-lock': 0 // minutes, 0 = off
}, prefs => {
  const t = id => chrome.i18n.getMessage(id);
  const def = prefs['unlock-default'];
  const parts = [];
  if (def === 'tab' || def === 'session') {
    parts.push(t(def === 'tab' ? 'blocked_info_tab' : 'blocked_info_session'));
  }
  else if (Number(def) > 0) {
    parts.push(t('blocked_info_for').replace('##', humanDuration(Number(def))));
  }
  const idle = Number(prefs['idle-lock']) || 0;
  if (idle > 0) {
    parts.push(t('blocked_info_idle').replace('##', idle));
  }
  document.getElementById('info').textContent = parts.join(' · ');
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
  post({
    method: 'open-once',
    host: unlockHost,
    password: e.target.querySelector('[type=password]')?.value || ''
  }, r => {
    if (r === true) {
      // replace the lock page instead of adding to history, so Back from the site skips it
      location.replace(document.getElementById('url').href);
    }
    else {
      showError(r?.error);
    }
  });
});

// a wrong password shows here and shakes the field, no desktop notification
const showError = msg => {
  const field = document.querySelector('.field');
  document.getElementById('error').textContent = msg || chrome.i18n.getMessage('bg_msg_2');
  field.classList.remove('shake');
  void field.offsetWidth; // restart the animation
  field.classList.add('shake');
  password.select();
};
password.addEventListener('input', () => {
  document.getElementById('error').textContent = '';
});

// reminder mode: leave the site, back to the previous page or by closing the tab
document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) {
    history.back();
  }
  else {
    post({method: 'close-page'});
  }
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
// storage
Promise.all([
  new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve)),
  chrome.storage.local.get({
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
  // the master password is optional (https://github.com/ray-lothian/Block-Site/issues/42).
  const hasPassword = prefs.password || prefs.sha256;
  const unlockNeedsPassword = hasPassword && !prefs['no-password-on-unlock'];
  // reminder mode: when opening the site needs no password, the page is a pause
  // with "Go back" and "Open anyway" instead of a lock (see index.css)
  if (!unlockNeedsPassword) {
    document.documentElement.classList.add('reminder');
    password.required = false;
    password.hidden = true;
    document.getElementById('unlock-label').textContent = chrome.i18n.getMessage('blocked_reminder_open');
    // the nudge: "Go back" is the main button, "Open anyway" the plain one
    document.getElementById('unlock').classList.remove('btn-primary');
    document.getElementById('back').focus();
  }
  document.documentElement.classList.add('ready');
  if (args.has('host')) {
    const h = args.get('host');
    const o = prefs.notes[h] || {};

    if (o.note) {
      document.getElementById('message').textContent = o.note;
    }

    // the popup lists how often each rule blocked a page
    const count = (o.count || 0) + 1;
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
        if (resp === true) {
          next();
        }
        else {
          password.hidden = false; // reminder mode hides it, but removing the block needs it
          showError(resp?.error);
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
