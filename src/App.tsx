/**
 * APP.TSX : Definition des routes de l'application
 *
 * Utilise React Router v6 pour le routing client-side.
 * Chaque page/outil a son propre chemin URL.
 */

import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/useAuthStore'

import AuthGuard from '@/routes/AuthGuard'
import AppLayout from '@/routes/AppLayout'
import LoginPage from '@/routes/LoginPage'
import HomePage from '@/routes/HomePage'
import ProjectPage from '@/routes/ProjectPage'
import SegmentationNewPage from '@/routes/SegmentationNewPage'
import TranscriptionPage from '@/routes/TranscriptionPage'
import LinguisticPage from '@/routes/LinguisticPage'
import AtlasPage from '@/routes/AtlasPage'
import AdminPage from '@/routes/AdminPage'

function App() {
  const { checkAuth } = useAuthStore()

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthGuard />}>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="transcription" element={<TranscriptionPage />} />
          <Route path="transcription/:projectId" element={<TranscriptionPage />} />
          <Route path="linguistic" element={<LinguisticPage />} />
          <Route path="linguistic/:projectId" element={<LinguisticPage />} />
          <Route path="atlas" element={<AtlasPage />} />
          <Route path="segmentation/new" element={<SegmentationNewPage />} />
          <Route path="project/:projectId" element={<ProjectPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}

export default App
