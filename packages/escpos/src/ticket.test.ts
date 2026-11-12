import { describe, expect, it } from 'vitest';
import { orderTotals, type KitchenTicket, type Order } from '@comanda/domain';
import {
  buildKitchenTicket,
  buildOrderTicket,
  line,
  rule,
  withGuide,
  TICKET_COLUMNS,
} from './ticket';
import * as cmd from './commands';
import { toBytes } from './text';
import { formatEscPos } from './drivers/console-driver';

/**
 * Los bytes del ticket, exactos.
 *
 * ## Por que `toEqual` y no snapshots
 *
 * Un snapshot es un `.snap` que se regenera con `--update` sin que nadie lo lea. Para
 * un ticket eso es exactamente el agujero por donde entra un bug: si el byte de corte
 * cambia de `1b 56 42` a `1b 56 41`, el snapshot se regenera, el test sigue verde y la
 * impresora deja de cortar el papel. Un ticket que se acumula adentro del rollo es el
 * fallo mas caro del sistema de impresion y no lo detecta nadie.
 *
 * Por eso el fixture esta escrito a mano en cada test, con los numeros a la vista, y
 * el orden de los bytes es el que el protocolo dice.
 *
 * Los tests que no necesitan el byte exacto (que haya un corte, que el total coincida)
 * usan busquedas: esos si sobreviven a un cambio legitimo del formato.
 */

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const CREATED_AT = new Date(2026, 2, 2, 14, 32, 0);

/**
 * El ticket como se lee, con los comandos marcados.
 *
 * El espacio entre el simbolo de la moneda y el numero es un **NBSP** (0xA0), no un
 * espacio comun: sale de `Intl` con la convencion argentina. En CP850 el NBSP si tiene
 * byte (0xFF), asi que en el papel se ve bien. Aca se cambia a espacio normal para que
 * las comparaciones se puedan escribir.
 */
function readable(bytes: readonly number[]): string {
  return formatEscPos(new Uint8Array(bytes)).replace(/\u00a0/g, ' ');
}

const KITCHEN_TICKET: KitchenTicket = {
  id: '11111111-1111-4111-8111-111111111111',
  stationId: '22222222-2222-4222-8222-222222222222',
  orderId: '33333333-3333-4333-8333-333333333333',
  orderNumberLabel: 'A-104',
  tableLabel: '4',
  status: 'NEW',
  priority: 0,
  // Se construye con el constructor local y no con un string ISO: `timeOf` usa las
  // horas locales (la impresora muestra la hora del local, no la de UTC), asi que un
  // ISO con `Z` daria un ticket con una hora que depende de la zona de la maquina
  // que corre el test.
  createdAt: CREATED_AT.toISOString(),
  lines: [
    {
      itemId: '44444444-4444-4444-8444-444444444444',
      name: 'Milanesa napolitana',
      quantity: 2,
      note: 'sin sal',
      modifiers: ['En-Casa', 'Con papas'],
      course: 1,
    },
    {
      itemId: '55555555-5555-4555-8555-555555555555',
      name: 'Vino tinto',
      quantity: 1,
      note: null,
      modifiers: [],
      course: 1,
    },
  ],
};

function orderOf(items: Order['items'], overrides: Partial<Order> = {}): Order {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    venueId: '66666666-6666-4666-8666-666666666666',
    tableId: '77777777-7777-4777-8777-777777777777',
    tableLabel: '4',
    channel: 'POS',
    status: 'OPEN',
    numberLabel: 'A-104',
    openedBy: null,
    openedAt: CREATED_AT.toISOString(),
    guests: 2,
    shiftId: null,
    totalCents: 0,
    tipCents: 0,
    items,
    ...overrides,
  };
}

const ITEMS: Order['items'] = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    orderId: '33333333-3333-4333-8333-333333333333',
    productId: null,
    nameSnapshot: 'Milanesa',
    quantity: 2,
    unitPriceCents: 6000,
    appliedRules: [],
    status: 'ACTIVE',
    course: 1,
    seat: null,
    note: 'sin sal',
    modifiers: [],
    voidReason: null,
    voidedAt: null,
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    orderId: '33333333-3333-4333-8333-333333333333',
    productId: null,
    nameSnapshot: 'Vino tinto',
    quantity: 1,
    unitPriceCents: 4500,
    appliedRules: [],
    status: 'ACTIVE',
    course: 1,
    seat: null,
    note: null,
    modifiers: [],
    voidReason: null,
    voidedAt: null,
  },
];

// -----------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------

