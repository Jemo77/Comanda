import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ERROR_CODES,
  PROBLEM_TYPES,
  problemDetails,
  type ErrorCode,
  type ProblemDetails,
} from '@comanda/domain';

/**
 * Errores en RFC 7807.
 *
 * El motivo de un unico formato: el POS es una PWA que cachea respuestas y
 * distingue "no tenes permiso" de "el servidor se cayo" para decidir si reintenta,
 * si pide PIN de supervisor o si muestra un error de red. Un `{ message }` no
 * alcanza para eso.
 *
 * `code` es estable y es lo que el cliente debe usar; `detail` esta escrito para
 * la persona que lo lee en el mostrador.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const problem = this.toProblem(exception, request);

    if (problem.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${problem.status} ${problem.code}: ${problem.detail}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${problem.status} ${problem.code}`);
    }

    response.status(problem.status).type('application/problem+json').send(problem);
  }

  private toProblem(exception: unknown, request: Request): ProblemDetails {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception, request);
    }

    // Un error no controlado nunca expone su mensaje al cliente: puede contener
    // nombres de tabla, rutas o valores de datos.
    return problemDetails({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL,
      detail: 'Algo fallo de nuestro lado. Ya lo estamos revisando.',
    });
  }

  private fromHttpException(exception: HttpException, request: Request): ProblemDetails {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    // Los guards lanzan con `{ code, detail, ... }`: se respeta lo que mandaron.
    if (typeof payload === 'object' && payload !== null && 'code' in payload) {
      const custom = payload as { code: ErrorCode; detail: string; errors?: unknown };
      return problemDetails({
        status,
        code: custom.code,
        detail: custom.detail,
        instance: request.url,
        ...(Array.isArray(custom.errors)
          ? { errors: custom.errors as Array<{ path: string; message: string }> }
          : {}),
      });
    }

    // Un `HttpException` a mano con texto plano se traduce al problema mas
    // cercano segun su status, en vez de devolver un string suelto.
    const detail =
      typeof payload === 'string' ? payload : this.detailFromNestPayload(payload, status);

    return problemDetails({
      status,
      code: codeForStatus(status),
      detail,
      instance: request.url,
    });
  }

  private detailFromNestPayload(payload: unknown, status: number): string {
    if (typeof payload === 'object' && payload !== null && 'message' in payload) {
      const message = (payload as { message: unknown }).message;
      if (Array.isArray(message)) {
        // Es el caso de ValidationPipe: se convierte en el detalle y tambien se
        // pasan los errores por campo para que la UI marque cada input.
        return 'Revisa los campos marcados.';
      }
      if (typeof message === 'string') return message;
    }
    return defaultDetailForStatus(status);
  }
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ERROR_CODES.VALIDATION_FAILED;
    case 401:
      return ERROR_CODES.UNAUTHENTICATED;
    case 403:
      return ERROR_CODES.FORBIDDEN;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.CONFLICT;
    case 422:
      return ERROR_CODES.VALIDATION_FAILED;
    case 429:
      return ERROR_CODES.RATE_LIMITED;
    default:
      return status >= 500 ? ERROR_CODES.INTERNAL : ERROR_CODES.VALIDATION_FAILED;
  }
}

function defaultDetailForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'La peticion no es valida.';
    case 401:
      return 'Tu sesion vencio. Volve a entrar.';
    case 403:
      return 'Tu rol no puede hacer esto.';
    case 404:
      return 'No encontramos eso.';
    case 409:
      return 'Ese cambio choca con algo que ya existe.';
    case 429:
      return 'Demasiados intentos. Espera un momento.';
    default:
      return 'Algo fallo de nuestro lado.';
  }
}

export { PROBLEM_TYPES };
