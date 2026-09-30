/**
 * EXPORT-IMAGE.TS : Export du nuage de mots en fichier image PNG
 *
 * Le nuage de mots est dessine en SVG dans la page. Pour le sortir en image,
 * on ne peut pas simplement "photographier" l'ecran : il faut recreer le dessin
 * dans un canvas, puis demander au navigateur d'en faire un PNG.
 *
 * Deux precautions indispensables, sinon l'image sort vide ou moche :
 *
 *  1. Le SVG affiche a l'ecran n'a pas de largeur/hauteur fixes (il s'adapte a
 *     son conteneur via du CSS). Une fois sorti de la page, ce CSS n'existe
 *     plus : on doit donc inscrire des dimensions explicites sur la copie.
 *
 *  2. Les polices de caracteres viennent aussi de la feuille de style. On les
 *     recopie directement sur chaque mot, sinon le PNG s'affiche dans la police
 *     par defaut du navigateur (Times New Roman), ce qui ne ressemble plus du
 *     tout a ce que l'utilisateur voit a l'ecran.
 *
 * Le rendu est fait en 3x la taille affichee : le fichier reste utilisable dans
 * un document imprime ou une presentation sans etre pixelise.
 */

/** Options de l'export PNG. */
export interface WordCloudPngOptions {
  /** Nom du fichier propose au telechargement (sans extension) */
  filename?: string
  /** Fond de l'image : blanc (pour un document) ou transparent (pour un montage) */
  background?: 'white' | 'transparent'
  /** Facteur de resolution : 3 = trois fois la taille affichee a l'ecran */
  scale?: number
}

/**
 * Convertit le SVG du nuage de mots en PNG et declenche son telechargement.
 *
 * @param svgEl - L'element SVG affiche dans la page
 * @param options - Nom de fichier, fond et resolution
 */
export async function exportWordCloudPNG(
  svgEl: SVGElement,
  options: WordCloudPngOptions = {}
): Promise<void> {
  const {
    filename = 'nuage-de-mots',
    background = 'white',
    scale = 3,
  } = options

  // Taille reellement occupee par le nuage a l'ecran
  const rect = svgEl.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))

  // On travaille sur une copie : le nuage affiche n'est jamais modifie
  const clone = svgEl.cloneNode(true) as SVGElement
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  // Recopie de la police sur la copie (voir precaution n°2 en tete de fichier)
  const computed = window.getComputedStyle(svgEl)
  const fontFamily = computed.fontFamily || 'sans-serif'
  clone.querySelectorAll('text').forEach(node => {
    const source = node as SVGTextElement
    const style = window.getComputedStyle(source)
    source.setAttribute('font-family', fontFamily)
    // Le gras des mots les plus frequents est defini en CSS : on le fige aussi
    if (style.fontWeight) source.setAttribute('font-weight', style.fontWeight)
    // Les mots survoles sont partiellement transparents : on remet tout opaque
    source.setAttribute('opacity', '1')
  })

  const svgData = new XMLSerializer().serializeToString(clone)
  const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  try {
    const img = await loadImage(url)

    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error("Le navigateur n'a pas pu preparer l'image")

    if (background === 'white') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    // toBlob produit un vrai fichier (plus econome en memoire que toDataURL,
    // qui encoderait l'image entiere en texte)
    const pngBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!pngBlob) throw new Error("La conversion en PNG a echoue")

    triggerDownload(pngBlob, `${sanitize(filename)}.png`)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Charge une image et attend qu'elle soit prete (ou echoue). */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Le nuage n'a pas pu etre converti en image"))
    img.src = url
  })
}

/** Cree un lien temporaire pour telecharger le fichier produit. */
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Le navigateur a besoin d'un instant pour lire le lien avant qu'on le libere
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Nettoie un nom de fichier (accents et caracteres interdits sous Windows). */
function sanitize(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim().replace(/\s+/g, '-')
    .substring(0, 60) || 'nuage-de-mots'
}
