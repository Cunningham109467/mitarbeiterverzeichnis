// ============================================================
// MITARBEITERVERZEICHNIS - Google Apps Script Backend
// ============================================================

const SPREADSHEET_ID      = "15FOa91GUaCOY_BODB_IxpSomlgqkxJLqyoo8VQFXqo4";
const SHEET_MITARBEITER   = "Mitarbeiter";
const SHEET_ADMINS        = "Admins";
const SHEET_RANGNUMMERN   = "Daten";          // Ränge für Dropdown + Ausbildungen
const SHEET_EVENTS        = "Events";
const SHEET_KUENDIGUNGEN  = "Leyla Kündigungen neu";
const SHEET_SANKTIONEN    = "Sanktionskatalog";

// Ausbildungen: Spalten AZ–BH im Tabellenblatt "Daten"
// AZ = Spalte 52, BH = Spalte 60  →  9 Spalten
const AUS_DATEN_START_COL = 52;  // AZ
const AUS_DATEN_END_COL   = 60;  // BH
const AUS_DATEN_COUNT     = AUS_DATEN_END_COL - AUS_DATEN_START_COL + 1; // 9
const AUS_HEADER_ROW      = 7;   // Zeile 7 = Überschriften
const AUS_DATA_START_ROW  = 8;   // Zeile 8 = erste Datenzeile im Daten-Blatt
                                  // (wird NICHT direkt genutzt – Mitarbeiter-Zeilen
                                  //  werden 1:1 gemappt, s.u.)

// Ausbildungen im Mitarbeiter-Blatt:
// Die TRUE/FALSE-Werte stehen ebenfalls in Spalten AZ–BH (52–60),
// eine Zeile pro Mitarbeiter (ab Zeile 10 des Mitarbeiter-Blatts).
const AUS_MIT_START_COL = 52;  // AZ im Mitarbeiter-Blatt
const AUS_MIT_END_COL   = 60;  // BH im Mitarbeiter-Blatt

function getSS() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

// ---- Web App Entry Point ----
function doGet(e) {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("Mitarbeiterverzeichnis")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function isValidDateValue(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value);
}

function formatSheetDate(value) {
  if (isValidDateValue(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

function formatSheetTime(value) {
  if (isValidDateValue(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(value || '').trim();
}

// ---- Auth ----
// Passwörter werden als SHA-256-Hex (64 Zeichen) gespeichert.
// Beim ersten Login mit altem Klartextpasswort wird es automatisch migriert.

// SHA-256 → 64-stelliger Hex-String
function sha256Hex(str) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    str,
    Utilities.Charset.UTF_8
  );
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// Admin-Levels: 1 = LAW, 2 = TD, 3 = HR, 4 = Admin
function getDefaultAdminLevel(username, fallbackLevel) {
  const normalized = String(username || '').trim().toLowerCase();
  const roleLevels = {
    law: 1,
    event: 2,
    mod: 3,
    admin: 4
  };
  return roleLevels[normalized] || (parseInt(fallbackLevel, 10) || 1);
}

function login(username, password) {
  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_ADMINS);
  if (!sheet) return { success: false, message: "Admin-Tabelle nicht gefunden." };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() !== String(username).trim()) continue;
    const stored   = String(data[i][1]).trim();
    const incoming = String(password).trim().toLowerCase();
    const level    = getDefaultAdminLevel(username, data[i][2]);

    // Erkennen ob gespeicherter Wert bereits ein SHA-256-Hash ist
    const isHashed = /^[0-9a-f]{64}$/.test(stored);
    let match = false;

    if (isHashed) {
      // Direkter Hash-Vergleich
      match = stored.toLowerCase() === incoming;
    } else {
      // Klartext-Migration: gespeichertes Passwort hashen und vergleichen
      const hashOfStored = sha256Hex(stored);
      match = hashOfStored === incoming;
      if (match) {
        // Klartext im Sheet durch Hash ersetzen
        sheet.getRange(i + 1, 2).setValue(hashOfStored);
      }
    }

    if (match) {
      const token = Utilities.getUuid();
      PropertiesService.getScriptProperties().setProperty(
        "SESSION_" + token, username + "|" + new Date().getTime() + "|" + level
      );
      return { success: true, token: token, username: username, adminLevel: level };
    }
    break; // Benutzername gefunden, aber Passwort falsch
  }
  return { success: false, message: "Benutzername oder Passwort falsch." };
}

function validateToken(token) {
  if (!token) return null;
  const prop = PropertiesService.getScriptProperties().getProperty("SESSION_" + token);
  if (!prop) return null;
  const parts = prop.split("|");
  const ts = parseInt(parts[1]);
  if (new Date().getTime() - ts > 8 * 60 * 60 * 1000) {
    PropertiesService.getScriptProperties().deleteProperty("SESSION_" + token);
    return null;
  }
  return { username: parts[0], level: parseInt(parts[2]) || 1 };
}

function logout(token) {
  PropertiesService.getScriptProperties().deleteProperty("SESSION_" + token);
  return { success: true };
}

// ---- Ausbildungs-Header aus "Daten"-Blatt (Zeile 7, Spalten AZ–BH) ----
function getAusbildungHeaders() {
  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_RANGNUMMERN);
  if (!sheet) return [];
  const headers = sheet
    .getRange(AUS_HEADER_ROW, AUS_DATEN_START_COL, 1, AUS_DATEN_COUNT)
    .getValues()[0];
  // Wichtig: Keine Filterung leerer Header, damit AZ..BH positionsgenau bleibt.
  return headers.map(h => String(h || "").trim());
}

