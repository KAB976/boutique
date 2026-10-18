import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/comic-neue/700.css';
import App from './App.jsx';
import Signature from './Signature.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<><App /><Signature /></>);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
