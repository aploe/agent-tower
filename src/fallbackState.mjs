// Copied from agent-colony@7da77bb: src/sources/sessions.mjs
// Changed: only parseMs, PROMPT_EDGE_TOLERANCE_MS, INTERACTIVE_TOOLS and decideState; the two constants are now exported; code and German comments unchanged.

/** Zeitstempel-Parser mit Waechter: ein kaputter oder fehlender ISO-String
 *  bricht nichts, sondern liefert `null` -- ein unparsebarer `since`-Wert hat
 *  in Task 1 beinahe die ganze Erhebung umgerissen. `Date.parse('garbage')`
 *  liefert `NaN`, nie einen Wurf; der Waechter macht daraus die ehrliche
 *  Auskunft "nicht ermittelbar" statt eine `NaN`, die sich in Vergleichen
 *  lautlos wie ein gueltiger, aber falscher Zeitstempel verhaelt. */
export function parseMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Toleranz fuer den R24-Zeitvergleich (siehe decideState): der `tool_use`-
 *  Record wird vom Modell geschrieben, das `PermissionRequest`-Ereignis (und
 *  damit die Statusdatei) feuert erst danach. Gemessen an Session
 *  4fd42af6 (2026-09-13): `tool_use` 09:01:53.516Z, Hook-`since`
 *  09:01:53.729Z -- 213 ms Jitter fuer denselben, tatsaechlich zusammen-
 *  gehoerigen Aufruf. Ein echter Folgeaufruf nach erteilter Erlaubnis liegt
 *  Minuten dahinter (in derselben Session real 50 Minuten 10 Sekunden --
 *  der urspruengliche Aufruf wurde nach fast 50 Minuten beantwortet, danach
 *  lief ein voellig unabhaengiger Bash-Aufruf). 2000 ms ist großzuegig genug
 *  fuer die Schreibreihenfolge und schluckt keinen echten Folgeaufruf. */
export const PROMPT_EDGE_TOLERANCE_MS = 2000;

/** Tools, deren Antwort eine Handlung des Menschen ist, keine des Hooks: fuer
 *  `AskUserQuestion` und die Plan-Freigabe (`ExitPlanMode`) feuert weder ein
 *  `PermissionRequest`- noch ein `Notification`-Ereignis -- der Hook kann
 *  diese Fragen schlicht nicht sehen und meldet in der Zwischenzeit weiter
 *  `working`. Ihr `tool_use` steht ohne `tool_result` im Transkript, solange
 *  die Frage offen ist -- genau das Signal, das die Heuristik ohnehin schon
 *  berechnet (`pendingToolUse` in transcript.mjs). Fund vom 2026-09-13 an
 *  Session a71eff33 (Details in docs/HISTORIE.md).
 *
 *  `EnterPlanMode` gehoert NICHT dazu: das startet nur den Planungsmodus,
 *  es wartet nicht auf eine Antwort des Menschen. */
export const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Die Zustandsentscheidung als reine Funktion ihrer Eingabe -- herausgeloest
 *  aus `loadAgents`, damit die Rangfolge tabellarisch testbar ist
 *  (`tests/decideState.test.mjs`), ohne Transkript oder Registry anzufassen.
 *
 *  `hookStatus` ist bereits der fuer diese Figur gueltige Status-String (oder
 *  `null`) -- die Frage, ob der Hook fuer eine Figur ueberhaupt gilt (nur
 *  Hauptsessions, nur bei lebendem Prozess), entscheidet diese Funktion
 *  selbst ueber `isOpen`/`sub`, nicht der Aufrufer. Genau das macht "Subagent
 *  bekommt nie den Hook" tabellarisch pruefbar, statt es beim Aufrufer
 *  stillschweigend vorauszusetzen.
 *
 *  `openTool` ist der Name des offenen Tool-Aufrufs (oder `null`) -- kleinste
 *  Erweiterung neben dem schon vorhandenen `open`-Flag, noetig fuer den
 *  INTERACTIVE_TOOLS-Zweig unten.
 *
 *  `openSinceMs`/`hookSinceMs` sind geparste Zeitstempel (`parseMs`, `null`
 *  wenn unbekannt oder unparsebar) fuer den R24-Zeitvergleich: der Zeitpunkt
 *  des offenen `tool_use` gegen den Zeitpunkt der Hook-Meldung. */
