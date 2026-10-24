'use strict';

/*
 * Screen off for the touch PC (per device): black after N minutes without a touch, a tap or the doorbell wakes it.
 * While awake a screen wake lock keeps Windows from turning the monitor off; when it rings the wake lock is requested
 * again, which can switch a monitor back on that Windows turned off (works only in a secure context: https, or http
 * whitelisted with the Edge flag). The black screen itself works everywhere.
 */
const Screen = (() => {
  const KEY = 'sv.screenOff';
  const STEPS = [0, 1, 2, 5, 10, 30, 60];
  let blank = null;
  let timer = null;
  let lock = null;
  let ringTimer = null;

  function minutes() {
    try {
      return Number(localStorage.getItem(KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  /** a call or the doorbell camera is on the screen: never go dark then */
  function busy() {
    return Boolean(document.querySelector('.camfull.ring, .camfull.call')) || SV.editing;
  }

  async function holdLock(on) {
    try {
      if (on) {
        if (!lock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
          lock = await navigator.wakeLock.request('screen');
          lock.addEventListener('release', () => (lock = null));
        }
      } else if (lock) {
        const l = lock;
        lock = null;
        await l.release();
      }
    } catch (e) {
      // not allowed (no secure context, battery saver): the black screen still works
    }
  }

  function arm() {
    clearTimeout(timer);
    const m = minutes();
    if (m > 0) timer = setTimeout(off, m * 60000);
  }

  /** go dark now (also from the menu) */
  function off() {
    if (busy()) return arm();
    if (!blank) {
      blank = document.createElement('div');
      blank.className = 'screenoff';
      // the first touch only wakes the screen, it does not switch anything
      blank.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
      });
      blank.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        wake();
      });
      document.body.appendChild(blank);
    }
    holdLock(false);
  }

  function wake() {
    if (blank) {
      blank.remove();
      blank = null;
    }
    if (minutes() > 0) holdLock(true);
    arm();
  }

  /** doorbell / intercom rings: screen on at once */
  function ring() {
    wake();
    holdLock(true);
    // without the screen-off feature the wake lock is only for the call
    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => {
      if (minutes() <= 0 && !busy()) holdLock(false);
    }, 180000);
  }

  for (const ev of ['pointerdown', 'keydown', 'wheel']) {
    document.addEventListener(ev, () => {
      if (!blank) arm();
    }, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    // the browser drops the wake lock when the page is hidden
    if (document.visibilityState === 'visible' && !blank && minutes() > 0) holdLock(true);
  });
  if (minutes() > 0) {
    holdLock(true);
    arm();
  }

  /** entries for the ⚙ menu: time until dark (per device) and "now" */
  function menuItems(box) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item';
    const label = () => icon('moon') + 'Bildschirm aus nach (dieses Gerät): <b>' + (minutes() ? minutes() + ' Min. ohne Berühren' : 'nie') + '</b>';
    b.innerHTML = label();
    b.onclick = () => {
      const next = STEPS[(STEPS.indexOf(minutes()) + 1) % STEPS.length];
      try {
        localStorage.setItem(KEY, String(next));
      } catch (e) {
        // ignore
      }
      b.innerHTML = label();
      if (next > 0) {
        holdLock(true);
        arm();
      } else {
        clearTimeout(timer);
        holdLock(false);
      }
    };
    const now = document.createElement('button');
    now.type = 'button';
    now.className = 'item';
    now.innerHTML = icon('moon') + 'Bildschirm jetzt ausschalten (Tippen weckt, Klingeln auch)';
    now.onclick = () => {
      box.closest('.overlay').remove();
      off();
    };
    box.append(b, now);
  }

  return { ring, wake, off, menuItems };
})();
