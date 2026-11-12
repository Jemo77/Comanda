import { randomUUID } from 'node:crypto';
import { DEFAULT_ROLES, PERMISSION_LABELS, PERMISSION_KEYS } from '@comanda/domain';
import type { PoolClient } from 'pg';
import type { DatabaseService } from './database.service';
import { PasswordHasher } from '../common/security/hash';
import { loadDotEnv, loadEnv, type AppEnv } from '../config/env';

/**
 * Seeds de demo.
 *
 * El objetivo es poder probar el producto a mano sin tener que cargar nada: dos
 * locales (un cafe y un bar) con su equipo, su dispositivo POS aprobado y sus
 * roles. Se corre **como el rol de la API**, con el contexto de tenant puesto:
 *
 *  - Si el seed usara el rol owner, pasaria por la RLS con privilegios que la app
 *    real no tiene, y un seed que funciona escondiendo un RLS roto.
 *  - Si el seed usara el superusuario, no probaria nada de la seguridad.
 *
 * Es idempotente: se puede correr varias veces sin duplicar nada.
 */

interface DemoUser {
  name: string;
  email: string;
  role: keyof typeof DEFAULT_ROLES;
  /** PIN de 4 digitos, como el que usa el mozo en la tablet. */
  pin?: string;
  /** Si tiene password, entra desde el navegador (dueno y encargado). */
  withPassword?: boolean;
}

interface DemoDevice {
  name: string;
  fingerprint: string;
  status: 'active' | 'pending';
}

/**
 * Estacion de trabajo del seed.
 *
 * `key` es la clave natural dentro del local: el seed la usa para resolver ids y
 * para colgar productos, y no viaja a la base. Existe porque los ids son UUID
 * generados por la base y el seed tiene que ser idempotente sin inventar una
 * constraint artificial en el esquema de produccion.
 */
interface DemoStation {
  key: string;
  name: string;
  kind: 'bar' | 'cocina' | 'cafe';
}

interface DemoCategory {
  key: string;
  name: string;
  sort: number;
}

/** Modificador concreto del seed. */
interface DemoModifier {
  key: string;
  name: string;
  priceDeltaCents: number;
}

interface DemoModifierGroup {
  key: string;
  name: string;
  /** 1 = obligatorio. Es lo que abre el selector de modificadores en el POS. */
  minSelect: number;
  maxSelect: number;
  modifiers: DemoModifier[];
}

interface DemoProduct {
  /** Clave natural del producto. Es el `sku`, que tiene indice unico. */
  key: string;
  category: string;
  name: string;
  priceCents: number;
  station: string;
  /** Grupos de modificadores, por clave. */
  groups: string[];
  tags?: string[];
  available?: boolean;
}

interface DemoTable {
  label: string;
  seats: number;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: 'rect' | 'round' | 'square';
  status: 'LIBRE' | 'RESERVADA' | 'BLOQUEADA';
}

interface DemoFloor {
  key: string;
  name: string;
  sort: number;
  tables: DemoTable[];
}

/**
 * Carta completa del local.
 *
 * Es lo que hace que el POS se pueda probar de verdad: sin productos, sin mesas y
 * sin modificadores, las pantallas de venta no tienen nada que pintar y el E2E de
 * corte de red no puede cortar la red "en medio de una orden".
 *
 * Los precios son de un bar y un cafe de Buenos Aires reales, no redondos de
 * fixture: un POS probado con $1000 y $2000 esconde los errores de formato de
 * importes, que es justo lo que el dominio de dinero existe para evitar.
 */
interface DemoCatalog {
  stations: DemoStation[];
  categories: DemoCategory[];
  modifierGroups: DemoModifierGroup[];
  products: DemoProduct[];
  floors: DemoFloor[];
}

interface DemoSeed {
  name: string;
  kind: 'cafe' | 'bar';
  address: string;
  legalName: string;
  taxId: string;
  plan: 'starter' | 'pro';
  users: DemoUser[];
  devices: DemoDevice[];
  catalog: DemoCatalog;
}

