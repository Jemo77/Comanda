import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * Auditoria.
 *
 * Global porque la usan casi todos los modulos y pasarla por imports en cada uno
 * solo genera ruido: la escritura de auditoria es una responsabilidad transversal,
 * igual que el logging.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
