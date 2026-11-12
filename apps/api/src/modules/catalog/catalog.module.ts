import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';

/**
 * Catalogo: estaciones, categorias, productos y modificadores.
 *
 * `AuditModule` es global y no hace falta importarlo, pero `CatalogModule` exporta
 * su servicio para que el modulo de sync (y el de ordenes, cuando exista) pueda
 * leer productos para snapshots sin volver a abrir una transaccion propia.
 */
@Module({
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
