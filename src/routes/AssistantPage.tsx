/**
 * ASSISTANTPAGE.TSX : Page de l'outil Assistant.
 *
 * L'Assistant est divise en deux SOUS-OUTILS, accessibles par des onglets :
 *   - "Chat"            : chat IA texte classique (AssistantTool, modele mistral-nemo)
 *   - "Lecture d'image" : chat avec vision / OCR manuscrit (VisionTool, modele qwen2.5vl)
 *
 * La page gere la hauteur (sous le Header sticky) ; chaque sous-outil occupe
 * tout l'espace restant (h-full).
 *
 * Route : /assistant
 */

import { useState } from 'react'
import { Bot, ScanText } from 'lucide-react'
import AssistantTool from '@/components/new/AssistantTool'
import VisionTool from '@/components/new/VisionTool'

type SubTool = 'chat' | 'vision'

export default function AssistantPage() {
  const [tab, setTab] = useState<SubTool>('chat')

  return (
    // 100vh moins la hauteur du Header (h-14 = 3.5rem)
    <div className="h-[calc(100vh-3.5rem)] flex flex-col">
      {/* Barre d'onglets des sous-outils */}
      <div className="flex items-center gap-1 px-4 border-b border-border bg-card/50 shrink-0">
        <TabButton active={tab === 'chat'} onClick={() => setTab('chat')} icon={<Bot className="w-4 h-4" />} label="Chat" color="primary" />
        <TabButton active={tab === 'vision'} onClick={() => setTab('vision')} icon={<ScanText className="w-4 h-4" />} label="Lecture d'image" color="violet" />
      </div>

      {/* Sous-outil actif. On garde les deux montes ? Non : un seul a la fois
          pour ne pas lancer deux streams en parallele. */}
      <div className="flex-1 min-h-0">
        {tab === 'chat' ? <AssistantTool /> : <VisionTool />}
      </div>
    </div>
  )
}

/** Un onglet de sous-outil (style soulignement quand actif). */
function TabButton({
  active, onClick, icon, label, color,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  color: 'primary' | 'violet'
}) {
  const activeColor = color === 'violet' ? 'text-violet-400 border-violet-400' : 'text-primary border-primary'
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active ? activeColor : 'text-muted-foreground border-transparent hover:text-foreground'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
