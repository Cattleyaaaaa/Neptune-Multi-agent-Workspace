"use client";

/* Cross-route cache for workspace resources.
   Navigating between sections unmounts the page component, so keeping the
   last payload at module scope lets a revisit render instantly instead of
   flashing an empty state while the request is in flight. */

type Entry<T> = { value: T; at: number };

const entries = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export function peekCache<T>(key: string): T | undefined {
  // Module scope is shared across requests on the server, so never seed
  // render output from it there — it would leak between requests.
  if (typeof window === "undefined") return undefined;
  const hit = entries.get(key);
  return hit ? (hit.value as T) : undefined;
}

export function primeCache<T>(key: string, value: T): void {
  entries.set(key, { value, at: Date.now() });
}

/* 登出时必须调用：这里的缓存是任务、工作区配置这类按账号可见的数据，
   留着就会闪给下一个登录的人看。 */
export function clearCache(): void {
  entries.clear();
  inflight.clear();
}

export async function loadResource<T>(
  key: string,
  request: () => Promise<T>,
  options: { ttlMs?: number; force?: boolean } = {},
): Promise<T> {
  const { ttlMs = 10_000, force = false } = options;
  const cached = entries.get(key);
  if (!force && cached && Date.now() - cached.at < ttlMs) return cached.value as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const task = request().then((value) => {
    entries.set(key, { value, at: Date.now() });
    inflight.delete(key);
    return value;
  });
  inflight.set(key, task);
  try {
    return await task;
  } catch (error) {
    inflight.delete(key);
    throw error;
  }
}
