#!/usr/bin/env python3
"""
FIB Verzeichnis – GitHub Data Uploader
Lädt Mitarbeiterdaten aus Google Sheets und pusht sie in dein GitHub-Repo.
Keine externen Libraries nötig – nur Python-Stdlib.
"""

import urllib.request, urllib.error, urllib.parse, json, base64, csv, io, re, sys, time

# ══════════════════════════════════════════════════════
#  KONFIGURATION – hier nichts ändern nötig
# ══════════════════════════════════════════════════════
SPREADSHEET_ID = "15FOa91GUaCOY_BODB_IxpSomlgqkxJLqyoo8VQFXqo4"
TOKEN          = ""  # <-- Hier deinen GitHub-Token eintragen
REPO_NAME      = "mitarbeiterverzeichnis"
AUS_NAMES      = ["GA","EVS","LST","AKS","TST","VHF/EL","JUR","UC","FTK"]

# ══════════════════════════════════════════════════════
#  GOOGLE SHEETS FETCH
# ══════════════════════════════════════════════════════
def fetch_sheet_csv(sheet_name):
    urls = [
        f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv&sheet={urllib.parse.quote(sheet_name)}",
        f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/gviz/tq?tqx=out:csv&headers=0&sheet={urllib.parse.quote(sheet_name)}",
    ]
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                content = resp.read()
                if len(content) > 20:
                    print(f"  ✓ Geladen von: {url[:80]}…")
                    return content.decode("utf-8-sig", errors="replace")
        except Exception as e:
            pass
    raise RuntimeError(f"Tabelle '{sheet_name}' konnte nicht geladen werden. Ist sie öffentlich geteilt?")

# ══════════════════════════════════════════════════════
#  CSV PARSER
# ══════════════════════════════════════════════════════
def parse_csv(text):
    reader = csv.reader(io.StringIO(text))
    return [row for row in reader if any(cell.strip() for cell in row)]

# ══════════════════════════════════════════════════════
#  MITARBEITER PARSER
# ══════════════════════════════════════════════════════
def parse_mitarbeiter(csv_text):
    rows = parse_csv(csv_text)
    if not rows:
        return []

    # Find header row with 'ID' and 'Name'
    header_idx = -1
    for i, row in enumerate(rows[:20]):
        if any(c.strip() == 'ID' for c in row) and any(c.strip() == 'Name' for c in row):
            header_idx = i
            break
    if header_idx < 0:
        for i, row in enumerate(rows[:20]):
            if sum(1 for c in row if c.strip()) >= 3:
                header_idx = i
                break
    if header_idx < 0:
        header_idx = 0

    hdrs = rows[header_idx]
    # Map column names → indices
    id_c = nm_c = rg_c = dn_c = dv_c = st_c = iv_c = lr_c = ha_c = ne_c = sk_c = -1
    aus_c = {}
    for j, h in enumerate(hdrs):
        t = h.strip()
        tl = t.lower()
        if t == 'ID':           id_c = j
        elif t == 'Name':       nm_c = j
        elif t == 'DN':         dn_c = j
        elif tl.startswith('rank') or tl == 'rang': rg_c = j
        elif 'division' in tl and dv_c < 0:         dv_c = j
        elif 'strike' in tl:    st_c = j
        elif 'invite' in tl:    iv_c = j
        elif 'last rank' in tl or tl == 'last rank': lr_c = j
        elif 'abteilung' in tl and ha_c < 0:        ha_c = j
        elif 'abteilung' in tl and ha_c >= 0:       ne_c = j
        elif tl in ('sanktionen','sanction'):        sk_c = j
        if t in AUS_NAMES:      aus_c[t] = j

    # Fallbacks (Code.gs 0-indexed)
    if id_c < 0: id_c = 1
    if nm_c < 0: nm_c = 2
    if rg_c < 0: rg_c = 3
    if dn_c < 0: dn_c = 5
    if dv_c < 0: dv_c = 8
    if st_c < 0: st_c = 10
    if iv_c < 0: iv_c = 12
    if lr_c < 0: lr_c = 13
    if ha_c < 0: ha_c = 16
    if ne_c < 0: ne_c = 17
    if sk_c < 0: sk_c = 18

    print(f"  Ausbildung-Spalten gefunden: { {k: v for k, v in aus_c.items()} }")

    employees = []
    for row in rows[header_idx + 1:]:
        def g(i): return row[i].strip() if i < len(row) else ''
        emp_id, name = g(id_c), g(nm_c)
        if not emp_id and not name:
            continue
        if name == 'Name' or emp_id == 'ID':
            continue

        aus = {}
        for an in AUS_NAMES:
            if an in aus_c:
                v = g(aus_c[an]).upper()
                aus[an] = v in ('TRUE','WAHR','JA','1','X')
            else:
                aus[an] = False

        sanktionen = []
        if sk_c >= 0:
            try:
                sk = json.loads(g(sk_c) or '[]')
                if isinstance(sk, list):
                    sanktionen = sk
            except Exception:
                pass

        employees.append({
            "ID": emp_id, "Name": name,
            "Rang": g(rg_c), "DN": g(dn_c), "Division": g(dv_c),
            "Strikes": int(g(st_c) or 0) if g(st_c).lstrip('-').isdigit() else 0,
            "Invite": g(iv_c), "Last Rank-up": g(lr_c),
            "Hauptabteilung": g(ha_c), "Nebenabteilung": g(ne_c),
            "Ausbildungen": aus, "Sanktionen": sanktionen,
        })
    return employees

