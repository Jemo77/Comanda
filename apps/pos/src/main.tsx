import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@comanda/ui/styles.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) {
  // Un POS que no monta es un POS que no vende. Falla ruidosamente en desarrollo.
  throw new Error('No se encontro #root en index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
