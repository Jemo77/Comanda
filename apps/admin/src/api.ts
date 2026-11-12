/**
 * Cliente de la API para el backoffice.
 *
 * El token vive en memoria (no localStorage): misma regla que el POS, un XSS no
 * se puede llevar la sesion. El refresh token no se persiste aca porque este
 * cliente se usa en sesiones cortas de navegador acotado; si vence, el usuario
 * vuelve a entrar.
 */

const API_URL = (import.meta as unknown as { env: Record<string, string> }).env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

let token: string | null = null;

export function setToken(value: string | null): void {
  token = value;
}

export function getToken(): string | null {
  return token;
}

export async function login(email: string, password: string): Promise<{ name: string }> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'password', email, password }),
  });
  const body = (await response.json()) as { accessToken?: string; detail?: string; user?: { name: string } };
  if (!response.ok || !body.accessToken) {
    throw new Error(body.detail ?? 'No se pudo entrar. Revisa el correo y la contraseña.');
  }
  token = body.accessToken;
  return { name: body.user?.name ?? '' };
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await response.json()) as T & { detail?: string };
  if (!response.ok) {
    throw new Error(body?.detail ?? `Error ${response.status}`);
  }
  return body;
}
