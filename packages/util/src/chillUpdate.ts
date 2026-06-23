export type ChillUpdateFn<TValue> = (value: TValue) => void;

export type ChillUpdaterSetParams<TValue> = {
  updateKey: string;
  updateFunction: ChillUpdateFn<TValue>;
  value: TValue;
  minMS?: number;
};

export type ChillUpdater = {
  check: () => boolean;
  setUpdate: <TValue>(params: ChillUpdaterSetParams<TValue>) => void;
};

type UpdateRecord = {
  updateFunction: ChillUpdateFn<unknown>;
  value: unknown;
  minMS: number;
  lastSentAt: number;
};

function createChillUpdater(): ChillUpdater {
  const records = new Map<string, UpdateRecord>();
  const pendingKeys = new Set<string>();
  const getNow = (): number => {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  };

  const check = (): boolean => {
    if (records.size === 0 || pendingKeys.size === 0) return false;

    const now = getNow();
    let didSend = false;

    for (const updateKey of pendingKeys) {
      const record = records.get(updateKey);
      if (record === undefined) {
        pendingKeys.delete(updateKey);
        continue;
      }
      if (record.lastSentAt !== 0 && now - record.lastSentAt < record.minMS) continue;

      record.lastSentAt = now;
      pendingKeys.delete(updateKey);
      try {
        record.updateFunction(record.value);
      }
      catch (e) {
        console.error("chillUpdater update failed", updateKey, e);
      }

      didSend = true;
    }

    return didSend;
  };

  const setUpdate = <TValue>({
    updateKey,
    updateFunction,
    value,
    minMS = 0,
  }: ChillUpdaterSetParams<TValue>): void => {
    const safeMinMS = minMS > 0 ? minMS : 0;
    const existing = records.get(updateKey);

    if (existing !== undefined) {
      existing.updateFunction = updateFunction as ChillUpdateFn<unknown>;
      existing.value = value;
      if (safeMinMS !== 0) existing.minMS = safeMinMS;
      pendingKeys.add(updateKey);
      return;
    }

    pendingKeys.add(updateKey);
    records.set(updateKey, {
      updateFunction: updateFunction as ChillUpdateFn<unknown>,
      value,
      minMS: safeMinMS,
      lastSentAt: 0
    });
  };

  return {
    check,
    setUpdate
  };
}

export { createChillUpdater };
