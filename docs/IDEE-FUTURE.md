# Idee per dopo l'MVP (non implementate)

Proposte in ordine di valore/semplicità. Nessuna è stata iniziata: da decidere insieme.

## 1. Tastiera su schermo controllata con le mani  ⭐ (la più utile)
Una tastiera a tasti grandi che compare quando serve (gesto o pulsante) e si usa "puntando e pizzicando",
come i tasti di un telefono. Si può scrivere senza tastiera vera.
* **Come:** finestra trasparente sempre in primo piano che *non ruba il focus* (come il badge attuale);
  i tasti vengono inviati con `SendInput` (già pronto: esiste `Input.key()`, usato nei test) usando il codice
  di scansione Unicode, così funzionano anche accenti e simboli.
* **Aiuti:** suggerimenti di parole (un piccolo dizionario locale italiano), tasto "invio/cancella" molto
  grandi, scrittura "a scorrimento" (swipe) con l'indice come sugli smartphone.
* **Costo:** medio (2–3 giorni). **Rischio:** la scrittura precisa a distanza è lenta → meglio tasti molto grandi.

## 2. Controllo multimediale
Volume, play/pausa, brano successivo/precedente, salto avanti/indietro di 10 s, a schermo intero.
* **Come:** gesti "a rotella" (indice + pollice che girano per il volume), swipe orizzontale per il brano,
  mano aperta tenuta per play/pausa. Si inviano i tasti multimediali di Windows (`VK_MEDIA_PLAY_PAUSE`,
  `VK_VOLUME_UP/DOWN`...), che funzionano con Spotify, YouTube, VLC, Netflix...
* **Modalità "Media":** si attiva con un gesto (es. due dita su + tieni), così i gesti da divano non
  interferiscono col cursore. Mostra un piccolo pannello con il volume.
* **Costo:** basso (1 giorno). **Valore:** alto per chi guarda film a distanza.

## 3. Gesti configurabili
Una scheda dove associare ogni gesto a un'azione scelta da una lista: click, tasto, scorciatoia
(es. `Alt+Tab`, `Win+D`), lancio di un programma, comando multimediale...
* **Come:** i gesti sono già nominati nel motore (`point`, `pinch`, `rclick`, `scroll`, `open`, `fist`):
  basta una tabella `gesto → azione` salvata nelle impostazioni, e nuove pose (pollice su, "ok",
  tre dita...) che si **registrano mostrandole alla fotocamera** (la forma della mano viene salvata come
  numeri, mai come immagini).
* **Attenzione sicurezza:** le azioni "pericolose" (chiudere finestre, spegnere, invio di tasti) devono
  chiedere conferma o richiedere due gesti in sequenza.
* **Costo:** medio-alto (3–5 giorni).

## 4. Altre idee piccole ma utili
* **Gesti a due mani:** zoom (mani che si allargano), "scorrimento orizzontale" tra desktop virtuali
  (`Win+Ctrl+←/→`), "Alt+Tab" con swipe.
* **Profili:** "Scrivania" (vicino, precisione alta) e "Divano" (lontano, cursore più lento e smorzato),
  scelti con un tasto o da soli in base alla grandezza della mano.
* **Cursore con "freno":** rallenta automaticamente quando ti avvicini a un bersaglio piccolo (come fanno
  i sistemi per l'accessibilità).
* **Calibrazione guidata a 4 angoli** con correzione prospettica (utile se la fotocamera è sopra lo schermo
  e inclinata, o quando si controllano più monitor).
* **Più monitor:** area attiva divisa fra schermi, o gesto per "saltare" al monitor successivo.
* **Auto-regolazione dell'illuminazione:** avviso "troppo buio" e consiglio (accendere una luce).
* **Modalità presentazione:** solo frecce avanti/indietro e un puntatore "laser" sullo schermo (PowerPoint
  a distanza, senza telecomando).
* **Modalità accessibilità:** soglie più larghe, tempi più lunghi, "click per permanenza" (fermi il cursore
  su un bersaglio per 1 s = click) per chi non riesce a pizzicare.
* **Installazione senza avvisi:** firma digitale del programma (costa ogni anno) per evitare SmartScreen.

## 5. Misure da fare con te (prima di tutto il resto)
Il codice dei gesti è stato provato con "mani finte" (test automatici) ma **non ancora con la tua mano
vera** su più sessioni. Prima di aggiungere funzioni conviene usare la scheda *Misure* (registrazione 20 s,
test tremolio, prova di precisione) a 1 m, 2 m e 3 m e annotare i risultati in `docs/MISURE.md`.
Così regoliamo con dati le soglie del pizzico e il ritaglio a distanza.
