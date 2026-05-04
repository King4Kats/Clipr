"""
=============================================================================
Fichier : alf-scrape.py
Rôle    : Aspiration de la base SYMILA (Atlas Linguistique de la France)
          vers une base SQLite locale `data/alf.db`.

          SYMILA (Toulouse) propose une version informatisée de l'ALF de
          Gilliéron 1902, avec transposition phonétique Rousselot → IPA.
          Source : http://symila.univ-tlse2.fr/alf

          Ce script récupère :
          - 639 points d'enquête (commune, dept, coords lat/lng, dialecte)
          - 603 cartes ALF (concept français + numéro de carte)
          - 33217 phrases réalisées (phrase FR + IPA par point + cartes liées)

          Idempotent : on peut le relancer, il n'écrase pas les données déjà
          présentes (INSERT OR IGNORE). Reprise possible si interruption.

          Volume estimé : ~250 Mo SQLite final, ~30 min pour le scrape complet
          (throttle 0.3s entre requêtes pour ne pas surcharger SYMILA).

Usage   : python scripts/alf-scrape.py
          python scripts/alf-scrape.py --skip-points  # si points déjà OK
          python scripts/alf-scrape.py --max-phrases 1000  # test rapide
=============================================================================
"""

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

# ── Constantes ──
BASE_URL = "http://symila.univ-tlse2.fr"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "alf.db"
USER_AGENT = "Mozilla/5.0 (Clipr ALF importer; contact: clipr@local)"
THROTTLE_SEC = 0.3  # délai mini entre requêtes (politesse)
BATCH_SIZE = 500    # taille des batchs AJAX phrases


# ── HTTP helpers ──
def http_get(url: str) -> str:
    """Récupère le texte d'une URL. Retry simple si erreur réseau."""
    for attempt in range(3):
        try:
            req = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (URLError, HTTPError) as e:
            if attempt == 2:
                raise
            print(f"  ! erreur {e}, retry dans 2s...", file=sys.stderr)
            time.sleep(2)
    return ""


def http_post(url: str, data: dict) -> str:
    """POST formdata, renvoie le texte. Retry simple."""
    body = urlencode(data, doseq=True).encode("utf-8")
    for attempt in range(3):
        try:
            req = Request(url, data=body, method="POST", headers={
                "User-Agent": USER_AGENT,
                "Content-Type": "application/x-www-form-urlencoded",
            })
            with urlopen(req, timeout=60) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (URLError, HTTPError) as e:
            if attempt == 2:
                raise
            print(f"  ! erreur {e}, retry dans 2s...", file=sys.stderr)
            time.sleep(2)
    return ""