# ══════════════════════════════════════════════════════
#  SANKTIONSKATALOG PARSER
# ══════════════════════════════════════════════════════
SANK_PENALTY_KW = ['humane','ems','ng runde','upranksperre','geldstrafe','strike','kündigung','kundigung']

def parse_sanktionskatalog(csv_text):
    rows = parse_csv(csv_text)
    if not rows:
        return {"headers": [], "data": []}

    def row_penalty_score(row):
        joined = ' '.join(c.strip().lower() for c in row)
        return sum(1 for kw in SANK_PENALTY_KW if kw in joined)

    # Best match: row with "§" OR "regeldefinition" AND at least 2 penalty keywords
    header_idx = -1
    for i, row in enumerate(rows[:60]):
        row_l = [c.strip().lower() for c in row]
        has_para = '§' in [c.strip() for c in row]
        has_regel = any('regeldefinition' in c for c in row_l)
        if (has_para or has_regel) and row_penalty_score(row) >= 2:
            header_idx = i
            break
    # Fallback: highest penalty score in first 60 rows
    if header_idx < 0:
        best_score, best_i = 0, 0
        for i, row in enumerate(rows[:60]):
            s = row_penalty_score(row)
            if s > best_score:
                best_score, best_i = s, i
        if best_score >= 2:
            header_idx = best_i
    # Last fallback: first row with "§"
    if header_idx < 0:
        for i, row in enumerate(rows[:30]):
            if any(c.strip() == '§' for c in row):
                header_idx = i; break
    if header_idx < 0:
        header_idx = 0

    raw_hdrs = rows[header_idx]
    col_map = [(j, h.strip()) for j, h in enumerate(raw_hdrs) if h.strip()]
    headers = [h for _, h in col_map]

    data = []
    for row in rows[header_idx + 1:]:
        if not any(c.strip() for c in row):
            continue
        obj = {h: (row[j].strip() if j < len(row) else '') for j, h in col_map}
        data.append(obj)
    return {"headers": headers, "data": data}

# ══════════════════════════════════════════════════════
#  RÄNGE PARSER
# ══════════════════════════════════════════════════════
def parse_raenge(csv_text):
    rows = parse_csv(csv_text)
    seen = set()
    raenge = []
    for row in rows:
        for cell in row:
            v = cell.strip()
            if re.match(r'^\d{2}\. .{3,}', v) and v not in seen:
                seen.add(v)
                raenge.append(v)
    raenge.sort(key=lambda r: int(r.split('.')[0]), reverse=True)
    return raenge

# ══════════════════════════════════════════════════════
#  ADMINS PARSER
# ══════════════════════════════════════════════════════
def parse_admins(csv_text):
    rows = parse_csv(csv_text)
    admins = []
    start = 1 if rows and re.match(r'^(username|name|user)$', rows[0][0].strip(), re.I) else 0
    for row in rows[start:]:
        if len(row) < 2: continue
        username = row[0].strip()
        pw_hash  = row[1].strip()
        level    = int(row[2].strip()) if len(row) > 2 and row[2].strip().isdigit() else 1
        if username and re.match(r'^[0-9a-f]{64}$', pw_hash, re.I):
            admins.append({"username": username, "passwordHash": pw_hash.lower(), "level": level})
    return admins

