import { describe, expect, it } from 'vitest';
import { emailSchema, loginSchema, passwordSchema, pinSchema } from './auth';
import { deviceRegistrationSchema, organizationInputSchema, venueInputSchema } from './tenancy';

describe('pinSchema', () => {
  it('acepta 4 a 6 digitos', () => {
    expect(pinSchema.parse('1234')).toBe('1234');
    expect(pinSchema.parse('123456')).toBe('123456');
  });

  it('rechaza letras, simbolos y longitudes fuera de rango', () => {
    for (const bad of ['123', '1234567', '12a4', '', '12 4', '１２３４']) {
      expect(() => pinSchema.parse(bad), bad).toThrow();
    }
  });
});

describe('passwordSchema', () => {
  it('exige longitud y variedad', () => {
    expect(passwordSchema.parse('Comanda1234!')).toBe('Comanda1234!');
    expect(() => passwordSchema.parse('corta1A')).toThrow(/12 caracteres/);
    expect(() => passwordSchema.parse('comanda1234!')).toThrow(/mayuscula/);
    expect(() => passwordSchema.parse('COMANDA1234!')).toThrow(/minuscula/);
    expect(() => passwordSchema.parse('ComandaSegura!')).toThrow(/digito/);
  });
});

describe('emailSchema', () => {
  it('normaliza a minusculas ignorando espacios', () => {
    expect(emailSchema.parse('  DUENO@Cafe.Test ')).toBe('dueno@cafe.test');
  });

  it('rechaza emails con caracteres fuera de ASCII', () => {
    // La especificacion de email admite IDN, pero la mayoria de los MTAs de
    // PAMI no lo hacen y un usuario no puede recibir un aviso de recuperacion.
    expect(() => emailSchema.parse('dueño@cafe.test')).toThrow(/email/);
  });

  it('rechaza formatos invalidos', () => {
    for (const bad of ['sin-arroba', 'a@b', '@cafe.test', 'a@.test']) {
      expect(() => emailSchema.parse(bad), bad).toThrow();
    }
  });
});

describe('loginSchema', () => {
  it('discrimina por metodo', () => {
    const byPassword = loginSchema.parse({
      method: 'password',
      email: 'Dueno@Cafe.Test',
      password: 'x',
    });
    expect(byPassword.method).toBe('password');

    const byPin = loginSchema.parse({
      method: 'pin',
      deviceId: 'c0ffee00-0000-4000-8000-000000000000',
      pin: '4821',
    });
    expect(byPin.method).toBe('pin');
  });

  it('exige deviceId en el login por PIN', () => {
    // Sin el dispositivo, un PIN de 4 digitos seria atacable desde cualquier lado.
    expect(() => loginSchema.parse({ method: 'pin', pin: '4821' })).toThrow();
  });

  it('rechaza un metodo desconocido', () => {
    expect(() => loginSchema.parse({ method: 'oauth', pin: '4821' })).toThrow();
  });
});

describe('organizationInputSchema', () => {
  it('exige nombre', () => {
    expect(() => organizationInputSchema.parse({})).toThrow();
    expect(organizationInputSchema.parse({ name: 'Cafe Luna' }).name).toBe('Cafe Luna');
  });
});

describe('venueInputSchema', () => {
  it('aplica defaults razonables para Argentina', () => {
    const venue = venueInputSchema.parse({ name: 'Cafe Luna' });
    expect(venue.kind).toBe('bar');
    expect(venue.currency).toBe('ARS');
    expect(venue.timezone).toBe('America/Argentina/Buenos_Aires');
    expect(venue.isActive).toBe(true);
  });

  it('valida el nombre', () => {
    expect(() => venueInputSchema.parse({ name: 'x' })).toThrow();
  });
});

describe('deviceRegistrationSchema', () => {
  it('exige una huella bastante larga', () => {
    const base = { venueId: 'c0ffee00-0000-4000-8000-000000000000', name: 'Tablet barra' };
    expect(deviceRegistrationSchema.parse({ ...base, fingerprint: 'abcd1234' }).kind).toBe(
      'tablet',
    );
    expect(() => deviceRegistrationSchema.parse({ ...base, fingerprint: 'abc' })).toThrow();
  });
});
