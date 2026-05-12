/**
 * SUPPORTCHAT.TSX — Messagerie support (utilisateur)
 *
 * Bouton flottant bas-droit + panneau chat (slide-in droite). Permet a
 * l'utilisateur connecte d'echanger texte + images avec les admins.
 * Gere le badge de non-lus, la sync temps reel via WebSocket existant,
 * et l'upload d'image (multipart vers /api/support/messages).
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MessageCircle, X, Send, Loader2, Paperclip, AlertCircle } from 'lucide-react'
import { useAuthStore } from '@/store/useAuthStore'
import api from '@/api'

interface SupportMessage {
  id: string
  user_id: string
  sender_role: 'user' | 'admin'
  content: string
  attachment_path: string | null
  created_at: string
}

export default function SupportChat() {
  const { isAuthenticated, token } = useAuthStore()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [unread, setUnread] = useState(0)
  const [content, setContent] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Charger le fil + non-lus a chaque ouverture (et au montage si auth)
  const refresh = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const res = await fetch('/api/support/messages', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const data = await res.json()
      setMessages(data.messages || [])
      setUnread(data.unread || 0)
    } catch {}
  }, [isAuthenticated, token])

  useEffect(() => { refresh() }, [refresh])

  // Sync temps reel via la WS partagee (api.ts) : auto-reconnect + auth gere centralement
  useEffect(() => {
    if (!isAuthenticated) return
    const unsub = api.onSupportMessage(() => {
      // Rafraichir la liste (plus simple que de merger localement)
      refresh()
    })
    return unsub
  }, [isAuthenticated, refresh])

  // Marque comme lu a l'ouverture du panneau
  useEffect(() => {
    if (!open || !isAuthenticated || unread === 0) return
    fetch('/api/support/mark-read', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      .then(() => setUnread(0))
      .catch(() => {})
  }, [open, isAuthenticated, unread, token])

  // Auto-scroll bas a chaque nouveau message si panneau ouvert
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, open])

  const handleSend = async () => {
    if (sending) return
    const trimmed = content.trim()
    if (!trimmed && !file) return
    setSending(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('content', trimmed)
      if (file) form.append('attachment', file)
      const res = await fetch('/api/support/messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Echec envoi')
      setContent('')
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      await refresh()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  // Pas de bouton si pas connecte
  if (!isAuthenticated) return null

  return (
    <>
      {/* Bouton flottant bas-droit avec badge non-lus */}
      <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-5 right-5 z-[80] w-12 h-12 rounded-full bg-primary text-primary-foreground shadow-lg hover:scale-105 transition-transform flex items-center justify-center"
        title="Support"
      >
        <MessageCircle className="w-5 h-5" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* Panneau chat (slide-in droite) */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={{ type: 'spring', damping: 25 }}
            className="fixed bottom-20 right-5 z-[81] w-[360px] max-w-[calc(100vw-2rem)] h-[520px] max-h-[calc(100vh-6rem)] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-secondary/20">
              <div>
                <h3 className="text-sm font-bold text-foreground">Support Clipr</h3>
                <p className="text-[10px] text-muted-foreground">Echange direct avec les admins</p>
              </div>
              <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-secondary">
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
              {messages.length === 0 && (
                <div className="text-center text-xs text-muted-foreground py-8 px-4">
                  Pose ta question ou signale un bug. Les admins recoivent une notification par email et te repondront ici.
                </div>
              )}
              {messages.map(m => (
                <MessageBubble key={m.id} message={m} token={token!} />
              ))}
            </div>

            {/* Composer */}
            <div className="p-3 border-t border-border space-y-2 bg-secondary/10">
              {error && (
                <div className="flex items-center gap-2 p-2 bg-destructive/10 border border-destructive/20 rounded text-[11px] text-destructive">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  {error}
                </div>
              )}
              {file && (
                <div className="flex items-center gap-2 px-2 py-1 bg-secondary rounded text-[11px]">
                  <Paperclip className="w-3 h-3 text-muted-foreground" />
                  <span className="flex-1 truncate text-foreground">{file.name}</span>
                  <button onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = '' }} className="hover:text-destructive">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
              <div className="flex items-end gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={e => e.target.files?.[0] && setFile(e.target.files[0])}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  className="p-2 rounded-lg bg-secondary hover:bg-secondary/70 text-muted-foreground hover:text-foreground"
                  title="Joindre une image (capture d'ecran de bug...)"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  onKeyDown={(e) => {
                    // Ctrl+Enter / Cmd+Enter pour envoyer
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault(); handleSend()
                    }
                  }}
                  placeholder="Ecris ton message... (Ctrl+Enter pour envoyer)"
                  rows={2}
                  className="flex-1 resize-none px-2.5 py-1.5 bg-background border border-border rounded-lg text-xs outline-none focus:ring-1 focus:ring-primary/50"
                />
                <button
                  onClick={handleSend}
                  disabled={sending || (!content.trim() && !file)}
                  className="p-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                  title="Envoyer"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

/** Bulle individuelle message (alignee a droite si user, gauche si admin). */
function MessageBubble({ message, token }: { message: SupportMessage; token: string }) {
  const isUser = message.sender_role === 'user'
  const time = new Date(message.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-lg px-3 py-2 text-xs ${
        isUser ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'
      }`}>
        {message.attachment_path && (
          <img
            src={`/api/support/attachments/${message.attachment_path}?t=${token}`}
            alt="piece jointe"
            className="rounded mb-1.5 max-w-full max-h-[200px] cursor-pointer"
            onClick={() => window.open(`/api/support/attachments/${message.attachment_path}?t=${token}`, '_blank')}
          />
        )}
        {message.content && <div className="whitespace-pre-wrap break-words">{message.content}</div>}
        <div className={`text-[9px] mt-1 ${isUser ? 'text-primary-foreground/60' : 'text-muted-foreground'}`}>{time}</div>
      </div>
    </div>
  )
}