# ── DB schema ──
def init_db(conn: sqlite3.Connection) -> None:
    """Crée les tables si elles n'existent pas."""
    cur = conn.cursor()
    cur.executescript("""
    -- Points d'enquête de l'ALF (639 lieux)
    CREATE TABLE IF NOT EXISTS alf_points (
        id INTEGER PRIMARY KEY,           -- ID interne SYMILA
        num_alf INTEGER,                  -- N° du point dans l'ALF original
        commune TEXT,
        dept_code TEXT,
        dept_nom TEXT,
        lat REAL,
        lng REAL,
        langue TEXT,                      -- ex: oïl, oc, fpr (francoprovençal)
        dialecte TEXT,
        ipa_local TEXT                    -- prononciation locale du nom de commune
    );
    CREATE INDEX IF NOT EXISTS idx_points_num_alf ON alf_points(num_alf);
    CREATE INDEX IF NOT EXISTS idx_points_dept ON alf_points(dept_code);

    -- Cartes ALF (concepts français, ~603 dans SYMILA)
    CREATE TABLE IF NOT EXISTS alf_cartes (
        id INTEGER PRIMARY KEY,           -- ID interne SYMILA
        num_alf INTEGER,                  -- N° de la carte dans l'ALF (ex: 835)
        titre TEXT,                       -- ex: "Il mène"
        is_partial INTEGER DEFAULT 0      -- 1 si "carte2" suffix
    );
    CREATE INDEX IF NOT EXISTS idx_cartes_num ON alf_cartes(num_alf);
    CREATE INDEX IF NOT EXISTS idx_cartes_titre ON alf_cartes(titre);

    -- Phrases sources du questionnaire ALF (~181 phrases)
    CREATE TABLE IF NOT EXISTS alf_phrases_sources (
        id INTEGER PRIMARY KEY,
        num_phrase INTEGER,
        texte_fr TEXT
    );

    -- Phrases réalisées par point (33217)
    CREATE TABLE IF NOT EXISTS alf_realisations (
        id INTEGER PRIMARY KEY,           -- ID interne SYMILA
        phrase_source_id INTEGER,         -- lien vers alf_phrases_sources
        point_id INTEGER,                 -- lien vers alf_points
        ipa TEXT,                         -- transcription phonétique IPA
        proprietes TEXT,                  -- tags syntaxiques
        complete INTEGER DEFAULT 0,
        validee INTEGER DEFAULT 0,
        FOREIGN KEY (phrase_source_id) REFERENCES alf_phrases_sources(id),
        FOREIGN KEY (point_id) REFERENCES alf_points(id)
    );
    CREATE INDEX IF NOT EXISTS idx_realisations_phrase ON alf_realisations(phrase_source_id);
    CREATE INDEX IF NOT EXISTS idx_realisations_point ON alf_realisations(point_id);

    -- Liens m:n entre réalisations et cartes (un mot d'une phrase = une carte)
    CREATE TABLE IF NOT EXISTS alf_realisation_cartes (
        realisation_id INTEGER,
        carte_id INTEGER,
        PRIMARY KEY (realisation_id, carte_id),
        FOREIGN KEY (realisation_id) REFERENCES alf_realisations(id),
        FOREIGN KEY (carte_id) REFERENCES alf_cartes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rc_carte ON alf_realisation_cartes(carte_id);

    -- Métadonnées de scrape (date, version, source)
    CREATE TABLE IF NOT EXISTS alf_meta (
        cle TEXT PRIMARY KEY,
        valeur TEXT
    );
    """)
    conn.commit()


# ── Scrape : points d'enquête (639) ──
RE_TD = re.compile(r"<td[^>]*>([^<]*)</td>")
RE_TH = re.compile(r"<th[^>]*>([^<]*)</th>")


def parse_lieu_page(html: str) -> dict:
    """Extrait les champs d'une page /alf/lieux/{id}/show."""
    # Construit un dict {nom_champ: valeur} en pairant les <th> et <td>
    ths = RE_TH.findall(html)
    tds = RE_TD.findall(html)
    fields = {}
    # Les <th> et <td> alternent dans la page show ; on aligne par index
    for i, label in enumerate(ths):
        label = label.strip()
        value = tds[i].strip() if i < len(tds) else ""
        fields[label] = value
    return fields


