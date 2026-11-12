import { Module } from '@nestjs/common';
import { StorefrontController } from './storefront.controller';
import { StorefrontService } from './storefront.service';
import { OrdersModule } from '../orders/orders.module';
import { KdsModule } from '../kds/kds.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';

@Module({
  imports: [OrdersModule, KdsModule, LoyaltyModule],
  controllers: [StorefrontController],
  providers: [StorefrontService],
  exports: [StorefrontService],
})
export class StorefrontModule {}
