// TopologyEditor REST API 헬퍼
import { BACKEND_URL } from "../../config";

export async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) throw new Error(`${r.status}`);
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
