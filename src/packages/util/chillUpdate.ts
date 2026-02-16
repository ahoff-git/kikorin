export type ChillUpdateFn<TValue> = (value: TValue) => void;

export type ChillUpdaterSetParams<TValue> = {
  updateKey: string;
  updateFunction: ChillUpdateFn<TValue>;
  value: TValue;
  minMS?: number;
};

export type ChillUpdater<TValue> = {
  check: () => boolean;
  setUpdate: (params: ChillUpdaterSetParams<TValue>) => void;
};

type UpdateRecord<TValue> = {
  updateFunction: ChillUpdateFn<TValue>;
  value: TValue;
  minMS: number;
  lastSentAt: number;
};

function createChillUpdater<TValue>(): ChillUpdater<TValue> {
  const records = new Map<string, UpdateRecord<TValue>>();
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

  const setUpdate = ({ updateKey, updateFunction, value, minMS = 0 }: ChillUpdaterSetParams<TValue>): void => {
    const safeMinMS = minMS > 0 ? minMS : 0;
    const existing = records.get(updateKey);

    if (existing !== undefined) {
      existing.updateFunction = updateFunction;
      existing.value = value;
      if (safeMinMS !== 0) existing.minMS = safeMinMS;
      pendingKeys.add(updateKey);
      return;
    }

    pendingKeys.add(updateKey);
    records.set(updateKey, {
      updateFunction,
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
