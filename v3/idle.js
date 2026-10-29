/* make sure timers are synced */

/* global schedule, getUnlocks, relock */

{
  const validate = async () => {
    const now = Date.now();
    let reschedule = false;
    for (const o of await chrome.alarms.getAll()) {
      if (o.scheduledTime < now) {
        console.info('outdated timer', o);
        // recreating a periodic "schedule.*" alarm with "when: now" permanently
        // shifts its weekly phase to the wake-up time; recompute them instead
        if (o.name.startsWith('schedule.')) {
          reschedule = true;
        }
        else {
          chrome.alarms.create(o.name, {
            when: now + Math.round(Math.random() * 1000),
            periodInMinutes: o.periodInMinutes
          });
        }
      }
    }
    if (reschedule) {
      schedule.update();
    }
  };

  chrome.idle.onStateChanged.addListener(state => {
    if (state === 'active') {
      validate();
    }
    else {
      idleLock(state);
    }
  });
  // Firefox does not reliably fire "locked -> active" state so we check whenever possible
  // https://github.com/ray-lothian/Block-Site/pull/165
  if (navigator.userAgent.includes('Firefox')) {
    validate();
  }
}

/* auto-lock on inactivity

   "idle-lock" (minutes, 0 = off) re-locks every temporary unlock, "while tabs
   are open" included, once the computer has had no keyboard or mouse input
   and no tab has played media for that long, or as soon as the screen locks.
   Media counts because watching a video needs no input. It is seen two ways:
   tab.audible (sound in the last few seconds, so a long silence still counts as
   idle) and a playing <video> or <audio> in any frame (data/inject/media-activity.js),
   which also covers a muted video and picture-in-picture. Two signals feed the
   lock, and each one re-checks the real idle time before locking:
   - idle.onStateChanged, with a detection interval set on every background
     wake and pref change (it is not guaranteed to survive a restart)
   - the "idle.check" alarm, a fallback poll that runs only while auto-lock
     is on and an unlock exists                                             */
const IDLE_MIN_SECONDS = 15; // the smallest interval the idle API accepts

const idleSeconds = minutes => Math.max(IDLE_MIN_SECONDS, Math.round(minutes * 60));
const idleMinutes = async () => Math.max(0, Number((await chrome.storage.local.get({'idle-lock': 0}))['idle-lock']) || 0);

// start or stop the fallback poll; pass `unlocked` when the caller already knows
const idleWatch = async unlocked => {
  const minutes = await idleMinutes();
  if (minutes > 0 && unlocked === undefined) {
    unlocked = (await getUnlocks()).length > 0;
  }
  if (minutes > 0 && unlocked) {
    if (!(await chrome.alarms.get('idle.check'))) {
      // polling at a quarter of the idle time keeps a lock at most 25% late, a missed
      // idle event as well as one that sound held back (it fires on the next poll)
      chrome.alarms.create('idle.check', {periodInMinutes: Math.max(0.5, minutes / 4)});
    }
  }
  else {
    await chrome.alarms.clear('idle.check');
  }
};

// a tab plays sound, or a page plays a video, even muted or in picture-in-picture
const mediaPlaying = async () => {
  if ((await chrome.tabs.query({audible: true})).length) {
    return true;
  }
  // media-activity.js answers for its frames. Tabs with no such script (discarded,
  // not loaded yet) reject, and count as not playing
  const tabs = await chrome.tabs.query({discarded: false, url: ['http://*/*', 'https://*/*']});
  const answers = await Promise.all(tabs.map(tab => {
    return chrome.tabs.sendMessage(tab.id, {method: 'media-playing'}).catch(() => false);
  }));
  return answers.includes(true);
};
// media is playing now, or stopped less than `minutes` ago ("idle-media-at")
const mediaActive = async minutes => {
  if (await mediaPlaying()) {
    return true;
  }
  const {'idle-media-at': at = 0} = await chrome.storage.session.get('idle-media-at');
  return Date.now() - at < minutes * 60 * 1000;
};
// sound or a video stopping restarts the idle clock, so the lock waits the
// full idle time after a video ends instead of firing right away. While media
// plays, mediaPlaying() sees it. No listener filter: Chrome has none
const mediaStopped = () => chrome.storage.session.set({'idle-media-at': Date.now()});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.audible === false) {
    mediaStopped();
  }
});
chrome.runtime.onMessage.addListener(request => {
  if (request.method === 'media-stopped') {
    mediaStopped();
  }
});

const idleLock = async state => {
  const minutes = await idleMinutes();
  if (minutes === 0) {
    return;
  }
  // a locked screen always locks; otherwise check input and sound
  if (state !== 'locked') {
    state = await chrome.idle.queryState(idleSeconds(minutes));
    if (state === 'idle' && await mediaActive(minutes)) {
      return;
    }
  }
  if (state === 'idle' || state === 'locked') {
    await relock();
  }
};

const idleInterval = async () => {
  const minutes = await idleMinutes();
  if (minutes > 0) {
    chrome.idle.setDetectionInterval(idleSeconds(minutes));
  }
};
idleInterval();

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'idle.check') {
    await idleLock();
    idleWatch(); // stops the poll once auto-lock is off or no unlock is left
  }
});
chrome.storage.onChanged.addListener(ps => {
  if (ps['idle-lock']) {
    idleInterval();
    // restart the poll at the pace of the new value
    chrome.alarms.clear('idle.check').then(() => idleWatch());
  }
});
