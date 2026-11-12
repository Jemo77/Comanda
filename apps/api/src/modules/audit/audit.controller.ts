import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { auditQuerySchema, type AuditQuery } from '@comanda/domain';
import { RequirePermissions, CurrentSession } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RbacService } from '../rbac/rbac.service';

/**
 * Lectura de auditoria.
 *
 * Solo lectura: `audit_log` es append-only y la escritura pasa por los servicios,
 * nunca por un endpoint. Este controller existe para que Encargado y Dueño puedan
 * ver que paso en el local.
 */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly rbac: RbacService) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiOperation({ summary: 'Auditoría del local, filtrable y paginada por cursor' })
  async list(
    @CurrentSession() session: SessionPrincipal,
    @Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    // El `orgId` sale de la sesion, no de un parametro: un Encargado no puede
    // pedir la auditoria de otro tenant ni aunque lo pida en la URL.
    return this.rbac.listAudit(session.orgId, query);
  }
}
