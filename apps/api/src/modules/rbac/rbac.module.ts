import { Global, Module } from '@nestjs/common';
import { RbacService } from './rbac.service';

/**
 * RBAC: catalogo de permisos, roles por defecto y resolucion de permisos
 * efectivos.
 *
 * Global porque `AuthService` depende de el y el auth es global; sin esta
 * separacion, importar `AuthModule` en todos lados arrastraria a RBAC igual.
 */
@Global()
@Module({
  providers: [RbacService],
  exports: [RbacService],
})
export class RbacModule {}
