import { Global, Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { KdsModule } from '../kds/kds.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';

/**
 * Sincronizacion offline.
 *
 * Global porque el POS lo consume desde el arranque (para hidratar la replica) y
 * desde el loop de la outbox, que vive en un provider distinto del que lo llama.
 *
 * Importa `KdsModule` por una sola razon: `SyncService` le pide a `KdsService` que
 * cree los tickets de cocina al confirmar un item. La logica de agrupar por estacion
 * vive en el modulo de cocina y no aca, porque el camino online
 * (`OrdersService.addItem`) la necesita tambien y duplicarla seria tener dos
 * politicas de "que papel va a que impresora".
 */
@Global()
@Module({
  imports: [KdsModule, LoyaltyModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
