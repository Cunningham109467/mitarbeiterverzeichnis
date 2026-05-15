# Mitarbeiterverzeichnis

Google Apps Script Backend + HTML-Frontend für ein internes Mitarbeiterverzeichnis.

## Dateien

| Datei | Beschreibung |
|-------|-------------|
| `Code.gs` | Google Apps Script Backend – liest/schreibt Google Sheets, verwaltet Auth, Events, Sanktionen |
| `Index.html` | Frontend – Login-Seite + Dashboard mit Suche und Tabelle |

## Setup

1. Öffne [Google Apps Script](https://script.google.com) und erstelle ein neues Projekt.
2. Kopiere `Code.gs` in die Datei `Code.gs` des Projekts.
3. Erstelle eine neue HTML-Datei namens `Index` und kopiere den Inhalt von `Index.html` hinein.
4. Passe die Konstante `SPREADSHEET_ID` in `Code.gs` auf deine Google-Tabellen-ID an.
5. Führe einmalig `setupSheets()` aus, um die Admin-Tabelle zu initialisieren.
6. Veröffentliche das Skript als Web-App: **Bereitstellen → Als Web-App bereitstellen**.

## Admin-Level

| Level | Rolle | Standard-Passwort |
|-------|-------|-------------------|
| 4 | Admin | admin123 |
| 3 | HR (Mod) | mod123 |
| 2 | TD (Event) | event123 |
| 1 | LAW | law123 |

> **Hinweis:** Passwörter werden als SHA-256-Hash gespeichert. Bitte ändere die Standard-Passwörter nach dem ersten Login.

## Tabellenblätter

Das Backend erwartet folgende Tabellenblätter in der Google-Tabelle:

- `Mitarbeiter` – Hauptliste aller Mitarbeiter
- `Admins` – Zugangsdaten
- `Daten` – Ränge & Ausbildungs-Header
- `Events` – Veranstaltungen
- `Leyla Kündigungen neu` – Kündigungsprotokoll
- `Sanktionskatalog` – Strafkatalog
- `Kleiderordnung` – Uniformregeln nach Rang
- `Kleiderordnung Division` – Uniformregeln nach Division
