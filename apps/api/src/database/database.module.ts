import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from './database.service';
import { loadEnv } from '../config/env';

/**
 * Base de datos y configuracion validada, como servicios globales.
 *
 * `@Global()` porque casi todos los modulos necesitan la base, y pasarla por
 * `imports` en cada uno sólo genera ruido. Los tokens son:
 *
 *  - `DATABASE`: la conexión con el rol `comanda_app` (sin BYPASSRLS, sin ser
 *    owner). Todo lo que lea datos de negocio pasa por acá.
 *  - `APP_ENV`: la configuración ya validada, tipada y normalizada.
 *
 * Que sean tokens de string y no clases es a propósito: permite testear un
 * servicio con un doble sin levantar Nest, que es como se prueban los servicios
 * de integración.
 */
@Global()
@Module({
  providers: [
    {
      provide: 'APP_ENV',
      inject: [ConfigService],
      // `loadEnv` lee `process.env`, no el ConfigService: el mismo entorno que
      // valido al arrancar. Que se inyecte ConfigService no significa que se use.
      useFactory: (_config: ConfigService) => loadEnv(process.env),
    },
    {
      provide: 'DATABASE',
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new DatabaseService(
          loadEnv({
            ...process.env,
            DATABASE_URL: config.getOrThrow<string>('DATABASE_URL'),
          }),
        ),
    },
    // `DatabaseService` NO va en `providers`: su constructor recibe `AppEnv`, que es
    // un tipo erased en runtime, así que Nest intentaría inyectarle `Object` y
    // fallaría al arrancar. Se expone únicamente bajo el token 'DATABASE'.
  ],
  exports: ['DATABASE', 'APP_ENV'],
})
export class DatabaseModule {}
