/**
 * MAIN.TSX : Point d'entree de l'application React
 *
 * Monte le composant racine App dans le DOM avec le StrictMode de React,
 * le BrowserRouter pour le routing client-side,
 * et le ThemeProvider (next-themes) pour la gestion du theme clair/sombre.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import './api'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider attribute="class" defaultTheme="dark" storageKey="clipr-theme">
        <App />
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
)
