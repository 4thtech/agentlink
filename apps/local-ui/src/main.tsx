// Entry point. Styles come from the design system as files (CSP style-src 'self').
import '@4thtech-io/ui/tokens.css';
import '@4thtech-io/ui/components.css';
import '@4thtech-io/ui/depth.css';
import '@4thtech-io/ui/progress.css';
import '@4thtech-io/ui/motion.css';
import '@4thtech-io/ui/hood.css';
import '@4thtech-io/ui/chrome.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyOs } from './layout/os.js';
import { initPrefs } from './prefs/index.js';
import { AppRoutes } from './router.js';

// Before the first paint: the stored display settings, and the platform for the chrome material.
initPrefs();
applyOs();

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <AppRoutes />
    </StrictMode>,
  );
}
