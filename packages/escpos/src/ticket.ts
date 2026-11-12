import { formatMoney, money, orderTotals, type KitchenTicket, type Order } from '@comanda/domain';
import * as cmd from './commands';
import { sanitize, toBytes, type Codepage } from './text';

/**
 * Generador de tickets ESC/POS.
 *
 * ## Que decide un ticket de cocina
 *
 * La pantalla de cocina esta a dos metros, de pie, con extractor y ruido. El papel es
 * la version de eso: se lee en un segundo y se tira. De ahi salen las tres reglas que
 * se ven en `buildKitchenTicket`:
 *
 *  1. **El nombre del local arriba, en doble.** Es lo primero que se lee de reojo para
 *     saber que papel es.
 *  2. **Cantidad y producto en la misma linea y en el mismo peso.** "2x Milanesa" y
 *     no "Milanesa x2": el orden en que se lee una lista de cosas es cantidad primero.
 *  3. **La nota del mozo en su propia linea, con sangria, sin nada alrededor.**
 *     "sin sal", "para llevar", "urgente". Es la linea que evita que el plato vuelva.
 *
 * ## Que NO se reimprime
 *
 * Los totales. Un papel de cocina no lleva el total porque el que lo mira no lo cobra,
 * y el total que alguien escribe a mano en un papel de cocina es un total que se puede
 * equivocar. El total va en `buildOrderTicket`, que es el comprobante.
 *
 * ## La guia de puntos
 *
 * `2x Milanesa .......... 2` no es decoracion: el punto guia es lo que dice que el
 * renglon se corto por el ancho del papel y no porque falto texto. En 42 columnas con
 * acentos, un nombre largo se trunca y el puntos es lo unico que marca donde terminaba.
 */

/** Ancho util del papel de 80 mm en la fuente A: 42 columnas. */
export const TICKET_COLUMNS = 42;

/**
 * Reparte `left` y `right` con puntos en el medio.
 *
 * Si no entra, **no se corta**: se devuelve `left + ' ' + right` y que la impresora
 * derive. Un nombre de producto truncado a la mitad con puntos de guia es peor que uno
 * que se pasa de ancho, porque el que se pasa de ancho por lo menos esta entero.
 */
export function withGuide(left: string, right: string, columns = TICKET_COLUMNS): string {
  const used = left.length + right.length;
  if (used + 1 >= columns) return `${left} ${right}`.trim();
  return `${left}${'.'.repeat(columns - used)}${right}`;
}

/**
 * Un renglon de texto, recortado al ancho del papel.
 *
 * El recorte es por **caracteres**, no por bytes: con acentos, 42 caracteres pueden ser
 * mas de 42 bytes y el renglon se pasa de ancho. Recortar a 42 caracteres deja el
 * renglon en 42 bytes o menos, que es lo que entra.
 */
export function line(text = '', columns = TICKET_COLUMNS): string {
  return text.length > columns ? text.slice(0, columns) : text;
}

/** Regla horizontal. */
export function rule(width = TICKET_COLUMNS, char = '-'): string {
  return char.repeat(width);
}

/**
 * Codifica un renglon a bytes.
 *
 * El `sanitize` va **aca y no en el driver**: un caracter fuera de la pagina de
 * codigos se sustituye por `?` en vez de emitir su byte, que la impresora podria
 * interpretar como el comienzo de un comando ESC/POS. Un producto llamado
 * "Cafe ☕" puede abrir el cajon de dinero si el byte crudo pasa de largo.
 */
function textOf(text: string, columns: number, codepage: Codepage): number[] {
  return toBytes(line(sanitize(text, codepage), columns), codepage);
}

