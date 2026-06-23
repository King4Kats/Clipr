/**
 * VISIONTOOL.TSX : Sous-outil "Lecture d'image" de l'Assistant.
 *
 * C'est un chat IA MULTIMODAL : l'utilisateur joint une ou plusieurs images
 * (pages de livre, manuscrits...) et discute avec un modele de vision local
 * (qwen2.5vl via Ollama). Il peut demander de :
 *   - retranscrire le texte manuscrit (khmer, vietnamien, latin, multilingue...)
 *   - traduire (francais ou anglais)
 *   - analyser / resumer / commenter
 *
 * Fonctionnement :
 * - Sidebar gauche : conversations vision (separees des conversations "chat").
 * - On joint des images : elles sont uploadees cote serveur (stockage securise)
 *   et rattachees au message a l'envoi.
 * - La reponse est streamee en SSE (tokens en temps reel), rendu Markdown.
 *
 * NB : le modele vision est plus lourd que le chat texte ; la 1ere reponse peut
 * prendre quelques secondes (chargement du modele en VRAM).
 */

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Plus, Trash2, Pencil, Check, X, Send, Bot, User as UserIcon,
  Loader2, MessageSquare, Square, ImagePlus, ScanText,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import api from '@/api'
import { Button } from '@/components/ui/button'

interface Conv {
  id: string
  title: string
  updated_at: string
}

/** Image affichee dans un message : `url` est soit un blob local, soit l'URL serveur. */
interface MsgImage {
  id?: string
  url: string
  name: string
}

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at?: string
  images?: MsgImage[]
}

/** Image en attente (uploadee, pas encore envoyee dans un message). */
interface PendingImage {
  id: string         // id serveur (pour l'envoi)
  name: string       // nom d'origine
  previewUrl: string // blob local pour l'apercu immediat
}

