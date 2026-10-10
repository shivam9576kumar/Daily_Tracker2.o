import axios from 'axios';
import { tokenStorage } from './tokenStorage';

function getApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_URL;
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    if (!envUrl || envUrl.includes('localhost') || envUrl.includes('127.0.0.1')) {
      return '/api';
    }
  }
  return envUrl || '/api';
}

const API_BASE_URL = getApiBaseUrl();

const BROWSER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  // Default for ordinary reads and writes. Long operations (AI, plan commit)
  // pass their own timeout per request. A hung request should fail in
  // seconds, not hold a spinner for a minute.
  timeout: 15_000,
});

// Attach JWT and X-Timezone to every request
api.interceptors.request.use((config) => {
  const token = tokenStorage.get();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  config.headers['X-Timezone'] = BROWSER_TZ;
  return config;
});

// Auto-logout on 401 & surface server error messages
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      tokenStorage.clear();
      // Decoupled from authStore via a DOM event to avoid a circular
      // import (authStore.ts already imports this module).
      window.dispatchEvent(new CustomEvent('auth:session-expired'));

      const isSilent = (err.config as any)?.silent === true;
      if (!isSilent && !window.location.pathname.startsWith('/login')) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/login?next=${next}`;
      }
    }
    const message =
      err?.response?.data?.error ||
      err?.response?.data?.message ||
      (err.code === 'ECONNABORTED' ? 'Server is taking too long — please try again' : err.message) ||
      'Something went wrong';
    err.friendlyMessage = message;
    return Promise.reject(err);
  }
);

/** Extract a human-readable message from an Axios error. */
export function getErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return (err as any).friendlyMessage || err.response?.data?.error || err.response?.data?.message || err.message || 'Something went wrong';
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

export default api;
