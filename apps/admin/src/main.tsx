import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@comanda/ui/styles.css';
import { AdminApp } from './AdminApp';

const container = document.getElementById('root');
if (!container) {
  throw new Error('No se encontro #root en index.html');
}

createRoot(container).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
