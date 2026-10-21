import { Platform, TurboModuleRegistry, type TurboModule } from 'react-native';

/** The fake backend is served by Metro (see mockApi.js), so reuse the bundle host. */
function apiBase(): string {
  try {
    const sourceCode = TurboModuleRegistry.get<TurboModule & { getConstants(): { scriptURL?: string } }>('SourceCode');
    const constants = sourceCode?.getConstants() as { scriptURL?: string } | undefined;
    const m = /^(https?:\/\/[^/]+)/.exec(constants?.scriptURL ?? '');
    if (m?.[1]) return `${m[1]}/example-api`;
  } catch {
    // fall through
  }
  return `http://${Platform.OS === 'android' ? '10.0.2.2' : 'localhost'}:8081/example-api`;
}

const BASE = apiBase();

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface Booking {
  id: string;
  status: string;
  route: { from: string; to: string };
  departure: string;
  passengers: { name: string; seat: string }[];
  baggage: string;
  fareRules: string;
  total: { amount: number; currency: string };
}

export interface Segment {
  flight: string;
  from: string;
  to: string;
  depart: string;
  arrive: string;
  aircraft: string;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: { name: string } }>('/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  booking: (id: string) => request<Booking>(`/bookings/${id}`),
  itinerary: (id: string) => request<Segment[]>(`/bookings/${id}/itinerary`),
  flaky: () => request<unknown>('/flaky'),
  slow: () => request<{ message: string }>('/slow'),
};
