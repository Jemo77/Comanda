import type { AuditEntry, AuditQuery } from '@comanda/domain';

/**
 * Tipos del modulo de auditoria.
 *
 * La entrada de auditoria lleva el contexto completo (actor, dispositivo, IP)
 * porque un registro que no dice quien lo hizo no sirve para nada: "alguien
 * anulo un item" no es informacion.
 */
export interface RecordAuditParams {
  orgId: string;
  venueId?: string | null;
  actorId?: string | null;
  /** Se desnormaliza para que el registro siga siendo legible si el usuario se
   *  borra. "El usuario X hizo esto" importa mas que el id. */
  actorName?: string | null;
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Reexportado para los consumers del modulo. */
export type { AuditEntry, AuditQuery };
