import { Module } from '@nestjs/common';
import { CashController } from './cash.controller';
import { CashService } from './cash.service';

/**
 * Caja y turnos.
 *
 * No importa `DatabaseModule` ni `AuditModule` porque los dos son globales: declararlos aca
 * seria ruido que hay que mantener sincronizado con cada modulo nuevo.
 */
@Module({
  controllers: [CashController],
  providers: [CashService],
  exports: [CashService],
})
export class CashModule {}
