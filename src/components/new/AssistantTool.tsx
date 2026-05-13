/**
 * ASSISTANTTOOL.TSX : Outil "Assistant" — chat IA standalone (multi-conversations).
 *
 * UI :
 * - Sidebar gauche : liste des conversations de l'utilisateur, bouton "Nouveau chat"
 * - Zone principale : messages user/assistant + zone de saisie en bas
 * - Streaming des reponses IA via SSE (tokens en temps reel)
 * - Markdown rendu (titres, puces, code, etc.)
 *
 * Persistance : tout est sauvegarde en DB cote serveur (table assistant_conversations
 * + assistant_messages). Aucune perte au refresh.
 */

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Plus, Trash2, Pencil, Check, X, Send, Bot, User as UserIcon,
  Loader2, MessageSquare, Square, Paperclip, FileText, Globe, ExternalLink,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import api from '@/api'
import { Button } from '@/components/ui/button'

interface Conv {
  id: string
  title: string
  updated_at: string
}

interface Source {
  title: string
  url: string
}

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at?: string
  sources?: Source[]
}

/**
 * Extrait les sources stockees en fin de message (commentaire HTML cache),
 * et retourne le texte sans cette balise + le tableau de sources.
 */
function parseSources(content: string): { text: string; sources?: Source[] } {
  const m = content.match(/\n*<!--sources:(.+?)-->\s*$/s)
  if (!m) return { text: content }
  try {
    const sources = JSON.parse(m[1]) as Source[]
    return { text: content.slice(0, m.index).trimEnd(), sources }
  } catch {
    return { text: content }
  }
}

