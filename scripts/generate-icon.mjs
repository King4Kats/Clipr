/**
 * Génère un fichier .ico avec le logo Clipr dans une bulle blanche arrondie.
 * Usage: node scripts/generate-icon.mjs
 */
import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const svgPath = join(__dirname, '..', 'src', 'assets', 'Clipr.svg')
const icoPath = join(__dirname, '..', 'src', 'assets', 'Clipr.ico')

// Tailles standard pour un .ico Windows
const sizes = [16, 32, 48, 256]

async function svgToPngs(svgPath, sizes) {
  const svgBuffer = readFileSync(svgPath)
  const pngs = []

  for (const size of sizes) {
    // Render at 4x then downscale for better anti-aliasing
    const renderSize = Math.min(size * 4, 1024)
    const padding = Math.round(renderSize * 0.14)
    const logoSize = renderSize - padding * 2
    const cornerRadius = Math.round(renderSize * 0.22)

    // 1. Dark teal rounded rectangle bubble (matches dark theme)
    const bubbleSvg = Buffer.from(
      `<svg width="${renderSize}" height="${renderSize}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${renderSize}" height="${renderSize}" rx="${cornerRadius}" ry="${cornerRadius}" fill="#152d32"/>
      </svg>`
    )
    const bubble = await sharp(bubbleSvg)
      .resize(renderSize, renderSize)
      .png()
      .toBuffer()

    // 2. Render full Clipr logo (fit inside logoSize)
    const logo = await sharp(svgBuffer, { density: 300 })
      .resize(logoSize, logoSize, { fit: 'inside' })
      .png()
      .toBuffer()

    // 3. Composite logo centered on the bubble (at full renderSize)
    const fullSize = await sharp(bubble)
      .composite([{ input: logo, gravity: 'centre' }])
      .png()
      .toBuffer()

    // 4. Downscale to target icon size
    const combined = await sharp(fullSize)
      .resize(size, size, { kernel: 'lanczos3' })
      .png()
      .toBuffer()

    pngs.push({ size, data: combined })
  }
  return pngs
}

function createIco(pngs) {
  // ICO header: 6 bytes
  const headerSize = 6
  const entrySize = 16
  const numImages = pngs.length
  const dataOffset = headerSize + entrySize * numImages

  // Calculate total size
  let totalDataSize = 0
  for (const png of pngs) {
    totalDataSize += png.data.length
  }

  const buffer = Buffer.alloc(dataOffset + totalDataSize)

  // ICO header
  buffer.writeUInt16LE(0, 0)          // Reserved
  buffer.writeUInt16LE(1, 2)          // Type: 1 = ICO
  buffer.writeUInt16LE(numImages, 4)  // Number of images

  // Write directory entries and image data
  let currentDataOffset = dataOffset
  for (let i = 0; i < pngs.length; i++) {
    const png = pngs[i]
    const entryOffset = headerSize + i * entrySize

    // ICO directory entry
    buffer.writeUInt8(png.size >= 256 ? 0 : png.size, entryOffset)      // Width (0 = 256)
    buffer.writeUInt8(png.size >= 256 ? 0 : png.size, entryOffset + 1)  // Height (0 = 256)
    buffer.writeUInt8(0, entryOffset + 2)                                 // Color count
    buffer.writeUInt8(0, entryOffset + 3)                                 // Reserved
    buffer.writeUInt16LE(1, entryOffset + 4)                              // Color planes
    buffer.writeUInt16LE(32, entryOffset + 6)                             // Bits per pixel
    buffer.writeUInt32LE(png.data.length, entryOffset + 8)               // Image data size
    buffer.writeUInt32LE(currentDataOffset, entryOffset + 12)            // Image data offset

    // Copy PNG data
    png.data.copy(buffer, currentDataOffset)
    currentDataOffset += png.data.length
  }

  return buffer
}

async function main() {
  console.log('Generating .ico with dark rounded bubble...')
  const pngs = await svgToPngs(svgPath, sizes)
  console.log(`  Rendered ${pngs.length} sizes: ${sizes.join(', ')}px`)

  const ico = createIco(pngs)
  writeFileSync(icoPath, ico)
  console.log(`  Written to ${icoPath} (${(ico.length / 1024).toFixed(1)} KB)`)
  console.log('Done!')
}

main().catch(console.error)