function parseAusBoolean(raw) {
  if (raw === true) return true;
  if (raw === false || raw === null || raw === undefined) return false;
  if (typeof raw === 'number') return raw === 1;
  const t = String(raw).trim().toUpperCase();
  return t === 'TRUE' || t === 'WAHR' || t === 'JA' || t === '1' || t === 'X';
}

// ---- Mitarbeiter lesen ----
function getAllBeamte() {
  const ss = getSS();
  const mitSheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!mitSheet) return [];

  const lastRow = mitSheet.getLastRow();
  if (lastRow < 10) return [];

  // Ausbildungs-Header aus "Daten"-Blatt (Zeile 7, Spalten AZ–BH)
  const ausHeaders = getAusbildungHeaders();
  const actualAusCount = AUS_DATEN_COUNT;

  // Alle Spalten bis mindestens BH (60) einlesen
  const totalCols = Math.max(mitSheet.getLastColumn(), AUS_MIT_END_COL);
  const numRows   = lastRow - 9; // ab Zeile 10
  const allData   = mitSheet.getRange(10, 1, numRows, totalCols).getValues();

  return allData.map((row, i) => {

    // ── Ausbildungen aus Spalten AZ–BH (Index 51–59) ──
    const ausbildungen = {};
    for (let a = 0; a < actualAusCount; a++) {
      const title = ausHeaders[a] || '';
      if (!title) continue;
      const raw = row[AUS_MIT_START_COL - 1 + a]; // 0-basierter Index
      ausbildungen[title] = parseAusBoolean(raw);
    }

    // ── FIX: Strikes-Spalte ──
    // updateBeamter schreibt Strikes in Spalte 11 → Index 10 (0-basiert)
    // Der alte Code prüfte row[11] (Spalte 12) als Bedingung – das war falsch.
    const strikesRaw = row[10]; // Spalte 11, 0-basierter Index 10
    const strikes    = (strikesRaw !== "" && strikesRaw !== null && strikesRaw !== undefined)
                         ? (parseInt(strikesRaw) || 0)
                         : 0;

    return {
      _row:              i + 10,
      "ID":              String(row[1]  || "").trim(),
      "Name":            String(row[2]  || "").trim(),
      "Rang":            String(row[3]  || "").trim(),
      "DN":              String(row[5]  || "").trim(),
      "Division":        String(row[8]  || "").trim(),
      "Strikes":         strikes,
      "Invite":          formatSheetDate(row[12]),
      "Last Rank-up":    formatSheetDate(row[13]),
      "Hauptabteilung":  String(row[16] || "").trim(),
      "Nebenabteilung":  String(row[17] || "").trim(),
      "Ausbildungen":    ausbildungen
    };
  }).filter(b => b["ID"] !== "" || b["Name"] !== "");
}

