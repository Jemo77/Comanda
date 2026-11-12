import { MenuClient } from './MenuClient';

interface Props {
  params: Promise<{ venueId: string; tableId: string }>;
  searchParams: Promise<{ token?: string; lang?: string }>;
}

export default async function MesaPage({ params, searchParams }: Props) {
  const { venueId, tableId } = await params;
  const { token, lang } = await searchParams;

  if (!token) {
    return (
      <main>
        <h1>QR incompleto</h1>
        <p>
          Este código no tiene el token de mesa. Pedile al encargado que te muestre el QR de la
          carta.
        </p>
      </main>
    );
  }

  return <MenuClient venueId={venueId} tableId={tableId} token={token} lang={lang ?? 'es'} />;
}
