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
   for that long, or as soon as the screen locks. Two signals feed it, and
   each one re-checks the real idle time with queryState() before locking:
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
      // polling at a quarter of the idle time keeps a missed idle event at most 25% late
      chrome.alarms.create('idle.check', {periodInMinutes: Math.max(0.5, minutes / 4)});
    }
  }
  else {
    await chrome.alarms.clear('idle.check');
  }
};

const idleLock = async state => {
  const minutes = await idleMinutes();
  if (minutes === 0) {
    return;
  }
  if (state !== 'locked') {
    state = await chrome.idle.queryState(idleSeconds(minutes));
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