// ---- Mitarbeiter mit Sanktionen lesen (für LAW) ----
function getAllBeamteWithSanktionen(token) {
  const auth = validateToken(token);
  if (!auth || (auth.level !== 1 && auth.level !== 4)) return [];

  const beamten = getAllBeamte();
  const ss = getSS();
  const mitSheet = ss.getSheetByName(SHEET_MITARBEITER);

  beamten.forEach(b => {
    try {
      const cell = mitSheet.getRange(b._row, SANKTIONEN_COL).getValue();
      const jsonStr = String(cell || "").trim();
      b._sanktionen = [];
      if (jsonStr) {
        b._sanktionen = JSON.parse(jsonStr);
      }
    } catch (e) {
      b._sanktionen = [];
    }
  });

  return beamten;
}

// Nur Beamte mit Sanktionen laden (Performance-Optimierung)
function getAllSanktionenOnly(token) {
  const auth = validateToken(token);
  if (!auth || (auth.level !== 1 && auth.level !== 4)) return [];

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const dataRange = sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), SANKTIONEN_COL));
  const rows = dataRange.getValues();

  const result = [];
  rows.forEach((row, idx) => {
    const rowIndex = idx + 2;
    const jsonStr = String(row[SANKTIONEN_COL - 1] || "").trim();
    let sanktionen = [];
    try {
      if (jsonStr) {
        sanktionen = JSON.parse(jsonStr);
      }
    } catch (e) {}

    if (sanktionen.length > 0) {
      const beamte = {
        _row: rowIndex,
        ID: String(row[1] || "").trim(),
        Name: String(row[2] || "").trim(),
        Rang: String(row[3] || "").trim(),
        DN: String(row[5] || "").trim(),
        _sanktionen: sanktionen
      };
      result.push(beamte);
    }
  });
  return result;
}

// ---- Beamter aktualisieren ----
function updateBeamter(token, rowIndex, data) {
  const auth = validateToken(token);
  if (!auth || auth.level < 3) return { success: false, message: "Keine Berechtigung." };

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!sheet) return { success: false, message: "Tabelle nicht gefunden." };

  const level = auth.level;

  if (level >= 3) {
    sheet.getRange(rowIndex, 2).setValue(data['ID'] || '');    // Spalte B → Index 2
    sheet.getRange(rowIndex, 3).setValue(data['Name'] || '');  // Spalte C → Index 3
    sheet.getRange(rowIndex, 9).setValue(data['Division'] || '');
    sheet.getRange(rowIndex, 11).setValue(parseInt(data['Strikes']) || 0);
  }
  if (level >= 2) {
    sheet.getRange(rowIndex, 4).setValue(data['Rang'] || '');
    sheet.getRange(rowIndex, 6).setValue(data['DN'] || '');
    sheet.getRange(rowIndex, 13).setValue(data['Invite'] || '');
    sheet.getRange(rowIndex, 14).setValue(data['Last Rank-up'] || '');
    sheet.getRange(rowIndex, 17).setValue(data['Hauptabteilung'] || '');
    sheet.getRange(rowIndex, 18).setValue(data['Nebenabteilung'] || '');
  }

  return { success: true };
}

// ---- Ausbildungen aktualisieren ----
// Schreibt die TRUE/FALSE-Werte in die Spalten AZ–BH des MITARBEITER-Blatts.
function updateAusbildungen(token, rowIndex, ausData) {
  const auth = validateToken(token);
  if (!auth) return { success: false, message: "Nicht autorisiert." };
  if (auth.level < 2) return { success: false, message: "Keine Berechtigung." };

  const ss = getSS();
  const mitSheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!mitSheet) return { success: false, message: "Tabelle nicht gefunden." };

  const ausHeaders = getAusbildungHeaders();

  for (let a = 0; a < AUS_DATEN_COUNT; a++) {
    const title = ausHeaders[a] || '';
    if (!title) continue;
    if (ausData.hasOwnProperty(title)) {
      mitSheet
        .getRange(rowIndex, AUS_MIT_START_COL + a)
        .setValue(parseAusBoolean(ausData[title]));
    }
  }
  return { success: true };
}

