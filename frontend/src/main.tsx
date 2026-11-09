import '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2';
import '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2';
import './fonts.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/app';
import '@/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Frontend root element is missing.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
