import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadDotEnv, loadEnv } from './config/env';

/**
 * Arranque de la API.
 *
 * Reverse proxy primero (`trust proxy`): sin esto, `req.ip` es la IP del balanceador
 * y el rate limiting bloquearia a todos los clientes a la vez por compartida la
 * misma direccion de entrada.
 */
async function bootstrap(): Promise<void> {
  // Antes de `loadEnv`: la validacion necesita ver el `.env` del repositorio.
  loadDotEnv();

  const logger = new Logger('bootstrap');
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, {
    logger: env.NODE_ENV === 'test' ? ['error', 'warn'] : undefined,
    // rawBody: el webhook de pagos firma los bytes crudos; si Express ya parseó el
    // JSON y lo re-serializamos para verificar la firma HMAC, el payload cambia y
    // la firma no cierra. Con `rawBody: true` los bytes originales sobreviven.
    rawBody: true,
  });

  const config = app.get(ConfigService);

  // Detras de un balanceador, `req.ip` seria la IP del proxy y el rate limiting
  // bloquearia a todos los clientes a la vez por compartir esa misma direccion.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(
    helmet({
      // La API sirve JSON, no HTML: un CSP estricto no aporta y complica el
      // Swagger de desarrollo.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.enableCors({
    origin: (config.get<string>('CORS_ORIGINS') ?? '').split(',').map((o) => o.trim()),
    credentials: true,
    // El POS y el admin mandan `Authorization`, no cookies: sin este header el
    // navegador bloquea el request cross-origin.
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Device-Id'],
    exposedHeaders: ['RateLimit-Remaining'],
  });

  // Sin `ValidationPipe` global: toda la validacion de entrada es Zod, con los
  // esquemas compartidos de `@comanda/domain`, y cada endpoint los aplica con
  // `@Body(new ZodValidationPipe(esquema))`. Un pipe global de class-validator
  // duplicaria la validacion con otra libreria y sin acceso a los contratos.

  // Las rutas cuelgan de /api/v1 segun el PLAN §7.
  app.setGlobalPrefix('api/v1');

  if (env.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Comanda API')
        .setDescription(
          'API multi-tenant para bares y cafés. Toda ruta autenticada requiere `Authorization: Bearer <token>` ' +
            'y está sujeta a Row Level Security por organización.',
        )
        .setVersion('0.1.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
        .addTag('auth', 'Sesiones: login por contraseña, login por PIN, refresh rotativo')
        .addTag('tenancy', 'Organización, locales y dispositivos')
        .addTag('audit', 'Auditoría append-only')
        .addTag('health', 'Liveness y readiness')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
    logger.log('OpenAPI en /api/docs');
  }

  app.enableShutdownHooks();

  const port = config.get<number>('API_PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`API escuchando en http://localhost:${port}/api/v1`);
}

void bootstrap();