export default function VisionTool() {
  const [convs, setConvs] = useState<Conv[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [streaming, setStreaming] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const streamCtrl = useRef<{ abort: () => void } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Images uploadees en attente d'envoi
  const [pending, setPending] = useState<PendingImage[]>([])
  const [uploading, setUploading] = useState(false)
  // Apercu local des images du message en cours d'envoi (affiche pendant le stream)
  const [streamingImages, setStreamingImages] = useState<MsgImage[]>([])

  // ── Chargement initial ──
  useEffect(() => { refreshConversations() }, [])

  // ── Scroll auto en bas ──
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, streaming])

  const refreshConversations = async () => {
    try {
      const list = await api.assistantListConversations('vision')
      setConvs(list)
    } catch (err) {
      console.error('Failed to load vision conversations:', err)
    }
  }

  /** Cree une conversation vision si aucune n'est active, et renvoie son id. */
  const ensureConversation = async (): Promise<string | null> => {
    if (activeId) return activeId
    try {
      const conv = await api.assistantCreateConversation('vision')
      setConvs((cs) => [conv, ...cs])
      setActiveId(conv.id)
      return conv.id
    } catch (err) {
      console.error('Failed to create vision conversation:', err)
      return null
    }
  }

  /** Bouton "Nouveau" : repart d'une conversation vierge. */
  const handleNewConv = async () => {
    if (activeId && messages.length === 0) return
    setActiveId(null)
    setMessages([])
    setStreaming(null)
    setPending([])
  }

  /** Ouvre une conversation : recupere ses messages (avec images). */
  const handleOpenConv = async (id: string) => {
    if (id === activeId) return
    streamCtrl.current?.abort()
    streamCtrl.current = null
    setStreaming(null)
    setPending([])
    setActiveId(id)
    try {
      const data = await api.assistantGetConversation(id)
      setMessages(
        data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          created_at: m.created_at,
          // Reconstruit les URLs d'affichage depuis les ids serveur
          images: m.images?.map((im) => ({ id: im.id, url: api.assistantVisionImageUrl(im.id), name: im.name })),
        })),
      )
    } catch (err) {
      console.error('Failed to load conversation:', err)
      setMessages([])
    }
  }

  /** Supprime une conversation (avec confirmation). */
  const handleDeleteConv = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!confirm('Supprimer cette conversation ?')) return
    try {
      await api.assistantDeleteConversation(id)
      setConvs((cs) => cs.filter((c) => c.id !== id))
      if (activeId === id) { setActiveId(null); setMessages([]); setStreaming(null); setPending([]) }
    } catch (err) {
      console.error('Failed to delete:', err)
    }
  }

  const handleStartRename = (e: React.MouseEvent, conv: Conv) => {
    e.stopPropagation()
    setRenamingId(conv.id)
    setRenameValue(conv.title)
  }

  const handleConfirmRename = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return }
    try {
      await api.assistantRenameConversation(renamingId, renameValue.trim())
      setConvs((cs) => cs.map((c) => (c.id === renamingId ? { ...c, title: renameValue.trim() } : c)))
    } catch (err) {
      console.error('Rename failed:', err)
    }
    setRenamingId(null)
  }

  /**
   * L'utilisateur choisit des images : on cree la conversation au besoin, puis
   * on uploade chaque image cote serveur. L'apercu local s'affiche tout de suite.
   */
  const handleFilesUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const convId = await ensureConversation()
    if (!convId) { alert("Impossible de creer la conversation."); return }
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        try {
          const res = await api.assistantUploadVisionImage(convId, file)
          setPending((p) => [...p, { id: res.id, name: res.name, previewUrl: URL.createObjectURL(file) }])
        } catch (err: any) {
          alert(`Echec de l'upload pour ${file.name} : ${err.message || 'erreur inconnue'}`)
        }
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleRemovePending = (index: number) => {
    setPending((p) => {
      // Libere le blob local pour ne pas fuiter de memoire
      const target = p[index]
      if (target) URL.revokeObjectURL(target.previewUrl)
      return p.filter((_, i) => i !== index)
    })
  }

  /** Envoie le message (texte + images en attente) et stream la reponse vision. */
  const handleSend = async () => {
    const text = input.trim()
    if ((!text && pending.length === 0) || streaming !== null) return

    const convId = await ensureConversation()
    if (!convId) return

    const imageIds = pending.map((p) => p.id)
    const localImages: MsgImage[] = pending.map((p) => ({ id: p.id, url: p.previewUrl, name: p.name }))

    // Message user optimiste (affiche immediatement avec les apercus locaux)
    const userMsg: Msg = {
      id: 'tmp-' + Date.now(),
      role: 'user',
      content: text || '(lecture d\'image)',
      images: localImages.length ? localImages : undefined,
    }
    setMessages((ms) => [...ms, userMsg])
    setInput('')
    setPending([])
    setStreaming('')
    setStreamingImages([])

    streamCtrl.current = api.assistantSendVisionMessage(
      convId,
      text || 'Transcris fidelement le texte de cette image.',
      imageIds,
      {
        onToken: (chunk) => setStreaming((s) => (s ?? '') + chunk),
        onDone: (_full, savedMsg) => {
          if (savedMsg) setMessages((ms) => [...ms, { id: savedMsg.id, role: 'assistant', content: savedMsg.content }])
          setStreaming(null)
          setStreamingImages([])
          streamCtrl.current = null
          refreshConversations()
        },
        onError: (err) => {
          setMessages((ms) => [...ms, { id: 'err-' + Date.now(), role: 'assistant', content: `Erreur : ${err}` }])
          setStreaming(null)
          setStreamingImages([])
          streamCtrl.current = null
        },
      },
    )
  }

  const handleStop = () => {
    streamCtrl.current?.abort()
    if (streaming) {
      setMessages((ms) => [...ms, { id: 'partial-' + Date.now(), role: 'assistant', content: streaming + ' [annule]' }])
    }
    setStreaming(null)
    streamCtrl.current = null
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  return (
    <main className="h-full flex">
      {/* ═══════════════ Sidebar : conversations vision ═══════════════ */}
      <aside className="w-64 border-r border-border bg-card/30 flex flex-col">
        <div className="p-3 border-b border-border">
          <Button
            onClick={handleNewConv}
            variant="secondary"
            size="sm"
            className="w-full h-9 gap-2 bg-violet-500/10 hover:bg-violet-500/20 text-violet-400 border border-violet-500/30"
          >
            <Plus className="w-4 h-4" />
            <span>Nouvelle lecture</span>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {convs.length === 0 ? (
            <p className="text-xs text-muted-foreground p-3 text-center">
              Aucune lecture. Joins une image pour commencer.
            </p>
          ) : (
            convs.map((c) => (
              <div
                key={c.id}
                onClick={() => handleOpenConv(c.id)}
                className={`group flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors text-sm ${
                  activeId === c.id ? 'bg-violet-500/15 text-foreground' : 'hover:bg-secondary/50 text-foreground/80'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                {renamingId === c.id ? (
                  <>
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleConfirmRename(e as any)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="flex-1 min-w-0 bg-background border border-border rounded px-1 py-0.5 text-xs"
                    />
                    <button onClick={handleConfirmRename} className="p-0.5 hover:bg-primary/20 rounded">
                      <Check className="w-3 h-3 text-emerald-400" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setRenamingId(null) }} className="p-0.5 hover:bg-destructive/20 rounded">
                      <X className="w-3 h-3 text-destructive" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 min-w-0 truncate text-xs">{c.title}</span>
                    <button
                      onClick={(e) => handleStartRename(e, c)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-secondary rounded transition-opacity"
                      title="Renommer"
                    >
                      <Pencil className="w-3 h-3 text-muted-foreground" />
                    </button>
                    <button
                      onClick={(e) => handleDeleteConv(e, c.id)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-destructive/20 rounded transition-opacity"
                      title="Supprimer"
                    >
                      <Trash2 className="w-3 h-3 text-destructive" />
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ═══════════════ Zone principale : chat vision ═══════════════ */}
      <section className="flex-1 flex flex-col bg-background">
        <div className="px-6 py-3 border-b border-border flex items-center gap-2">
          <ScanText className="w-5 h-5 text-violet-400" />
          <h1 className="text-sm font-bold text-foreground">Lecture d'image</h1>
          <span className="text-[10px] text-muted-foreground">· qwen2.5vl (local)</span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {messages.length === 0 && streaming === null ? (
            <div className="max-w-2xl mx-auto py-12 text-center">
              <ScanText className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h2 className="text-xl font-bold text-foreground mb-2">Lis et analyse une image</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Joins une ou plusieurs pages (manuscrit, livre...) puis demande par exemple :<br />
                <em>"Transcris le texte"</em>, <em>"Traduis en anglais"</em>, <em>"Resume cette page"</em>.<br />
                Le modele gere le manuscrit et les ecritures non-latines (khmer, vietnamien...).
              </p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} role={m.role} content={m.content} images={m.images} />
              ))}
              {streaming !== null && (
                <MessageBubble
                  role="assistant"
                  content={streaming + (streaming ? '▌' : '')}
                  streaming
                  images={streamingImages}
                />
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Zone de saisie */}
        <div className="border-t border-border p-4 bg-card/30">
          <div className="max-w-3xl mx-auto">
            {/* Miniatures des images jointes au prochain message */}
            {pending.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {pending.map((p, i) => (
                  <div key={p.id} className="relative group">
                    <img
                      src={p.previewUrl}
                      alt={p.name}
                      className="w-16 h-16 object-cover rounded-lg border border-violet-500/30"
                    />
                    <button
                      onClick={() => handleRemovePending(i)}
                      className="absolute -top-1.5 -right-1.5 p-0.5 bg-destructive text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Retirer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 items-end">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => handleFilesUpload(e.target.files)}
                className="hidden"
              />
              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 shrink-0"
                disabled={streaming !== null || uploading}
                title="Joindre une ou plusieurs images"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
              </Button>

              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={pending.length > 0 ? "Que veux-tu faire avec cette/ces image(s) ? (vide = transcrire)" : "Joins une image puis pose ta question... (Shift+Entree = saut de ligne)"}
                rows={Math.min(8, Math.max(1, input.split('\n').length))}
                disabled={streaming !== null}
                className="flex-1 resize-none bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 disabled:opacity-60"
              />
              {streaming !== null ? (
                <Button onClick={handleStop} variant="secondary" size="sm" className="h-9 gap-2 bg-destructive/10 hover:bg-destructive/20 text-destructive">
                  <Square className="w-3.5 h-3.5" fill="currentColor" />
                  <span>Stop</span>
                </Button>
              ) : (
                <Button onClick={handleSend} size="sm" className="h-9 gap-2" disabled={!input.trim() && pending.length === 0}>
                  <Send className="w-4 h-4" />
                  <span>Envoyer</span>
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

/** Bulle d'un message (user ou assistant) avec images + rendu Markdown. */
function MessageBubble({
  role, content, streaming, images,
}: {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  images?: MsgImage[]
}) {
  const isUser = role === 'user'
  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isUser ? 'bg-primary text-primary-foreground' : 'bg-violet-500/10 text-violet-400'}`}>
        {isUser ? <UserIcon className="w-4 h-4" /> : streaming && !content ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
      </div>
      <div
        className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser ? 'bg-primary text-primary-foreground' : 'bg-card border border-border text-foreground'
        }`}
      >
        {/* Images jointes (cliquables pour agrandir) */}
        {images && images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((im, i) => (
              <a key={im.id || i} href={im.url} target="_blank" rel="noopener noreferrer" title={im.name}>
                <img
                  src={im.url}
                  alt={im.name}
                  className="max-w-[180px] max-h-[180px] rounded-lg border border-border/60 object-contain bg-background/40"
                />
              </a>
            ))}
          </div>
        )}

        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{content}</div>
        ) : (
          <div className="prose prose-sm prose-invert max-w-none break-words [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_h1]:text-base [&_h1]:mt-2 [&_h2]:text-sm [&_h2]:mt-2 [&_h3]:text-sm [&_h3]:mt-1 [&_code]:text-xs [&_pre]:text-xs [&_pre]:bg-background [&_pre]:p-2 [&_pre]:rounded">
            <ReactMarkdown>{content || ' '}</ReactMarkdown>
          </div>
        )}
      </div>
    </motion.div>
  )
}
