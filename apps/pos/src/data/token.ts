/**
 * El access token vigente, fuera de React y fuera del store.
 *
 * Existe como modulo hoja, y no dentro de `state/session.ts`, por una razon
 * concreta: el transporte de sincronizacion (`data/sync.ts`) necesita leer el token
 * en cada peticion, y la sesion necesita llamar al motor para limpiarlo al salir.
 * Si el token viviera en la sesion, esos dos modulos se importarian mutuamente y
 * el cicloaria en el momento de cargar.
 *
 * El token NO se persiste. Solo el refresh va a IndexedDB, y ya se que eso es un
 * riesgo aceptado: un POS abierto 8 horas pierde la sesion al reiniciar y el mozo
 * reingresa con PIN. Persistir un access token en `localStorage` lo dejaria
 * expuesto a cualquier XSS, y en el POS el costo de un robo de sesion es acceso a
 * la caja.
 */
let currentAccessToken: string | null = null;

export function getAccessToken(): string | null {
  return currentAccessToken;
}

export function setAccessToken(token: string | null): void {
  currentAccessToken = token;
}