# ══════════════════════════════════════════════════════
#  GITHUB API
# ══════════════════════════════════════════════════════
def gh_request(method, path, data=None):
    url = f"https://api.github.com{path}"
    headers = {
        "Authorization": f"token {TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "FIB-Setup/1.0",
    }
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

def upload_file(owner, repo, path, content_str, message):
    b64_content = base64.b64encode(content_str.encode("utf-8")).decode("ascii")
    # Get current SHA if file exists
    sha = None
    status, existing = gh_request("GET", f"/repos/{owner}/{repo}/contents/{path}")
    if status == 200:
        sha = existing.get("sha")
    payload = {"message": message, "content": b64_content}
    if sha:
        payload["sha"] = sha
    status, result = gh_request("PUT", f"/repos/{owner}/{repo}/contents/{path}", payload)
    return status in (200, 201)

# ══════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════

def main():
    print("=" * 55)
    print("  FIB Verzeichnis – GitHub Data Uploader")
    print("=" * 55)

    # Get GitHub username
    status, user_data = gh_request("GET", "/user")
    if status != 200:
        print(f"✗ Token ungültig (Status {status})")
        sys.exit(1)
    owner = user_data["login"]
    print(f"\n✓ Eingeloggt als: {owner}")
    print(f"  Repo: {owner}/{REPO_NAME}\n")

    # ── Fetch and parse sheets ──
    results = {}

    print("📊 Lade Mitarbeiter…")
    try:
        csv = fetch_sheet_csv("Mitarbeiter")
        employees = parse_mitarbeiter(csv)
        results["employees"] = employees
        print(f"  → {len(employees)} Mitarbeiter gefunden")
    except Exception as e:
        print(f"  ✗ Fehler: {e}")
        results["employees"] = None

    print("\n📊 Lade Sanktionskatalog…")
    try:
        csv = fetch_sheet_csv("Sanktionskatalog")
        sk = parse_sanktionskatalog(csv)
        results["sanktionskatalog"] = sk
        print(f"  → {len(sk['data'])} Einträge gefunden")
    except Exception as e:
        print(f"  ✗ Fehler: {e}")
        results["sanktionskatalog"] = None

    print("\n📊 Lade Ränge (Daten-Sheet)…")
    try:
        csv = fetch_sheet_csv("Daten")
        raenge = parse_raenge(csv)
        results["raenge"] = raenge
        print(f"  → {len(raenge)} Ränge gefunden")
    except Exception as e:
        print(f"  ✗ Fehler: {e}")
        results["raenge"] = None

    print("\n📊 Lade Admins…")
    try:
        csv = fetch_sheet_csv("Admins")
        admins = parse_admins(csv)
        results["admins"] = admins
        print(f"  → {len(admins)} Admins gefunden")
    except Exception as e:
        print(f"  ✗ Fehler: {e}")
        results["admins"] = None

    # ── Upload to GitHub ──
    print(f"\n📤 Lade in GitHub ({owner}/{REPO_NAME}) hoch…\n")

    uploads = []

    if results["employees"] is not None:
        uploads.append(("data/employees.json",
                        json.dumps(results["employees"], ensure_ascii=False, indent=2),
                        f"Update employees ({len(results['employees'])} entries)"))
    else:
        print("  ⚠ Mitarbeiter übersprungen (Ladefehler)")

    if results["sanktionskatalog"] is not None:
        uploads.append(("data/sanktionskatalog.json",
                        json.dumps(results["sanktionskatalog"], ensure_ascii=False, indent=2),
                        f"Update sanktionskatalog ({len(results['sanktionskatalog']['data'])} entries)"))
    else:
        print("  ⚠ Sanktionskatalog übersprungen (Ladefehler)")

    if results["raenge"] and len(results["raenge"]) > 0:
        uploads.append(("data/raenge.json",
                        json.dumps(results["raenge"], ensure_ascii=False, indent=2),
                        f"Update raenge ({len(results['raenge'])} ranks)"))

 