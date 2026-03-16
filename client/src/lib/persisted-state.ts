"use client";

import { useCallback, useSyncExternalStore, useState } from "react";

const stateByKey = new Map<string, unknown>();
const listenersByKey = new Map<string, Set<() => void>>();

export function usePersistedState<T>(
  storageKey: string,
  createInitialState: () => T,
) {
  const [initialState] = useState(() => getOrCreateInitialState(storageKey, createInitialState));

  const subscribe = useCallback((listener: () => void) => {
    let listeners = listenersByKey.get(storageKey);
    if (!listeners) {
      listeners = new Set();
      listenersByKey.set(storageKey, listeners);
    }

    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) {
        listenersByKey.delete(storageKey);
      }
    };
  }, [storageKey]);

  const getSnapshot = useCallback(
    () => readPersistedState(storageKey, () => initialState),
    [initialState, storageKey],
  );

  const getServerSnapshot = useCallback(() => initialState, [initialState]);

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setState = useCallback(
    (next: T | ((current: T) => T)) => {
      const current = readPersistedState(storageKey, () => initialState);
      const resolved =
        typeof next === "function"
          ? (next as (current: T) => T)(current)
          : next;

      stateByKey.set(storageKey, resolved);

      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(resolved));
        } catch {
          // ignore storage failures
        }
      }

      emit(storageKey);
    },
    [initialState, storageKey],
  );

  return [state, setState] as const;
}

function getOrCreateInitialState<T>(
  storageKey: string,
  createInitialState: () => T,
): T {
  if (stateByKey.has(storageKey)) {
    return stateByKey.get(storageKey) as T;
  }

  const initialState = createInitialState();
  stateByKey.set(storageKey, initialState);
  return initialState;
}

function readPersistedState<T>(
  storageKey: string,
  createInitialState: () => T,
): T {
  if (stateByKey.has(storageKey)) {
    return stateByKey.get(storageKey) as T;
  }

  const fallback = createInitialState();
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    const resolved = raw ? (JSON.parse(raw) as T) : fallback;
    stateByKey.set(storageKey, resolved);
    return resolved;
  } catch {
    stateByKey.set(storageKey, fallback);
    return fallback;
  }
}

function emit(storageKey: string) {
  const listeners = listenersByKey.get(storageKey);
  if (!listeners) {
    return;
  }

  for (const listener of listeners) {
    listener();
  }
}
