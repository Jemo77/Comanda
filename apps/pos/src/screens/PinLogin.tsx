import { useState, type ReactElement } from 'react';
import { PinDots, PinPad } from '@comanda/ui';
import { useSession } from '../state/session';

/**
 * Pantalla de PIN.
 *
 * El mozo entra con un PIN de 4-6 digitos en la tablet del mostrador, sin pasar por
 * un teclado de letras. Por eso:
 *
 *  - El teclado es en pantalla, con el orden del teclado telefonico: es el que todos
 *    ya saben tocar de memoria.
 *  - Los digitos son de 64px, mas que el minimo de 48: se tipea con guantes y sin
 *    mirar la pantalla.
 *  - Se muestra la longitud, nunca el valor.
 *  - El boton de entrar se habilita recien con la longitud minima del PIN.
 *
 * El hash del PIN se verifica en el dispositivo cuando la replica local esta
 * cargada, y en el servidor cuando hay conexion. Offline, el POS tiene que poder
 * abrir igual.
 */
export function PinLogin(): ReactElement {
  const { loginWithPin, devices, selectedDeviceId, selectDevice, error, busy } = useSession();
  const [pin, setPin] = useState('');

  const MIN_PIN = 4;
  const MAX_PIN = 6;

  const push = (digit: string): void => {
    setPin((current) => (current.length < MAX_PIN ? current + digit : current));
  };

  const backspace = (): void => {
    setPin((current) => current.slice(0, -1));
  };

  const submit = (): void => {
    if (pin.length < MIN_PIN || !selectedDeviceId) return;
    void loginWithPin(selectedDeviceId, pin);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-enamel p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <header>
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Comanda</h1>
          <p className="mt-1 text-sm text-ink-soft">Tocá el botón de tu nombre para empezar.</p>
        </header>

        <section aria-label="Dispositivo">
          <p className="mb-2 text-xs font-semibold text-ink-soft">Este dispositivo</p>
          <div className="flex flex-col gap-2">
            {devices.map((device) => (
              <button
                key={device.id}
                type="button"
                onClick={() => selectDevice(device.id)}
                aria-pressed={device.id === selectedDeviceId}
                className={[
                  'min-h-touch rounded-wire border px-3 py-2.5 text-left font-display text-sm font-semibold',
                  'transition-[background-color,border-color] duration-80',
                  device.id === selectedDeviceId
                    ? 'border-azulejo-deep bg-azulejo text-tile'
                    : 'border-steel bg-tile text-ink hover:bg-tile-warm',
                ].join(' ')}
              >
                {device.name}
              </button>
            ))}
          </div>
        </section>

        <section aria-label="PIN">
          <PinDots length={pin.length} max={MAX_PIN} />
          <PinPad onDigit={push} onBackspace={backspace} onSubmit={submit} disabled={busy} />

          {error && (
            <p role="alert" className="mt-3 text-sm font-medium text-coca">
              {error}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
