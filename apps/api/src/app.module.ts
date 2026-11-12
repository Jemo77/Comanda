import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { loadEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { PermissionsGuard } from './common/authz/permissions.guard';
import { TenantContextInterceptor } from './common/middleware/tenant.interceptor';
import { AuthMiddleware } from './common/middleware/auth.middleware';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { BillingFiscalModule } from './modules/billing-fiscal/fiscal.module';
import { CashModule } from './modules/cash/cash.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { KdsModule } from './modules/kds/kds.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PromotionsModule } from './modules/promotions/promotions.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { ReportsModule } from './modules/reports/reports.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { SyncModule } from './modules/sync/sync.module';
import { TablesModule } from './modules/tables/tables.module';
import { StorefrontModule } from './modules/storefront/storefront.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { HealthController } from './health/health.controller';
import { RateLimitGuard } from './common/rate-limit/rate-limit.guard';

/**
 * Rutas públicas.
 *
 * La lista es explícita y corta a propósito: cada entrada es una decisión de que
 * ese endpoint responde sin sesión. Agregar una es fácil; notar que falta una, no.
 *
 * Coincide con los endpoints marcados `@Public()`. La lista del middleware y la del
 * decorador están juntas a propósito: si se agregan endpoints públicos, las dos
 * tienen que crecer, y tenerlas separadas hace visible el desajuste.
 */
const PUBLIC_ROUTES: Array<{ path: string; method: RequestMethod }> = [
  // Liveness y readiness: un probe sin sesión tiene que responder 200, o el
  // orquestador reinicia un proceso sano.
  { path: 'health', method: RequestMethod.GET },
  { path: 'health/ready', method: RequestMethod.GET },
  // La puerta de entrada: login y renovación de sesión.
  { path: 'auth/login', method: RequestMethod.POST },
  { path: 'auth/refresh', method: RequestMethod.POST },
  // El POS se anuncia con esto ANTES de tener credenciales: es lo único que puede
  // hacer para saber si está autorizado, porque `GET /devices` exige sesión. Sin
  // eximirlo del middleware, un aparato recién instalado nunca llega a la pantalla
  // de PIN y el POS no puede entrar nunca. Rate-limited, y devuelve solo datos de
  // rótulo: nada que sirva para autenticarse.
  { path: 'devices/resolve', method: RequestMethod.POST },
  // Fase 3: superficie pública del autopedido QR, takeaway, fidelización y
  // webhooks de pasarela. La "credencial" es el token HMAC del QR o la firma
  // del webhook; la RLS se abre recién después de resolver el tenant.
  { path: 'storefront/venues/:venueId/menu', method: RequestMethod.GET },
  { path: 'storefront/venues/:venueId/tables/:tableId/resolve', method: RequestMethod.GET },
  { path: 'storefront/venues/:venueId/tables/:tableId/orders', method: RequestMethod.POST },
  { path: 'storefront/venues/:venueId/tables/:tableId/bill', method: RequestMethod.GET },
  { path: 'storefront/venues/:venueId/tables/:tableId/checkout', method: RequestMethod.POST },
  { path: 'storefront/webhooks/payments/:provider', method: RequestMethod.POST },
  { path: 'storefront/venues/:venueId/takeaway/slots', method: RequestMethod.GET },
  { path: 'storefront/venues/:venueId/takeaway/orders', method: RequestMethod.POST },
  { path: 'storefront/orders/:orderId/takeaway-status', method: RequestMethod.GET },
  { path: 'storefront/venues/:venueId/customers/identify', method: RequestMethod.POST },
];

/**
 * Modulo raiz.
 *
 * Decisiones de composicion que importan:
 *
 *  - Los providers `*_GUARD` e `*_INTERCEPTOR` son globales: la autorizacion y el
 *    contexto de tenant tienen que aplicar en TODOS los endpoints, no solo en los
 *    que alguien se acuerde de anotarlos.
 *
 *  - `loadEnv` se evalua al importar el modulo, no al arrancar: una configuracion
 *    invalida rompe el deploy de una, no en el primer request de un local.
 *
 *  - `DatabaseModule` va primero y es global: los modulos de dominio necesitan la
 *    base, y declararla acá (en vez de en cada modulo) evita el error de
 *    "Nest can't resolve dependencies" al agregar un modulo nuevo.
 *
 *  - `JwtModule` NO se registra acá: solo lo usa auth, y declararlo sin exportarlo
 *    hacia `AuthModule` hace fallar el arranque.
 *
 *  - El orden de middleware es: autenticacion primero (para tener sesion), despues
 *    los guards, y el interceptor de tenant al final (abre la transaccion).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // El `.env` vive en la raiz del monorepo, no en `apps/api`.
      envFilePath: ['.env', '../../.env'],
      validate: (raw) => loadEnv(raw as NodeJS.ProcessEnv),
    }),
    DatabaseModule,
    AuthModule,
    AuditModule,
    BillingFiscalModule,
    CashModule,
    CatalogModule,
    LoyaltyModule,
    // Cocina: el gateway de WebSocket y los endpoints que el KDS necesita al abrir.
    // Antes de `SyncModule` porque el sync le pide a `KdsService` que cree los tickets
    // al confirmar items.
    KdsModule,
    OrdersModule,
    PaymentsModule,
    PromotionsModule,
    RbacModule,
    ReportsModule,
    TenancyModule,
    SyncModule,
    TablesModule,
    StorefrontModule,
  ],
  controllers: [HealthController],
  providers: [
    AuthMiddleware,
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    // El orden importa: primero el rate limit (barato), despues la sesion.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // El middleware de autenticacion aplica a TODO lo demas. Sin esto, `request.principal`
    // nunca se arma y los guards rechazan toda peticion aunque el token sea valido.
    consumer
      .apply(AuthMiddleware)
      .exclude(...PUBLIC_ROUTES)
      .forRoutes('*');
  }
}
