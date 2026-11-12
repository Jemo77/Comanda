import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Cobro: pagos, division de cuenta y propinas.
 *
 * No importa `OrdersModule`: el servicio usa las funciones de `orders/order-state.ts`, que
 * son helpers sobre el `PoolClient` y no un servicio de Nest. Importar el modulo entero para
 *tres funciones de SQL ataria el cobro a la comanda por el modulo entero, y la unica razon
 * para esa atadura seria el servicio de lectura de comandas, que el POS ya pide por su
 * propio endpoint.
 */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
