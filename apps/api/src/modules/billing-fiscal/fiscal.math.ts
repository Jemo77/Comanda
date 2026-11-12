/**
 * Matematica de la factura. Pura y testeable.
 *
 * Los precios del catalogo son IVA-inclusive (el mostrador cobra lo que ves),
 * asi que la factura desglosa el total: neto = total / (1 + alicuota), con
 * redondeo a centavo por grupo de alicuota. `iva = bruto - neto` por grupo y
 * no `bruto - round(bruto/(1+r))` redondeado de otra forma: sumar por grupo
 * con esa regla preserva el total al centavo.
 */

export interface IvaGroupInput {
  /** Bruto de la linea (cantidad * precio con IVA), centavos. */
  grossCents: number;
  /** Alicuota como fraccion: 0.21, 0.105, 0. */
  taxRate: number;
}

export interface IvaGroup {
  rate: number;
  netoCents: number;
  ivaCents: number;
}

export interface InvoiceTotals {
  netoCents: number;
  ivaCents: number;
  totalCents: number;
  ivaLines: IvaGroup[];
}

export function computeInvoiceTotals(items: readonly IvaGroupInput[]): InvoiceTotals {
  const byRate = new Map<number, { gross: number }>();
  for (const item of items) {
    if (!Number.isInteger(item.grossCents) || item.grossCents < 0) {
      throw new Error(`Importe no entero o negativo: ${item.grossCents}`);
    }
    if (!(item.taxRate >= 0 && item.taxRate <= 1)) {
      throw new Error(`Alicuota fuera de rango: ${item.taxRate}`);
    }
    const key = Number(item.taxRate.toFixed(4));
    const bucket = byRate.get(key) ?? { gross: 0 };
    bucket.gross += item.grossCents;
    byRate.set(key, bucket);
  }

  const ivaLines: IvaGroup[] = [];
  let netoCents = 0;
  let ivaCents = 0;
  let totalCents = 0;

  for (const [rate, { gross }] of [...byRate.entries()].sort((a, b) => b[0] - a[0])) {
    const neto = Math.round(gross / (1 + rate));
    const iva = gross - neto;
    ivaLines.push({ rate, netoCents: neto, ivaCents: iva });
    netoCents += neto;
    ivaCents += iva;
    totalCents += gross;
  }

  return { netoCents, ivaCents, totalCents, ivaLines };
}
