import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { App } from './App';
import { AuthProvider } from './context/AuthContext';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#161a24',
              color: '#e2e6ef',
              border: '1px solid #2a3040',
              borderRadius: '12px',
              fontSize: '14px',
            },
            success: { iconTheme: { primary: '#10b981', secondary: '#161a24' } },
            error: { iconTheme: { primary: '#f43f5e', secondary: '#161a24' } },
          }}
        />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
