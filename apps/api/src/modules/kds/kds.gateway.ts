import { Logger, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  canAll,
  ERROR_CODES,
  problemDetails,
  type ErrorCode,
  type ProblemDetails,
} from '@comanda/domain';
import { AccessTokenService } from '../../common/security/token.service';
import { AuthService } from '../auth/auth.service';
import type { SessionPrincipal } from '../../common/authz/principal';
import { KdsEventBus } from './kds-event-bus';
import { KdsService } from './kds.service';

/**
 * Tiempo real de cocina.
 *
 * ## Que resuelve
 *
 * El pull por cursor (`GET /sync/pull`) sincroniza bien, pero su ciclo es de 20
 * segundos. Para una comanda eso esta bien; para una pantalla de cocina a dos metros,
 * con extractor y ruido, no: el ticket nuevo tiene que aparecer **ya**.
 *
 * ## Lo que el socket NO es
 *
 * No es la fuente de verdad. La fuente de verdad es `kitchen_tickets`: cuando llega un
 * cambio, el gateway **relee la fila** y emite lo que dice la base. Si emitiera el
 * evento tal cual, dos escrituras que compiten (dos KDS, o el sync contra el endpoint
 * online) harian que dos pantallas mostraran estados que la base nunca tuvo.
 *
 * ## Por que la sesion se verifica en `server.use()` y no en `handleConnection`
 *
 * Dos razones, y la segunda es la que duele en el mostrador.
 *
 * **Los guards de Nest no alcanzan.** `PermissionsGuard` lee `request.principal`, que
 * arma `AuthMiddleware`, que es middleware de **HTTP**. Un WebSocket no pasa por ahi: el
 * handshake es una peticion HTTP y los mensajes son otra cosa. Sin verificar, el
 * chequeo de local — que es lo unico que separa a un KDS de una sucursal de otra — no
 * tiene contra que compararse.
 *
 * **`handleConnection` llega tarde.** El `connect` del cliente se emite cuando el
 * transporte se levanta, **antes** de que corra cualquier handler async de Nest. Con la
 * verificacion en `handleConnection`, un token invalido igual llega al cliente como
 * `connect` y la desconexion un instante despues: el POS se creyo conectado, pinto "en
 * vivo" y al instante siguiente se cae. Con `server.use()`, el handshake falla y el
 * cliente recibe `connect_error` con el motivo, sin haber estado conectado nunca.
 *
 * El token viaja en `handshake.auth.token` y se verifica con el mismo
 * `AccessTokenService` que usa el middleware: si esta vencido, la conexion no se acepta.
 * No hay excepcion para el socket.
 */
@WebSocketGateway({
  // El prefijo global de Nest (`api/v1`) no aplica a los sockets: el path se resuelve
  // en el handshake, y por eso el POS conecta a `/ws/kds` y no a `/api/v1/ws/kds`.
  path: '/ws/kds',
  // Sin esto el navegador bloquea el handshake desde el origen del POS, que en
  // desarrollo es otro puerto.
  cors: { origin: true, credentials: true },
})
export class KdsGateway implements OnModuleInit {
  private readonly logger = new Logger(KdsGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly tokens: AccessTokenService,
    private readonly auth: AuthService,
    private readonly kds: KdsService,
    private readonly bus: KdsEventBus,
  ) {}

  /**
   * Verifica la sesion en el **handshake**, no despues.
   *
   * `server.use()` es el punto correcto y `handleConnection` no sirve para esto. La
   * razon es concreta: el `connect` del cliente se emite cuando el transporte se
   * levanta, **antes** de que corra cualquier handler async de Nest. Con la
   * verificacion en `handleConnection`, un token invalido igual到达 el cliente como
   * `connect` y la desconexion llega un instante despues: el POS se creyo conectado,
   * pinto "en vivo" y al instante siguiente se cae. En el mostrador eso es una pantalla
   * que dice "en vivo" y no muestra nada.
   *
   * Con `server.use()`, `next(new Error(...))` hace que el handshake falle y el
   * cliente reciba `connect_error` con el motivo, sin haber estado conectado nunca.
   *
   * `err.data` lleva el problem+json: el POS muestra `detail`, no un string de error.
   */
  afterInit(server: Server): void {
    server.use(async (socket, next) => {
      const principal = await this.authenticate(socket);
      if (principal instanceof Error) {
        next(principal);
        return;
      }
      socket.data.principal = principal;
      next();
    });
  }