// ---- Beamter hinzufügen (Level 2) ----
function addBeamter(token, data) {
  const auth = validateToken(token);
  if (!auth || auth.level < 3) return { success: false, message: "Keine Berechtigung." };

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!sheet) return { success: false, message: "Tabelle nicht gefunden." };

  const newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 2).setValue(data['ID'] || '');
  sheet.getRange(newRow, 3).setValue(data['Name'] || '');
  sheet.getRange(newRow, 4).setValue(data['Rang'] || '');
  sheet.getRange(newRow, 6).setValue(data['DN'] || '');
  sheet.getRange(newRow, 9).setValue(data['Division'] || 'Officer');
  sheet.getRange(newRow, 11).setValue(parseInt(data['Strikes']) || 0);
  sheet.getRange(newRow, 13).setValue(data['Invite'] || '');
  sheet.getRange(newRow, 14).setValue(data['Last Rank-up'] || '');
  sheet.getRange(newRow, 17).setValue(data['Hauptabteilung'] || '');
  sheet.getRange(newRow, 18).setValue(data['Nebenabteilung'] || '');
  return { success: true };
}

// ---- Beamter löschen (Level 3) ----
function deleteBeamter(token, rowIndex) {
  const auth = validateToken(token);
  if (!auth || auth.level < 4) return { success: false, message: "Keine Berechtigung." };

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!sheet) return { success: false, message: "Tabelle nicht gefunden." };
  sheet.deleteRow(rowIndex);
  return { success: true };
}

// ====================================================
// ---- Kündigung (Level 3) ----
// ====================================================
function kuendigeBeamter(token, rowIndex, grund, text, adminName) {
  const auth = validateToken(token);
  if (!auth || auth.level < 4) return { success: false, message: "Keine Berechtigung." };

  const ss = getSS();
  const mitSheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!mitSheet) return { success: false, message: "Tabelle nicht gefunden." };

  const totalCols = Math.max(mitSheet.getLastColumn(), 20);
  const row = mitSheet.getRange(rowIndex, 1, 1, totalCols).getValues()[0];

  const name     = String(row[2]  || "Unbekannt").trim(); // Spalte C
  const id       = String(row[1]  || "").trim();           // Spalte B
  const rang     = String(row[3]  || "").trim();           // Spalte D
  const division = String(row[8]  || "").trim();           // Spalte I
  const dn       = String(row[5]  || "").trim();           // Spalte F
  const invite   = formatSheetDate(row[12]);                 // Spalte M

  let kuendSheet = ss.getSheetByName(SHEET_KUENDIGUNGEN);
  if (!kuendSheet) {
    kuendSheet = ss.insertSheet(SHEET_KUENDIGUNGEN);
    const headers = ["Datum", "ID", "DN", "Name", "Rang", "Division",
                     "Eingestellt am", "Kündigungsgrund", "Begründung", "Bearbeitet von"];
    kuendSheet.appendRow(headers);
    kuendSheet.getRange(1, 1, 1, headers.length)
      .setFontWeight("bold").setBackground("#7c1d1d").setFontColor("#ffffff");
    kuendSheet.setFrozenRows(1);
    [120, 80, 60, 160, 180, 120, 120, 160, 300, 140].forEach((w, i) => {
      kuendSheet.setColumnWidth(i + 1, w);
    });
  }

  const datum = new Date().toLocaleDateString('de-DE');
  kuendSheet.appendRow([datum, id, dn, name, rang, division, invite, grund, text || "", adminName]);
  mitSheet.deleteRow(rowIndex);

  return { success: true, name: name };
}

// ====================================================
// ---- Sanktionen (Level 4 - LAW) ----
// ====================================================
// Sanktionen werden als JSON in Spalte 19 des Mitarbeiter-Sheets gespeichert
const SANKTIONEN_COL = 19;

function getSanktionen(token, rowIndex) {
  const auth = validateToken(token);
  if (!auth || (auth.level !== 1 && auth.level !== 4)) return { success: false, message: "Nicht autorisiert." };

  // Validiere rowIndex
  if (!rowIndex || rowIndex < 2 || isNaN(rowIndex)) {
    return { success: false, message: "Ungültiger Zeilenindex." };
  }

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!sheet) return { success: false, message: "Tabelle nicht gefunden." };

  const cell = sheet.getRange(rowIndex, SANKTIONEN_COL).getValue();
  const jsonStr = String(cell || "").trim();
  let sanktionen = [];
  try {
    if (jsonStr) {
      sanktionen = JSON.parse(jsonStr);
    }
  } catch (e) {
    Logger.log("Fehler beim Parsen von Sanktionen: " + e);
  }
  return { success: true, data: sanktionen };
}

