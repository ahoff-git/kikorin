type UpdaterOpts = { minMS?: number; maxMS?: number };

type Rec<T> = {
  uid: string;
  fn: (v: T) => void;
  value: T;

  minMS: number; // fastest allowed to send
  maxMS: number; // longest to wait before sending (during a pending burst)

  lastFire: number;       // last time we invoked fn
  firstPendingAt: number; // when current pending burst started
  lastSeenAt: number;     // last push time
  hasPending: boolean;
};

export const createThrottledUpdater = () => {
  const byUid = new Map<string, Rec<any>>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduledFor = Infinity; // when the current timer is set to fire

  const computeDueAt = (r: Rec<any>) => {
    // You can only fire after minMS since last fire (hard rate limit)
    const dueMin = r.lastFire + r.minMS;

    // But you must also not starve: once pending starts, force a fire by maxMS (bounded waiting)
    const dueMax = r.firstPendingAt + r.maxMS;

    // If pushes keep coming, we still allow trailing-ish behavior:
    // don't fire until either (a) we've been quiet for minMS OR (b) maxMS cap hits
    const dueQuiet = r.lastSeenAt + r.minMS;

    // Eligible when:
    // now >= dueMin AND (now >= dueQuiet OR now >= dueMax)
    // Earliest time that can become true:
    return Math.max(dueMin, Math.min(dueQuiet, dueMax));
  };

  const reschedule = () => {
    const now = Date.now();
    let nextAt = Infinity;

    for (const r of byUid.values()) {
      if (!r.hasPending) continue;
      const due = computeDueAt(r);
      if (due < nextAt) nextAt = due;
    }

    if (nextAt === Infinity) {
      if (timer) clearTimeout(timer);
      timer = null;
      scheduledFor = Infinity;
      return;
    }

    // 🔑 If something is due earlier than what we already scheduled, re-schedule.
    if (timer && nextAt >= scheduledFor) return;

    if (timer) clearTimeout(timer);

    scheduledFor = nextAt;
    timer = setTimeout(() => {
      timer = null;
      scheduledFor = Infinity;
      tick();
      reschedule();
    }, Math.max(0, nextAt - now));
  };

  const tick = () => {
    const now = Date.now();

    for (const [uid, r] of byUid) {
      if (!r.hasPending) {
        // optional cleanup
        if (now - r.lastSeenAt > Math.max(r.minMS, r.maxMS) * 4) byUid.delete(uid);
        continue;
      }

      const due = computeDueAt(r);
      if (now < due) continue;

      // Rate limit is enforced by computeDueAt via dueMin
      r.lastFire = now;
      r.hasPending = false;
      r.firstPendingAt = 0;

      const fn = r.fn;
      const v = r.value;
      fn(v);
    }
  };

  function push<T>(
    uid: string,
    fn: (v: T) => void,
    value: T,
    opts: UpdaterOpts = {}
  ) {
    const minMS = opts.minMS ?? 50;
    const maxMS = opts.maxMS ?? 500;

    const now = Date.now();
    let r = byUid.get(uid) as Rec<T> | undefined;

    if (!r) {
      r = {
        uid,
        fn,
        value,
        minMS,
        maxMS,
        lastFire: 0,
        firstPendingAt: now,
        lastSeenAt: now,
        hasPending: true,
      };
      byUid.set(uid, r);
    } else {
      r.fn = fn;
      r.value = value;
      r.minMS = minMS;
      r.maxMS = maxMS;
      r.lastSeenAt = now;

      if (!r.hasPending) r.firstPendingAt = now;
      r.hasPending = true;
    }

    // 🔑 This is what makes records independent: new pushes can pull the global wake-up earlier.
    reschedule();
  }

  push.flush = (uid?: string) => {
    const now = Date.now();
    if (uid) {
      const r = byUid.get(uid);
      if (r?.hasPending) {
        r.lastFire = now;
        r.hasPending = false;
        r.firstPendingAt = 0;
        r.fn(r.value);
      }
      return;
    }
    for (const r of byUid.values()) {
      if (!r.hasPending) continue;
      r.lastFire = now;
      r.hasPending = false;
      r.firstPendingAt = 0;
      r.fn(r.value);
    }
    reschedule();
  };

  push.drop = (uid: string) => {
    byUid.delete(uid);
    reschedule();
  };

  return push;
};
