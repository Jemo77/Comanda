import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { ERROR_CODES, problemDetails } from '@comanda/domain';

/**
 * Rate limiting en memoria con ventana deslizante.
 *
 * Fase 0 no usa Redis: el rate limit tiene que proteger el login, y si dependiera
 * de Redis unRedis caido dejaria el login abierto justo cuando hay un ataque. En
 * memoria es suficiente para una instancia, y cuando haya varias se cambia el
 * backing store sin tocar los endpoints.
 *
 * Que sea por IP y no solo por usuario: un atacante no tiene cuenta.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();
  private readonly timer: NodeJS.Timeout;

  constructor() {
    // El contador se limpia solo: sin esto, un proceso de larga vida acumularia
    // una entrada por cada IP vista y terminaria comiendose la memoria.
    this.timer = setInterval(() => this.sweep(), 60_000);
    // `unref` evita que este timer mantenga vivo el proceso en tests.
    this.timer.unref?.();
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      method: string;
      path: string;
      ip?: string;
      route?: { path?: string };
    }>();

    // Solo las rutas de autenticacion se limitan. Limitar toda la API con el mismo
    // limite dejaria sin CUDA a un POS que sincroniza mil eventos.
    if (!request.path.startsWith('/api/v1/auth')) {
      return true;
    }

    const isLogin = request.path.endsWith('/login') || request.path.endsWith('/login/');
    const limit = isLogin ? 10 : 60;
    const windowMs = 60_000;

    const key = `${request.ip ?? 'unknown'}:${request.path}`;
    const now = Date.now();

    const previous = this.hits.get(key) ?? [];
    const recent = previous.filter((at) => now - at < windowMs);

    if (recent.length >= limit) {
      throw new HttpException(
        problemDetails({
          status: 429,
          code: ERROR_CODES.RATE_LIMITED,
          detail:
            recent.length >= limit
              ? 'Demasiados intentos. Espera un minuto e intenta de nuevo.'
              : 'Demasiados intentos.',
        }),
        429,
      );
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  private sweep(): void {
    const cutoff = Date.now() - 60_000;
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((at) => at > cutoff);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }

  /** Limpia el estado. Solo lo usan los tests. */
  reset(): void {
    this.hits.clear();
  }
}
