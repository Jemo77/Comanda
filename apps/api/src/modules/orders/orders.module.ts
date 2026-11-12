import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { LoyaltyModule } from '../loyalty/loyalty.module';

/**
 * Comandas.
 *
 * No importa `DatabaseModule` ni `AuditModule` porque los dos son globales: declararlos
 * aca seria ruido que hay que mantener sincronizado con cada modulo nuevo.
 *
 * Exporta `OrdersService` para que otros modulos puedan leer la comanda sin duplicar la
 * proyeccion (el detalle lo consume la pantalla de cuenta).
 */
@Module({
  imports: [LoyaltyModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