describe('layout', () => {
  it('la guia de puntos llena el ancho exacto', () => {
    const result = withGuide('2x Milanesa', '12000', TICKET_COLUMNS);
    expect(result).toHaveLength(TICKET_COLUMNS);
    expect(result.startsWith('2x Milanesa')).toBe(true);
    expect(result.endsWith('12000')).toBe(true);
  });

  it('la guia no recorta cuando no entra', () => {
    // Recortar el nombre a la mitad con puntos de guia es peor que pasarse de ancho.
    const result = withGuide('x'.repeat(40), '999999999', TICKET_COLUMNS);
    expect(result).not.toContain('.');
    expect(result.length).toBeGreaterThan(TICKET_COLUMNS);
  });

  it('line recorta por caracteres, no por bytes', () => {
    // Con acentos, 42 caracteres pueden ser mas de 42 bytes.
    expect(line('ñ'.repeat(50))).toHaveLength(TICKET_COLUMNS);
  });

  it('rule tiene el ancho del papel', () => {
    expect(rule()).toHaveLength(TICKET_COLUMNS);
    expect(rule()).toBe('-'.repeat(42));
  });
});

// -----------------------------------------------------------------------------
// Ticket de cocina
// -----------------------------------------------------------------------------

describe('buildKitchenTicket', () => {
  const bytes = buildKitchenTicket(KITCHEN_TICKET, 'Bar');

  it('empieza con init y la pagina de codigos, en ese orden', () => {
    // El `init` va primero: es lo unico que garantiza que el ticket anterior no dejo la
    // fuente en negrita.
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]);
    // `ESC t 2` = CP850, que es la que se elige por default.
    expect(bytes.slice(2, 5)).toEqual([0x1b, 0x74, 0x02]);
  });

  it('el encabezado va centrado, en doble y en negrita', () => {
    const printable = readable(bytes);
    expect(printable.startsWith('<ESC @><ESC t 0x02><ESC a 0x01><GS ! 0x11><ESC E 0x01>Bar')).toBe(
      true,
    );
  });

  it('codifica los acentos de CP850 en sus bytes', () => {
    // `ñ` = A4, `é` = 82, `á` = A0. En UTF-8 serían dos bytes cada uno y la
    // impresora imprimiría dos simbolos raros.
    const ticket = buildKitchenTicket(
      {
        ...KITCHEN_TICKET,
        lines: [
          {
            itemId: '44444444-4444-4444-8444-444444444444',
            name: 'Ñandú',
            quantity: 1,
            note: 'niño',
            modifiers: ['Español'],
            course: 1,
          },
        ],
      },
      'Bar',
    );
    const text = toBytes('Ñandú', 'CP850');
    expect(text).toEqual([0xa5, 0x61, 0x6e, 0x64, 0xa3]);
    // Los bytes aparecen en el buffer del ticket, no en UTF-8.
    expect(ticket.join(',')).toContain(text.join(','));
    expect(readable(ticket)).toContain('Ñandú');
    expect(readable(ticket)).toContain('niño');
  });

  it('pone cantidad y producto juntos, en el mismo peso', () => {
    const printable = readable(bytes);
    expect(printable).toContain('<ESC E 0x01>2x Milanesa napolitana\n');
  });

  it('los modificadores van con sangria y en su propia linea', () => {
    const printable = readable(bytes);
    expect(printable).toContain('<ESC E 0x00>   - En-Casa\n');
    expect(printable).toContain('   - Con papas\n');
  });

  it('la nota del mozo va sola, en negrita, al final del producto', () => {
    const printable = readable(bytes);
    expect(printable).toContain('<ESC E 0x01>   sin sal\n');
  });

  it('el ticket de cocina NO lleva el total', () => {
    // El que mira el papel no lo cobra, y un total escrito a mano es un total que se
    // puede equivocar.
    const printable = readable(bytes);
    expect(printable).not.toContain('TOTAL');
    expect(printable).not.toContain('$');
  });

  it('el corte esta al final, precedido del cortador armado', () => {
    // `ESC p 1 19 fa` arma el cortador: sin eso, este ticket corta y el siguiente se
    // imprime entero adentro del rollo.
    const printable = readable(bytes);
    expect(printable).toContain('<ESC p 0x01 0x19 0xfa><GS V>B');

    // Los ultimos bytes, en el orden en que los interpreta la impresora:
    //   GS V 66  -> corta
    //   ESC @    -> reset: devuelve la impresora al estado de fabrica
    //   ESC t 2  -> CP850 de vuelta
    // El `ESC p 1 19 fa` que arma el cortador va justo antes, y los bytes `19 fa`
    // quedan ahi pegados porque `formatEscPos` los imprime dentro de la marca.
    expect(bytes.slice(-8, -5)).toEqual([0x1d, 0x56, 0x42]);
    expect(bytes.slice(-5)).toEqual([0x1b, 0x40, 0x1b, 0x74, 0x02]);
  });

  it('con cut: false no corta pero arma el cortador igual', () => {
    const sinCorte = buildKitchenTicket(KITCHEN_TICKET, 'Bar', { cut: false });
    const printable = readable(sinCorte);
    expect(printable).toContain('<ESC p 0x01 0x19 0xfa>');
    expect(printable).not.toContain('<GS V>');
  });

  it('sin mesa no imprime el renglón de mesa', () => {
    const ticket = buildKitchenTicket({ ...KITCHEN_TICKET, tableLabel: null }, 'Bar');
    expect(readable(ticket)).not.toContain('Mesa');
  });

  it('un item sin modificadores ni nota imprime solo su linea', () => {
    const printable = readable(bytes);
    expect(printable).toContain('1x Vino tinto\n<ESC E 0x00>---');
  });

  it('un caracter fuera de la pagina no puede inyectar un comando', () => {
    // Un `0x1B` suelto en medio del texto abre un ESC y lo que sigue se ejecuta. El
    // `sanitize` lo convierte antes de codificar, asi que un producto con emoji no abre
    // el cajon de dinero.
    const ticket = buildKitchenTicket(
      {
        ...KITCHEN_TICKET,
        lines: [
          {
            itemId: '44444444-4444-4444-8444-444444444444',
            name: 'Café ☕',
            quantity: 1,
            note: null,
            modifiers: [],
            course: 1,
          },
        ],
      },
      'Bar',
    );
    expect(readable(ticket)).toContain('1x Café ?');
    // Ningún ESC fuera de los que genera el propio ticket.
    const escCount = ticket.filter((byte) => byte === 0x1b).length;
    const printable = readable(ticket);
    const generatedEsc = (printable.match(/<ESC /g) ?? []).length;
    expect(escCount).toBe(generatedEsc);
  });
});

