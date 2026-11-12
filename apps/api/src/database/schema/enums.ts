import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Enums de la base.
 *
 * Se declaran como `pgEnum` y no como `text` con CHECK por una razon concreta:
 * un enum de Postgres es un tipo, asi que el motor rechaza un valor invalido en
 * la columna sin importar quien escriba, y `drizzle-kit` genera la migracion
 * desde la unica definicion de TypeScript.
 *
 * Ojo: agregar un valor a un enum en Postgres es barato; quitarlo o renombrarlo
 * no. Por eso los enums son solo para valores que se usan en consultas; el resto
 * va en columnas de texto validadas por la aplicacion.
 */

export const planEnum = pgEnum('plan', ['starter', 'pro', 'enterprise']);

export const venueKindEnum = pgEnum('venue_kind', [
  'bar',
  'cafe',
  'restaurante',
  'kiosco',
  'confiteria',
]);

export const deviceKindEnum = pgEnum('device_kind', [
  'tablet',
  'pos',
  'kiosk',
  'printer',
  'kds',
  'unknown',
]);

/**
 * `pending` existe aparte de `active`: el dueño tiene que aprobar el dispositivo
 * y ese paso es una decision, no un estado que se deduzca de otra cosa.
 */
export const deviceStatusEnum = pgEnum('device_status', ['pending', 'active', 'revoked']);

export const userStatusEnum = pgEnum('user_status', ['active', 'inactive']);

export const roleKeyEnum = pgEnum('role_key', ['mozo', 'cajero', 'encargado', 'dueno']);
