import { Injectable, Logger } from '@nestjs/common';

/**
 * Bus de eventos de cocina, **in-process**.
 *
 * Es lo que usa el gateway para enterarse de que un ticket cambio sin que quien
 * escribe (el sync, el endpoint online) tenga que saber quien esta escuchando.
 *
 * ## Por que es in-process y no Redis
 *
 * `docs/ASSUMPTIONS.md` A-09: Redis no es obligatorio en Fase 1, es cache y pub/sub.
 * Con Redis, quien escribe publicaria en un canal y todas las instancias del API lo
 * recibirian. Aca la lista de suscriptores vive en la memoria de **un** proceso, asi que:
 *
 *  - **Una sola instancia del API: funciona.** Es el caso de Fase 1: el POS y la API
 *    del local, o un unico contenedor.
 *  - **Varias instancias: se rompe, en silencio.** El POS que cae en la instancia B
 *    no recibe el evento que la instancia A aplico, y el sintoma no es un error: es
 *    "la cocina se actualiza a veces". Un KDS que a veces no se actualiza es peor que
 *    uno que no se actualiza nunca, porque el que esta en cocina deja de confiar en la
 *    pantalla y va a mirar la comanda.
 *
 * Por eso el aviso esta aca y no en el `.env`: cuando el API escale, migrar a Redis (o
 * a `LISTEN/NOTIFY` de Postgres, que ya esta disponible) tiene que cambiar **esta**
 * clase y nada mas. El resto del sistema ya habla con este bus.
 *
 * ## Por que NO es un `Subject` de RxJS
 *
 * Un `Subject` entrega el `next` a todos los suscriptores desde la misma pila, y si uno
 * de ellos tira, RxJS lo reporta **fuera** de la cadena como error no manejado. El
 * `try/catch` del `publish` no lo ve, y el proceso termina con una excepcion sin
 * manejar.
 *
 * Peor todavia: en RxJS un error de un handler termina en el stream del resto, que
 * **desuscribe a todos los suscriptores**. Una pantalla de cocina con un error de
 * render dejaba sin KDS a las demas.
 *
 * Con una lista de listeners y un `try/catch` por listener, cada suscriptor es
 * independiente: uno roto se desuscribe y los demas siguen.
 */

/** Que cambio en cocina, con el tenant que lo provoco. */
export interface KdsChange {
  kind: 'ticket-status' | 'ticket-created' | 'order-items';
  orgId: string;
  venueId: string;
  /** `ticket-status` y `ticket-created`. */
  ticketId?: string;
  /** `order-items`. */
  orderId?: string;
}

/** Alguien que quiere enterarse de los cambios. */
export type KdsListener = (change: KdsChange) => void;

/** Cancela una suscripcion. Es idempotente. */
export type Unsubscribe = () => void;

@Injectable()
export class KdsEventBus {
  private readonly logger = new Logger(KdsEventBus.name);
  private readonly listeners = new Set<KdsListener>();

  /**
   * Se suscribe a los cambios de cocina.
   *
   * Devuelve la baja. El gateway se suscribe en `onModuleInit` y vive toda la vida del
   * proceso, asi que no necesita baja: la tiene para los tests y por si el modulo se
   * recarga.
   */
  subscribe(listener: KdsListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Cuantos hay suspending. Solo para diagnostico. */
  get size(): number {
    return this.listeners.size;
  }

  /**
   * Publica un cambio.
   *
   * Nunca tira. Quien publica lo hace en medio de una transaccion de negocio (el sync
   * aplica un evento y despues avisa), y una excepcion ahi abortaria el lote entero: un
   * fallo de notificaciones le costaria al POS la comanda.
   *
   * Y un listener que tira se **desuscribe**: se avisa una vez al log y se saca de la
   * lista. Un handler roto que se reintenta en cada evento llena el log y aun asi no
   * aporta nada.
   */
  publish(change: KdsChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.listeners.delete(listener);
        this.logger.warn(
          `Se desuscribio un listener de cocina por un error en ${change.kind}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