  /**
   * Verifica el token del handshake y resuelve la sesion.
   *
   * Devuelve el principal, o un `Error` con `data` de problem+json. No tira: el
   * middleware de socket.io convierte un `throw` en un error sin motivo.
   */
  private async authenticate(client: Socket): Promise<SessionPrincipal | Error> {
    const token = readToken(client);
    if (!token) {
      return this.handshakeError(401, ERROR_CODES.UNAUTHENTICATED, 'Falta el token de sesion.');
    }

    let claims: { sub: string; org: string; venue: string; jti?: string };
    try {
      claims = await this.tokens.verify(token);
    } catch (error) {
      // Se distingue "expirado" de "invalido" porque el POS reacciona distinto a cada
      // uno: un token vencido se renueva solo, uno invalido obliga a volver a loguear.
      const expired =
        error instanceof Error &&
        (error.name === 'TokenExpiredError' || error.message.includes('expired'));
      return this.handshakeError(
        401,
        expired ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.UNAUTHENTICATED,
        expired ? 'Tu sesion vencio. Renovando…' : 'La sesion no es valida.',
      );
    }

    // El org y el venue salen del token firmado, nunca del handshake: es el mismo
    // criterio que el middleware de HTTP.
    try {
      return await this.auth.resolvePrincipal({
        userId: claims.sub,
        orgId: claims.org,
        venueId: claims.venue,
        sessionId: claims.jti ?? '',
        authMethod: 'refresh',
      });
    } catch (error) {
      // Una cuenta desactivada entre el login y el handshake no es un error de
      // transporte: es una sesion que ya no existe. El motivo se loguea porque
      // "la sesion no es valida" con un 401 no distingue una cuenta dada de baja de un
      // fallo de base, y sin el motivo no hay forma de diagnosticarlo desde el log.
      this.logger.warn(
        `No se pudo resolver la sesion del handshake: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.handshakeError(401, ERROR_CODES.UNAUTHENTICATED, 'La sesion no es valida.');
    }
  }

  /**
   * Ultima linea de defensa.
   *
   * El handshake ya verifica, asi que aca `principal` siempre esta. Queda igual porque
   * un gateway que depende de que "otro ya verifico" es un gateway que se abre en
   * cuanto ese otro cambia: sin esta linea, un `client.data` vacio seria un
   * `undefined.venueId` en cada mensaje y un ticket del local de al lado en pantalla.
   */
  handleConnection(client: Socket): void {
    if (!client.data.principal) {
      this.logger.warn('Conexion sin sesion en el handshake: se cierra de nuevo.');
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket): void {
    // Socket.io saca al socket de sus salas solo. Un `leaveAll` explicito aca seria
    // ruido que ademas sugiere que hay estado que limpiar cuando no lo hay.
  }

  /**
   * Suscribirse a un canal del local.
   *
   * Los canales son `venue:{id}:kds` y `venue:{id}:orders` (PLAN §7). El `{id}` tiene
   * que ser **el local de la sesion**: si no coincide, no se entra a la sala y se
   * devuelve un 403 explicito. Ese chequeo es el aislamiento entre locales del tiempo
   * real, y por eso compara el id entero en vez de un `startsWith`: "empieza con
   * `venue:`" es cierto para cualquier local.
   */
  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ channel: string } | { error: ProblemDetails }> {
    const principal = client.data.principal as SessionPrincipal | undefined;
    if (!principal) {
      return {
        error: problemDetails({
          status: 401,
          code: ERROR_CODES.UNAUTHENTICATED,
          detail: 'La conexion no tiene sesion.',
        }),
      };
    }

    const channel = readChannel(body);
    if (!channel) {
      return {
        error: problemDetails({
          status: 422,
          code: ERROR_CODES.VALIDATION_FAILED,
          detail: 'Mandá el canal al que te querés suscribir.',
        }),
      };
    }

    const match = CHANNEL_PATTERN.exec(channel);
    if (!match) {
      return {
        error: problemDetails({
          status: 422,
          code: ERROR_CODES.VALIDATION_FAILED,
          detail: 'Ese canal no existe.',
        }),
      };
    }

    const [, venueId, room] = match as unknown as [string, string, string];

    // EL aislamiento entre locales. Un KDS del local B no entra a la sala del local A,
    // ni aunque sepa el id: el id de la sesion es del token, no del mensaje.
    if (venueId !== principal.venueId) {
      return {
        error: problemDetails({
          status: 403,
          code: ERROR_CODES.FORBIDDEN,
          detail: 'Ese canal es de otro local.',
        }),
      };
    }

    // Y el permiso, distinto por canal: ver la cocina es `kitchen.read`; el canal de
    // ordenes es lo que ve la pantalla de comandas, o sea `order.read`.
    const required = room === 'kds' ? ['kitchen.read'] : ['order.read'];
    if (!canAll(principal.permissions, required)) {
      return {
        error: problemDetails({
          status: 403,
          code: ERROR_CODES.FORBIDDEN,
          detail: 'Tu rol no puede ver ese canal.',
          // `problemDetails` no tiene `missing` en su contrato (el guard HTTP lo
          // agrega aparte), asi que se pone el campo sobre el resultado. Los faltantes
          // son lo que el POS necesita para explicar el boton deshabilitado.
          ...({ missing: required } as Record<string, unknown>),
        }),
      };
    }

    await client.join(channel);
    return { channel };
  }

  /**
   * Suscribe el gateway al bus.
   *
   * Va en `onModuleInit` y no en `handleConnection` a proposito: el bus se popula desde
   * el sync, que corre en el mismo proceso y puede publicar antes de que se conecte el
   * primer socket. Una suscripcion perezosa se perderia el cambio que dispara la
   * creacion del socket.
   */
  onModuleInit(): void {
    this.bus.subscribe((change) => {
      void this.broadcast(change);
    });
  }

  /**
   * Emite un cambio a las salas del local.
   *
   * Lo que viaja es el **ticket releido de la base**, no un delta. Un delta obliga al
   * cliente a aplicarlo sobre un estado que puede no ser el suyo (se perdio un mensaje,
   * se ordenaron distinto); con la fila entera, el cliente reemplaza lo que tiene por lo
   * que la base dice, y dos pantallas del mismo local no pueden discrepar.
   */
  private async broadcast(change: {
    kind: 'ticket-status' | 'ticket-created' | 'order-items';
    orgId: string;
    venueId: string;
    ticketId?: string;
    orderId?: string;
  }): Promise<void> {
    try {
      if (change.kind === 'order-items') {
        const tickets = await this.kds.tickets(change.orgId, change.venueId, {
          status: undefined,
          includeServed: false,
          limit: 100,
          offset: 0,
        });
        this.server.to(`venue:${change.venueId}:kds`).emit('kds:tickets', { tickets });
        return;
      }

      if (!change.ticketId) return;

      const ticket = await this.kds.ticket(change.orgId, change.venueId, change.ticketId);
      if (!ticket) {
        // El ticket no existe mas (o no es de este local). Se emite una baja para que
        // la pantalla lo saque: sin esto, un ticket que otra tablet marcó SERVED queda
        // clavado en la de enfrente, y lo que esta en cocina lo saca a mano.
        this.server.to(`venue:${change.venueId}:kds`).emit('kds:ticket-removed', {
          ticketId: change.ticketId,
        });
        return;
      }

      this.server.to(`venue:${change.venueId}:kds`).emit('kds:ticket', { ticket });
      this.server.to(`venue:${change.venueId}:orders`).emit('kds:ticket', { ticket });
    } catch (error) {
      this.logger.warn(
        `No se pudo emitir el cambio ${change.kind} del local ${change.venueId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * El error que ve el cliente del handshake, con el problem+json en `data`.
   *
   * `data` y no el mensaje del `Error` porque el POS muestra `detail`: lo que tiene que
   * poder diferenciar es "tu sesion vencio, renovando" de "tu sesion no es valida", y
   * con un string suelto las dos llegan iguales.
   */
  private handshakeError(status: number, code: ErrorCode, detail: string): Error {
    this.logger.warn(`Handshake rechazado (${code}): ${detail}`);
    const error = new Error(detail) as Error & { data: unknown };
    error.data = problemDetails({ status, code, detail });
    return error;
  }
}

/** Canales del PLAN §7: `venue:{uuid}:kds` y `venue:{uuid}:orders`. */
const CHANNEL_PATTERN =
  /^venue:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(kds|orders)$/i;

/** El token viaja en `auth.token`, que es donde socket.io lo deja. */
function readToken(client: Socket): string | null {
  const auth = client.handshake?.auth as Record<string, unknown> | undefined;
  const token = auth?.token ?? (client.handshake?.query?.token as string | undefined);
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function readChannel(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && 'channel' in body) {
    const channel = (body as { channel: unknown }).channel;
    return typeof channel === 'string' ? channel : null;
  }
  return null;
}
