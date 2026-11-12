import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Database } from '../database/database.service';
import { Public } from '../common/authz/permissions.guard';

/**
 * Salud del servicio.
 *
 * `/health` es publico y barato: responde sin tocar la base, para que el orquestador
 * no reinicie el pod porque la base este lenta. `/health/ready` si consulta, y es
 * el que decide si el pod recibe trafico.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject('DATABASE') private readonly db: Database) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness: el proceso responde' })
  live(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Readiness: la base responde' })
  async ready(): Promise<{ status: 'ok' | 'degraded'; database: string }> {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok', database: 'up' };
    } catch {
      // No se propaga el error: un readiness que tira 500 hace que el orquestador
      // reinicie un proceso que quizas solo tiene un problema de conexion.
      return { status: 'degraded', database: 'down' };
    }
  }
}