const SEEDS: DemoSeed[] = [
  {
    name: 'Cafe Luna',
    kind: 'cafe',
    address: 'Av. Corrientes 1234, Buenos Aires',
    legalName: 'Cafe Luna S.A.',
    taxId: '30-71234567-9',
    plan: 'pro',
    users: [
      {
        name: 'Valeria Soto',
        email: 'valeria@cafe-luna.test',
        role: 'dueno',
        pin: '4821',
        withPassword: true,
      },
      {
        name: 'Marcos Belloni',
        email: 'marcos@cafe-luna.test',
        role: 'encargado',
        pin: '9134',
        withPassword: true,
      },
      {
        name: 'Juana Pryce',
        email: 'juana@cafe-luna.test',
        role: 'cajero',
        pin: '5577',
        withPassword: true,
      },
      { name: 'Nico Alvarez', email: 'nico@cafe-luna.test', role: 'mozo', pin: '1357' },
      { name: 'Tomas Reinoso', email: 'tomas@cafe-luna.test', role: 'mozo', pin: '2468' },
    ],
    devices: [
      { name: 'Tablet Barra', fingerprint: 'demo-luna-barra-01', status: 'active' },
      { name: 'Kiosco Mostrador', fingerprint: 'demo-luna-kiosco-01', status: 'active' },
      { name: 'Tablet Terraza', fingerprint: 'demo-luna-terraza-01', status: 'pending' },
      // Aparato que usa el E2E de Playwright. Existe en el seed y no solo en el
      // test porque el POS descubre su dispositivo por huella contra
      // `POST /devices/resolve`: sin una huella conocida, el navegador de test llega
      // a la pantalla de "aparato no registrado" y no hay nada que probar.
      { name: 'Tablet E2E', fingerprint: 'e2e-pos-tablet', status: 'active' },
    ],
    catalog: {
      stations: [
        { key: 'barra', name: 'Barra', kind: 'bar' },
        { key: 'cocina', name: 'Cocina', kind: 'cocina' },
        { key: 'cafe', name: 'Cafe', kind: 'cafe' },
      ],
      categories: [
        { key: 'cafeteria', name: 'Cafeteria', sort: 10 },
        { key: 'comidas', name: 'Comidas', sort: 20 },
        { key: 'panaderia', name: 'Panaderia', sort: 30 },
        { key: 'bebidas', name: 'Bebidas frias', sort: 40 },
        { key: 'postres', name: 'Postres', sort: 50 },
      ],
      modifierGroups: [
        {
          key: 'leche',
          name: 'Leche',
          minSelect: 1,
          maxSelect: 1,
          modifiers: [
            { key: 'entera', name: 'Entera', priceDeltaCents: 0 },
            { key: 'deslacte', name: 'Deslacte', priceDeltaCents: 0 },
            { key: 'descafeinado', name: 'Descafeinado', priceDeltaCents: 0 },
            { key: 'almendra', name: 'De almendra', priceDeltaCents: 200 },
          ],
        },
        {
          key: 'tostado',
          name: 'Tostado',
          minSelect: 0,
          maxSelect: 1,
          modifiers: [
            { key: 'simple', name: 'Simple', priceDeltaCents: 0 },
            { key: 'doble', name: 'Doble', priceDeltaCents: 250 },
            { key: 'sin-cafeina', name: 'Sin cafeina', priceDeltaCents: 0 },
          ],
        },
        {
          key: 'extras-cafe',
          name: 'Extras',
          minSelect: 0,
          maxSelect: 3,
          modifiers: [
            { key: 'shot', name: 'Shot extra', priceDeltaCents: 300 },
            { key: 'crema', name: 'Crema', priceDeltaCents: 150 },
            { key: 'canela', name: 'Canela', priceDeltaCents: 100 },
            { key: 'sin-azucar', name: 'Sin azucar', priceDeltaCents: 0 },
          ],
        },
        {
          key: 'punto-carne',
          name: 'Punto de la carne',
          minSelect: 1,
          maxSelect: 1,
          modifiers: [
            { key: 'jugoso', name: 'Jugoso', priceDeltaCents: 0 },
            { key: 'a-punto', name: 'A punto', priceDeltaCents: 0 },
            { key: 'bien-pasado', name: 'Bien pasado', priceDeltaCents: 0 },
          ],
        },
        {
          key: 'acompanamiento',
          name: 'Acompanamiento',
          minSelect: 0,
          maxSelect: 2,
          modifiers: [
            { key: 'papas', name: 'Papas fritas', priceDeltaCents: 900 },
            { key: 'ensalada', name: 'Ensalada', priceDeltaCents: 1100 },
            { key: 'arroz', name: 'Arroz', priceDeltaCents: 800 },
          ],
        },
      ],
      products: [
        {
          key: 'LUN-001',
          category: 'cafeteria',
          name: 'Capuchino',
          priceCents: 3400,
          station: 'cafe',
          groups: ['leche', 'tostado', 'extras-cafe'],
        },
        {
          key: 'LUN-002',
          category: 'cafeteria',
          name: 'Cafe con leche',
          priceCents: 2900,
          station: 'cafe',
          groups: ['leche', 'tostado'],
        },
        {
          key: 'LUN-003',
          category: 'cafeteria',
          name: 'Flat white',
          priceCents: 3600,
          station: 'cafe',
          groups: ['leche', 'tostado'],
        },
        {
          key: 'LUN-004',
          category: 'cafeteria',
          name: 'Latte',
          priceCents: 3600,
          station: 'cafe',
          groups: ['leche', 'extras-cafe'],
        },
        {
          key: 'LUN-005',
          category: 'cafeteria',
          name: 'Americano',
          priceCents: 2500,
          station: 'cafe',
          groups: ['tostado'],
        },
        {
          key: 'LUN-006',
          category: 'cafeteria',
          name: 'Mocha',
          priceCents: 4200,
          station: 'cafe',
          groups: ['leche', 'extras-cafe'],
        },
        {
          key: 'LUN-007',
          category: 'cafeteria',
          name: 'Cortado',
          priceCents: 3100,
          station: 'cafe',
          groups: ['leche'],
        },
        {
          key: 'LUN-008',
          category: 'cafeteria',
          name: 'Cafe de olla',
          priceCents: 2800,
          station: 'cafe',
          groups: [],
        },
        {
          key: 'LUN-101',
          category: 'comidas',
          name: 'Milanesa napolitana',
          priceCents: 9800,
          station: 'cocina',
          groups: ['punto-carne', 'acompanamiento'],
        },
        {
          key: 'LUN-102',
          category: 'comidas',
          name: 'Empanadas de carne (x3)',
          priceCents: 4200,
          station: 'cocina',
          groups: [],
        },
        {
          key: 'LUN-103',
          category: 'comidas',
          name: 'Torta de ricota',
          priceCents: 3200,
          station: 'cocina',
          groups: ['acompanamiento'],
        },
        {
          key: 'LUN-104',
          category: 'comidas',
          name: 'Fideos a la boloñesa',
          priceCents: 8900,
          station: 'cocina',
          groups: ['acompanamiento'],
        },
        {
          key: 'LUN-105',
          category: 'comidas',
          name: 'Sanguche de miga',
          priceCents: 5600,
          station: 'cocina',
          groups: ['extras-cafe'],
        },
        {
          key: 'LUN-201',
          category: 'panaderia',
          name: 'Medialunas (x6)',
          priceCents: 5400,
          station: 'barra',
          groups: [],
        },
        {
          key: 'LUN-202',
          category: 'panaderia',
          name: 'Factura de manteca',
          priceCents: 1200,
          station: 'barra',
          groups: [],
        },
        {
          key: 'LUN-203',
          category: 'panaderia',
          name: 'Brioche',
          priceCents: 1800,
          station: 'barra',
          groups: [],
        },
        {
          key: 'LUN-204',
          category: 'panaderia',
          name: 'Alfajor de chocolate',
          priceCents: 1600,
          station: 'barra',
          groups: [],
        },
        {
          key: 'LUN-301',
          category: 'bebidas',
          name: 'Limonada de menta',
          priceCents: 3500,
          station: 'barra',
          groups: [],
        },
        {
          key: 'LUN-302',
          category: 'bebidas',
          name: 'Jugo de naranja',
          priceCents: 3800,
          station: 'barra',
          groups: [],
        },
        {
          key: 'LUN-303',
          category: 'bebidas',
          name: 'Frappe de chocolate',
          priceCents: 5200,
          station: 'barra',
          groups: ['leche', 'extras-cafe'],
        },
        {
          key: 'LUN-304',
          category: 'bebidas',
          name: 'Agua mineral 500ml',
          priceCents: 1500,
          station: 'barra',
          groups: [],
        },
        {
          key: 'LUN-401',
          category: 'postres',
          name: 'Flan con dulce',
          priceCents: 2100,
          station: 'cocina',
          groups: ['extras-cafe'],
        },
        {
          key: 'LUN-402',
          category: 'postres',
          name: 'Cheesecake de frutos rojos',
          priceCents: 3900,
          station: 'cocina',
          groups: [],
        },
        {
          key: 'LUN-403',
          category: 'postres',
          name: 'Helado de dulce de leche',
          priceCents: 2400,
          station: 'barra',
          groups: [],
        },
      ],
      floors: [
        {
          key: 'salon',
          name: 'Salon',
          sort: 10,
          tables: [
            { label: '1', seats: 2, x: 0, y: 0, w: 100, h: 100, shape: 'round', status: 'LIBRE' },
            { label: '2', seats: 2, x: 140, y: 0, w: 100, h: 100, shape: 'round', status: 'LIBRE' },
            { label: '3', seats: 4, x: 280, y: 0, w: 140, h: 100, shape: 'rect', status: 'LIBRE' },
            { label: '4', seats: 4, x: 460, y: 0, w: 140, h: 100, shape: 'rect', status: 'LIBRE' },
            { label: '5', seats: 6, x: 0, y: 140, w: 200, h: 120, shape: 'rect', status: 'LIBRE' },
            {
              label: '6',
              seats: 2,
              x: 240,
              y: 140,
              w: 100,
              h: 120,
              shape: 'round',
              status: 'BLOQUEADA',
            },
          ],
        },
        {
          key: 'barra',
          name: 'Barra',
          sort: 20,
          tables: [
            { label: 'B1', seats: 1, x: 0, y: 0, w: 90, h: 90, shape: 'square', status: 'LIBRE' },
            { label: 'B2', seats: 1, x: 120, y: 0, w: 90, h: 90, shape: 'square', status: 'LIBRE' },
            { label: 'B3', seats: 1, x: 240, y: 0, w: 90, h: 90, shape: 'square', status: 'LIBRE' },
            { label: 'B4', seats: 1, x: 360, y: 0, w: 90, h: 90, shape: 'square', status: 'LIBRE' },
          ],
        },
        {
          key: 'terraza',
          name: 'Terraza',
          sort: 30,
          tables: [
            { label: 'T1', seats: 2, x: 0, y: 0, w: 100, h: 100, shape: 'round', status: 'LIBRE' },
            {
              label: 'T2',
              seats: 2,
              x: 140,
              y: 0,
              w: 100,
              h: 100,
              shape: 'round',
              status: 'LIBRE',
            },
            {
              label: 'T3',
              seats: 4,
              x: 280,
              y: 0,
              w: 140,
              h: 100,
              shape: 'rect',
              status: 'RESERVADA',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'Bar Orion',
    kind: 'bar',
    address: 'Av. Santa Fe 3210, Buenos Aires',
    legalName: 'Bar Orion SRL',
    taxId: '30-70987654-3',
    plan: 'starter',
    users: [
      {
        name: 'Bruno Ferrari',
        email: 'bruno@bar-orion.test',
        role: 'dueno',
        pin: '8642',
        withPassword: true,
      },
      {
        name: 'Lucia Ferreyra',
        email: 'lucia@bar-orion.test',
        role: 'encargado',
        pin: '1122',
        withPassword: true,
      },
      { name: 'Diego Sosa', email: 'diego@bar-orion.test', role: 'mozo', pin: '3344' },
    ],
    devices: [
      { name: 'Tablet Mostrador', fingerprint: 'demo-orion-mostrador-01', status: 'active' },
    ],
    catalog: {
      stations: [
        { key: 'barra', name: 'Barra', kind: 'bar' },
        { key: 'cocina', name: 'Cocina', kind: 'cocina' },
      ],
      categories: [
        { key: 'copas', name: 'Copas y tragos', sort: 10 },
        { key: 'cervezas', name: 'Cervezas', sort: 20 },
        { key: 'sin-alcohol', name: 'Sin alcohol', sort: 30 },
        { key: 'comidas', name: 'Comidas', sort: 40 },
        { key: 'picadas', name: 'Picadas', sort: 50 },
      ],
      modifierGroups: [
        {
          key: 'hielo',
          name: 'Hielo',
          minSelect: 0,
          maxSelect: 1,
          modifiers: [
            { key: 'con-hielo', name: 'Con hielo', priceDeltaCents: 0 },
            { key: 'sin-hielo', name: 'Sin hielo', priceDeltaCents: 0 },
          ],
        },
        {
          key: 'medida',
          name: 'Medida',
          minSelect: 1,
          maxSelect: 1,
          modifiers: [
            { key: 'medida-chica', name: 'Chica', priceDeltaCents: 0 },
            { key: 'medida-doble', name: 'Doble', priceDeltaCents: 1200 },
          ],
        },
        {
          key: 'extras-bar',
          name: 'Extras',
          minSelect: 0,
          maxSelect: 3,
          modifiers: [
            { key: 'limon', name: 'Limón', priceDeltaCents: 0 },
            { key: 'sal-y-pimienta', name: 'Sal y pimienta', priceDeltaCents: 100 },
            { key: 'hielo-cola', name: 'Hielo de cola', priceDeltaCents: 200 },
          ],
        },
        {
          key: 'punto-carne',
          name: 'Punto de la carne',
          minSelect: 1,
          maxSelect: 1,
          modifiers: [
            { key: 'jugoso', name: 'Jugoso', priceDeltaCents: 0 },
            { key: 'a-punto', name: 'A punto', priceDeltaCents: 0 },
            { key: 'bien-pasado', name: 'Bien pasado', priceDeltaCents: 0 },
          ],
        },
        {
          key: 'para-compartir',
          name: 'Para compartir',
          minSelect: 0,
          maxSelect: 1,
          modifiers: [
            { key: 'picadora', name: 'Con picadera', priceDeltaCents: 1800 },
            { key: 'pan', name: 'Con pan', priceDeltaCents: 1200 },
          ],
        },
      ],
      products: [
        {
          key: 'ORI-001',
          category: 'copas',
          name: 'Fernet con Pepsi',
          priceCents: 4800,
          station: 'barra',
          groups: ['hielo'],
        },
        {
          key: 'ORI-002',
          category: 'copas',
          name: 'Gancia',
          priceCents: 4500,
          station: 'barra',
          groups: ['hielo'],
        },
        {
          key: 'ORI-003',
          category: 'copas',
          name: 'Vodka tonic',
          priceCents: 6200,
          station: 'barra',
          groups: ['hielo', 'extras-bar'],
        },
        {
          key: 'ORI-004',
          category: 'copas',
          name: 'Gin sour',
          priceCents: 6800,
          station: 'barra',
          groups: ['extras-bar'],
        },
        {
          key: 'ORI-005',
          category: 'copas',
          name: 'Whisky doble',
          priceCents: 7500,
          station: 'barra',
          groups: ['hielo'],
        },
        {
          key: 'ORI-006',
          category: 'copas',
          name: 'Aperol spritz',
          priceCents: 6400,
          station: 'barra',
          groups: ['medida', 'hielo'],
        },
        {
          key: 'ORI-101',
          category: 'cervezas',
          name: 'Rubia de/barra',
          priceCents: 3200,
          station: 'barra',
          groups: ['hielo', 'medida'],
        },
        {
          key: 'ORI-102',
          category: 'cervezas',
          name: 'IPA artesanal',
          priceCents: 4500,
          station: 'barra',
          groups: ['hielo', 'medida'],
        },
        {
          key: 'ORI-103',
          category: 'cervezas',
          name: 'Stout',
          priceCents: 4800,
          station: 'barra',
          groups: ['hielo', 'medida'],
        },
        {
          key: 'ORI-201',
          category: 'sin-alcohol',
          name: 'Limonada de menta',
          priceCents: 3300,
          station: 'barra',
          groups: ['hielo'],
        },
        {
          key: 'ORI-202',
          category: 'sin-alcohol',
          name: 'Jugo de naranja',
          priceCents: 3600,
          station: 'barra',
          groups: [],
        },
        {
          key: 'ORI-203',
          category: 'sin-alcohol',
          name: 'Agua mineral',
          priceCents: 1500,
          station: 'barra',
          groups: ['hielo'],
        },
        {
          key: 'ORI-301',
          category: 'comidas',
          name: 'Bife de chorizo',
          priceCents: 11200,
          station: 'cocina',
          groups: ['punto-carne'],
        },
        {
          key: 'ORI-302',
          category: 'comidas',
          name: 'Milanesa completa',
          priceCents: 9900,
          station: 'cocina',
          groups: ['punto-carne'],
        },
        {
          key: 'ORI-303',
          category: 'comidas',
          name: 'Empanadas (x6)',
          priceCents: 7800,
          station: 'cocina',
          groups: [],
        },
        {
          key: 'ORI-304',
          category: 'comidas',
          name: 'Sanguche de milanesa',
          priceCents: 8200,
          station: 'cocina',
          groups: ['punto-carne'],
        },
        {
          key: 'ORI-305',
          category: 'comidas',
          name: 'Papas a la inglesa',
          priceCents: 4200,
          station: 'cocina',
          groups: ['para-compartir'],
        },
        {
          key: 'ORI-401',
          category: 'picadas',
          name: 'Tabla de quesos',
          priceCents: 14500,
          station: 'cocina',
          groups: ['para-compartir'],
        },
        {
          key: 'ORI-402',
          category: 'picadas',
          name: 'Empanadas de humita',
          priceCents: 4800,
          station: 'cocina',
          groups: [],
        },
        {
          key: 'ORI-403',
          category: 'picadas',
          name: 'Chorizo con criolla',
          priceCents: 8900,
          station: 'cocina',
          groups: ['punto-carne'],
        },
        {
          key: 'ORI-404',
          category: 'picadas',
          name: 'Papas fritas con provolone',
          priceCents: 5800,
          station: 'cocina',
          groups: ['para-compartir'],
        },
      ],
      floors: [
        {
          key: 'salon',
          name: 'Salon',
          sort: 10,
          tables: [
            { label: '1', seats: 2, x: 0, y: 0, w: 100, h: 100, shape: 'round', status: 'LIBRE' },
            { label: '2', seats: 2, x: 140, y: 0, w: 100, h: 100, shape: 'round', status: 'LIBRE' },
            { label: '3', seats: 4, x: 280, y: 0, w: 140, h: 100, shape: 'rect', status: 'LIBRE' },
            { label: '4', seats: 4, x: 460, y: 0, w: 140, h: 100, shape: 'rect', status: 'LIBRE' },
            { label: '5', seats: 6, x: 0, y: 140, w: 200, h: 120, shape: 'rect', status: 'LIBRE' },
            {
              label: '6',
              seats: 8,
              x: 240,
              y: 140,
              w: 240,
              h: 120,
              shape: 'rect',
              status: 'LIBRE',
            },
          ],
        },
        {
          key: 'barra',
          name: 'Barra',
          sort: 20,
          tables: [
            { label: 'B1', seats: 1, x: 0, y: 0, w: 90, h: 90, shape: 'square', status: 'LIBRE' },
            { label: 'B2', seats: 1, x: 120, y: 0, w: 90, h: 90, shape: 'square', status: 'LIBRE' },
            { label: 'B3', seats: 1, x: 240, y: 0, w: 90, h: 90, shape: 'square', status: 'LIBRE' },
            { label: 'B4', seats: 1, x: 360, y: 0, w: 90, h: 90, shape: 'square', status: 'LIBRE' },
            { label: 'B5', seats: 1, x: 480, y: 0, w: 90, h: 90, shape: 'square', status: 'LIBRE' },
          ],
        },
      ],
    },
  },
];

export interface SeedSummary {
  organizations: Array<{
    name: string;
    orgId: string;
    venueId: string;
    roles: number;
    users: Array<{ name: string; email: string; role: string; pin?: string }>;
    devices: Array<{ name: string; status: string }>;
    catalog: {
      stations: number;
      categories: number;
      products: number;
      modifierGroups: number;
      floors: number;
      tables: number;
    };
  }>;
  permissions: number;
}

/**
 * Corre el seed.
 *
 * Es idempotente: cada paso consulta antes de insertar, asi que correrlo dos veces
 * no duplica organizaciones, usuarios ni dispositivos.
 */
export async function runSeed(db: DatabaseService, env: AppEnv): Promise<SeedSummary> {
  // El esquema de entorno ya garantiza un default, asi que no hay fallback que inventar:
  // si el default y el README no coinciden, el error se ve al loguearse.
  const ownerPassword = env.SEED_OWNER_PASSWORD;
  const hasher = new PasswordHasher(
    env.PIN_PEPPER,
    { memoryCost: env.ARGON2_MEMORY_KB, timeCost: env.ARGON2_TIME_COST },
    { memoryCost: env.ARGON2_PIN_MEMORY_KB, timeCost: env.ARGON2_PIN_TIME_COST },
  );

  // 1. Catalogo global de permisos. No tiene RLS (es identico para todos), asi que
  //    va con el rol de la app directo.
  await syncPermissions(db);

  const organizations: SeedSummary['organizations'] = [];

  for (const seed of SEEDS) {
    const org = await upsertOrganization(db, seed, hasher, ownerPassword);
    organizations.push(org);
  }

  return { organizations, permissions: PERMISSION_KEYS.length };
}

/**
 * Sincroniza el catalogo de permisos.
 *
 * Es la misma operacion que hace `RbacService.syncPermissionCatalog`, replicada
 * aqui porque el seed corre standalone (`pnpm db:seed`) sin levantar Nest.
 */
async function syncPermissions(db: DatabaseService): Promise<void> {
  for (const key of PERMISSION_KEYS) {
    await db.query(
      `INSERT INTO permissions (key, description)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
      [key, PERMISSION_LABELS[key]],
    );
  }
}

async function upsertOrganization(
  db: DatabaseService,
  seed: DemoSeed,
  hasher: PasswordHasher,
  ownerPassword: string,
): Promise<SeedSummary['organizations'][number]> {
  // La busqueda va por `platform_find_organization` (SECURITY DEFINER): con el
  // contexto de tenant vacio, un SELECT normal sobre `organizations` no devuelve
  // nada, y sin esto el seed no seria idempotente.
  const existing = await db.query<{ id: string }>(`SELECT * FROM platform_find_organization($1)`, [
    seed.taxId,
  ]);

  let orgId: string;
  if (existing.rows.length > 0) {
    orgId = existing.rows[0]!.id;
  } else {
    // El id se genera aca y NO con `RETURNING`.
    //
    // `INSERT ... RETURNING` exige que la fila nueva sea visible para las policies de
    // SELECT, y la fila recien creada todavia no lo es (el tenant recien creado no es
    // todavia el contexto). El error que devuelve Postgres es
    // "new row violates row-level security policy", que no dice nada del RETURNING.
    orgId = await db.transaction(async (client) => {
      const newId = randomUUID();
      await client.query(
        `INSERT INTO organizations (id, name, plan, country, currency, timezone, legal_name, tax_id)
         VALUES ($1::uuid, $2, $3::plan, 'AR', 'ARS', 'America/Argentina/Buenos_Aires', $4, $5)`,
        [newId, seed.name, seed.plan, seed.legalName, seed.taxId],
      );
      return newId;
    });
  }

  // A partir de aca todo corre con el contexto del local: es el mismo camino que
  // usa la API, RLS incluida.
  return db.withTenant({ orgId }, async (client) => {
    await client.query(
      `UPDATE organizations
       SET plan = $2, legal_name = $3, tax_id = $4, updated_at = now()
       WHERE id = $1::uuid`,
      [orgId, seed.plan, seed.legalName, seed.taxId],
    );

    // `venues` no tiene clave natural, asi que la idempotencia se resuelve con un
    // SELECT antes del INSERT, sin inventar una constraint artificial.
    const existingVenue = await client.query<{ id: string }>(
      `SELECT id FROM venues WHERE org_id = $1::uuid ORDER BY created_at LIMIT 1`,
      [orgId],
    );

    let venueId: string;
    if (existingVenue.rows.length > 0) {
      venueId = existingVenue.rows[0]!.id;
      await client.query(
        `UPDATE venues SET name = $2, kind = $3::venue_kind, address = $4, updated_at = now()
         WHERE id = $1::uuid`,
        [venueId, seed.name, seed.kind, seed.address],
      );
    } else {
      const venueRow = await client.query<{ id: string }>(
        `INSERT INTO venues (org_id, name, kind, address) VALUES ($1::uuid, $2, $3::venue_kind, $4)
         RETURNING id`,
        [orgId, seed.name, seed.kind, seed.address],
      );
      venueId = venueRow.rows[0]!.id;
    }

    // --- Roles por defecto
    const roleIds = new Map<string, string>();
    for (const role of Object.values(DEFAULT_ROLES)) {
      await client.query(
        `INSERT INTO roles (org_id, key, name, description, constraints, system)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb, true)
         ON CONFLICT (org_id, key) DO NOTHING`,
        [orgId, role.key, role.name, role.description, JSON.stringify(role.constraints)],
      );

      const roleRow = await client.query<{ id: string }>(
        `SELECT id FROM roles WHERE org_id = $1::uuid AND key = $2`,
        [orgId, role.key],
      );
      const roleId = roleRow.rows[0]!.id;
      roleIds.set(role.key, roleId);

      for (const permission of role.permissions) {
        await client.query(
          `INSERT INTO role_permissions (org_id, role_id, permission_key)
           VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT DO NOTHING`,
          [orgId, roleId, permission],
        );
      }
    }

    // --- Usuarios
    const users: SeedSummary['organizations'][number]['users'] = [];

    for (const user of seed.users) {
      const passwordHash = user.withPassword ? await hasher.hashPassword(ownerPassword) : null;

      const userRow = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, name, email, password_hash, status)
         VALUES ($1::uuid, $2, $3, $4, 'active')
         ON CONFLICT (org_id, email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [orgId, user.name, user.email, passwordHash],
      );
      const userId = userRow.rows[0]!.id;

      if (user.pin) {
        // El hash del PIN depende del id del usuario, asi que se escribe despues del
        // INSERT: es lo que hace que dos usuarios con el mismo PIN no sean iguales.
        //
        // Se limpian tambien los bloqueos. `loginWithPin` **saltea** al usuario con
        // `locked_until` en el futuro y responde "El PIN no coincide" sin verificar
        // nada, asi que un usuario de demo bloqueado queda inservible para siempre: no
        // hay ninguna accion en la app que lo desbloquee, y el PIN del seed es
        // publico. Es un problema de datos de demo, no de seguridad: en produccion el
        // desbloqueo lo decide un humano.
        //
        // Sin esto, probar el POS un par de veces con el PIN mal deja el usuario de
        // demo bloqueado y el unico remedio es tocar la base a mano.
        await client.query(
          `UPDATE users
              SET pin_hash = $2, pin_set_at = now(),
                  failed_login_count = 0, locked_until = NULL
            WHERE id = $1::uuid`,
          [userId, await hasher.hashPin(user.pin, userId)],
        );
      }

      await client.query(
        `INSERT INTO user_roles (org_id, user_id, role_id, venue_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
         ON CONFLICT DO NOTHING`,
        [orgId, userId, roleIds.get(user.role)!, venueId],
      );

      users.push({ name: user.name, email: user.email, role: user.role, pin: user.pin });
    }

    // --- Dispositivos
    const devices: SeedSummary['organizations'][number]['devices'] = [];
    for (const device of seed.devices) {
      await client.query(
        `INSERT INTO devices (org_id, venue_id, name, kind, fingerprint, status, approved_at)
         VALUES ($1::uuid, $2::uuid, $3, 'tablet', $4, $5::device_status,
                 CASE WHEN $5::device_status = 'active' THEN now() ELSE NULL END)
         ON CONFLICT (venue_id, fingerprint) DO UPDATE SET name = EXCLUDED.name`,
        [orgId, venueId, device.name, device.fingerprint, device.status],
      );
      devices.push({ name: device.name, status: device.status });
    }

    const catalog = await upsertCatalog(client, orgId, venueId, seed.catalog);

    // --- Promos y configuración fiscal de demo (Fase 2). Va DESPUÉS de la carta:
    // las promos se buscan por nombre de producto/categoría, que no existían antes.
    await seedDemoPromotionsAndFiscal(client, orgId, venueId);

    return {
      name: seed.name,
      orgId,
      venueId,
      roles: roleIds.size,
      users,
      devices,
      catalog,
    };
  });
}

/**
 * Promociones y fiscal para los locales demo (Fase 2).
 *
 * Se siembran desde lo que ya existe en la carta (buscar por nombre parcial) y
 * con idempotencia por nombre de la regla: correr el seed dos veces no duplica.
 */
async function seedDemoPromotionsAndFiscal(
  client: PoolClient,
  orgId: string,
  venueId: string,
): Promise<void> {
  // Una aclaracion util: la facturacion demo usa 21% en toda la carta; el motor
  // fiscal funciona igual con 0%, pero con 21% los neto/IVA se pueden verificar
  // a ojo en la cola de comprobantes.
  await client.query(
    `UPDATE products SET tax_rate = 0.21 WHERE org_id = $1::uuid AND tax_rate = 0`,
    [orgId],
  );

  const insertRule = async (
    name: string,
    type: string,
    scope: string,
    scopeNamePattern: string | null,
    schedule: object | null,
    params: object,
    priority: number,
    stackable: boolean,
  ) => {
    const exists = await client.query(
      `SELECT id FROM price_rules WHERE org_id = $1::uuid AND name = $2 LIMIT 1`,
      [orgId, name],
    );
    if (exists.rows.length > 0) return;

    let scopeId: string | null = null;
    if (scope !== 'ORDER' && scopeNamePattern) {
      const found = await client.query<{ id: string }>(
        scope === 'PRODUCT'
          ? `SELECT id FROM products WHERE org_id = $1::uuid AND name ILIKE $2 LIMIT 1`
          : `SELECT id FROM categories WHERE org_id = $1::uuid AND name ILIKE $2 LIMIT 1`,
        [orgId, scopeNamePattern],
      );
      scopeId = found.rows[0]?.id ?? null;
      // Si la promo no encuentra su objetivo, no se crea: un PERCENT sobre
      // scopeId NULL sería invisible para la CHECK y una promo que "no hace nada".
      if (!scopeId) return;
    }

    await client.query(
      `INSERT INTO price_rules (org_id, venue_id, name, type, scope, scope_id, schedule, params, priority, stackable, active)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::jsonb, $8::jsonb, $9, $10, true)`,
      [
        orgId,
        venueId,
        name,
        type,
        scope,
        scopeId,
        schedule ? JSON.stringify(schedule) : null,
        JSON.stringify(params),
        priority,
        stackable,
      ],
    );
  };

  await insertRule(
    'Happy Hour fernet (lun-jue 18-20)',
    'PERCENT',
    'PRODUCT',
    '%Fernet%',
    {
      daysOfWeek: [1, 2, 3, 4],
      from: '18:00',
      to: '20:00',
      timezone: 'America/Argentina/Buenos_Aires',
    },
    { bps: 2000 },
    10,
    false,
  );

  await insertRule(
    '2x1 en cafe (mié 15-18)',
    'BOGO',
    'CATEGORY',
    '%caf%',
    { daysOfWeek: [3], from: '15:00', to: '18:00', timezone: 'America/Argentina/Buenos_Aires' },
    {},
    5,
    false,
  );

  await insertRule(
    'Miércoles de barra -10%',
    'PERCENT',
    'ORDER',
    null,
    { daysOfWeek: [3], from: '20:00', to: '23:59', timezone: 'America/Argentina/Buenos_Aires' },
    { bps: 1000 },
    5,
    true,
  );

  // Fase 3: mock en homologacion. En prod real, `provider: 'afip'` y certRef
  // apuntando al vault.
  await client.query(
    `INSERT INTO fiscal_settings (venue_id, org_id, provider, environment, point_of_sale, cuit)
     VALUES ($1::uuid, $2::uuid, 'mock', 'homo', '00001', '30712345678')
     ON CONFLICT (venue_id) DO NOTHING`,
    [venueId, orgId],
  );

  // --- Fase 3: settings del local para el autopedido y el takeaway ---
  const venueKind = await client.query<{ kind: string }>(
    `SELECT kind FROM venues WHERE id = $1::uuid`,
    [venueId],
  );
  await client.query(
    `UPDATE venues
        SET settings = settings || $2::jsonb, updated_at = now()
      WHERE id = $1::uuid`,
    [
      venueId,
      JSON.stringify({
        qrApprovalMode: venueKind.rows[0]?.kind === 'bar' ? 'WAITER' : 'AUTO',
        takeaway: { slotMinutes: 15, maxPerSlot: 4, leadMinutes: 20, openHour: 9, closeHour: 23 },
      }),
    ],
  );

  // --- Fase 3: alérgenos, foto y traducción del catálogo ---
  // Los alérgenos se derivan del nombre por una heurística de demo; un catálogo
  // real los carga a mano en el backoffice. La foto sale de picsum con seed del
  // SKU: determinística para la demo, nunca rota.
  await client.query(
    `UPDATE products p
        SET image_url = 'https://picsum.photos/seed/' || p.sku || '/600/400',
            description = 'Clásico de la casa: ' || p.name,
            allergens = CASE
              WHEN p.name ILIKE '%leche%' OR p.name ILIKE '%capuchino%' OR p.name ILIKE '%latte%'
                OR p.name ILIKE '%cortado%' OR p.name ILIKE '%flat white%' OR p.name ILIKE '%mocha%'
                OR p.name ILIKE '%torta%' OR p.name ILIKE '%ricota%' OR p.name ILIKE '%alfajor%'
                OR p.name ILIKE '%napolitana%' OR p.name ILIKE '%brioche%'
                THEN ARRAY['lactosa']
              WHEN p.name ILIKE '%medialuna%' OR p.name ILIKE '%factura%' OR p.name ILIKE '%sanguche%'
                OR p.name ILIKE '%empanada%' OR p.name ILIKE '%milanesa%' OR p.name ILIKE '%fideos%'
                THEN ARRAY['gluten']
              ELSE ARRAY[]::text[]
            END,
            name_i18n = jsonb_build_object('es', jsonb_build_object('name', p.name),
                                           'en', jsonb_build_object('name', p.name),
                                           'pt', jsonb_build_object('name', p.name)),
            description_i18n = jsonb_build_object('es', jsonb_build_object('description', 'Clásico de la casa: ' || p.name)),
            updated_at = now()
      WHERE p.org_id = $1::uuid`,
    [orgId],
  );

  // --- Fase 3: programa de fidelización de puntos (único por organización) ---
  await client.query(
    `INSERT INTO loyalty_programs (org_id, name, kind, points_per_cents, stamps_target, redeem_cost_points)
     SELECT $1::uuid, 'Café Comanda', 'POINTS', 100, 0, 500
     WHERE NOT EXISTS (SELECT 1 FROM loyalty_programs lp WHERE lp.org_id = $1::uuid)`,
    [orgId],
  );

  // --- Fase 3: dos clientes de ejemplo (para probar canje y saldo) ---
  await client.query(
    `INSERT INTO customers (org_id, phone, name) VALUES ($1::uuid, '+5491100000001', 'Cliente Demo')
     ON CONFLICT (org_id, phone) WHERE phone IS NOT NULL DO NOTHING`,
    [orgId],
  );
}

/**
 * Resumen de la carta, tal como quedo en la base.
 *
 * Se devuelve para el log: un seed que dice "listo" sin decir quantos productos
 * escribio deja al que lo corre sin forma de saber si cargo la carta o si el
 * `ON CONFLICT` se comio todo.
 */
interface CatalogUpsertResult {
  stations: number;
  categories: number;
  products: number;
  modifierGroups: number;
  floors: number;
  tables: number;
}

/**
 * Siembra la carta completa del local.
 *
 * Corre **dentro** de la transaccion con contexto de tenant que abrio
 * `upsertOrganization`, igual que el resto del seed: la RLS filtra cada tabla y un
 * seed que corriera con privilegios de owner probaria una seguridad que la app no
 * tiene.
 *
 * La idempotencia es por clave natural, no por id: los ids los genera la base y
 * volver a correr el seed tiene que encontrar lo que ya escribio. Cada clave esta
 * respaldada por algo real del esquema:
 *
 *  - `products.sku` tiene indice unico parcial (`products_org_sku_key`).
 *  - El resto se resuelve con un SELECT antes del INSERT, como ya se hace con
 *    `venues`: son tablas sin clave natural y agregar una constraint artificial
 *    para acomodar al seed seria cambiar el esquema de produccion por el seed.
 *
 * Los productos se actualizan en cada corrida (`DO UPDATE`). Es lo que hace que
 * corregir un precio en el seed y volver a correrlo tome efecto, y no deja la
 * fila con el precio viejo para siempre.
 */
async function upsertCatalog(
  client: PoolClient,
  orgId: string,
  venueId: string,
  catalog: DemoCatalog,
): Promise<CatalogUpsertResult> {
  // --- Estaciones. Necesarias antes que los productos: `products.station_id` las referencia.
  const stationIds = new Map<string, string>();
  for (const [sort, station] of catalog.stations.entries()) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM stations WHERE org_id = $1::uuid AND venue_id = $2::uuid AND name = $3`,
      [orgId, venueId, station.name],
    );

    if (existing.rows.length > 0) {
      const id = existing.rows[0]!.id;
      await client.query(
        `UPDATE stations SET kind = $2, sort = $3, active = true, updated_at = now()
          WHERE id = $1::uuid`,
        [id, station.kind, sort * 10],
      );
      stationIds.set(station.key, id);
      continue;
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO stations (org_id, venue_id, name, kind, sort)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5) RETURNING id`,
      [orgId, venueId, station.name, station.kind, sort * 10],
    );
    stationIds.set(station.key, inserted.rows[0]!.id);
  }

  // --- Categorias. `venue_id` NO es null: la carta del local es del local.
  //
  // El esquema permite `venue_id IS NULL` para categorias compartidas entre locales
  // de una organizacion, y el seed no las usa a proposito: un local de demo que
  // compartiera carta con otro obligaria al POS a resolver que productos son de
  // este mostrador, que es exactamente la confusion que el `venue_id` nullable
  // resuelve para el dueno de una cadena, no para una demo.
  const categoryIds = new Map<string, string>();
  for (const category of catalog.categories) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM categories WHERE org_id = $1::uuid AND venue_id = $2::uuid AND name = $3`,
      [orgId, venueId, category.name],
    );

    if (existing.rows.length > 0) {
      const id = existing.rows[0]!.id;
      await client.query(
        `UPDATE categories SET sort = $2, active = true, updated_at = now() WHERE id = $1::uuid`,
        [id, category.sort],
      );
      categoryIds.set(category.key, id);
      continue;
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO categories (org_id, venue_id, name, sort)
       VALUES ($1::uuid, $2::uuid, $3, $4) RETURNING id`,
      [orgId, venueId, category.name, category.sort],
    );
    categoryIds.set(category.key, inserted.rows[0]!.id);
  }

  // --- Grupos de modificadores y modificadores.
  const groupIds = new Map<string, string>();
  for (const [sort, group] of catalog.modifierGroups.entries()) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM modifier_groups WHERE org_id = $1::uuid AND name = $2`,
      [orgId, group.name],
    );

    let groupId: string;
    if (existing.rows.length > 0) {
      groupId = existing.rows[0]!.id;
      await client.query(
        `UPDATE modifier_groups
            SET min_select = $2, max_select = $3, sort = $4, active = true, updated_at = now()
          WHERE id = $1::uuid`,
        [groupId, group.minSelect, group.maxSelect, sort * 10],
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO modifier_groups (org_id, name, min_select, max_select, sort)
         VALUES ($1::uuid, $2, $3, $4, $5) RETURNING id`,
        [orgId, group.name, group.minSelect, group.maxSelect, sort * 10],
      );
      groupId = inserted.rows[0]!.id;
    }
    groupIds.set(group.key, groupId);

    for (const [modifierSort, modifier] of group.modifiers.entries()) {
      const existingModifier = await client.query<{ id: string }>(
        `SELECT id FROM modifiers WHERE group_id = $1::uuid AND name = $2`,
        [groupId, modifier.name],
      );

      if (existingModifier.rows.length > 0) {
        await client.query(
          `UPDATE modifiers SET price_delta_cents = $2, sort = $3, active = true, updated_at = now()
            WHERE id = $1::uuid`,
          [existingModifier.rows[0]!.id, modifier.priceDeltaCents, modifierSort * 10],
        );
        continue;
      }

      await client.query(
        `INSERT INTO modifiers (org_id, group_id, name, price_delta_cents, sort)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
        [orgId, groupId, modifier.name, modifier.priceDeltaCents, modifierSort * 10],
      );
    }
  }

  // --- Productos.
  //
  // `tax_rate` se deja en 0: el motor fiscal es Fase 2 y el campo existe para no
  // tener que repoblar la tabla despues. Poner 0.21 en un seed de demo hace que
  // un POS de prueba muestre un impuesto que ningun local de Buenos Aires factura
  // asi.
  const productIds = new Map<string, string>();
  for (const [sort, product] of catalog.products.entries()) {
    const categoryId = categoryIds.get(product.category);
    if (!categoryId) {
      throw new Error(`El producto ${product.key} cuelga de una categoria que no existe`);
    }

    const sku = product.key;
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM products WHERE org_id = $1::uuid AND sku = $2`,
      [orgId, sku],
    );

    let productId: string;
    if (existing.rows.length > 0) {
      productId = existing.rows[0]!.id;
      await client.query(
        `UPDATE products
            SET category_id = $2, name = $3, price_cents = $4, station_id = $5,
                available = $6, sort = $7, updated_at = now()
          WHERE id = $1::uuid`,
        [
          productId,
          categoryId,
          product.name,
          product.priceCents,
          stationIds.get(product.station) ?? null,
          product.available ?? true,
          sort * 10,
        ],
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO products (org_id, category_id, name, sku, price_cents, station_id, tags, sort)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], $8) RETURNING id`,
        [
          orgId,
          categoryId,
          product.name,
          sku,
          product.priceCents,
          stationIds.get(product.station) ?? null,
          product.tags ?? [],
          sort * 10,
        ],
      );
      productId = inserted.rows[0]!.id;
    }
    productIds.set(product.key, productId);

    // La tabla puente se reemplaza entera. Un merge dejaria grupos que el seed
    // saco de la carta, y el POS abriria un selector de modificadores que el
    // dueno ya habia dado de baja.
    await client.query(`DELETE FROM product_modifier_groups WHERE product_id = $1::uuid`, [
      productId,
    ]);
    for (const [groupSort, groupKey] of product.groups.entries()) {
      const groupId = groupIds.get(groupKey);
      if (!groupId) {
        throw new Error(`El producto ${product.key} cuelga de un grupo que no existe`);
      }
      await client.query(
        `INSERT INTO product_modifier_groups (org_id, product_id, group_id, sort)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
         ON CONFLICT (product_id, group_id) DO NOTHING`,
        [orgId, productId, groupId, groupSort],
      );
    }
  }

  // --- Sectores y mesas.
  const floorIds = new Map<string, string>();
  let tableCount = 0;
  for (const floor of catalog.floors) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM floors WHERE org_id = $1::uuid AND venue_id = $2::uuid AND name = $3`,
      [orgId, venueId, floor.name],
    );

    let floorId: string;
    if (existing.rows.length > 0) {
      floorId = existing.rows[0]!.id;
      await client.query(`UPDATE floors SET sort = $2 WHERE id = $1::uuid`, [floorId, floor.sort]);
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO floors (org_id, venue_id, name, sort)
         VALUES ($1::uuid, $2::uuid, $3, $4) RETURNING id`,
        [orgId, venueId, floor.name, floor.sort],
      );
      floorId = inserted.rows[0]!.id;
    }
    floorIds.set(floor.key, floorId);

    for (const table of floor.tables) {
      const existingTable = await client.query<{ id: string }>(
        `SELECT id FROM tables WHERE org_id = $1::uuid AND venue_id = $2::uuid AND floor_id = $3::uuid AND label = $4`,
        [orgId, venueId, floorId, table.label],
      );

      // El estado NO se sobrescribe: `OCUPADA` y `PIDIO_CUENTA` los deriva el
      // sincronizador al abrir o cerrar una comanda, y una mesa con gente sentada
      // no puede volver a `LIBRE` porque se corrio el seed.
      if (existingTable.rows.length > 0) {
        await client.query(
          `UPDATE tables
              SET seats = $2, x = $3, y = $4, w = $5, h = $6, shape = $7, updated_at = now()
            WHERE id = $1::uuid`,
          [existingTable.rows[0]!.id, table.seats, table.x, table.y, table.w, table.h, table.shape],
        );
        tableCount += 1;
        continue;
      }

      await client.query(
        `INSERT INTO tables (org_id, venue_id, floor_id, label, seats, x, y, w, h, shape, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::varchar)`,
        [
          orgId,
          venueId,
          floorId,
          table.label,
          table.seats,
          table.x,
          table.y,
          table.w,
          table.h,
          table.shape,
          table.status,
        ],
      );
      tableCount += 1;
    }
  }

  return {
    stations: stationIds.size,
    categories: categoryIds.size,
    products: productIds.size,
    modifierGroups: groupIds.size,
    floors: floorIds.size,
    tables: tableCount,
  };
}

