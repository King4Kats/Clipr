/**
 * =============================================================================
 * Fichier : AtlasView.tsx
 * Rôle    : Vue carte de l'atlas dialectal moderne.
 *
 *           Affiche sur carte de France :
 *           - Les 639 points ALF historiques (markers gris)
 *           - Les points ou nous avons collecte des attestations modernes
 *             (markers verts, taille proportionnelle au nombre d'attestations)
 *
 *           Au clic sur un point :
 *           - Liste des attestations modernes collectees a ce point
 *           - Liste des attestations historiques ALF (1900) au meme point
 *           - Comparaison cote a cote en double notation IPA + ALF
 *
 *           Filtre par concept (carte ALF) : voir un mot specifique.
 * =============================================================================
 */

import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Globe2, MapPin, Search, Loader2, X } from 'lucide-react'
import api from '@/api'
import type { AlfPoint, AlfAttestation, AlfCarte } from '@/types'

// Reutilise la config d'icones du selecteur de point
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
})

// Markers : gris pour ALF historique seul, vert progressif selon volume moderne
const makeMarker = (modernCount: number, isSelected: boolean) => {
  const size = isSelected ? 16 : Math.min(8 + modernCount * 2, 18)
  const color = modernCount === 0
    ? 'rgba(99, 102, 241, 0.5)'
    : modernCount < 3
      ? 'rgba(16, 185, 129, 0.7)'
      : '#10b981'
  const border = isSelected ? '3px solid white' : '1px solid rgba(255,255,255,0.6)'
  return new L.DivIcon({
    className: 'atlas-marker',
    html: `<div style="
      width: ${size}px; height: ${size}px;
      background: ${color}; border: ${border};
      border-radius: 50%;
      box-shadow: ${isSelected ? '0 2px 6px rgba(0,0,0,0.4)' : 'none'};
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  })
}

interface ModernAttestation {
  id: number
  linguistic_id: string
  point_alf_id: number | null
  speaker: string
  french_text: string
  ipa: string
  rousselot: string
  carte_alf_id: number | null
  created_at: string
}

const AtlasView = () => {
  // ── État global ──
  const [stats, setStats] = useState<{ total: number; pointsCount: number; conceptsCount: number; recordings: number } | null>(null)
  const [allPoints, setAllPoints] = useState<AlfPoint[]>([])
  const [modernAtts, setModernAtts] = useState<ModernAttestation[]>([])
  const [loading, setLoading] = useState(true)

  // Selection
  const [selectedPointId, setSelectedPointId] = useState<number | null>(null)
  const [historicalAtts, setHistoricalAtts] = useState<AlfAttestation[]>([])
  const [pointModernAtts, setPointModernAtts] = useState<ModernAttestation[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  // Filtre concept
  const [concept, setConcept] = useState<AlfCarte | null>(null)
  const [conceptSearch, setConceptSearch] = useState('')
  const [conceptSuggestions, setConceptSuggestions] = useState<AlfCarte[]>([])

  // ── Chargement initial : stats + points + attestations modernes ──
  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.getAtlasStats(),
      api.getAlfPoints(),
      api.getAtlasAttestations({ limit: 5000 })
    ]).then(([s, pts, atts]) => {
      if (cancelled) return
      setStats(s)
      setAllPoints((pts.points || []).filter((p: AlfPoint) => p.lat !== null && p.lng !== null))
      setModernAtts(atts.attestations || [])
      setLoading(false)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // ── Comptage des attestations modernes par point ──
  const modernCountByPoint = useMemo(() => {
    const m = new Map<number, number>()
    for (const a of modernAtts) {
      if (a.point_alf_id !== null) m.set(a.point_alf_id, (m.get(a.point_alf_id) || 0) + 1)
    }
    return m
  }, [modernAtts])

  // ── Recherche concept (autocomplete) ──
  useEffect(() => {
    if (!conceptSearch.trim()) { setConceptSuggestions([]); return }
    let cancelled = false
    const t = setTimeout(() => {
      api.searchAlfCartes(conceptSearch).then(res => {
        if (!cancelled) setConceptSuggestions(res.cartes || [])
      })
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [conceptSearch])

  // ── Selection d'un point : charge les attestations historiques + modernes locales ──
  useEffect(() => {
    if (selectedPointId === null) {
      setHistoricalAtts([])
      setPointModernAtts([])
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    // Pour les attestations historiques, on doit choisir une carte (sinon trop de donnees).
    // Si un concept est selectionne, on filtre par carte. Sinon on n'affiche rien d'historique
    // tant qu'aucun concept n'est choisi.
    const histPromise = concept
      ? api.getAlfAttestations(concept.id).then(r => (r.attestations || []).filter(a => a.point.id === selectedPointId))
      : Promise.resolve([])
    const modernPromise = api.getAtlasAttestations({ pointId: selectedPointId, limit: 200 }).then(r => r.attestations || [])
    Promise.all([histPromise, modernPromise]).then(([h, m]) => {
      if (cancelled) return
      setHistoricalAtts(h)
      setPointModernAtts(m)
      setLoadingDetail(false)
    })
    return () => { cancelled = true }
  }, [selectedPointId, concept])

  // ── Filtre des points affiches sur la carte ──
  // Si un concept est selectionne, on ne montre que les points ou il y a une attestation
  // (historique OU moderne) de ce concept. Sinon, tous les points.
  const [conceptPointIds, setConceptPointIds] = useState<Set<number> | null>(null)
  useEffect(() => {
    if (!concept) { setConceptPointIds(null); return }
    let cancelled = false
    api.getAlfAttestations(concept.id).then(res => {
      if (cancelled) return
      const ids = new Set<number>((res.attestations || []).map(a => a.point.id))
      setConceptPointIds(ids)
    })
    return () => { cancelled = true }
  }, [concept])

  const visiblePoints = useMemo(() => {
    if (!conceptPointIds) return allPoints
    return allPoints.filter(p => conceptPointIds.has(p.id) || (modernCountByPoint.get(p.id) ?? 0) > 0)
  }, [allPoints, conceptPointIds, modernCountByPoint])

  // ── Render ──
  const selectedPoint = useMemo(
    () => allPoints.find(p => p.id === selectedPointId) || null,
    [selectedPointId, allPoints]
  )

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
          <Globe2 className="w-5 h-5 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-foreground">Atlas dialectal moderne</h1>
          <p className="text-xs text-muted-foreground">
            Comparaison des attestations modernes collectees vs ALF historique (1900)
          </p>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground">Attestations</p>
            <p className="text-2xl font-bold text-foreground">{stats.total}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground">Points couverts</p>
            <p className="text-2xl font-bold text-foreground">{stats.pointsCount} / 639</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground">Concepts ALF</p>
            <p className="text-2xl font-bold text-foreground">{stats.conceptsCount}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground">Enregistrements</p>
            <p className="text-2xl font-bold text-foreground">{stats.recordings}</p>
          </div>
        </div>
      )}

      {/* Filtre concept */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4 relative">
        <label className="text-[10px] font-bold uppercase text-muted-foreground mb-1 block">
          Concept ALF (filtre les points et l'affichage)
        </label>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={conceptSearch}
            onChange={(e) => setConceptSearch(e.target.value)}
            placeholder={concept ? `${concept.titre} (carte ${concept.num_alf})` : "Chercher un mot (ex: vache)..."}
            className="w-full bg-secondary border border-border rounded-lg pl-8 pr-8 py-2 text-xs text-foreground placeholder:text-muted-foreground"
          />
          {(concept || conceptSearch) && (
            <button onClick={() => { setConcept(null); setConceptSearch(''); setConceptSuggestions([]) }}
              className="absolute right-2 top-2 p-0.5 rounded hover:bg-border">
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
        {conceptSuggestions.length > 0 && (
          <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {conceptSuggestions.map(c => (
              <button
                key={c.id}
                onMouseDown={(e) => {
                  e.preventDefault()
                  setConcept(c); setConceptSearch(''); setConceptSuggestions([])
                }}
                className="w-full px-3 py-2 text-left hover:bg-secondary text-xs flex justify-between items-center border-b border-border/50 last:border-b-0"
              >
                <span className="font-medium text-foreground">{c.titre}</span>
                <span className="text-[10px] font-mono text-emerald-400">carte {c.num_alf}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Layout : carte + panneau detail */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Carte */}
        <div className="lg:col-span-2 relative w-full h-[500px] rounded-xl overflow-hidden border border-border">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
            </div>
          ) : (
            <MapContainer center={[46.5, 2.5]} zoom={5} style={{ height: '100%', width: '100%' }} scrollWheelZoom={true}>
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {visiblePoints.map(p => {
                const modernCount = modernCountByPoint.get(p.id) || 0
                return (
                  <Marker
                    key={p.id}
                    position={[p.lat as number, p.lng as number]}
                    icon={makeMarker(modernCount, p.id === selectedPointId)}
                    eventHandlers={{ click: () => setSelectedPointId(p.id) }}
                  >
                    <Popup>
                      <div className="text-xs">
                        <p className="font-bold">Point ALF #{p.num_alf}</p>
                        <p>{p.commune}</p>
                        <p className="text-[10px] opacity-70">{p.dept_nom} — {p.dialecte || p.langue}</p>
                        {modernCount > 0 && (
                          <p className="text-[10px] text-emerald-600 font-medium mt-1">
                            {modernCount} attestation{modernCount > 1 ? 's' : ''} moderne{modernCount > 1 ? 's' : ''}
                          </p>
                        )}
                      </div>
                    </Popup>
                  </Marker>
                )
              })}
            </MapContainer>
          )}
        </div>

        {/* Panneau detail */}
        <div className="bg-card border border-border rounded-xl p-4 max-h-[500px] overflow-y-auto">
          {!selectedPoint ? (
            <div className="text-center text-xs text-muted-foreground py-8">
              <MapPin className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>Cliquer sur un point pour voir les attestations</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Header point */}
              <div className="pb-3 border-b border-border">
                <p className="text-xs font-bold text-emerald-400">Point ALF #{selectedPoint.num_alf}</p>
                <p className="text-sm font-medium text-foreground">{selectedPoint.commune}</p>
                <p className="text-[10px] text-muted-foreground">
                  {selectedPoint.dept_nom} ({selectedPoint.dept_code})
                  {selectedPoint.dialecte && ` · ${selectedPoint.dialecte}`}
                </p>
              </div>

              {loadingDetail && (
                <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
              )}

              {/* Attestations modernes */}
              <div>
                <h3 className="text-[10px] font-bold uppercase text-emerald-400 mb-2">
                  Attestations modernes ({pointModernAtts.length})
                </h3>
                {pointModernAtts.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">Aucune attestation moderne a ce point</p>
                ) : (
                  <div className="space-y-2">
                    {pointModernAtts.map(a => (
                      <div key={a.id} className="bg-secondary/40 rounded-lg p-2 text-xs">
                        <p className="font-medium text-foreground">{a.speaker}</p>
                        {a.french_text && <p className="text-[10px] text-muted-foreground italic mb-1">« {a.french_text} »</p>}
                        <p className="font-mono text-foreground">{a.rousselot || '(pas d\'ALF)'}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">/{a.ipa || ''}/</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Attestations historiques (si concept selectionne) */}
              {concept && (
                <div>
                  <h3 className="text-[10px] font-bold uppercase text-muted-foreground mb-2">
                    ALF historique 1900 — « {concept.titre} »
                  </h3>
                  {historicalAtts.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground italic">Pas d'attestation ALF a ce point pour ce concept</p>
                  ) : (
                    <div className="space-y-2">
                      {historicalAtts.map(a => (
                        <div key={a.realisation_id} className="bg-indigo-500/10 rounded-lg p-2 text-xs">
                          {a.phrase_fr && <p className="text-[10px] text-muted-foreground italic mb-1">« {a.phrase_fr} »</p>}
                          <p className="font-mono text-foreground">/{a.ipa}/</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!concept && (
                <p className="text-[10px] text-muted-foreground italic">
                  Selectionner un concept ALF en haut pour voir les attestations historiques 1900 a ce point.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default AtlasView
