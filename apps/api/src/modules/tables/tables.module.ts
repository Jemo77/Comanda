import { Module } from '@nestjs/common';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

/**
 * Salon: sectores y mesas.
 *
 * No importa `DatabaseModule` ni `AuditModule` porque los dos son globales: declararlos
 * aca seria ruido que hay que mantener sincronizado con cada modulo nuevo.
 */
@Module({
  controllers: [TablesController],
  providers: [TablesService],
  exports: [TablesService],
})
export class TablesModule {}