function createSanktion(token, rowIndex, data) {
  const auth = validateToken(token);
  if (!auth || (auth.level !== 1 && auth.level !== 4)) return { success: false, message: "Nur LAW oder Admin darf Sanktionen erstellen." };

  // Akte-Link ist PFLICHT
  if (!data.akte || String(data.akte).trim() === "") {
    return { success: false, message: "Discord Thread URL ist erforderlich!" };
  }

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!sheet) return { success: false, message: "Tabelle nicht gefunden." };

  const cell = sheet.getRange(rowIndex, SANKTIONEN_COL).getValue();
  const jsonStr = String(cell || "").trim();
  let sanktionen = [];
  try {
    if (jsonStr) {
      sanktionen = JSON.parse(jsonStr);
    }
  } catch (e) {}

  const newSanktion = {
    id: Utilities.getUuid(),
    type: data.type || "KATALOG",  // KATALOG oder CUSTOM
    name: data.name || "",
    regel: data.regel || "",  // Regeldefinition aus Katalog
    penalties: data.penalties || [],  // Array von {type, value}
    status: "OFFEN",
    akte: String(data.akte).trim(),
    notiz: data.notiz || "",
    erstelltVon: auth.username,
    erstelltAm: new Date().toISOString().split('T')[0],
    aktualisiertVon: auth.username,
    aktualisiertAm: new Date().toISOString().split('T')[0]
  };

  sanktionen.push(newSanktion);
  sheet.getRange(rowIndex, SANKTIONEN_COL).setValue(JSON.stringify(sanktionen));
  return { success: true, sanktion: newSanktion };
}

function updateSanktionStatus(token, rowIndex, sanktionId, newStatus, akte, notiz) {
  const auth = validateToken(token);
  if (!auth || (auth.level !== 1 && auth.level !== 4)) return { success: false, message: "Nur LAW oder Admin darf Sanktionen verwalten." };

  // Wenn Status auf ABSOLVIERT gesetzt wird, ist Akte-Link PFLICHT
  if (newStatus === "ABSOLVIERT" && (!akte || String(akte).trim() === "")) {
    return { success: false, message: "Bei Status 'Absolviert' ist die Discord Thread URL erforderlich!" };
  }

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!sheet) return { success: false, message: "Tabelle nicht gefunden." };

  const cell = sheet.getRange(rowIndex, SANKTIONEN_COL).getValue();
  const jsonStr = String(cell || "").trim();
  let sanktionen = [];
  try {
    if (jsonStr) {
      sanktionen = JSON.parse(jsonStr);
    }
  } catch (e) {}

  const sanktion = sanktionen.find(s => s.id === sanktionId);
  if (!sanktion) {
    return { success: false, message: "Sanktion nicht gefunden." };
  }

  sanktion.status = newStatus;
  if (akte) {
    sanktion.akte = String(akte).trim();
  }
  if (notiz !== undefined) {
    sanktion.notiz = String(notiz || "").trim();
  }
  sanktion.aktualisiertVon = auth.username;
  sanktion.aktualisiertAm = new Date().toISOString().split('T')[0];

  sheet.getRange(rowIndex, SANKTIONEN_COL).setValue(JSON.stringify(sanktionen));
  return { success: true, sanktion: sanktion };
}

function deleteSanktion(token, rowIndex, sanktionId) {
  const auth = validateToken(token);
  if (!auth || (auth.level !== 1 && auth.level !== 4)) return { success: false, message: "Nur LAW oder Admin darf Sanktionen löschen." };

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_MITARBEITER);
  if (!sheet) return { success: false, message: "Tabelle nicht gefunden." };

  const cell = sheet.getRange(rowIndex, SANKTIONEN_COL).getValue();
  const jsonStr = String(cell || "").trim();
  let sanktionen = [];
  try {
    if (jsonStr) {
      sanktionen = JSON.parse(jsonStr);
    }
  } catch (e) {}

  const idx = sanktionen.findIndex(s => s.id === sanktionId);
  if (idx < 0) {
    return { success: false, message: "Sanktion nicht gefunden." };
  }

  sanktionen.splice(idx, 1);
  sheet.getRange(rowIndex, SANKTIONEN_COL).setValue(JSON.stringify(sanktionen));
  return { success: true };
}

