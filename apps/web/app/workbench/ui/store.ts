"use client";

/* Browser-side persistence for workbench resources that have no backend table
   yet (定时任务 / 工作流 / MCP / Skill / 附件 / 租户 ...). The shape mirrors the
   TaskStore contract so swapping in a real REST endpoint later is a one-line
   change per collection: replace read/write with fetch and keep the hook API.

   Seeding rules:
   - The first render always uses `seed` so server and client markup match.
   - localStorage is applied in an effect, never during render.
   - Writes are blocked until the hydrate pass finished, otherwise a slow
     request would clobber the stored value with the seed. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PREFIX = "nexus.workbench.v1.";

function storageKey(key: string) {
  return `${PREFIX}${key}`;
}

function read<T>(key: string): T | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // Quota or private-mode failures must not break the page.
  }
}

export type Entity = { id: string };

export type Collection<T extends Entity> = {
  items: T[];
  ready: boolean;
  create: (item: Omit<T, "id"> & { id?: string }) => T;
  insert: (item: T) => void;
  update: (id: string, patch: Partial<T>) => void;
  remove: (id: string) => void;
  setAll: (items: T[]) => void;
  reset: () => void;
};

/* A stable id generator that also works in non-secure contexts where
   crypto.randomUUID is unavailable. */
export function uid(prefix = "id") {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid.slice(0, 8)}`;
}

export function useCollection<T extends Entity>(key: string, seed: T[]): Collection<T> {
  const [items, setItems] = useState<T[]>(seed);
  const [ready, setReady] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    const stored = read<T[]>(key);
    if (stored) setItems(stored);
    hydrated.current = true;
    setReady(true);
  }, [key]);

  useEffect(() => {
    if (!hydrated.current) return;
    write(key, items);
  }, [key, items]);

  const create = useCallback((item: Omit<T, "id"> & { id?: string }) => {
    const created = { ...item, id: item.id ?? uid(key) } as T;
    setItems((current) => [created, ...current]);
    return created;
  }, [key]);

  const insert = useCallback((item: T) => setItems((current) => [item, ...current]), []);

  const update = useCallback((id: string, patch: Partial<T>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const reset = useCallback(() => setItems(seed), [seed]);

  return useMemo(
    () => ({ items, ready, create, insert, update, remove, setAll: setItems, reset }),
    [items, ready, create, insert, update, remove, reset],
  );
}

/* Single-object variant for 账号设置 / 治理开关这类表单。 */
export function useRecord<T extends object>(key: string, seed: T) {
  const [value, setValue] = useState<T>(seed);
  const [ready, setReady] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    const stored = read<T>(key);
    if (stored) setValue({ ...seed, ...stored });
    hydrated.current = true;
    setReady(true);
    // `seed` is a module-level literal in every caller, so identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!hydrated.current) return;
    write(key, value);
  }, [key, value]);

  const patch = useCallback((next: Partial<T>) => setValue((current) => ({ ...current, ...next })), []);
  const reset = useCallback(() => setValue(seed), [seed]);

  return { value, ready, patch, setValue, reset };
}