export default function AssistantTool() {
  // Liste des conversations (sidebar)
  const [convs, setConvs] = useState<Conv[]>([])
  // ID de la conversation active
  const [activeId, setActiveId] = useState<string | null>(null)
  // Messages de la conversation active
  const [messages, setMessages] = useState<Msg[]>([])
  // Texte en cours de generation par l'IA (live streaming)
  const [streaming, setStreaming] = useState<string | null>(null)
  // Texte saisi par l'utilisateur
  const [input, setInput] = useState('')
  // ID de la conversation en cours de renommage (inline)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // Controleur d'annulation du stream en cours
  const streamCtrl = useRef<{ abort: () => void } | null>(null)
  // Pour scroll auto en bas de la liste de messages
  const bottomRef = useRef<HTMLDivElement>(null)
  // Pour ouvrir le selecteur de fichier
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Fichiers attaches au prochain message (texte deja extrait cote serveur)
  const [attachments, setAttachments] = useState<{ name: string; text: string }[]>([])
  // Indicateur d'upload en cours
  const [uploading, setUploading] = useState(false)
  // Mode "recherche web" active pour le prochain message (Tavily + sites de confiance)
  const [webSearch, setWebSearch] = useState(false)
  // Sources du message en cours de streaming (affichees au-dessus)
  const [streamingSources, setStreamingSources] = useState<Source[] | null>(null)
  // Message de status pendant la recherche web
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // ── Chargement initial : recupere la liste des conversations ──
  useEffect(() => {
    refreshConversations()
  }, [])

  // ── Scroll auto en bas a chaque nouveau message ou pendant le streaming ──
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, streaming])

  /** Recharge la liste des conversations depuis le serveur. */
  const refreshConversations = async () => {
    try {
      const list = await api.assistantListConversations()
      setConvs(list)
    } catch (err) {
      console.error('Failed to load conversations:', err)
    }
  }

  /** Cree une nouvelle conversation vide et la selectionne. */
  const handleNewConv = async () => {
    // Si une conversation existe deja sans aucun message, on la reutilise (pas de doublon)
    if (activeId && messages.length === 0) return
    try {
      const conv = await api.assistantCreateConversation()
      setConvs((cs) => [conv, ...cs])
      setActiveId(conv.id)
      setMessages([])
      setStreaming(null)
    } catch (err) {
      console.error('Failed to create conversation:', err)
    }
  }

  /** Ouvre une conversation : recupere ses messages. */
  const handleOpenConv = async (id: string) => {
    if (id === activeId) return
    // Annule le stream en cours si on change de conv
    streamCtrl.current?.abort()
    streamCtrl.current = null
    setStreaming(null)
    setActiveId(id)
    try {
      const data = await api.assistantGetConversation(id)
      // On parse les sources eventuelles en fin de chaque message assistant
      setMessages(
        data.messages.map((m) => {
          if (m.role !== 'assistant') return m
          const parsed = parseSources(m.content)
          return { ...m, content: parsed.text, sources: parsed.sources }
        }),
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
      if (activeId === id) {
        setActiveId(null)
        setMessages([])
        setStreaming(null)
      }
    } catch (err) {
      console.error('Failed to delete:', err)
    }
  }

  /** Demarre le renommage inline d'une conversation. */
  const handleStartRename = (e: React.MouseEvent, conv: Conv) => {
    e.stopPropagation()
    setRenamingId(conv.id)
    setRenameValue(conv.title)
  }

  /** Confirme le renommage. */
  const handleConfirmRename = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null)
      return
    }
    try {
      await api.assistantRenameConversation(renamingId, renameValue.trim())
      setConvs((cs) => cs.map((c) => (c.id === renamingId ? { ...c, title: renameValue.trim() } : c)))
    } catch (err) {
      console.error('Rename failed:', err)
    }
    setRenamingId(null)
  }

  /** Upload un ou plusieurs fichiers : extrait le texte cote serveur et l'ajoute aux attachments. */
  const handleFilesUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        try {
          const res = await api.assistantExtractFile(file)
          setAttachments((a) => [...a, { name: res.filename, text: res.text }])
        } catch (err: any) {
          alert(`Echec d'extraction pour ${file.name} : ${err.message || 'erreur inconnue'}`)
        }
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  /** Retire un fichier attache. */
  const handleRemoveAttachment = (index: number) => {
    setAttachments((a) => a.filter((_, i) => i !== index))
  }

  /** Envoie le message saisi et stream la reponse IA. */
  const handleSend = async () => {
    const text = input.trim()
    // On peut envoyer si on a soit du texte saisi, soit des fichiers attaches (ou les deux)
    if ((!text && attachments.length === 0) || streaming !== null) return

    // Concatene les fichiers attaches avant le prompt utilisateur
    let finalContent = ''
    if (attachments.length > 0) {
      finalContent = attachments
        .map((a) => `### Fichier : ${a.name}\n\n${a.text}`)
        .join('\n\n---\n\n')
      finalContent += '\n\n---\n\n'
    }
    finalContent += text || 'Analyse ce/ces document(s).'

    // Cree une conversation si aucune n'est active
    let convId = activeId
    if (!convId) {
      try {
        const conv = await api.assistantCreateConversation()
        setConvs((cs) => [conv, ...cs])
        setActiveId(conv.id)
        convId = conv.id
      } catch (err) {
        console.error('Failed to create conversation:', err)
        return
      }
    }

    // Pour l'affichage du message user : on cache le texte des fichiers (juste les noms)
    const userDisplayContent = attachments.length > 0
      ? `${attachments.map((a) => `📎 ${a.name}`).join(', ')}${text ? `\n\n${text}` : ''}`
      : text

    // Ajoute le message user dans l'UI immediatement
    const userMsg: Msg = { id: 'tmp-' + Date.now(), role: 'user', content: userDisplayContent }
    setMessages((ms) => [...ms, userMsg])
    setInput('')
    setAttachments([])
    setStreaming('')
    setStreamingSources(null)
    setStatusMsg(null)

    const wasWebSearch = webSearch
    // On laisse le toggle a l'etat actuel pour les messages suivants, l'user peut le couper s'il veut

    // Lance le stream SSE
    streamCtrl.current = api.assistantSendMessage(
      convId,
      finalContent,
      {
        onToken: (chunk) => setStreaming((s) => (s ?? '') + chunk),
        onSources: (sources) => setStreamingSources(sources),
        onStatus: (msg) => setStatusMsg(msg),
        onDone: (_full, savedMsg) => {
          if (savedMsg) {
            const parsed = parseSources(savedMsg.content)
            setMessages((ms) => [...ms, { ...savedMsg, content: parsed.text, sources: parsed.sources }])
          }
          setStreaming(null)
          setStreamingSources(null)
          setStatusMsg(null)
          streamCtrl.current = null
          refreshConversations()
        },
        onError: (err) => {
          setMessages((ms) => [
            ...ms,
            { id: 'err-' + Date.now(), role: 'assistant', content: `Erreur : ${err}` },
          ])
          setStreaming(null)
          setStreamingSources(null)
          setStatusMsg(null)
          streamCtrl.current = null
        },
      },
      { webSearch: wasWebSearch },
    )
  }

  /** Annule le stream en cours. */
  const handleStop = () => {
    streamCtrl.current?.abort()
    // Sauvegarde le texte partiel quand meme dans l'UI (pas en DB)
    if (streaming) {
      setMessages((ms) => [
        ...ms,
        { id: 'partial-' + Date.now(), role: 'assistant', content: streaming + ' [annule]' },
      ])
    }
    setStreaming(null)
    streamCtrl.current = null
  }

  /** Gere Enter (send) / Shift+Enter (newline) dans le textarea. */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <main className="h-[calc(100vh-64px)] flex">
      {/* ═══════════════ Sidebar : liste des conversations ═══════════════ */}
      <aside className="w-64 border-r border-border bg-card/30 flex flex-col">
        <div className="p-3 border-b border-border">
          <Button
            onClick={handleNewConv}
            variant="secondary"
            size="sm"
            className="w-full h-9 gap-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30"
          >
            <Plus className="w-4 h-4" />
            <span>Nouveau chat</span>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {convs.length === 0 ? (
            <p className="text-xs text-muted-foreground p-3 text-center">
              Aucune conversation. Cree-en une pour commencer.
            </p>
          ) : (
            convs.map((c) => (
              <div
                key={c.id}
                onClick={() => handleOpenConv(c.id)}
                className={`group flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors text-sm ${
                  activeId === c.id ? 'bg-primary/15 text-foreground' : 'hover:bg-secondary/50 text-foreground/80'
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

      {/* ═══════════════ Zone principale : chat ═══════════════ */}
      <section className="flex-1 flex flex-col bg-background">
        {/* Header outil */}
        <div className="px-6 py-3 border-b border-border flex items-center gap-2">
          <Bot className="w-5 h-5 text-primary" />
          <h1 className="text-sm font-bold text-foreground">Assistant</h1>
          <span className="text-[10px] text-muted-foreground">· mistral-nemo:12b</span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {messages.length === 0 && streaming === null ? (
            <div className="max-w-2xl mx-auto py-12 text-center">
              <Bot className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h2 className="text-xl font-bold text-foreground mb-2">Comment puis-je t'aider ?</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Colle un texte et demande-moi par exemple :<br />
                <em>"Sors-moi toutes les recettes de cuisine"</em>, <em>"Resume ce document"</em>, <em>"Liste les idees principales"</em>.
              </p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} role={m.role} content={m.content} sources={m.sources} />
              ))}
              {streaming !== null && (
                <MessageBubble
                  role="assistant"
                  content={streaming + (streaming ? '▌' : '')}
                  streaming
                  sources={streamingSources || undefined}
                  status={statusMsg || undefined}
                />
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Zone de saisie */}
        <div className="border-t border-border p-4 bg-card/30">
          <div className="max-w-3xl mx-auto">
            {/* Chips des fichiers attaches au prochain message */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {attachments.map((a, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 bg-sky-500/10 border border-sky-500/30 rounded-lg px-2 py-1 text-xs text-sky-300"
                  >
                    <FileText className="w-3 h-3" />
                    <span className="truncate max-w-[180px]">{a.name}</span>
                    <span className="text-[10px] opacity-60">{(a.text.length / 1000).toFixed(0)}k chars</span>
                    <button
                      onClick={() => handleRemoveAttachment(i)}
                      className="p-0.5 hover:bg-sky-500/20 rounded"
                      title="Retirer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 items-end">
              {/* Input file cache + bouton attache */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.docx,.pdf,.md"
                onChange={(e) => handleFilesUpload(e.target.files)}
                className="hidden"
              />
              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 shrink-0"
                disabled={streaming !== null || uploading}
                title="Joindre un fichier (.txt, .docx, .pdf, .md)"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
              </Button>

              {/* Toggle recherche web : quand actif, le prochain message va chercher sur les
                  sites de confiance (Wikipedia, officiels, academique) et l'IA cite ses sources */}
              <Button
                onClick={() => setWebSearch((w) => !w)}
                variant={webSearch ? 'default' : 'ghost'}
                size="sm"
                className={`h-9 gap-1.5 shrink-0 ${webSearch ? 'bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40' : ''}`}
                disabled={streaming !== null}
                title="Recherche web sur sites de confiance (Wikipedia, officiels, academique)"
              >
                <Globe className="w-4 h-4" />
                <span className="text-xs hidden sm:inline">Web</span>
              </Button>

              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={attachments.length > 0 ? "Que veux-tu faire avec ce(s) document(s) ? (laisse vide = analyse generale)" : "Pose ta question ou colle ton texte ici... (Shift+Entree pour saut de ligne)"}
                rows={Math.min(8, Math.max(1, input.split('\n').length))}
                disabled={streaming !== null}
                className="flex-1 resize-none bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary/50 disabled:opacity-60"
              />
              {streaming !== null ? (
                <Button onClick={handleStop} variant="secondary" size="sm" className="h-9 gap-2 bg-destructive/10 hover:bg-destructive/20 text-destructive">
                  <Square className="w-3.5 h-3.5" fill="currentColor" />
                  <span>Stop</span>
                </Button>
              ) : (
                <Button onClick={handleSend} size="sm" className="h-9 gap-2" disabled={!input.trim() && attachments.length === 0}>
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

/**
 * Bulle d'un message (user ou assistant) avec rendu Markdown + sources web.
 */
function MessageBubble({
  role, content, streaming, sources, status,
}: {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  sources?: Source[]
  status?: string
}) {
  const isUser = role === 'user'
  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isUser ? 'bg-primary text-primary-foreground' : 'bg-emerald-500/10 text-emerald-400'}`}>
        {isUser ? <UserIcon className="w-4 h-4" /> : streaming && !content ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
      </div>
      <div
        className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser ? 'bg-primary text-primary-foreground' : 'bg-card border border-border text-foreground'
        }`}
      >
        {/* Status pendant la recherche web ("Recherche sur les sites de confiance...") */}
        {status && (
          <div className="text-xs text-sky-300 italic mb-1.5 flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            {status}
          </div>
        )}

        {/* Sources web : affichees AU-DESSUS de la reponse (comme Perplexity) */}
        {!isUser && sources && sources.length > 0 && (
          <div className="mb-2 pb-2 border-b border-border/40">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
              <Globe className="w-3 h-3" />
              Sources
            </div>
            <div className="space-y-1">
              {sources.map((s, i) => (
                <a
                  key={i}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-1.5 text-xs text-sky-400 hover:text-sky-300 hover:underline group"
                  title={s.url}
                >
                  <span className="font-mono opacity-60 shrink-0">[{i + 1}]</span>
                  <span className="line-clamp-2">{s.title || s.url}</span>
                  <ExternalLink className="w-3 h-3 opacity-50 group-hover:opacity-100 shrink-0 mt-0.5" />
                </a>
              ))}
            </div>
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