// ====================================================
// ---- Kleiderordnung ----
// ====================================================
const SHEET_KLEIDERORDNUNG     = "Kleiderordnung";
const SHEET_KLEIDERORDNUNG_DIV = "Kleiderordnung Division";

function getKleiderordnung() {
  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_KLEIDERORDNUNG);
  if (!sheet) return { success: false, message: "Tabellenblatt 'Kleiderordnung' nicht gefunden." };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true, data: [] };
  const cols = Math.max(sheet.getLastColumn(), 19);
  const rows = sheet.getRange(2, 1, lastRow - 1, cols).getValues();
  return {
    success: true,
    data: rows
      .filter(r => String(r[0] || '').trim() !== '')
      .map(r => ({
        rang:          String(r[0]  || '').trim(),
        anforderungen: String(r[1]  || '').trim(),
        befugnisse:    String(r[2]  || '').trim(),
        kl_m_img:      String(r[3]  || '').trim(),
        kl_m_text:     String(r[4]  || '').trim(),
        kl_f_img:      String(r[5]  || '').trim(),
        kl_f_text:     String(r[6]  || '').trim(),
        ev_m_img:      String(r[7]  || '').trim(),
        ev_m_text:     String(r[8]  || '').trim(),
        ev_f_img:      String(r[9]  || '').trim(),
        ev_f_text:     String(r[10] || '').trim(),
        pdw:           String(r[11] || '').trim(),
        schrot:        String(r[12] || '').trim(),
        schrot_sw:     String(r[13] || '').trim(),
        sturmgew:      String(r[14] || '').trim(),
        schlagstock:   String(r[15] || '').trim(),
        mg:            String(r[16] || '').trim(),
        sniper:        String(r[17] || '').trim(),
        balaclava:     String(r[18] || '').trim()
      }))
  };
}

function getKleiderordnungDivision() {
  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_KLEIDERORDNUNG_DIV);
  if (!sheet) return { success: false, message: "Tabellenblatt 'Kleiderordnung Division' nicht gefunden." };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true, data: [] };
  const cols = Math.max(sheet.getLastColumn(), 27);
  const rows = sheet.getRange(2, 1, lastRow - 1, cols).getValues();
  return {
    success: true,
    data: rows
      .filter(r => String(r[0] || '').trim() !== '')
      .map(r => ({
        division:      String(r[0]  || '').trim(),
        anforderungen: String(r[1]  || '').trim(),
        befugnisse:    String(r[2]  || '').trim(),
        m_tr_img:      String(r[3]  || '').trim(),
        m_tr_text:     String(r[4]  || '').trim(),
        m_ag_img:      String(r[5]  || '').trim(),
        m_ag_text:     String(r[6]  || '').trim(),
        m_sa_img:      String(r[7]  || '').trim(),
        m_sa_text:     String(r[8]  || '').trim(),
        m_ea_img:      String(r[9]  || '').trim(),
        m_ea_text:     String(r[10] || '').trim(),
        f_tr_img:      String(r[11] || '').trim(),
        f_tr_text:     String(r[12] || '').trim(),
        f_ag_img:      String(r[13] || '').trim(),
        f_ag_text:     String(r[14] || '').trim(),
        f_sa_img:      String(r[15] || '').trim(),
        f_sa_text:     String(r[16] || '').trim(),
        f_ea_img:      String(r[17] || '').trim(),
        f_ea_text:     String(r[18] || '').trim(),
        pdw:           String(r[19] || '').trim(),
        schrot:        String(r[20] || '').trim(),
        schrot_sw:     String(r[21] || '').trim(),
        sturmgew:      String(r[22] || '').trim(),
        schlagstock:   String(r[23] || '').trim(),
        mg:            String(r[24] || '').trim(),
        sniper:        String(r[25] || '').trim(),
        balaclava:     String(r[26] || '').trim()
      }))
  };
}

