import { create } from 'zustand'

interface User {
  id: string
  username: string
  email: string
  role: 'user' | 'admin'
}

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null

  login: (login: string, password: string) => Promise<boolean>
  register: (username: string, email: string, password: string) => Promise<boolean>
  logout: () => void
  checkAuth: () => Promise<void>
  clearError: () => void
}

const STORAGE_KEY = 'clipr-auth-token'

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem(STORAGE_KEY),
  isAuthenticated: false,
  isLoading: true,
  error: null,

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

      localStorage.setItem(STORAGE_KEY, data.token)
      set({ user: data.user, token: data.token, isAuthenticated: true, error: null })
      return true
    } catch (e: any) {
      set({ error: e.message })
      return false
    }
  },

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

      localStorage.setItem(STORAGE_KEY, data.token)
      set({ user: data.user, token: data.token, isAuthenticated: true, error: null })
      return true
    } catch (e: any) {
      set({ error: e.message })
      return false
    }
  },

  logout: () => {
    localStorage.removeItem(STORAGE_KEY)
    set({ user: null, token: null, isAuthenticated: false, error: null })
  },

  checkAuth: async () => {
    const token = get().token
    if (!token) {
      set({ isLoading: false })
      return
    }

    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Token invalid')

      const user = await res.json()
      set({ user, isAuthenticated: true, isLoading: false })
    } catch {
      localStorage.removeItem(STORAGE_KEY)
      set({ user: null, token: null, isAuthenticated: false, isLoading: false })
    }
  },

  clearError: () => set({ error: null })
}))
