import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Comanda — Menú',
  description: 'Autopedido QR, takeaway y fidelización',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          maxWidth: 720,
          marginInline: 'auto',
          padding: '0 16px',
        }}
      >
        {children}
      </body>
    </html>
  );
}