// ====================================================
// ---- Ränge aus "Daten" Tabellenblatt ----
// ====================================================
function getRaenge() {
  const ss = getSS();
  const rangSheet = ss.getSheetByName(SHEET_RANGNUMMERN);
  if (rangSheet) {
    const lastRow = Math.min(rangSheet.getLastRow(), 34);
    if (lastRow >= 4) {
      const vals = rangSheet.getRange(4, 14, lastRow, 4).getValues();
      const result = vals
        .map(r => String(r[0]).trim())
        .filter(v => v !== "" && v !== "null" && v !== "undefined");
      if (result.length > 0) return result;
    }
  }
  return [];
}

// ====================================================
// ---- Sanktionskatalog lesen ----
// ====================================================
function getSanktionskatalog() {
  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_SANKTIONEN);
  if (!sheet) return { success: false, message: "Tabellenblatt 'Sanktionskatalog' nicht gefunden." };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return { success: true, data: [], headers: [] };

  // Scan for the real header row:
  // 1) exact match § in col A
  // 2) col A contains § (covers extra whitespace / unicode variants)
  // 3) fallback: first row with >= 5 non-empty cells (dense header row)
  const allVals = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  let headerRowIdx = -1;
  for (let i = 0; i < allVals.length; i++) {
    const a = String(allVals[i][0]).trim();
    if (a === "§" || a.includes("§")) { headerRowIdx = i; break; }
  }
  if (headerRowIdx < 0) {
    // Fallback: find first row with >= 5 non-empty non-image cells
    for (let i = 0; i < allVals.length; i++) {
      const nonEmpty = allVals[i].filter(c => {
        const s = String(c).trim();
        return s !== "" && s.toLowerCase() !== "cell image";
      }).length;
      if (nonEmpty >= 5) { headerRowIdx = i; break; }
    }
  }
  if (headerRowIdx < 0) return { success: true, data: [], headers: [] };

  const headers = allVals[headerRowIdx].map(v => String(v).trim());
  const data = [];
  for (let i = headerRowIdx + 1; i < allVals.length; i++) {
    const row = allVals[i];
    // Skip completely empty rows and rows that only contain embedded-image placeholders
    const colA = String(row[0] || "").trim().toLowerCase();
    if (colA === "cell image") continue;
    const meaningful = row.some(cell => {
      const s = String(cell).trim();
      return s !== "" && s.toLowerCase() !== "cell image";
    });
    if (!meaningful) continue;
    const obj = { _row: i + 1 };
    headers.forEach((h, j) => { if (h) obj[h] = String(row[j] || "").trim(); });
    data.push(obj);
  }

  return { success: true, data: data, headers: headers.filter(h => h !== "") };
}

// ---- Events ----
function getEvents() {
  const ss = getSS();
  let sheet = ss.getSheetByName(SHEET_EVENTS);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  return data.map((row, i) => ({
    id:     i + 2,
    title:  String(row[0] || "").trim(),
    date:   formatSheetDate(row[1]),
    time:   formatSheetTime(row[2]),
    desc:   String(row[3] || "").trim(),
    author: String(row[4] || "").trim()
  })).filter(e => e.title !== "");
}

function addEvent(token, eventData) {
  const auth = validateToken(token);
  if (!auth || auth.level < 2) return { success: false, message: "Keine Berechtigung." };

  const ss = getSS();
  let sheet = ss.getSheetByName(SHEET_EVENTS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_EVENTS);
    sheet.appendRow(["Titel", "Datum", "Uhrzeit", "Beschreibung", "Erstellt von"]);
    sheet.getRange(1, 1, 1, 5).setFontWeight("bold").setBackground("#1e1e2e").setFontColor("#ffffff");
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([
    eventData.title || "",
    eventData.date  || "",
    eventData.time  || "",
    eventData.desc  || "",
    auth.username
  ]);
  return { success: true };
}

function deleteEvent(token, rowIndex) {
  const auth = validateToken(token);
  if (!auth || auth.level < 4) return { success: false, message: "Keine Berechtigung." };

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_EVENTS);
  if (!sheet) return { success: false, message: "Events-Tabelle nicht gefunden." };
  sheet.deleteRow(rowIndex);
  return { success: true };
}

