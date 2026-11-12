import { Module } from '@nestjs/common';
import { KdsController } from './kds.controller';
import { KdsGateway } from './kds.gateway';
import { KdsService } from './kds.service';
import { KdsEventBus } from './kds-event-bus';

/**
 * Cocina.
 *
 * No importa `DatabaseModule` ni `AuthModule` porque los dos son globales: declararlos
 * aca seria ruido que hay que mantener sincronizado con cada modulo nuevo.
 *
 * Exporta `KdsService` y `KdsEventBus` por dos razones concretas:
 *
 *  - `KdsService`, para que `sync` cree los tickets al confirmar items. La logica de
 *    agrupar por estacion vive **aca** y no en el sync: si viviera en el sync, el
 *    endpoint online (`OrdersService.addItem`) no tendria donde ir y terminaria
 *    reimplementando el agrupamiento.
 *  - `KdsEventBus`, porque el sync publica cambios de cocina sin saber que hay un
 *    gateway. Esa indireccion es la que permite que el dia de hoy el bus sea un
 *    `Subject` en memoria y mañana sea Redis sin tocar el sync. Ver la nota de
 *    `kds-event-bus.ts`.
 *
 * El gateway es un provider del modulo, no un `@Controller`: Nest lo registra por la
 * anotacion `@WebSocketGateway` y lo levanta con el IoAdapter de socket.io.
 */
@Module({
  controllers: [KdsController],
  providers: [KdsService, KdsEventBus, KdsGateway],
  exports: [KdsService, KdsEventBus],
})
export class KdsModule {}
