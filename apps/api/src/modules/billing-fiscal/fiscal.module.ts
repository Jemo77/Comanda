import { Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { FiscalController } from './fiscal.controller';
import { FiscalService } from './fiscal.service';

/**
 * Facturacion electronica.
 *
 * La cola trabaja con un barrido periodico (poller): mientras BullMQ no exista en
 * este repo (Redis es opcional, A-09), la base ya es la cola durable: la fila de
 * PENDING + next_attempt_at + attempts es exactamente el estado de reintento, y
 * reiniciar el proceso no pierde nada. Ver ADR-0007 para la tradeoff contra
 * BullMQ.
 */
@Injectable()
class FiscalWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('FiscalWorker');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly fiscal: FiscalService,
    @Inject('APP_ENV') private readonly env: { FISCAL_WORKER_INTERVAL_MS: number },
  ) {}

  onModuleInit(): void {
    const intervalMs = this.env.FISCAL_WORKER_INTERVAL_MS;
    // 0 = deshabilitado: los tests de integracion llaman processDueInvoices a mano
    // y un intervalo corriendo en el medio haria el orden de los reintentos
    // no deterministico.
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    this.timer = setInterval(() => {
      void this.fiscal.processDueInvoices(10).catch((error: unknown) => {
        this.logger.warn(`falla del barrido fiscal: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

@Module({
  controllers: [FiscalController],
  providers: [FiscalService, FiscalWorker],
  exports: [FiscalService],
})
export class BillingFiscalModule {}
