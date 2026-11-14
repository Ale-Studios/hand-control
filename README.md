# Hand Control

Controlla il PC **con le mani**, senza toccare mouse o tastiera, anche da qualche metro di distanza.
Una fotocamera guarda la tua mano; **tutto resta sul tuo PC** (niente internet, niente cloud, niente registrazioni).

> Stato: **MVP (v0.1)**. Provato con "mani finte" lungo tutta la catena fino al mouse vero (27 controlli
> automatici superati, ritardo del software ~3 ms) e con la fotocamera reale (motore locale su GPU: 25 ms a immagine).
> La precisione con la **tua** mano reale, soprattutto a 2–3 m, va ancora misurata: vedi [docs/MISURE.md](docs/MISURE.md).

## Cosa sa fare

| Gesto | Cosa succede |
|---|---|
| ☝️ **Indice teso** | muove il cursore (con smorzamento del tremolio) |
| 🤏 **Pizzico pollice + indice** | click sinistro · tenuto e mosso = trascinamento · due pizzichi = doppio click |
| 🤏 **Pizzico pollice + medio** | click destro |
| ✌️ **Indice + medio tesi** | scorrimento: muovi la mano su/giù |
| 🖐️ **Mano aperta ferma** | attiva / mette in pausa (barra di avanzamento) |
| ✊ **Pugno chiuso fermo** | **blocco di emergenza** |
| ⌨️ **Ctrl+Alt+K** | **blocco di emergenza** da tastiera (di nuovo = sblocca, in pausa) |

Inoltre: anteprima con scheletro della mano, indicatore di stato sempre in primo piano (ATTIVO / IN PAUSA /
BLOCCATO / mano non vista, e pallino rosso quando la fotocamera è accesa), calibrazione guidata dell'area di
movimento, impostazioni di sensibilità/smorzamento/area/distanza, e una scheda **Misure** (latenza, tremolio,
precisione).

## Avvio rapido

Servono **Windows 10/11** e **Node.js 20+** (per sviluppare). Poi:

```bash
npm install
npm start
```

1. Mettiti a 1–3 m dalla fotocamera, con la mano ben visibile.
2. Scheda **Comandi → Calibra l'area di movimento** (due angoli, 1,5 s ciascuno).
3. Tieni la **mano aperta ferma ~2 secondi**: il badge diventa verde (**ATTIVO**).
4. Punta con l'indice. Per fermare tutto: **Ctrl+Alt+K**.

Il controllo parte **sempre in pausa**: non muove nulla finché non fai tu il gesto di attivazione.

### Installarlo come programma

```bash
npm run dist
```

crea `dist\Hand Control Setup 0.1.0.exe` (installer NSIS da ~96 MB; puoi scegliere la cartella; crea collegamenti sul
Desktop e nel menu Start). Non è firmato digitalmente: al primo avvio Windows SmartScreen può mostrare «Windows ha
protetto il PC» → *Ulteriori informazioni → Esegui comunque*.
Per provare solo la build senza installer: `npm run build` (crea `dist\win-unpacked\Hand Control.exe`).
Controllo rapido di un'app costruita o installata: `"Hand Control.exe" --selftest` (verifica che mouse, motore, modello
e file ci siano, stampa il risultato e si chiude con codice 0 se tutto è a posto).
La build scarica da internet **solo** gli strumenti di costruzione di Electron/NSIS (una volta); l'app finita no.

## Permessi e sicurezza (cosa serve e cosa NON fa)

| Cosa | Serve? | Perché |
|---|---|---|
| **Fotocamera** | sì | per vedere la mano. Si accende all'avvio, c'è l'indicatore rosso "CAMERA" sempre visibile e si spegne col pulsante. Windows: *Impostazioni → Privacy e sicurezza → Fotocamera* deve consentire le app desktop. |
| **Controllo di mouse** | sì (nessun permesso speciale) | usa la funzione di sistema `SendInput`, come una tastiera/mouse virtuale. |
| **Amministratore** | no, **solo** se vuoi controllare finestre avviate come Amministratore | Windows impedisce a un programma normale di cliccare dentro quelle finestre (UIPI). |
| **Microfono** | **no** (richiesta negata dal codice) | |
| **Internet** | **no**, mai | ogni richiesta non locale viene bloccata e contata (riga *«Richieste di rete bloccate»*). Il motore e il modello di riconoscimento sono dentro l'app. |
| **Disco** | solo le impostazioni | `%APPDATA%\hand-control\settings.json`. Le misure salvano **solo numeri**. |

* **Nessuna registrazione:** i fotogrammi vengono analizzati e subito scartati; non si scrive nessuna immagine o video.
* **Controllo accidentale difficile:** parte in pausa; per attivare serve un gesto deliberato (mano aperta **ferma**
  ~1,6 s; se la muovi riparte da capo); i gesti di pausa/blocco funzionano da fermi.
