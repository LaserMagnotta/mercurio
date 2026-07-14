// API client transport: URL building, JSON handling and — above all — error
// normalization into ApiError codes the UI maps to copy.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../api/client';

function mockFetch(response: Partial<Response> & { jsonBody?: unknown }) {
  const { jsonBody, ...rest } = response;
  const headers = new Headers(jsonBody !== undefined ? { 'content-type': 'application/json' } : {});
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers,
    json: async () => jsonBody,
    ...rest,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('prefixes /api and serializes the query, skipping undefined', async () => {
    const fn = mockFetch({ jsonBody: { ok: true } });
    await apiFetch('/shipments/suggested-offer', {
      query: { originHubId: 'a', destHubId: 'b', missing: undefined },
    });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/shipments/suggested-offer?originHubId=a&destHubId=b');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
  });

  it('sends JSON bodies with the content-type header', async () => {
    const fn = mockFetch({ jsonBody: { ok: true } });
    await apiFetch('/auth/request-link', { method: 'POST', body: { email: 'a@b.c' } });
    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.body).toBe('{"email":"a@b.c"}');
  });

  it('omits the content-type header when there is no body', async () => {
    const fn = mockFetch({ jsonBody: {} });
    await apiFetch('/me');
    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({});
    expect(init.body).toBeNull();
  });

  it('normalizes API error envelopes into ApiError', async () => {
    mockFetch({ ok: false, status: 422, jsonBody: { error: 'bond_above_cap', message: 'cap' } });
    const err = await apiFetch<never>('/shipments', { method: 'POST', body: {} }).catch(
      (e: unknown) => e as ApiError,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('bond_above_cap');
    expect(err.message).toBe('cap');
  });

  it('falls back to http_<status> when the body has no error code', async () => {
    mockFetch({ ok: false, status: 500 });
    const err = await apiFetch<never>('/health').catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('http_500');
  });

  it('maps network failures to a network_error code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const err = await apiFetch<never>('/me').catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('network_error');
  });

  it('honors an absolute baseUrl for server-side calls', async () => {
    const fn = mockFetch({ jsonBody: {} });
    await apiFetch('/hubs', { baseUrl: 'http://localhost:3001' });
    expect((fn.mock.calls[0] as [string])[0]).toBe('http://localhost:3001/hubs');
  });
});