// ---- Kündigungen lesen ----
function getKuendigungen(token) {
  const auth = validateToken(token);
  if (!auth || auth.level < 4) return { success: false, message: "Keine Berechtigung." };

  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_KUENDIGUNGEN);
  if (!sheet) return { success: true, data: [] };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true, data: [] };

  const rows = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  const data = rows.map(row => ({
    datum:    String(row[0] || "").trim(),
    id:       String(row[1] || "").trim(),
    dn:       String(row[2] || "").trim(),
    name:     String(row[3] || "").trim(),
    rang:     String(row[4] || "").trim(),
    division: String(row[5] || "").trim(),
    invite:   formatSheetDate(row[6]),
    grund:    String(row[7] || "").trim(),
    text:     String(row[8] || "").trim(),
    admin:    String(row[9] || "").trim()
  })).filter(k => k.name !== "");

  return { success: true, data: data };
}

// ---- Setup ----
function setupSheets() {
  const ss = getSS();

  let adminSheet = ss.getSheetByName(SHEET_ADMINS);
  if (!adminSheet) {
    adminSheet = ss.insertSheet(SHEET_ADMINS);
    adminSheet.appendRow(["Benutzername", "Passwort (SHA-256)", "Level (1-4)"]);
    // Passwörter direkt als Hash speichern
    adminSheet.appendRow(["admin",  sha256Hex("admin123"),  4]);
    adminSheet.appendRow(["mod",    sha256Hex("mod123"),    3]);
    adminSheet.appendRow(["event",  sha256Hex("event123"),  2]);
    adminSheet.appendRow(["law",    sha256Hex("law123"),    1]);
    adminSheet.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#1e1e2e").setFontColor("#ffffff");
    adminSheet.setFrozenRows(1);
  }

  let evSheet = ss.getSheetByName(SHEET_EVENTS);
  if (!evSheet) {
    evSheet = ss.insertSheet(SHEET_EVENTS);
    evSheet.appendRow(["Titel", "Datum", "Uhrzeit", "Beschreibung", "Erstellt von"]);
    evSheet.getRange(1, 1, 1, 5).setFontWeight("bold").setBackground("#1e1e2e").setFontColor("#ffffff");
    evSheet.setFrozenRows(1);
  }

  let kuendSheet = ss.getSheetByName(SHEET_KUENDIGUNGEN);
  if (!kuendSheet) {
    kuendSheet = ss.insertSheet(SHEET_KUENDIGUNGEN);
    const headers = ["Datum", "ID", "DN", "Name", "Rang", "Division",
                     "Eingestellt am", "Kündigungsgrund", "Begründung", "Bearbeitet von"];
    kuendSheet.appendRow(headers);
    kuendSheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#7c1d1d").setFontColor("#ffffff");
    kuendSheet.setFrozenRows(1);
  }

  return {
    success: true,
    message: "Setup abgeschlossen. Passwörter werden als SHA-256-Hash gespeichert.\n" +
             "Level 4 (Admin): admin / admin123\n" +
             "Level 3 (HR): mod / mod123\n" +
             "Level 2 (TD): event / event123\n" +
             "Level 1 (LAW): law / law123"
  };
}

/**
 * Einmalig aus dem Apps Script-Editor ausführen, um alle noch im Klartext
 * gespeicherten Passwörter im Admins-Sheet sofort zu hashen.
 * Bereits gehashte Einträge (64-stellig hex) werden übersprungen.
 */
function migrateAllAdminPasswords() {
  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_ADMINS);
  if (!sheet) { Logger.log("Admins-Sheet nicht gefunden."); return; }

  const data = sheet.getDataRange().getValues();
  let migrated = 0;
  for (let i = 1; i < data.length; i++) {
    const stored = String(data[i][1]).trim();
    if (!stored) continue;
    if (/^[0-9a-f]{64}$/.test(stored)) continue; // bereits Hash
    sheet.getRange(i + 1, 2).setValue(sha256Hex(stored));
    migrated++;
    Logger.log("Migriert: " + String(data[i][0]).trim());
  }
  Logger.log(migrated + " Passwort(e) gehasht.");
}
