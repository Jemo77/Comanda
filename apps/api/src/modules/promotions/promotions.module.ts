import { Module } from '@nestjs/common';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';

/**
 * Promociones y happy hour (CRUD de reglas). La evaluacion la hace
 * `@comanda/pricing-engine`; este modulo no repite logica de precios.
 */
@Module({
  controllers: [PromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
