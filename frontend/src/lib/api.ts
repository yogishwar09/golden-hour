/**
 * The HTTP client.
 *
 * One axios instance, one place that knows about the token, and one place that
 * turns an API error envelope into a message worth showing a user. Nothing
 * else in the app touches axios directly.
 */

import axios, { AxiosError, type AxiosInstance } from 'axios';

/** In development Vite proxies `/api`, so a relative base is correct. */
const BASE_URL = import.meta.env.VITE_API_URL ?? '';

const TOKEN_KEY = 'sas.accessToken';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing or blocked storage: the session simply will not persist.
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* Storage is unavailable; the in-memory session still works. */
  }
}

export const api: AxiosInstance = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** Called when the server rejects our token, so the app can sign out cleanly. */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error?: { code?: string; message?: string } }>) => {
    // A 401 on the session check is expected while signed out; anywhere else it
    // means the token has expired or been revoked.
    const isAuthProbe = error.config?.url?.includes('/auth/me');
    if (error.response?.status === 401 && !isAuthProbe) {
      storeToken(null);
      onUnauthorized?.();
    }
    return Promise.reject(error);
  },
);

export interface FieldIssue {
  field: string;
  message: string;
}

/** A human-readable message for any failure, including network-level ones. */
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const envelope = (error.response?.data as { error?: { message?: string } } | undefined)?.error;
    if (envelope?.message) return envelope.message;
    if (error.code === 'ECONNABORTED') return 'The server took too long to respond.';
    if (!error.response) return 'Cannot reach the server. Check your connection.';
    return `Request failed (${error.response.status}).`;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/** Field-level validation problems, for highlighting individual inputs. */
export function fieldIssues(error: unknown): FieldIssue[] {
  if (!axios.isAxiosError(error)) return [];
  const details = (error.response?.data as { error?: { details?: unknown } } | undefined)?.error
    ?.details;
  if (!Array.isArray(details)) return [];
  return details.filter(
    (item): item is FieldIssue =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as FieldIssue).field === 'string' &&
      typeof (item as FieldIssue).message === 'string',
  );
}
