/**
 * ASSISTANTPAGE.TSX : Page de l'outil Assistant (chat IA standalone).
 *
 * Wrapper simple qui rend AssistantTool. Route : /assistant
 */

import AssistantTool from '@/components/new/AssistantTool'

export default function AssistantPage() {
  return <AssistantTool />
}