def scrape_points(conn: sqlite3.Connection, max_id: int = 700) -> int:
    """Récupère les pages /alf/lieux/{id}/show pour {1..max_id} et insère."""
    cur = conn.cursor()
    inserted = 0
    skipped = 0
    print(f"[1/3] Points d'enquête (jusqu'à {max_id})...")

    for lieu_id in range(1, max_id + 1):
        # Skip si déjà en base
        existing = cur.execute("SELECT 1 FROM alf_points WHERE id = ?", (lieu_id,)).fetchone()
        if existing:
            skipped += 1
            continue

        try:
            html = http_get(f"{BASE_URL}/alf/lieux/{lieu_id}/show")
        except Exception as e:
            print(f"  ! lieu {lieu_id} : {e}", file=sys.stderr)
            time.sleep(THROTTLE_SEC)
            continue

        # Page 404 ou vide
        if "<h1>" not in html or "Point ALF" not in html:
            time.sleep(THROTTLE_SEC)
            continue

        fields = parse_lieu_page(html)

        def to_float(s: str) -> float | None:
            try:
                return float(s)
            except (ValueError, TypeError):
                return None

        def to_int(s: str) -> int | None:
            try:
                return int(s)
            except (ValueError, TypeError):
                return None

        cur.execute("""
            INSERT OR REPLACE INTO alf_points
            (id, num_alf, commune, dept_code, dept_nom, lat, lng, langue, dialecte, ipa_local)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            lieu_id,
            to_int(fields.get("Pt_alf", "")),
            fields.get("Nom_comm", ""),
            fields.get("Code_dept", ""),
            fields.get("Nom_dept", ""),
            to_float(fields.get("Lat_pt_alf", "")),
            to_float(fields.get("Long_pt_alf", "")),
            fields.get("Langue", ""),
            fields.get("Dialecte", ""),
            fields.get("Nom_comm_local_phonetique", ""),
        ))
        inserted += 1

        if inserted % 50 == 0:
            conn.commit()
            print(f"  {inserted} points insérés (passés en cache : {skipped})")

        time.sleep(THROTTLE_SEC)

    conn.commit()
    print(f"  [OK] {inserted} points inseres, {skipped} deja presents")
    return inserted


# ── Scrape : cartes (603) ──
RE_CARTE_LINK = re.compile(
    r'<a href="/alf/(\d+)/(carte\d*)"><b>(\d+)</b>\s*-\s*([^<]+)</a>'
)


def scrape_cartes(conn: sqlite3.Connection) -> int:
    """Récupère la liste des 603 cartes depuis /alf/cartesALF."""
    print("[2/3] Cartes ALF...")
    html = http_get(f"{BASE_URL}/alf/cartesALF")
    cur = conn.cursor()
    inserted = 0

    for match in RE_CARTE_LINK.finditer(html):
        carte_id = int(match.group(1))
        suffix = match.group(2)
        num_alf = int(match.group(3))
        titre = match.group(4).strip()
        is_partial = 1 if suffix != "carte" else 0

        cur.execute("""
            INSERT OR IGNORE INTO alf_cartes (id, num_alf, titre, is_partial)
            VALUES (?, ?, ?, ?)
        """, (carte_id, num_alf, titre, is_partial))
        if cur.rowcount > 0:
            inserted += 1

    conn.commit()
    print(f"  [OK] {inserted} cartes inserees")
    return inserted


# ── Scrape : phrases réalisées (33217) ──
RE_PHRASE_LINK = re.compile(r'/alf/phrase/(\d+)/show".*?title="(\d+)"[^>]*>(\d+)\s+([^<]+)<')
RE_REALISATION_LINK = re.compile(r'/alf/phraserealisee/(\d+)/show')
RE_LIEU_LINK = re.compile(r'/alf/lieu/(\d+)/show')
RE_CARTE_REF = re.compile(r'/alf/(\d+)/carte\d*"title="([^"]*)">(\d+)<')


def scrape_phrases(conn: sqlite3.Connection, max_records: int | None = None, start_offset: int = 0) -> int:
    """Récupère toutes les phrases réalisées via l'AJAX paginé."""
    print(f"[3/3] Phrases réalisées (batch {BATCH_SIZE}, start={start_offset})...")
    cur = conn.cursor()

    total_inserted = 0
    start = start_offset
    consecutive_failures = 0

    while True:
        body = {
            "draw": "1",
            "start": str(start),
            "length": str(BATCH_SIZE),
            "leslieux[]": "0",
            "lesphrases[]": "0",
            "lechoixphrase": "1",
            "lechoixaffichage": "1",
        }

        try:
            text = http_post(f"{BASE_URL}/alf/phraserealisee/ajax/leipzig2", body)
            consecutive_failures = 0
        except Exception as e:
            consecutive_failures += 1
            print(f"  ! batch start={start} : {e} (echec #{consecutive_failures})", file=sys.stderr)
            if consecutive_failures >= 3:
                # On saute ce batch apres 3 echecs consecutifs (probleme cote SYMILA)
                print(f"  ! batch start={start} ignore apres 3 echecs, on continue", file=sys.stderr)
                start += BATCH_SIZE
                consecutive_failures = 0
                time.sleep(THROTTLE_SEC)
                continue
            time.sleep(5)
            continue

        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            print(f"  ! réponse non-JSON à start={start} (taille {len(text)})")
            break

        recs = payload.get("data", [])
        total = payload.get("recordsTotal", 0)

        if not recs:
            break

        for rec in recs:
            # ID de la réalisation
            m_real = RE_REALISATION_LINK.search(rec.get("colid", ""))
            if not m_real:
                continue
            real_id = int(m_real.group(1))

            # Phrase source : on parse "<a href="/alf/phrase/{id}/show" title="{num}">{num} {texte}</a>"
            phrase_html = rec.get("phrase", "")
            m_phr = re.search(r'/alf/phrase/(\d+)/show"\s+title="(\d+)">(\d+)\s+([^<]+)<', phrase_html)
            phrase_source_id = None
            if m_phr:
                phrase_source_id = int(m_phr.group(1))
                num_phrase = int(m_phr.group(2))
                texte_fr = m_phr.group(4).strip()
                # Insère/met à jour la phrase source
                cur.execute("""
                    INSERT OR IGNORE INTO alf_phrases_sources (id, num_phrase, texte_fr)
                    VALUES (?, ?, ?)
                """, (phrase_source_id, num_phrase, texte_fr))

            # Point d'enquête
            point_html = rec.get("pointalf", "")
            m_pt = RE_LIEU_LINK.search(point_html)
            point_id = int(m_pt.group(1)) if m_pt else None

            # IPA (champ phonetique)
            ipa = rec.get("phonetique", "").strip()

            # Propriétés
            proprietes = rec.get("proprietes", "").strip().rstrip(",").rstrip()

            # Booléens
            complete = 1 if rec.get("complete") == "true" else 0
            validee = 1 if rec.get("validee") else 0

            # Insère la réalisation
            cur.execute("""
                INSERT OR REPLACE INTO alf_realisations
                (id, phrase_source_id, point_id, ipa, proprietes, complete, validee)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (real_id, phrase_source_id, point_id, ipa, proprietes, complete, validee))

            # Cartes liées (m:n)
            cartes_html = rec.get("cartes", "")
            for m_c in RE_CARTE_REF.finditer(cartes_html):
                carte_id = int(m_c.group(1))
                cur.execute("""
                    INSERT OR IGNORE INTO alf_realisation_cartes (realisation_id, carte_id)
                    VALUES (?, ?)
                """, (real_id, carte_id))

            total_inserted += 1

        conn.commit()
        print(f"  {start + len(recs)}/{total} phrases traitées")

        start += BATCH_SIZE
        if max_records and total_inserted >= max_records:
            break
        if start >= total:
            break

        time.sleep(THROTTLE_SEC)

    print(f"  [OK] {total_inserted} realisations inserees")
    return total_inserted


# ── Main ──
def main():
    parser = argparse.ArgumentParser(description="Aspirateur SYMILA → SQLite")
    parser.add_argument("--skip-points", action="store_true", help="Ne pas refaire les points")
    parser.add_argument("--skip-cartes", action="store_true", help="Ne pas refaire les cartes")
    parser.add_argument("--skip-phrases", action="store_true", help="Ne pas refaire les phrases")
    parser.add_argument("--max-phrases", type=int, default=None, help="Limite (test)")
    parser.add_argument("--start-offset", type=int, default=0, help="Reprise scrape phrases au batch N (offset records)")
    parser.add_argument("--max-points", type=int, default=700, help="Range de scan des IDs lieux")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    init_db(conn)

    # Trace de la session
    conn.execute("INSERT OR REPLACE INTO alf_meta (cle, valeur) VALUES ('last_scrape', ?)",
                 (time.strftime("%Y-%m-%dT%H:%M:%S"),))
    conn.commit()

    if not args.skip_points:
        scrape_points(conn, max_id=args.max_points)
    if not args.skip_cartes:
        scrape_cartes(conn)
    if not args.skip_phrases:
        scrape_phrases(conn, max_records=args.max_phrases, start_offset=args.start_offset)

    # Stats finales
    counts = {}
    for t in ["alf_points", "alf_cartes", "alf_phrases_sources",
              "alf_realisations", "alf_realisation_cartes"]:
        counts[t] = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    print("\n=== Statistiques finales ===")
    for t, n in counts.items():
        print(f"  {t} : {n}")
    print(f"  Fichier : {DB_PATH} ({DB_PATH.stat().st_size / 1024 / 1024:.1f} Mo)")

    conn.close()


if __name__ == "__main__":
    main()
