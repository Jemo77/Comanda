import { describe, expect, it } from 'vitest';
import { HttpSyncTransport } from './http-transport';

/**
 * Transporte HTTP.
 *
 * Estos tests fijan el contrato que el POS depende y que no se puede ver leyendo el
 * motor: como se invoca `fetch`, que se reintenta y que sale como error.
 */

/** `fetch` que exige el receptor correcto, como el de un navegador. */
function browserLikeFetch(): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = function fetch(this: unknown, url: string): Promise<Response> {
    // El `fetch` nativo del navegador exige `this === window`. Node no lo exige, y por
    // eso un transporte mal vinculado pasa todos los tests de este paquete en Node y
    // falla en el mostrador con "Illegal invocation".
    if (this !== globalThis) {
      return Promise.reject(
        new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"),
      );
    }
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };

  return { impl: impl as unknown as typeof fetch, calls };
}

describe('HttpSyncTransport', () => {
  it('invoca el fetch inyectado con globalThis como receptor', async () => {
    // Este es el test que habria atrapado el bug real: el POS no subia nada porque
    // `globalThis.fetch` se guardaba sin.bind y el navegador lo rechazaba.
    const { impl } = browserLikeFetch();
    const transport = new HttpSyncTransport({
      baseUrl: 'http://localhost:3000/api/v1',
      getAccessToken: () => 'token',
      fetchImpl: impl,
    });

    const result = await transport.push(
      'token',
      [
        {
          eventId: 'e1',
          type: 'ORDER_OPENED',
          seq: 1,
          occurredAt: '2026-01-01T00:00:00.000Z',
          payload: {},
          deviceId: 'd1',
          status: 'pending',
          attempts: 0,
          lastError: null,
        },
      ],
      'd1',
    );

    expect(result).toBeTruthy();
  });

  it('manda el Authorization y el body del lote', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport = new HttpSyncTransport({
      baseUrl: 'http://localhost:3000/api/v1',
      getAccessToken: () => 'token-abc',
      fetchImpl: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(
          new Response(JSON.stringify({ results: [], cursor: '1', acknowledgedSeq: 1 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }) as unknown as typeof fetch,
    });

    await transport.push('token-abc', [], 'd1');

    const call = calls[0]!;
    expect(call.url).toBe('http://localhost:3000/api/v1/sync/push');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');
    expect(call.init.method).toBe('POST');
  });

  it('un error del servidor viaja con el detalle del problem+json', async () => {
    // El POS muestra `detail` al mozo. Un "HTTP 400" a secas no le sirve para nada.
    const transport = new HttpSyncTransport({
      baseUrl: 'http://api',
      getAccessToken: () => 't',
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: 'El PIN no coincide.', status: 401 }), {
            status: 401,
            headers: { 'Content-Type': 'application/problem+json' },
          }),
        )) as unknown as typeof fetch,
    });

    await expect(transport.push('t', [], 'd')).rejects.toThrow('El PIN no coincide.');
  });

  it('reintenta un fallo de red y no un rechazo del servidor', async () => {
    let intentos = 0;
    const transport = new HttpSyncTransport({
      baseUrl: 'http://api',
      getAccessToken: () => 't',
      fetchImpl: (() => {
        intentos += 1;
        if (intentos < 3) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(
          new Response(JSON.stringify({ results: [], cursor: '0', acknowledgedSeq: 0 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }) as unknown as typeof fetch,
    });

    await transport.push('t', [], 'd');
    expect(intentos).toBe(3);

    // Un 4xx es deterministico: mandarlo otra vez va a fallar otra vez, y el motor ya
    // lo saca de la cola.
    intentos = 0;
    const con400 = new HttpSyncTransport({
      baseUrl: 'http://api',
      getAccessToken: () => 't',
      fetchImpl: (() => {
        intentos += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ detail: 'Payload invalido.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/problem+json' },
          }),
        );
      }) as unknown as typeof fetch,
    });

    await expect(con400.push('t', [], 'd')).rejects.toThrow('Payload invalido.');
    expect(intentos).toBe(1);
  });
});
