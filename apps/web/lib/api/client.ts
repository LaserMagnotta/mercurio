// Minimal typed transport to the Mercurio API. Every call goes through the
// same-origin `/api` rewrite (ADR-018): the httpOnly session cookie rides
// along automatically and no CORS exists anywhere. Errors are normalized to
// ApiError carrying the API's machine-readable `error` code — the UI maps
// codes to copy, never string-matches messages.

export interface ApiErrorBody {
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly body?: ApiErrorBody,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** Absolute API origin for server-side calls (rewrites are browser-only). */
  baseUrl?: string;
}

function buildUrl(path: string, query: Query | undefined, baseUrl: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, baseUrl = '/api' } = options;
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query, baseUrl), {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : null,
      // Same-origin cookies are the default, stated for clarity.
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error');
  }

  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  const payload = isJson ? ((await response.json()) as unknown) : undefined;

  if (!response.ok) {
    const errorBody = (payload ?? {}) as ApiErrorBody;
    throw new ApiError(
      response.status,
      typeof errorBody.error === 'string' ? errorBody.error : `http_${response.status}`,
      typeof errorBody.message === 'string' ? errorBody.message : undefined,
      errorBody,
    );
  }
  return payload as T;
}

/** Binary upload variant of apiFetch (ADR-020: photo blobs travel as raw
 *  image/jpeg bodies, not JSON) — same origin, same cookie, same ApiError
 *  normalization. */
export async function apiUploadJpeg<T>(path: string, blob: Blob): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: blob,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error');
  }
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  const payload = isJson ? ((await response.json()) as unknown) : undefined;
  if (!response.ok) {
    const errorBody = (payload ?? {}) as ApiErrorBody;
    throw new ApiError(
      response.status,
      typeof errorBody.error === 'string' ? errorBody.error : `http_${response.status}`,
      typeof errorBody.message === 'string' ? errorBody.message : undefined,
      errorBody,
    );
  }
  return payload as T;
}
