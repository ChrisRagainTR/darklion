import Constants from 'expo-constants';

const defaultApiBase = 'https://darklion.ai';

export function apiBaseUrl() {
  const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
  return (process.env.EXPO_PUBLIC_API_BASE_URL || extra?.apiBaseUrl || defaultApiBase).replace(/\/$/, '');
}

export class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string) { super(message); }
}

const pendingReads = new Map<string, Promise<unknown>>();
let unauthorizedHandler: ((token: string) => void) | null = null;

// Called once per expired saved session. Login attempts send no token, so wrong passwords keep their own message.
export function setUnauthorizedHandler(handler: ((token: string) => void) | null) {
  unauthorizedHandler = handler;
}

function isUpload(options: RequestInit) {
  return typeof FormData !== 'undefined' && options.body instanceof FormData;
}

export function apiFetch<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const read = !options.method || options.method.toUpperCase() === 'GET';
  const key = JSON.stringify([token, path, options.headers]);
  if (read && !options.signal && pendingReads.has(key)) return pendingReads.get(key) as Promise<T>;
  const request = performRequest<T>(path, options, token);
  if (read && !options.signal) {
    pendingReads.set(key, request);
    void request.finally(() => { if (pendingReads.get(key) === request) pendingReads.delete(key); }).catch(() => undefined);
  }
  return request;
}

async function performRequest<T>(path: string, options: RequestInit, token?: string): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort);
  const read = !options.method || options.method.toUpperCase() === 'GET';
  // Uploads can legitimately take several minutes on a slow connection, so they are not time-limited.
  const timeout = isUpload(options) ? null : setTimeout(abort, read ? 20000 : 90000);
  try {
    const response = await fetch(`${apiBaseUrl()}${path}`, {
      ...options, signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && token) {
        unauthorizedHandler?.(token);
        throw new ApiError('Your session has expired. Please sign in again.', 401);
      }
      const serverMessage = typeof body?.error === 'string' ? body.error : null;
      throw new ApiError(serverMessage || (response.status >= 500
        ? 'The service is temporarily unavailable. Please try again in a moment.'
        : `Request failed (${response.status}). Please try again.`), response.status, typeof body?.code === 'string' ? body.code : undefined);
    }
    return (body ?? {}) as T;
  } catch (error) {
    if (controller.signal.aborted) throw new ApiError(read ? 'The connection took too long. Please try again.' : 'Confirmation was interrupted. Check for your change before trying again.');
    if (error instanceof TypeError) throw new ApiError('Could not reach your workspace. Check your connection and try again.');
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
