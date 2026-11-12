/**
 * Contrato del adaptador fiscal.
 *
 * Un `FiscalProvider` recibe un pedido de comprobante con totales ya calculados
 * (neto + IVA por alicuota) y devuelve el comprobante autorizado (CAE, numero,
 * QR) o un error con clasificacion: si fue RECHAZO del fisco (decision terminal,
 * no se reintenta) o FALLA de red/servicio (se reintenta con backoff).
 *
 * Los totales viajan en centavos enteros y con moneda: jamas float (PLAN §1).
 */

export const FISCAL_VOUCHER_TYPES = ['FACT_A', 'FACT_B', 'FACT_C', 'NC_A', 'NC_B', 'NC_C'] as const;
export type FiscalVoucherType = (typeof FISCAL_VOUCHER_TYPES)[number];

export interface IvaLine {
  /** Alicuota en fraccion exacta: 0.21, 0.105, 0. una linea por alicuota distinta. */
  rate: number;
  /** Neto gravado de esta alicuota, centavos. */
  netoCents: number;
  /** IVA de esta alicuota, centavos. neto + iva = importe de la linea. */
  ivaCents: number;
}

export interface FiscalReceiver {
  name: string;
  /** CUIT/CUIL/DNI. "0" cuando es consumidor final B/C. */
  taxId: string;
  condition: 'RESPONSABLE_INSCRIPTO' | 'MONOTRIBUTO' | 'CONSUMIDOR_FINAL' | 'EXENTO';
}

export interface FiscalInvoiceRequest {
  type: FiscalVoucherType;
  pointOfSale: string;
  /** Numero interno de pedido. El numero de COMPROBANTE lo asigna el proveedor. */
  internalId: string;
  receiver: FiscalReceiver;
  /** Concepto: 1 = productos, 2 = servicios, 3 = ambos. */
  concept: 1 | 2 | 3;
  /** Fecha del comprobante, YYYYMMDD. */
  issueDate: string;
  currency: string;
  netoCents: number;
  ivaCents: number;
  totalCents: number;
  ivaLines: IvaLine[];
  /** Nota de credito: tipo y numero de la factura original cuando aplica. */
  creditNoteFor?: { type: FiscalVoucherType; pointOfSale: string; number: number };
}

export interface FiscalInvoiceResult {
  /** Numero de comprobante asignado por el proveedor. */
  voucherNumber: number;
  /** CAE, o el numero de CAEA cuando es contingencia. */
  cae: string;
  /** Vencimiento del CAE, YYYY-MM-DD. */
  caeDue: string;
  /** URL del QR fiscal listo para imprimir. */
  qrPayload: string;
  /** True cuando se emitio con CAEA por WSFE caido (contingencia). */
  contingency: boolean;
}

/** Error terminal del fisco: no se reintenta, se muestra al operador. */
export class FiscalRejectionError extends Error {
  readonly code = 'FISCAL_REJECTED' as const;
  readonly observations?: string[];
  constructor(message: string, observations?: string[]) {
    super(message);
    this.name = 'FiscalRejectionError';
    this.observations = observations;
  }
}

/** Falla transitoria (red, 5xx, WSFE intermitente): la cola reintenta. */
export class FiscalUnavailableError extends Error {
  readonly code = 'FISCAL_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'FiscalUnavailableError';
  }
}

export interface FiscalProvider {
  readonly key: string;
  /** Emite una factura. Respeta la interfaz sin saber de Nest ni de base. */
  issueInvoice(request: FiscalInvoiceRequest): Promise<FiscalInvoiceResult>;
  /** Nota de credito total de un comprobante. */
  creditNote(request: FiscalInvoiceRequest): Promise<FiscalInvoiceResult>;
}

/** Contexto comun que un provider necesita para operar. */
export interface FiscalCredentials {
  cuit: string;
  /** Material fiscal: en homologacion suele ser un .crt/.key de prueba. */
  certRef: string;
  environment: 'homo' | 'prod';
  /** CAEA vigente para contingencia, vacio si no hay. */
  caeaNumber?: string;
  /** Vencimiento del CAEA, YYYY-MM-DD. */
  caeaExpiresOn?: string;
}
