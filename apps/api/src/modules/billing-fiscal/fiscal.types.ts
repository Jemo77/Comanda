import { z } from 'zod';

/** Tasa de impuesto viene como numeric(5,4) de Postgres: aceptamos string o number. */
export const settingsSchema = z.object({
  provider: z.enum(['mock', 'afip']).default('mock'),
  environment: z.enum(['homo', 'prod']).default('homo'),
  pointOfSale: z.string().min(1).max(8).default('00001'),
  cuit: z.string().max(11).default(''),
  certRef: z.string().max(120).default(''),
  caeaNumber: z.string().max(16).default(''),
  caeaExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  maxAttempts: z.number().int().min(1).max(20).default(5),
});

export const receiverSchema = z.object({
  name: z.string().min(1).max(80).default('Consumidor Final'),
  taxId: z.string().min(1).max(13).default('0'),
  condition: z
    .enum(['RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'CONSUMIDOR_FINAL', 'EXENTO'])
    .default('CONSUMIDOR_FINAL'),
});

export const issueInvoiceSchema = z.object({
  type: z.enum(['FACT_A', 'FACT_B', 'FACT_C']).default('FACT_B'),
  receiver: receiverSchema.default({}),
  /** Nota de credito: comanda original y tipo de NC. La original se busca por su ID. */
  creditNoteFor: z.string().uuid().optional(),
});

export const listInvoicesSchema = z.object({
  status: z.enum(['PENDING', 'EMITIDA', 'RECHAZADA', 'ERROR']).optional(),
  orderId: z.string().uuid().optional(),
});

export type SettingsInput = z.infer<typeof settingsSchema>;
export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;
export type ListInvoicesInput = z.infer<typeof listInvoicesSchema>;
