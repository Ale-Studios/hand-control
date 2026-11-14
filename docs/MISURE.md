# Misure

Dove e come sono stati misurati i numeri, cosa significano e cosa **non** è ancora stato misurato.
PC di prova: Windows 11, GTX 1650 4 GB + Intel UHD 630, 16 GB RAM, schermo 1920×1080 (scala 100%), webcam
integrata/USB a 1280×720. Data: 14/11/2026. Versione app: 0.1.0.

## 1. Prova end-to-end con "mani finte" (`npm run test:e2e`)

Catena provata: fotogramma con 21 punti di una mano sintetica → pagina dell'app → motore dei gesti → processo
principale → `SendInput` → **mouse vero di Windows** → finestra di prova a schermo intero che registra gli eventi.
Profilo isolato (USERPROFILE/APPDATA/LOCALAPPDATA temporanei). **27 controlli su 27 superati.**

| Cosa | Risultato |
|---|---|
| In PAUSA la mano non muove il cursore | ✅ (0 px) |
| Mano aperta ferma 1 s non attiva; ~2 s attiva | ✅ |
| Il cursore arriva dove punti | ✅ scarto 0 px (atteso 1535,755 / ottenuto 1535,755), 48 eventi `mousemove` |
| Raggiunge i 4 angoli dello schermo | ✅ (0,0) e (1919,1079) |
| Click col pizzico (giù, su, click) | ✅ |
| Il click cade dove puntavi prima del pizzico | ✅ scarto 0 px (anche se la mano "scivola" mentre pizzichi) |
| Doppio click (due pizzichi) | ✅ la finestra riceve `dblclick` (280 ms fra i due click, stesso pixel) |
| Click destro (pizzico col medio) | ✅ un solo `contextmenu` |
| Trascinamento (pizzico tenuto e mosso) | ✅ mosso di 767 px con tasto premuto |
| Scorrimento V su/giù | ✅ nei due versi (8 e 9 scatti) |
| Pausa con mano aperta (~1 s) | ✅ e il cursore resta fermo |
| **Ctrl+Alt+K** (vero, via tastiera) con tasto premuto | ✅ blocco in **6–15 ms**; tasto del mouse rilasciato (verificato sullo stato reale di Windows) |
| Da BLOCCATO: gesti ignorati; la mano aperta non sblocca; Ctrl+Alt+K sblocca in PAUSA | ✅ |
| Pugno chiuso ~1 s = BLOCCO | ✅ |
| Mano non vista 3 s (con soglia a 3 s) = PAUSA automatica | ✅ |
| Internet bloccato (navigazione e `fetch`) | ✅ `ERR_BLOCKED_BY_CLIENT` / CSP, richieste contate |

### Latenza della parte "software" (senza fotocamera)

| Tratto | Mediana | 95° percentile |
|---|---|---|
| Fotogramma → `SendInput` terminato (pagina + IPC + sistema) | **2,5 ms** | 3,1 ms |
| Click: fotogramma → evento `mousedown` nella finestra | **13 ms** (di cui SendInput→finestra 2–3 ms) | – |
| Tasto di emergenza → modalità BLOCCATO | **6–15 ms** | – |

Per confronto, il click di JARVIS lancia PowerShell a ogni click (centinaia di ms: non misurato qui, non è stato toccato).

> ⚠️ Queste misure **non includono** fotocamera e riconoscimento: sono solo il tratto "dal momento in cui
> i punti della mano sono pronti a quando il cursore si è mosso".

## 2. Fotocamera vera + MediaPipe (`npm run bench:camera`)

Registrazione di 20 s con la fotocamera reale a 1280×720, preset *Vicino*, **senza nessuna mano davanti**
(quindi il modello lavora in "ricerca": il caso più pesante per il riconoscimento del palmo). Solo numeri salvati.

| Motore | Immagini/s | Riconoscimento (mediana / 95°) | Fotocamera→app (mediana) |
|---|---|---|---|
| **GPU potente** (`force_high_performance_gpu`, predefinito) | 15 | **25 ms** / 38 ms | 39 ms |
| Processore (CPU, XNNPACK) | 14 | 67 ms / 88 ms | 71 ms |
| GPU "predefinita" scelta da Windows | ⛔ non è partita (nessun risultato in 90 s) | – | – |

Cosa vuol dire:
* La fotocamera in quella stanza lavorava a ~15 fotogrammi/s (probabilmente poca luce: le webcam abbassano i
  fps al buio). Con più luce dovrebbe arrivare a 30; il riconoscimento (25 ms) basterebbe.
* **Stima del ritardo totale mano→cursore** = fotocamera→app (~40 ms) + riconoscimento (~25 ms) + software
  (~3 ms) ≈ **70 ms** + ritardo interno della fotocamera (sensore/USB, tipicamente 30–60 ms, non misurabile
  da software) + eventuale ritardo dello schermo. Per un cursore da puntatore a distanza è nella norma, non
  "istantaneo".
* Per questo l'app **forza la scheda video potente** all'avvio; se un PC non ce la fa, dopo 15 s senza
  immagini passa da solo al processore (e il blocco di rete di sicurezza mette in pausa se le immagini si
  fermano mentre si è ATTIVI).
* Primo avvio: la prima immagine sulla GPU può richiedere alcuni secondi (compila i programmi grafici); la
  registrazione parte quindi 8 s dopo la prima immagine.

## 3. Cosa **non** è ancora misurato (serve la tua mano)

* **Riconoscimento dei gesti con una mano vera** (pizzico/medio/V/pugno/mano aperta): soglie scelte da
  geometria della mano (rapporti fra distanze, indipendenti dalla distanza), ma da verificare. Come fare:
  scheda *Misure → Registra 20 secondi* facendo i gesti → il file `.json` conta i gesti riconosciuti.
* **Tremolio reale** a mano ferma e **precisione di click**: scheda *Misure → Test tremolio* e *Prova di precisione*
  (9 bersagli). Obiettivi: tremolio < ~3 px da fermi; errore medio di click < ~15 px; ≥ 8/9 bersagli centrati.
* **Distanza**: ripetere la registrazione a 1 m, 2 m, 3 m con i preset *Vicino/Medio/Lontano* e annotare % di
  fotogrammi con mano vista. Il ritaglio che segue la mano (*Medio/Lontano*) **non è mai stato provato con
  una mano vera**: è implementato, ma da validare.
* **Etichetta destra/sinistra** di MediaPipe (se "Solo destra" sceglie la mano sbagliata, usa "Solo sinistra").
* Più monitor, scala schermo diversa da 100% (la matematica usa pixel fisici e coordinate assolute di
  Windows, ma non è stata provata con scale diverse).
* Applicazioni "Amministratore" (limite di Windows) e giochi a schermo intero esclusivo.

### Tabella da compilare

| Data | Distanza | Luce | Immagini/s | Mano vista | Ritardo totale | Tremolio (px) | Precisione (px) | Note |
|---|---|---|---|---|---|---|---|---|
| | 1 m | | | | | | | |
| | 2 m | | | | | | | |
| | 3 m | | | | | | | |