export function decideState({
  hookStatus,
  open,
  openTool = null,
  openSinceMs = null,
  hookSinceMs = null,
  pendingMin,
  ageMin,
  recType,
  isOpen,
  sub,
  thresholds,
}) {
  const { agentWorkingMinutes, agentPromptMinutes, agentWaitingMinutes } = thresholds;

  // Prozess weg: niemand arbeitet, niemand wartet — egal was das Transkript
  // oder eine liegengebliebene Statusdatei sagt. Haerteste Aussage, schlaegt
  // alles, auch einen (falschen) Hook-Eintrag.
  if (isOpen === false) return { state: 'idle', statusSource: 'transcript' };

  // Der Hook ist die einzige Quelle, die nicht raet — nur gueltig, solange
  // der Prozess nachweislich lebt, und nur fuer Hauptsessions: rec.sessionId
  // zeigt bei einem Subagenten auf die Session des Parents, die Figur wuerde
  // sonst den Zustand ihres Parents erben statt eigenen.
  if (isOpen === true && !sub && hookStatus != null) {
    // Fix vom 2026-09-13, Reihenfolge korrigiert in Fix-Runde 1 (Review,
    // Critical): diese Pruefung steht bewusst VOR dem R24-Zeitvergleich
    // unten und ist unabhaengig vom gemeldeten `hookStatus` -- nicht nur
    // bei `working`. Grund: der Hook hat fuer "Erlaubnis erteilt" kein
    // Ereignis (siehe R24 unten), die Statusdatei bleibt nach einer
    // gewaehrten Permission-Abfrage also auf `prompt` stehen, bis das
    // naechste Hook-Ereignis eintrifft. Stellt die Session im selben Turn
    // eine neue `AskUserQuestion`/`ExitPlanMode`, waere deren `tool_use`
    // juenger als diese (veraltete) `prompt`-Meldung -- der Zeitvergleich
    // unten wuerde daraus faelschlich `working` machen, waehrend der Mensch
    // gerade wirklich gefragt ist (vom Reviewer gefunden: `hookStatus:
    // 'prompt'`, offener `AskUserQuestion` juenger als `hookSinceMs` +
    // Toleranz ergab faelschlich `working`). `AskUserQuestion`/`ExitPlanMode`
    // sind eindeutig, unabhaengig davon, was der Hook zuletzt gemeldet hat
    // (`working`, `prompt`, ...) -- ihr offener `tool_use` heisst immer
    // "wartet auf den Menschen". Keine Minutenschwelle, `agentPromptMinutes`
    // gilt nur fuer die reine Heuristik unten. Genau eine Bedingung, keine
    // Kaskade zurueck in die Heuristik (Projektregel "Zustandsuebergaenge
    // nur eine Stufe").
    if (open && INTERACTIVE_TOOLS.has(openTool)) {
      return { state: 'prompt', statusSource: 'hook' };
    }
    // R24, korrigiert am 2026-09-13: die fallende Flanke einer Permission-
    // Abfrage liefert der Hook nicht ("Erlaubnis erteilt" feuert kein eigenes
    // Ereignis). Das fruehere Kriterium "kein offener Tool-Aufruf" war
    // falsch: eine arbeitende Session hat fast immer einen offenen Aufruf --
    // das ist ihr Normalzustand, kein Signal fuer "Abfrage beantwortet".
    // Richtig ist der Zeitvergleich: der offene Aufruf ist derselbe, auf den
    // sich die Abfrage bezieht, genau dann, wenn sein `tool_use` VOR der
    // Abfrage geschrieben wurde (plus Jitter-Toleranz). Ein offener Aufruf,
    // der NACH der Abfrage begann, beweist, dass die Session laengst
    // weitergearbeitet hat. Befund an Session 4fd42af6 (2026-09-13): der
    // urspruengliche Aufruf, auf den sich die Abfrage bezog, wurde nach fast
    // 50 Minuten beantwortet, danach lief ein voellig unabhaengiger Bash-
    // Aufruf -- der Hook meldete waehrenddessen weiter `prompt`, ohne dass ein
    // Mensch gefragt war. Der `INTERACTIVE_TOOLS`-Zweig oben muss dieser
    // Pruefung vorausgehen, sonst verschluckt genau dieser Zeitvergleich eine
    // echte, neue Frage (siehe oben).
    //
    // Genau eine Bedingung, keine Kaskade zurueck in die Heuristik
    // (Projektregel "Zustandsuebergaenge nur eine Stufe"). Sind Open- oder
    // Hook-Zeitstempel unbekannt, bleibt das bisherige, unscharfe Verhalten:
    // `prompt` bei offenem Aufruf -- ehrlich unscharf statt falsch scharf.
    if (hookStatus === 'prompt') {
      const openIsNewer =
        openSinceMs != null && hookSinceMs != null && openSinceMs > hookSinceMs + PROMPT_EDGE_TOLERANCE_MS;
      if (!open || openIsNewer) return { state: 'working', statusSource: 'hook' };
      return { state: 'prompt', statusSource: 'hook' };
    }
    return { state: hookStatus, statusSource: 'hook' };
  }

  // Der Zeitdeckel agentWaitingMinutes ist ein Notbehelf fuer den Fall, dass
  // die Registry nichts weiss. Ist die Session nachweislich offen, wartet
  // die Frage so lange, bis jemand reagiert — auch nach Stunden.
  const withinCap = isOpen === true || ageMin <= agentWaitingMinutes;

  let state;
  // `prompt` schlaegt `working`: eine Permission-Abfrage in den ersten drei
  // Minuten darf nicht gruen leuchten.
  if (open && pendingMin >= agentPromptMinutes && withinCap) state = 'prompt';
  else if (ageMin <= agentWorkingMinutes) state = 'working';
  else if (withinCap && recType === 'assistant') state = 'waiting';
  else state = 'idle';
  return { state, statusSource: 'transcript' };
}
