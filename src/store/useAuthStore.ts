/**
 * =============================================================================
 * Fichier : useAuthStore.ts
 * Rôle    : Store Zustand pour gérer l'authentification de l'utilisateur.
 *
 *           Ce store centralise tout ce qui concerne la connexion/déconnexion :
 *           - Connexion (login) et inscription (register) via l'API
 *           - Stockage du token JWT dans le localStorage du navigateur
 *           - Vérification automatique du token au démarrage de l'app
 *           - Gestion des erreurs d'authentification
 *
 *           Zustand est une bibliothèque de gestion d'état pour React,
 *           plus simple que Redux. On crée un "store" avec `create()`,
 *           et on l'utilise dans les composants avec `useAuthStore()`.
 * =============================================================================
 */

import { create } from 'zustand'

/**
 * Interface décrivant un utilisateur connecté.
 * Ces données viennent du serveur après un login réussi.
 */
interface User {
  id: string        // Identifiant unique (UUID)
  username: string   // Nom d'utilisateur (affiché dans l'interface)
  email: string      // Email de l'utilisateur
  role: 'user' | 'admin'  // Rôle : utilisateur normal ou administrateur
}

/**
 * Interface du store d'authentification.
 * Contient à la fois les données (state) et les actions (méthodes).
 */
interface AuthState {
  // ── Données ──
  user: User | null          // L'utilisateur connecté (null si pas connecté)
  token: string | null       // Le token JWT (null si pas connecté)
  isAuthenticated: boolean   // Est-ce que l'utilisateur est connecté ?
  isLoading: boolean         // Est-ce qu'on vérifie le token au démarrage ?
  error: string | null       // Message d'erreur à afficher (null si pas d'erreur)

  // ── Actions ──
  login: (login: string, password: string) => Promise<boolean>       // Se connecter
  register: (username: string, email: string, password: string) => Promise<boolean>  // S'inscrire
  logout: () => void                    // Se déconnecter
  checkAuth: () => Promise<void>        // Vérifier si le token stocké est encore valide
  clearError: () => void                // Effacer le message d'erreur
}

// Clé utilisée dans le localStorage pour stocker le token JWT
const STORAGE_KEY = 'clipr-auth-token'

/**
 * Création du store Zustand.
 * `set` permet de modifier l'état, `get` permet de lire l'état actuel.
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  // ── État initial ──
  user: null,
  token: localStorage.getItem(STORAGE_KEY),  // Récupérer le token s'il existe déjà
  isAuthenticated: false,
  isLoading: true,   // Au démarrage, on est "en chargement" le temps de vérifier le token
  error: null,

  /**
   * Connexion : envoie le login + mot de passe au serveur.
   * Si la connexion réussit, on stocke le token et les infos utilisateur.
   * Retourne true si succès, false si échec.
   */
  login: async (login, password) => {
    set({ error: null })
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erreur de connexion')

      // Sauvegarder le token dans le localStorage (persiste entre les rechargements)
      localStorage.setItem(STORAGE_KEY, data.token)
      set({ user: data.user, token: data.token, isAuthenticated: true, error: null })
      return true
    } catch (e: any) {
      set({ error: e.message })
      return false
    }
  },

  /**
   * Inscription : crée un nouveau compte utilisateur.
   * Le premier utilisateur inscrit devient automatiquement admin.
   * Après l'inscription, l'utilisateur est connecté automatiquement.
   */
  register: async (username, email, password) => {
    set({ error: null })
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erreur d\'inscription')

      // Connecter automatiquement après l'inscription
      localStorage.setItem(STORAGE_KEY, data.token)
      set({ user: data.user, token: data.token, isAuthenticated: true, error: null })
      return true
    } catch (e: any) {
      set({ error: e.message })
      return false
    }
  },

  /**
   * Déconnexion : supprime le token et réinitialise l'état.
   */
  logout: () => {
    localStorage.removeItem(STORAGE_KEY)
    set({ user: null, token: null, isAuthenticated: false, error: null })
  },

  /**
   * Vérification du token au démarrage de l'application.
   * Si un token existe dans le localStorage, on demande au serveur
   * s'il est encore valide (endpoint /api/auth/me).
   * Si le token est expiré ou invalide, on déconnecte l'utilisateur.
   */
  checkAuth: async () => {
    const token = get().token
    if (!token) {
      // Pas de token stocké → pas connecté
      set({ isLoading: false })
      return
    }

    try {
      // Demander au serveur les infos utilisateur avec ce token
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Token invalid')

      const user = await res.json()
      set({ user, isAuthenticated: true, isLoading: false })
    } catch {
      // Token invalide ou expiré → nettoyer et déconnecter
      localStorage.removeItem(STORAGE_KEY)
      set({ user: null, token: null, isAuthenticated: false, isLoading: false })
    }
  },

  /** Efface le message d'erreur (utile quand l'utilisateur retape son mot de passe) */
  clearError: () => set({ error: null })
}))
