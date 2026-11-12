import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuidv7 } from '@comanda/domain';
import type { Request } from 'express';
import { StorefrontService } from './storefront.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { Public, RequirePermissions, CurrentSession } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RateLimitGuard } from '../../common/rate-limit/rate-limit.guard';

const qrOrderSchema = z.object({
  token: z.string().min(8).max(64),
  guests: z.number().int().min(1).max(40).default(1),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(99).default(1),
        modifiers: z
          .array(z.object({ modifierId: z.string().uuid() }))
          .max(20)
          .default([]),
        note: z.string().max(300).nullish(),
      }),
    )
    .min(1)
    .max(50),
});

const checkoutSchema = z.object({
  token: z.string().min(8).max(64),
  provider: z.enum(['mock', 'mercadopago', 'stripe']).default('mock'),
  tipCents: z.number().int().min(0).max(10_000_000).default(0),
  sourceEventId: z.string().uuid(),
});

const takeawayOrderSchema = z.object({
  slotAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  customerName: z.string().trim().min(1).max(120),
  customerPhone: z.string().trim().min(6).max(32),
  items: z
    .array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50),
  sourceEventId: z.string().uuid(),
});

const identifySchema = z.object({
  phone: z.string().trim().min(6).max(32),
  name: z.string().trim().max(120).optional(),
});

const redeemSchema = z.object({
  phone: z.string().trim().min(6).max(32),
  points: z.number().int().min(1).max(1_000_000),
});

@ApiTags('storefront')
@Controller('storefront')
export class StorefrontController {
  constructor(
    private readonly storefront: StorefrontService,
    private readonly loyalty: LoyaltyService,
  ) {}

  @Get('venues/:venueId/menu')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Carta digital (pública, multi-idioma)' })
  menu(@Param('venueId', ParseUUIDPipe) venueId: string, @Query('lang') lang = 'es') {
    return this.storefront.menu(venueId, ['es', 'en', 'pt'].includes(lang) ? lang : 'es');
  }

  @Get('venues/:venueId/tables/:tableId/resolve')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Valida el token del QR y devuelve el modo de aprobación' })
  resolve(
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Param('tableId', ParseUUIDPipe) tableId: string,
    @Query('token') token: string,
  ) {
    return this.storefront.resolveTable(venueId, tableId, token ?? '');
  }

  @Post('venues/:venueId/tables/:tableId/orders')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Pedido desde la mesa (crea o agrega a la comanda abierta)' })
  openOrder(
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Param('tableId', ParseUUIDPipe) tableId: string,
    @Body(new ZodValidationPipe(qrOrderSchema)) body: z.infer<typeof qrOrderSchema>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.storefront.openTableOrder(
      venueId,
      tableId,
      body.token,
      { guests: body.guests, items: body.items },
      idempotencyKey ?? uuidv7(),
    );
  }

  @Get('venues/:venueId/tables/:tableId/bill')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Cuenta de la mesa: ítems, totales, propina y lo pagado' })
  bill(
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Param('tableId', ParseUUIDPipe) tableId: string,
    @Query('token') token: string,
  ) {
    return this.storefront.tableBill(venueId, tableId, token ?? '');
  }

  @Post('venues/:venueId/tables/:tableId/checkout')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Crea un intento de cobro con el proveedor elegido' })
  checkout(
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Param('tableId', ParseUUIDPipe) tableId: string,
    @Body(new ZodValidationPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ) {
    return this.storefront.createCheckout(
      venueId,
      tableId,
      body.token,
      { provider: body.provider, tipCents: body.tipCents },
      body.sourceEventId,
    );
  }

  @Post('webhooks/payments/:provider')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Webhook verificado e idempotente del proveedor de pagos' })
  async webhook(
    @Param('provider') provider: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string | undefined>,
  ) {
    const rawBody = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    try {
      return await this.storefront.processPaymentWebhook(provider, headers, rawBody);
    } catch (error) {
      // Firma que no cierra: 401, no un 500 genérico. Es lo que el proveedor
      // tiene que ver para reintentar con credenciales bien, no para panic.
      if (error instanceof Error && error.name === 'WebhookSignatureError') {
        throw new UnauthorizedException({
          title: 'Firma de webhook inválida.',
          code: 'WEBHOOK_BAD_SIGNATURE',
        });
      }
      throw error;
    }
  }

  @Get('venues/:venueId/takeaway/slots')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Slots de retiro disponibles para una fecha (YYYY-MM-DD)' })
  slots(@Param('venueId', ParseUUIDPipe) venueId: string, @Query('date') date: string) {
    return this.storefront.takeawaySlots(venueId, date);
  }

  @Post('venues/:venueId/takeaway/orders')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Pedido para llevar con slot de retiro' })
  takeawayOrder(
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Body(new ZodValidationPipe(takeawayOrderSchema)) body: z.infer<typeof takeawayOrderSchema>,
  ) {
    return this.storefront.createTakeawayOrder(venueId, body, body.sourceEventId);
  }

  @Get('orders/:orderId/takeaway-status')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Estado del pedido takeaway (listo para retirar)' })
  takeawayStatus(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.storefront.takeawayStatus(orderId);
  }

  @Post('venues/:venueId/customers/identify')
  @Public()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Identifica o crea al cliente y devuelve su saldo de puntos' })
  identify(
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Body(new ZodValidationPipe(identifySchema)) body: z.infer<typeof identifySchema>,
  ) {
    return this.loyalty.identifyCustomer(venueId, body);
  }

  @Post('orders/:orderId/approve')
  @RequirePermissions('order.approve')
  @ApiOperation({
    summary: 'El mozo aprueba una comanda QR pendiente: pasa a OPEN y sale a cocina',
  })
  approve(
    @CurrentSession() session: SessionPrincipal,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.storefront.approveOrder(session.orgId, session.venueId, orderId);
  }

  @Post('loyalty/redeem')
  @RequirePermissions('loyalty.redeem')
  @ApiOperation({ summary: 'Canje de puntos en mostrador (POS)' })
  redeem(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(redeemSchema)) body: z.infer<typeof redeemSchema>,
  ) {
    return this.loyalty.redeem(session.orgId, session.venueId, {
      phone: body.phone,
      points: body.points,
      actorUserId: session.userId,
    });
  }
}
