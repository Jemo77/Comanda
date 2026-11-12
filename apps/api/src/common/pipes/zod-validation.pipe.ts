import {
  ArgumentMetadata,
  Injectable,
  PipeTransform,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ZodType, z } from 'zod';
import { ERROR_CODES, problemDetails } from '@comanda/domain';

/**
 * Validacion de entrada con Zod.
 *
 * El esquema es parte del contrato (`@comanda/domain`), no se duplica en el DTO:
 * si el cliente y el servidor validan con el mismo objeto, no puede pasar algo
 * que el cliente considera valido y el servidor no.
 *
 * El pipe devuelve un `UnprocessableEntityException` con problem+json, no un
 * array de mensajes sueltos: el POS necesita saber QUE campo Fallo para marcar
 * ese input y no toda la pantalla.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new UnprocessableEntityException(
        problemDetails({
          status: 422,
          code: ERROR_CODES.VALIDATION_FAILED,
          detail: 'Revisa los campos marcados.',
          errors: result.error.issues.map((issue) => ({
            path: issue.path.join('.') || '(raiz)',
            message: issue.message,
          })),
        }),
      );
    }

    return result.data;
  }
}

/** Atajo de tipo para inferir el tipo de salida de un esquema. */
export type Infer<T extends ZodType> = z.infer<T>;