/** Ejecuta el seed y muestra un resumen legible en consola. */
export async function seedFromEnv(): Promise<SeedSummary> {
  loadDotEnv();
  const env = loadEnv();
  const { DatabaseService } = await import('./database.service');
  const db = new DatabaseService(env);

  try {
    const summary = await runSeed(db, env);
    printSummary(summary, env);
    return summary;
  } finally {
    await db.onModuleDestroy();
  }
}

function printSummary(summary: SeedSummary, env: AppEnv): void {
  console.log(`\n  ${summary.permissions} permisos sincronizados\n`);

  for (const org of summary.organizations) {
    console.log(`  ${org.name}  (${org.orgId})`);
    console.log(`    local ${org.venueId} · ${org.roles} roles\n`);

    console.log('    usuarios:');
    for (const user of org.users) {
      const pin = user.pin ? ` · PIN ${user.pin}` : '';
      console.log(`      ${user.role.padEnd(9)} ${user.name} <${user.email}>${pin}`);
    }

    console.log('\n    dispositivos:');
    for (const device of org.devices) {
      console.log(`      ${device.status.padEnd(8)} ${device.name}`);
    }

    const c = org.catalog;
    console.log('\n    carta:');
    console.log(`      ${c.products} productos en ${c.categories} categorias`);
    console.log(`      ${c.modifierGroups} grupos de modificadores · ${c.stations} estaciones`);
    console.log(`      ${c.tables} mesas en ${c.floors} sectores`);
    console.log('');
  }

  console.log(`  Contraseña de los usuarios con acceso web: ${env.SEED_OWNER_PASSWORD}`);
  console.log('  Entrar al POS: elegí el dispositivo activo y tipeá el PIN del mozo.\n');
}

if (require.main === module) {
  seedFromEnv().catch((error: unknown) => {
    console.error('Fallo el seed:', error);
    process.exit(1);
  });
}
