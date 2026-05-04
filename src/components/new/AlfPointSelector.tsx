/**
 * =============================================================================
 * Fichier : AlfPointSelector.tsx
 * Rôle    : Composant de sélection d'un point d'enquête ALF.
 *
 *           Affiche :
 *           - Un champ recherche commune avec autocomplete
 *           - Une carte Leaflet avec les 639 points ALF cliquables
 *           - Le point sélectionné en surbrillance + détails
 *
 *           Utilisé dans LinguisticTool, en config avant l'analyse,
 *           pour permettre à l'utilisateur d'indiquer la zone géographique
 *           de l'enregistrement (commune actuelle ou point ALF historique).
 *
 *           La base ALF doit être disponible (`alf.db` scrape SYMILA fait).
 *           Si elle ne l'est pas, le composant affiche un message d'erreur
 *           et propose un fallback (saisie libre du nom de commune).
 * =============================================================================
 */

import { useEffect, useState, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPin, Search, X } from 'lucide-react'
import api from '@/api'
import type { AlfPoint } from '@/types'

// Fix : les icônes par défaut de Leaflet ne sont pas correctement chargées via Vite.
// On configure manuellement les URLs des images d'icône (CDN unpkg).
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
})

// Icône customisée pour le point sélectionné (vert vif)
const selectedIcon = new L.DivIcon({
  className: 'alf-selected-marker',
  html: `<div style="
    width: 18px; height: 18px;
    background: #10b981; border: 3px solid white;
    border-radius: 50%; box-shadow: 0 2px 6px rgba(0,0,0,0.4);
  "></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9]
})

const defaultIcon = new L.DivIcon({
  className: 'alf-default-marker',
  html: `<div style="
    width: 8px; height: 8px;
    background: rgba(99, 102, 241, 0.7); border: 1px solid rgba(255,255,255,0.6);
    border-radius: 50%;
  "></div>`,
  iconSize: [8, 8],
  iconAnchor: [4, 4]
})

interface AlfPointSelectorProps {
  selectedPointId: number | null
  onSelect: (point: AlfPoint | null) => void
}

/**
 * Sous-composant : recentre la carte sur le point sélectionné quand il change.
 * Doit être placé à l'intérieur de <MapContainer> pour avoir accès à useMap().
 */
function FlyToPoint({ point }: { point: AlfPoint | null }) {
  const map = useMap()
  useEffect(() => {
    if (point && point.lat !== null && point.lng !== null) {
      map.flyTo([point.lat, point.lng], 9, { duration: 1.2 })
    }
  }, [point, map])
  return null
}

const AlfPointSelector = ({ selectedPointId, onSelect }: AlfPointSelectorProps) => {
  const [allPoints, setAllPoints] = useState<AlfPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)

  // ── Chargement initial des 639 points ──
  useEffect(() => {
    let cancelled = false
    api.getAlfPoints().then((res: any) => {
      if (cancelled) return
      if (!res.available) {
        setError("Base ALF indisponible. Lance scripts/alf-scrape.py pour la générer.")
      } else {
        // Filtre les points sans coordonnées valides (anomalies de scrape)
        const valid = res.points.filter((p: AlfPoint) => p.lat !== null && p.lng !== null)
        setAllPoints(valid)
      }
      setLoading(false)
    }).catch((e: Error) => {
      if (cancelled) return
      setError(`Erreur de chargement : ${e.message}`)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // ── Recherche locale (filter sur le tableau déjà chargé) ──
  // Plus rapide qu'un appel réseau, et 639 points = filtrage instantané.
  const suggestions = useMemo(() => {
    if (!search.trim()) return []
    const q = search.toLowerCase()
    return allPoints
      .filter(p =>
        p.commune?.toLowerCase().includes(q) ||
        p.dept_nom?.toLowerCase().includes(q)
      )
      .slice(0, 10)
  }, [search, allPoints])

  const selectedPoint = useMemo(
    () => allPoints.find(p => p.id === selectedPointId) || null,
    [selectedPointId, allPoints]
  )

  // ── Render ──
  if (loading) {
    return (
      <div className="p-4 bg-card border border-border rounded-xl text-center">
        <p className="text-xs text-muted-foreground">Chargement de la base ALF...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-700 dark:text-amber-400">
        <p className="font-medium mb-1">Base ALF non disponible</p>
        <p className="text-[11px] opacity-80">{error}</p>
        <p className="text-[11px] mt-2 opacity-80">L'analyse fonctionnera sans le contexte ALF.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Champ recherche commune avec autocomplete */}
      <div className="relative">
        <label className="text-[10px] font-bold uppercase text-muted-foreground mb-1 block">
          Point d'enquete ALF (commune ou departement)
        </label>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowSuggestions(true) }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            placeholder={selectedPoint ? `${selectedPoint.commune} (${selectedPoint.dept_nom})` : "Rechercher une commune..."}
            className="w-full bg-secondary border border-border rounded-lg pl-8 pr-8 py-2 text-xs text-foreground placeholder:text-muted-foreground"
          />
          {(search || selectedPoint) && (
            <button
              onClick={() => { setSearch(''); onSelect(null) }}
              className="absolute right-2 top-2 p-0.5 rounded hover:bg-border"
              title="Effacer"
            >
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* Liste de suggestions */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
            {suggestions.map(p => (
              <button
                key={p.id}
                onMouseDown={(e) => {
                  e.preventDefault() // empeche le blur de fermer la liste avant le click
                  onSelect(p)
                  setSearch('')
                  setShowSuggestions(false)
                }}
                className="w-full px-3 py-2 text-left hover:bg-secondary text-xs flex justify-between items-center border-b border-border/50 last:border-b-0"
              >
                <div>
                  <p className="font-medium text-foreground">{p.commune}</p>
                  <p className="text-[10px] text-muted-foreground">{p.dept_nom} ({p.dept_code}) — {p.dialecte || p.langue}</p>
                </div>
                <span className="text-[10px] font-mono text-emerald-400">#{p.num_alf}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Carte Leaflet */}
      <div className="relative w-full h-64 rounded-lg overflow-hidden border border-border">
        <MapContainer
          center={[46.5, 2.5]}     // centre approximatif France
          zoom={5}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom={true}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FlyToPoint point={selectedPoint} />
          {allPoints.map(p => (
            <Marker
              key={p.id}
              position={[p.lat as number, p.lng as number]}
              icon={p.id === selectedPointId ? selectedIcon : defaultIcon}
              eventHandlers={{ click: () => onSelect(p) }}
            >
              <Popup>
                <div className="text-xs">
                  <p className="font-bold">Point ALF #{p.num_alf}</p>
                  <p>{p.commune}</p>
                  <p className="text-[10px] opacity-70">{p.dept_nom} — {p.dialecte || p.langue}</p>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* Détails du point sélectionné */}
      {selectedPoint && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg flex items-start gap-2">
          <MapPin className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0 text-xs">
            <p className="font-bold text-foreground">
              Point ALF #{selectedPoint.num_alf} — {selectedPoint.commune}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {selectedPoint.dept_nom} ({selectedPoint.dept_code})
              {selectedPoint.dialecte && ` · ${selectedPoint.dialecte}`}
              {selectedPoint.langue && ` · ${selectedPoint.langue}`}
            </p>
            {selectedPoint.ipa_local && (
              <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                Prononciation locale : /{selectedPoint.ipa_local}/
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default AlfPointSelector