/** `14:32`, que es como se lee de reojo. */
function timeOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** `12/03`, para cuando el papel queda colgado de una pinza hasta el otro dia. */
function dateOf(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

/** Que imprime el generador. */
export interface TicketOptions {
  /**
   * Pagina de codigos. `CP850` por default.
   *
   * Es un **string**, no un numero de `ESC t`: el numero es parte del protocolo y el
   * generador no deberia exponerlo. Ver `text.ts` para por que CP850 y no CP437.
   */
  codepage?: string;
  /** Ancho en columnas. 42 para 80 mm. */
  columns?: number;
  /**
   * Si se corta el papel al final.
   *
   * `true` por default y **no** se cambia por gusto: un ticket que no se corta se
   * acumula adentro del rollo y el siguiente se imprime pegado al anterior, que es la
   * forma mas cara de que dos comandas se confundan.
   */
  cut?: boolean;
  /** Lineas de papel en blanco antes del corte, para poder desgarrar. */
  feed?: number;
}

// -----------------------------------------------------------------------------
// Pie y encabezado, comunes a los dos tickets
// -----------------------------------------------------------------------------

/**
 * El `ESC t n` de cada pagina.
 *
 * Vive aca y no se lee de `CODEPAGES[codepage].escT` porque el generador trabaja con
 * el **nombre** (`'CP850'`), que es lo que el resto del sistema conoce. Traducir el
 * nombre al numero del protocolo en un solo lugar evita que las dos copias divergan.
 */
function codepageCommand(codepage: Codepage): number[] {
  return [...cmd.codepage(codepageNumber(codepage))];
}

/** Nombre de pagina -> numero de `ESC t`. Un nombre desconocido cae en CP850. */
export function codepageNumber(codepage: Codepage): number {
  switch (codepage) {
    case 'CP437':
      return 0;
    case 'CP858':
      return 19;
    default:
      return 2;
  }
}

/**
 * El encabezado comun: nombre del local.
 *
 * En doble y centrado es lo unico del ticket que se lee a tres metros.
 *
 * El `init` va **primero**: es lo unico que garantiza que el ticket anterior no dejo la
 * fuente en negrita o el cortador desarmado.
 */
function header(venueName: string, columns: number, codepage: Codepage): number[] {
  return cmd.concat(
    cmd.init(),
    codepageCommand(codepage),
    cmd.align(cmd.ALIGN.CENTER),
    cmd.doubleSize(),
    cmd.bold(true),
    textOf(venueName, columns, codepage),
    cmd.CRLF,
    cmd.bold(false),
    cmd.normalSize(),
  );
}

/**
 * El pie comun.
 *
 * Es una funcion y no texto pegado en los dos generadores porque el estado de la
 * impresora (pagina de codigos, alineacion, tamano) tiene que volver al inicial **una**
 * vez. Si cada generador lo hace por su cuenta, tarde o temprano uno lo olvida y el
 * siguiente ticket sale en doble y centrado.
 */
function footer(options: TicketOptions, codepage: Codepage): number[] {
  return cmd.concat(
    cmd.align(cmd.ALIGN.CENTER),
    cmd.normalSize(),
    cmd.bold(false),
    cmd.feed(options.feed ?? 3),
    // El cortador se arma **antes** de cortar: sin esto, `GS V 66` corta este papel pero
    // no deja armado el siguiente, y el segundo ticket se imprime entero adentro del
    // rollo.
    cmd.enableCutting(),
    options.cut === false ? [] : cmd.cut(),
    // El `init` del final no es paranoia: devuelve la impresora al estado de fabrica
    // para que un ticket impreso a mano (o el de la caja) no salga en doble con el
    // papel cortado en la mitad.
    cmd.init(),
    codepageCommand(codepage),
  );
}

// -----------------------------------------------------------------------------
// Ticket de cocina
// -----------------------------------------------------------------------------

/**
 * El papel de cocina.
 *
 * No lleva precios: ver la nota de la clase. Los modificadores van en su propia linea
 * con sangria, porque "Milanesa napolitana" y "sin sal" son cosas distintas y en la
 * misma linea el que cocina no sabe donde termina una y empieza la otra.
 *
 * @param ticket El ticket del dominio, tal como lo guarda la replica del POS.
 * @param venueName Nombre del local: va en el encabezado.
 */
export function buildKitchenTicket(
  ticket: KitchenTicket,
  venueName: string,
  options: TicketOptions = {},
): number[] {
  const columns = options.columns ?? TICKET_COLUMNS;
  const codepage = options.codepage ?? 'CP850';
  const parts: number[] = [];

  parts.push(...header(venueName, columns, codepage));

  // Numero de comanda: lo primero que se busca en un monton de papeles apilados.
  parts.push(
    ...cmd.concat(
      cmd.bold(true),
      cmd.doubleHeight(),
      textOf(`#${ticket.orderNumberLabel}`, columns, codepage),
      cmd.CRLF,
      cmd.bold(false),
      cmd.normalSize(),
    ),
  );

  if (ticket.tableLabel) {
    parts.push(
      ...cmd.concat(
        cmd.doubleHeight(),
        textOf(`Mesa ${ticket.tableLabel}`, columns, codepage),
        cmd.CRLF,
        cmd.normalSize(),
      ),
    );
  }

  const created = new Date(ticket.createdAt);
  parts.push(
    ...cmd.concat(
      textOf(`${dateOf(created)}  ${timeOf(created)}`, columns, codepage),
      cmd.CRLF,
      textOf(rule(columns), columns, codepage),
      cmd.CRLF,
    ),
  );

  for (const item of ticket.lines) {
    parts.push(
      ...cmd.concat(
        cmd.bold(true),
        textOf(`${item.quantity}x ${item.name}`, columns, codepage),
        cmd.CRLF,
        cmd.bold(false),
      ),
    );

    for (const modifier of item.modifiers) {
      parts.push(...cmd.concat(textOf(`   - ${modifier}`, columns, codepage), cmd.CRLF));
    }

    // La nota del mozo al final y sola, en negrita. Es la linea que evita que el plato
    // vuelva, y por eso no comparte renglon con nada.
    if (item.note) {
      parts.push(
        ...cmd.concat(
          cmd.bold(true),
          textOf(`   ${item.note}`, columns, codepage),
          cmd.CRLF,
          cmd.bold(false),
        ),
      );
    }
  }

  parts.push(...cmd.concat(textOf(rule(columns), columns, codepage), cmd.CRLF));
  parts.push(...footer(options, codepage));

  return parts;
}

// -----------------------------------------------------------------------------
// Comprobante
// -----------------------------------------------------------------------------

/** Lo que hace falta para imprimir una comanda como comprobante. */
export interface OrderTicketInput {
  order: Order;
  venueName: string;
  currency: string;
  /** Descuento ya aplicado, en centavos. */
  discountCents?: number;
  /** Tasa de servicio en basis points (1000 = 10%). */
  serviceBps?: number;
  /** Propina, en centavos. */
  tipCents?: number;
  /** Cuanto se pago, en centavos. */
  paidCents?: number;
}

/**
 * El comprobante de la comanda.
 *
 * **Los totales salen de `orderTotals()` del dominio y no se calculan aca.** Es la
 * misma funcion pura que corre el POS sobre su replica y la que corre el servidor. Si
 * el ticket reimprimiera su propia aritmetica, un redondeo distinto entre pantalla y
 * papel es exactamente el reclamo del mostrador ("me cobraron 120 y el ticket dice
 * 118"). Reutilizar la funcion es lo que hace que los tres den el mismo numero.
 *
 * Los pagos no se suman al total: el total es lo que se **debe** y ya esta calculado
 * desde los items. Sumar el pago daria "lo que se debe" mezclado con "lo que se pago",
 * que es el mismo error que ya documenta `applyPayment` en el sync.
 */
export function buildOrderTicket(input: OrderTicketInput, options: TicketOptions = {}): number[] {
  const columns = options.columns ?? TICKET_COLUMNS;
  const codepage = options.codepage ?? 'CP850';
  const { order, currency } = input;

  const totals = orderTotals({
    items: order.items,
    currency,
    discountCents: input.discountCents ?? 0,
    serviceBps: input.serviceBps ?? 0,
    tipCents: input.tipCents ?? 0,
    paidCents: input.paidCents ?? 0,
  });

  const parts: number[] = [];
  parts.push(...header(input.venueName, columns, codepage));

  parts.push(
    ...cmd.concat(
      cmd.bold(true),
      textOf(`Comanda ${order.numberLabel}`, columns, codepage),
      cmd.CRLF,
      cmd.bold(false),
    ),
  );

  if (order.tableLabel) {
    parts.push(...cmd.concat(textOf(`Mesa ${order.tableLabel}`, columns, codepage), cmd.CRLF));
  }

  const opened = new Date(order.openedAt);
  parts.push(
    ...cmd.concat(
      textOf(`${dateOf(opened)}  ${timeOf(opened)}`, columns, codepage),
      cmd.CRLF,
      textOf(rule(columns), columns, codepage),
      cmd.CRLF,
    ),
  );

  for (const item of order.items) {
    if (item.status === 'VOIDED') continue;

    // El modificador entra **dentro** del precio unitario, no como una linea aparte:
    // "capuchino doble" es un producto, no dos. Es la misma regla de `orderTotals`, y
    // por eso el importe de la linea se calcula con la misma formula.
    const modifierDelta = item.modifiers.reduce(
      (acc, modifier) => acc + modifier.priceDeltaCents,
      0,
    );
    const lineCents = (item.unitPriceCents + modifierDelta) * item.quantity;

    parts.push(
      ...cmd.concat(
        textOf(
          withGuide(
            `${item.quantity}x ${item.nameSnapshot}`,
            formatMoney(money(lineCents, currency)),
            columns,
          ),
          columns,
          codepage,
        ),
        cmd.CRLF,
      ),
    );

    // El modificador con precio va con su propio importe: "extra queso +$300" es un
    // dato que el cliente tiene que poder ver sin hacer cuentas de memoria.
    for (const modifier of item.modifiers) {
      const sign = modifier.priceDeltaCents < 0 ? '-' : '+';
      const delta = formatMoney(money(modifier.priceDeltaCents, currency), 'es-AR', {
        showSymbol: false,
      });
      parts.push(
        ...cmd.concat(textOf(`   ${sign}${delta} ${modifier.name}`, columns, codepage), cmd.CRLF),
      );
    }

    if (item.note) {
      parts.push(...cmd.concat(textOf(`   ${item.note}`, columns, codepage), cmd.CRLF));
    }
  }

  parts.push(...cmd.concat(textOf(rule(columns), columns, codepage), cmd.CRLF));

  parts.push(...totalRow('Subtotal', totals.subtotalCents, currency, columns, codepage));
  if (totals.discountCents > 0) {
    parts.push(...totalRow('Descuento', -totals.discountCents, currency, columns, codepage));
  }
  if (totals.serviceCents > 0) {
    parts.push(...totalRow('Servicio', totals.serviceCents, currency, columns, codepage));
  }
  if (totals.tipCents > 0) {
    parts.push(...totalRow('Propina', totals.tipCents, currency, columns, codepage));
  }

  parts.push(...cmd.concat(textOf(rule(columns), columns, codepage), cmd.CRLF));

  // El total en doble: es la unica cifra del papel que se mira de reojo para decidir
  // si se abre la billetera.
  parts.push(
    ...cmd.concat(
      cmd.align(cmd.ALIGN.RIGHT),
      cmd.doubleHeight(),
      cmd.bold(true),
      textOf(`TOTAL ${formatMoney(money(totals.totalCents, currency))}`, columns, codepage),
      cmd.CRLF,
      cmd.bold(false),
      cmd.normalSize(),
      cmd.align(cmd.ALIGN.LEFT),
    ),
  );

  parts.push(...footer(options, codepage));

  return parts;
}

/** Un renglon de importe: etiqueta a la izquierda, cifra a la derecha. */
function totalRow(
  label: string,
  cents: number,
  currency: string,
  columns: number,
  codepage: Codepage,
): number[] {
  return cmd.concat(
    textOf(withGuide(label, formatMoney(money(cents, currency)), columns), columns, codepage),
    cmd.CRLF,
  );
}
