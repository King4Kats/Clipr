/**
 * MAIN.TSX : Point d'entrée de l'application React
 *
 * Monte le composant racine App dans le DOM avec le StrictMode de React
 * et le ThemeProvider (next-themes) pour la gestion du thème clair/sombre.
 */

// Imports React et configuration globale
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import App from './App'
import './index.css'

// Montage de l'application dans l'élément root du DOM
// - StrictMode : active les vérifications supplémentaires en développement
// - ThemeProvider : gère le basculement clair/sombre via la classe CSS "dark"
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" storageKey="clipr-theme">
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