* **Interruttore di emergenza che funziona sempre:** `Ctrl+Alt+K` (globale, anche con l'app in secondo piano),
  pulsante rosso, menu dell'icona nella barra, o pugno chiuso. Rilascia subito i tasti del mouse premuti.
  Da BLOCCATO i gesti non fanno nulla e si esce solo da tastiera/pulsante, tornando in *pausa*.
* Se un'altra app usa già `Ctrl+Alt+K` (per esempio JARVIS), Hand Control prova `Ctrl+Alt+Shift+K` e lo scrive
  nel registro; il pulsante rosso e il pugno restano sempre disponibili.
* Se muovi il **mouse vero**, la mano si ferma per ~1,5 s per non litigare con te.
* Se la fotocamera risulta accesa ma smettono di arrivare immagini analizzate (5 s) mentre sei ATTIVO, l'app va in pausa da sola.
* Su PC con due schede video l'app chiede a Windows di usare quella **potente** (sul PC di prova, con quella scelta da
  Windows il riconoscimento non partiva); se la scheda video non risponde passa da sola al processore
  (*Impostazioni → Fotocamera → Motore di calcolo* per sceglierlo a mano).

## A distanza (1–3 metri)

Nella scheda *Impostazioni → Fotocamera → Distanza* scegli **Vicino / Medio / Lontano**. Più è lontano, più
l'app chiede alla fotocamera 1080p e ingrandisce attorno alla mano (il ritaglio la segue). Consigli:
buona luce davanti (non controluce), sfondo non troppo caotico, manica a contrasto con la pelle,
**fotocamera 1080p** o meglio. A 3 m con una webcam economica grandangolo la mano può restare troppo piccola:
dipende dalla fotocamera, serve misurare (scheda *Misure*).

## Misure (precisione e latenza)

Scheda **Misure**:
* **In diretta:** immagini/s, tempo di riconoscimento, ritardo mano→cursore (fotocamera→app, elaborazione, mouse).
* **Registra 20 secondi:** statistiche complete (mediane, 95° percentile, % di fotogrammi con mano vista, gesti contati), salvate come `.json` in `%APPDATA%\hand-control\misure`.
* **Test tremolio (5 s):** quanti pixel "balla" il cursore a mano ferma, prima e dopo lo smorzamento.
* **Prova di precisione:** 9 bersagli da colpire col pizzico a schermo intero → errore medio in pixel e tempi.

Da terminale, senza interfaccia: `npm run bench:camera` (accende la fotocamera per ~35 s, scrive i numeri in
un profilo isolato, esce; `npm run bench:camera -- --delegate=CPU` prova il processore al posto della scheda video).
Risultati e come leggerli: [docs/MISURE.md](docs/MISURE.md).

## Provare che funziona (test automatici)

```bash
npm test          # 17 prove sul "cervello" dei gesti con mani finte (veloci, nessuna fotocamera)
npm run test:e2e  # prova completa: app vera → mouse vero → finestra che registra gli eventi (~3 min)
HC_E2E_ONLY=dbl,kill npm run test:e2e   # solo alcune sezioni (dbl = doppio click, kill = emergenza, net = rete)
```

`test:e2e` apre una finestra a schermo intero che **usa il mouse da sola per ~1 minuto** (non toccare nulla) in
un profilo isolato (`USERPROFILE/APPDATA/LOCALAPPDATA` temporanei); controlla movimento, click, doppio click, click
destro, trascinamento, scorrimento, pausa, interruttore di emergenza (con un vero `Ctrl+Alt+K`), pugno, pausa
automatica e blocco della rete, e misura la latenza.

## Struttura del progetto

```
src/core/       cervello dei gesti (puro, testabile): engine, filtri, mappatura, misure della mano
src/main/       Electron: sicurezza e modalità, SendInput (koffi), scorciatoie, icona, rete bloccata
src/renderer/   interfaccia, fotocamera + MediaPipe (tracker.mjs), overlay di stato
assets/models/  modello di riconoscimento della mano (Google, Apache 2.0)
test/           prove automatiche e prova end-to-end
docs/           scelte tecniche, idee future, misure
```

Per capire **perché** è fatto così (e le alternative scartate): [docs/SCELTE-TECNICHE.md](docs/SCELTE-TECNICHE.md).
Idee per dopo: [docs/IDEE-FUTURE.md](docs/IDEE-FUTURE.md).

## Limiti noti (onestà)

* I gesti sono stati verificati con mani sintetiche e con la catena fino al mouse; **con una mano vera servono ancora misure** e probabilmente qualche ritocco alle soglie (impostazioni *Sensibilità del pizzico*, *Durata minima di un gesto*).
* L'etichetta **destra/sinistra** di MediaPipe va confermata con la tua fotocamera (se "Solo destra" sceglie la mano sbagliata, usa "Solo sinistra").
* A 3 m il risultato dipende molto dalla fotocamera e dalla luce.
* Non può controllare finestre "Amministratore" se non avviato anch'esso come Amministratore.
* Una sola mano controlla (la più vicina, o quella scelta).
* Installer non firmato → avviso SmartScreen.

## Licenze

Codice: Ale Studios. Dipendenze: Electron (MIT), koffi (MIT), MediaPipe Tasks Vision e modello
`hand_landmarker.task` (Google, Apache 2.0).