// -----------------------------------------------------------------------------
// Comprobante
// -----------------------------------------------------------------------------

describe('buildOrderTicket', () => {
  const order = orderOf(ITEMS);
  const bytes = buildOrderTicket({ order, venueName: 'Bar', currency: 'ARS' });

  it('el total coincide con orderTotals() del dominio', () => {
    // El comprobante NO recalcula: usa la misma funcion pura que corre el POS sobre su
    // replica. Si difirieran un centavo, el cliente ve un numero en pantalla y otro en
    // el papel.
    const expected = orderTotals({ items: order.items, currency: 'ARS' });
    const printable = readable(bytes);
    expect(expected.totalCents).toBe(16500);
    expect(printable).toContain('TOTAL');
    // El importe formateado de `$ 165,00` tiene que estar en el ticket.
    expect(printable).toContain('$ 165,00');
  });

  it('el total va en doble y alineado a la derecha', () => {
    const printable = readable(bytes);
    expect(printable).toContain('<ESC a 0x02><GS ! 0x01><ESC E 0x01>TOTAL $ 165,00\n');
  });

  it('los modificadores van dentro del precio unitario, no como una linea con importe', () => {
    // "capuchino doble" es un producto con dos atributos, no dos productos: el importe
    // de la linea ya lo incluye, asi que no puede aparecer dos veces.
    const conModificador = orderOf([
      {
        ...ITEMS[0]!,
        quantity: 1,
        unitPriceCents: 3000,
        modifiers: [
          {
            modifierId: null,
            name: 'doble',
            priceDeltaCents: 1500,
          },
        ],
      },
    ]);
    const printable = readable(
      buildOrderTicket({ order: conModificador, venueName: 'Bar', currency: 'ARS' }),
    );

    expect(printable).toContain('$ 45,00');
    expect(printable).toContain('+15,00 doble');
    const expected = orderTotals({ items: conModificador.items, currency: 'ARS' });
    expect(expected.totalCents).toBe(4500);
  });

  it('un descuento sale restado y con motivo visible', () => {
    const printable = readable(
      buildOrderTicket({ order, venueName: 'Bar', currency: 'ARS', discountCents: 1000 }),
    );
    expect(printable).toContain('Descuento');
    expect(printable).toContain('-$ 10,00');
    expect(printable).toContain('TOTAL $ 155,00');
  });

  it('sin descuento ni propina no imprime las filas vacias', () => {
    const printable = readable(bytes);
    expect(printable).not.toContain('Descuento');
    expect(printable).not.toContain('Propina');
    expect(printable).toContain('Subtotal');
  });

  it('un item anulado no sale en el papel', () => {
    const conVoided = orderOf([{ ...ITEMS[0]!, status: 'VOIDED' }, ITEMS[1]!]);
    const printable = readable(
      buildOrderTicket({ order: conVoided, venueName: 'Bar', currency: 'ARS' }),
    );
    expect(printable).not.toContain('Milanesa');
    expect(printable).toContain('Vino tinto');
    expect(printable).toContain('TOTAL $ 45,00');
  });

  it('el corte esta al final, como en el ticket de cocina', () => {
    expect(bytes.slice(-8, -5)).toEqual([0x1d, 0x56, 0x42]);
    expect(bytes.slice(-5)).toEqual([0x1b, 0x40, 0x1b, 0x74, 0x02]);
  });

  it('el importe de cada linea sale con la guia de puntos', () => {
    const printable = readable(bytes);
    const lineWithGuide = printable
      .split('\n')
      .map((candidate) => candidate.replace(/<[A-Z]+ [^>]*>/g, ''))
      .find((candidate) => candidate.includes('2x Milanesa'));
    expect(lineWithGuide).toBeDefined();
    expect(lineWithGuide!.length).toBeLessThanOrEqual(TICKET_COLUMNS);
    expect(lineWithGuide).toContain('$ 120,00');
  });

  it('el ancho se respeta en un nombre larguisimo', () => {
    // Se trunca a 42 caracteres, no a 42 bytes: con acentos, 42 caracteres pueden ser
    // mas de 42 bytes y el renglon se pasa del papel.
    const largo = orderOf([
      { ...ITEMS[0]!, nameSnapshot: 'Milanesa napolitana con puré de papas y huevo'.repeat(3) },
      ITEMS[1]!,
    ]);
    const printable = readable(
      buildOrderTicket({ order: largo, venueName: 'Bar', currency: 'ARS' }),
    );
    // Las marcas de comando no son papel: el ancho se mide sobre el texto.
    for (const candidate of printable.split('\n').map((c) => c.replace(/<[A-Z]+ [^>]*>/g, ''))) {
      expect(candidate.length).toBeLessThanOrEqual(TICKET_COLUMNS);
    }
  });

  it('respeta CP858 cuando el local factura en euros', () => {
    const euros = orderOf([ITEMS[0]!]);
    const printable = readable(
      buildOrderTicket(
        { order: euros, venueName: 'Bar €', currency: 'EUR' },
        { codepage: 'CP858' },
      ),
    );
    expect(printable).toContain('Bar €');
    expect(printable).toContain('€');
  });

  it('la cola del ticket es siempre la misma, sea cual sea el ticket', () => {
    // El estado de la impresora tiene que volver al inicial **una** vez. Si cada
    // generador lo hiciera por su cuenta, el segundo ticket sale en doble y centrado.
    const cola = (b: readonly number[]) => b.slice(-10).join(',');
    const otro = buildOrderTicket({
      order: orderOf([ITEMS[1]!]),
      venueName: 'Otro',
      currency: 'ARS',
    });
    expect(cola(bytes)).toBe(cola(otro));
  });
});

