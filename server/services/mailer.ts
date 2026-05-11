/**
 * MAILER.TSX — Envoi d'emails via SMTP (nodemailer).
 *
 * Configuration via variables d'environnement :
 *   SMTP_HOST, SMTP_PORT (defaut 465), SMTP_SECURE (defaut true pour port 465),
 *   SMTP_USER, SMTP_PASS, SMTP_FROM (expediteur),
 *   ADMIN_EMAIL (destinataire des notifications), PUBLIC_URL (base URL pour les liens).
 *
 * Si SMTP_HOST n'est pas defini, les fonctions journalisent un avertissement
 * et ne plantent pas — l'admin pourra toujours valider depuis le dashboard.
 */

import nodemailer, { Transporter } from 'nodemailer'
import { logger } from '../logger.js'

let transporter: Transporter | null = null
let transporterTried = false

function getTransporter(): Transporter | null {
  if (transporterTried) return transporter
  transporterTried = true

  const host = process.env.SMTP_HOST
  if (!host) {
    logger.warn('SMTP non configure (SMTP_HOST manquant) — les emails ne seront pas envoyes')
    return null
  }

  const port = parseInt(process.env.SMTP_PORT || '465')
  // Port 465 = SMTPS (TLS implicite) ; 587 = STARTTLS
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  })
  logger.info(`Mailer configure: ${host}:${port} (secure=${secure})`)
  return transporter
}

export function isMailerConfigured(): boolean {
  return !!process.env.SMTP_HOST
}

interface SendArgs {
  to: string
  subject: string
  text: string
  html?: string
}

export async function sendMail(args: SendArgs): Promise<boolean> {
  const t = getTransporter()
  if (!t) return false
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@localhost'
  try {
    await t.sendMail({ from, to: args.to, subject: args.subject, text: args.text, html: args.html })
    logger.info(`Mail envoye a ${args.to}: ${args.subject}`)
    return true
  } catch (err: any) {
    logger.error(`Echec envoi mail a ${args.to}: ${err.message}`)
    return false
  }
}

/**
 * Construit l'URL absolue d'un endpoint à partir de PUBLIC_URL.
 * Tombe sur le path relatif si PUBLIC_URL n'est pas défini (mail moins utile mais pas cassé).
 */
export function publicUrl(path: string): string {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '')
  if (!base) return path
  return `${base}${path.startsWith('/') ? path : '/' + path}`
}

/**
 * Envoie a l'admin une notification d'inscription en attente avec liens
 * d'approbation et de rejet (auto-authentifies via approval_token).
 */
export async function notifyAdminPendingSignup(args: {
  username: string
  email: string
  approvalToken: string
}): Promise<boolean> {
  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) {
    logger.warn('ADMIN_EMAIL non defini — pas de notification admin')
    return false
  }
  const approveUrl = publicUrl(`/api/auth/approve/${args.approvalToken}`)
  const rejectUrl = publicUrl(`/api/auth/reject/${args.approvalToken}`)

  const text = [
    `Nouvelle inscription Clipr en attente de validation :`,
    ``,
    `  Utilisateur : ${args.username}`,
    `  Email       : ${args.email}`,
    ``,
    `Approuver : ${approveUrl}`,
    `Rejeter   : ${rejectUrl}`,
    ``,
    `Tu peux aussi gerer les demandes depuis l'onglet "Utilisateurs" du dashboard admin.`,
  ].join('\n')

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:20px;border:1px solid #ddd;border-radius:8px">
      <h2 style="margin-top:0">Nouvelle inscription Clipr</h2>
      <p>Un utilisateur demande la creation d'un compte :</p>
      <table style="font-size:14px;margin:12px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Utilisateur</td><td><strong>${escapeHtml(args.username)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Email</td><td>${escapeHtml(args.email)}</td></tr>
      </table>
      <p style="margin-top:20px">
        <a href="${approveUrl}" style="display:inline-block;padding:10px 16px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;margin-right:8px">Approuver</a>
        <a href="${rejectUrl}" style="display:inline-block;padding:10px 16px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px">Rejeter</a>
      </p>
      <p style="font-size:12px;color:#888;margin-top:24px">Tu peux aussi gerer les demandes depuis le dashboard admin.</p>
    </div>
  `

  return sendMail({ to: adminEmail, subject: `[Clipr] Inscription en attente : ${args.username}`, text, html })
}

/** Notifie l'utilisateur que son compte est valide (ou refuse). */
export async function notifyUserDecision(args: {
  to: string
  username: string
  approved: boolean
}): Promise<boolean> {
  const loginUrl = publicUrl('/login')
  if (args.approved) {
    return sendMail({
      to: args.to,
      subject: '[Clipr] Ton compte est active',
      text: `Bonjour ${args.username},\n\nTon compte Clipr vient d'etre approuve. Tu peux maintenant te connecter :\n${loginUrl}\n`,
      html: `<p>Bonjour <strong>${escapeHtml(args.username)}</strong>,</p><p>Ton compte Clipr vient d'etre approuve.</p><p><a href="${loginUrl}">Se connecter</a></p>`,
    })
  }
  return sendMail({
    to: args.to,
    subject: '[Clipr] Inscription refusee',
    text: `Bonjour ${args.username},\n\nTa demande d'inscription a Clipr a ete refusee. Contacte l'administrateur si tu penses qu'il s'agit d'une erreur.\n`,
    html: `<p>Bonjour <strong>${escapeHtml(args.username)}</strong>,</p><p>Ta demande d'inscription a Clipr a ete refusee.</p>`,
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