// -----------------------------------------------------------------------------
// Codepage
// -----------------------------------------------------------------------------

describe('codepage del ticket', () => {
  it('el nombre se traduce al numero de ESC t', () => {
    const byName = (name: string) =>
      readable(buildKitchenTicket(KITCHEN_TICKET, 'Bar', { codepage: name })).match(
        /<ESC t (0x[0-9a-f]+)>/,
      )?.[1];

    expect(byName('CP437')).toBe('0x00');
    expect(byName('CP850')).toBe('0x02');
    expect(byName('CP858')).toBe('0x13');
    // Una pagina desconocida no rompe el ticket: cae en CP850.
    expect(byName('CP999')).toBe('0x02');
  });

  it('init y el corte son los mismos en cualquier pagina', () => {
    const a = buildKitchenTicket(KITCHEN_TICKET, 'Bar', { codepage: 'CP437' });
    const b = buildKitchenTicket(KITCHEN_TICKET, 'Bar', { codepage: 'CP858' });
    expect(a.slice(0, 2)).toEqual(b.slice(0, 2));
    expect(a.slice(-8, -5)).toEqual(b.slice(-8, -5));
  });
});

describe('los comandos usados son los del protocolo', () => {
  it('el corte del ticket es exactamente GS V 66', () => {
    // Si esto cambia, la impresora deja de cortar y el papel se acumula en el rollo.
    expect([...cmd.cut()]).toEqual([0x1d, 0x56, 66]);
  });
});
