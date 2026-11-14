# Scelte tecniche (e le alternative scartate)

Questo documento spiega **perché** Hand Control è fatto così. Ogni scelta importante
ha le opzioni messe a confronto. Se vuoi cambiarne una, il punto da toccare è indicato.

---

## 1. Come far muovere davvero mouse e tastiera su Windows

| Opzione | Pro | Contro | Verdetto |
|---|---|---|---|
| **`koffi` + `SendInput`** (chiama `user32.dll` direttamente) | Nessun programma esterno. ~0,05 ms a mossa. Libreria attiva, ha file già pronti per Electron (nessuna compilazione sul PC). Uso "normale" di Windows. | Una dipendenza nativa in più (ma precompilata). | ✅ **Scelta** |
| `robotjs` | Famoso, semplice | Non più mantenuto da anni; va **ricompilato** per ogni versione di Electron (serve Visual Studio Build Tools); spesso si rompe agli aggiornamenti | ❌ |
| `nut.js` | Moderno, molte funzioni (immagini, finestre) | La versione ufficiale ora è a pagamento/registro privato; il fork libero è meno aggiornato; è pesante (porta anche visione artificiale) | ❌ |
| **PowerShell** a ogni mossa/click (come fa JARVIS oggi) | Zero dipendenze | Lento (300–800 ms **per click**), compila codice C# al volo a ogni volta (gli antivirus lo guardano male), impossibile per il movimento continuo | ❌ |
| Un helper `.exe` esterno (C#/Go) | Veloce | Un programma in più da firmare, mantenere e far accettare all'antivirus | ❌ (per ora) |

**Antivirus:** `SendInput` è la stessa funzione che usano tastiere virtuali, strumenti di accessibilità e
AutoHotkey. Non c'è codice che si scarica o si compila al volo. L'app comunque non è "firmata": al primo
avvio SmartScreen può mostrare un avviso (vedi README, sezione installazione).

**Dove cambiarlo:** tutto è in `src/main/input.cjs` (una classe con 5 metodi: `moveNorm`, `button`, `click`,
`wheel`, `releaseAll`). Sostituire `koffi` con altro significa riscrivere solo quel file.

**Limite di Windows (UIPI):** un programma normale non può "cliccare" dentro finestre avviate come
Amministratore. Per quelle serve avviare Hand Control anch'esso come Amministratore.

---

## 2. Dove gira il riconoscimento della mano

| Opzione | Verdetto |
|---|---|
| **MediaPipe Tasks (HandLandmarker) nella pagina di Electron**, con il motore e il modello **dentro l'app** | ✅ Scelta. Stessa tecnologia di JARVIS, ma senza scaricare nulla da internet (JARVIS oggi lo carica da una CDN a ogni avvio). Usa la GPU (WebGL) e ripiega sulla CPU. |
| Python + MediaPipe in un processo separato | ❌ Un secondo runtime da installare, comunicazione più lenta. |
| Modello ONNX personalizzato | ❌ Molto lavoro per risultati simili; MediaPipe è già molto buono. |

Il modello (`assets/models/hand_landmarker.task`, ~7,8 MB, licenza Apache 2.0 di Google) e i file `wasm`
sono serviti da un protocollo interno `hc://` (solo file locali).

---

## 3. Come funziona "a distanza" (1–3 metri)

Il problema: una webcam normale vede la mano **piccolissima** a 3 metri, e il modello di Google ha bisogno
di una mano di almeno ~30–40 pixel per riconoscerla.

La soluzione implementata ("ritaglio che segue la mano"):
1. chiediamo alla fotocamera **1080p**;
2. quando vediamo la mano, diamo al modello solo un **ritaglio** attorno ad essa (grande ~2,8 volte la mano),
   che la segue; il modello "vede" una mano grande anche se lontana;
3. quando la mano sparisce, cerchiamo a giri: tutta l'immagine, poi il centro ingrandito, poi i lati.

Tre preset: **Vicino** (fino a 1,5 m, 720p, nessun ritaglio), **Medio** (1,5–2,5 m), **Lontano** (2,5–4 m).
Limite onesto: dipende dalla fotocamera. Una webcam da 1080p con grandangolo largo è il caso peggiore; una con
ottica più "stretta" o 4K è molto meglio. **I valori reali vanno misurati con la tua fotocamera**
(vedi scheda *Misure* nell'app e `docs/MISURE.md`).

---

## 4. Come si evitano i click per sbaglio

* Il controllo parte **sempre in pausa**. Per attivarlo serve un gesto deliberato (mano aperta **ferma**
  ~1,6 s, con barra di avanzamento). Muovere o salutare con la mano ricomincia il conteggio.
* **Pausa** con lo stesso gesto (~0,9 s), oppure `Ctrl+Alt+P`.
* **Blocco di emergenza**: `Ctrl+Alt+K` (globale, funziona con l'app in secondo piano), pulsante rosso,
  icona nella barra, oppure **pugno chiuso fermo ~1 s**. Da bloccato i gesti sono ignorati; si esce **solo**
  da tastiera/pulsante, e si torna in *pausa*, mai direttamente in *attivo*.
* **Il "giudice" è il processo principale**, non la finestra con la fotocamera: se la finestra si bloccasse
  o venisse manomessa, i comandi del mouse vengono comunque scartati quando non si è ATTIVI. Il rilascio
  dei tasti è invece **sempre** permesso (mai lasciare un tasto incastrato).
* **Guardia**: se un tasto resta premuto e non arrivano più segnali per 1,5 s, lo rilascia.
* **Mano persa**: tasto rilasciato dopo 0,35 s; pausa automatica dopo 20 s senza mano (regolabile).
* **Mouse vero**: se muovi tu il mouse, la mano si ferma per 1,5 s (così non "litigano").

## 5. Click: perché "giù al pizzico, su all'apertura"

Un click classico è **premere** e **rilasciare**. Il pizzico fa esattamente questo, quindi click, doppio
click e trascinamento vengono gratis e con la minima latenza:

* pizzico breve = click; due pizzichi = doppio click (il secondo si "incolla" allo stesso punto del primo);
* pizzico **tenuto** e mano mossa = trascinamento (dopo 0,28 s, regolabile).

Il problema classico: quando pizzichi, il dito si muove e il click cade accanto al bersaglio. Soluzioni:
* il cursore è guidato dalla **nocca dell'indice** (si muove poco quando pizzichi), non dalla punta;
* il click viene piazzato nella posizione che il cursore aveva ~30 ms **prima** che il pizzico fosse
  riconosciuto, e il cursore resta fermo per 0,28 s.

## 6. Smorzamento del tremolio

Filtro **One Euro** (standard per cursori da mano/occhi): da fermo "liscia" molto, quando ti muovi veloce
quasi non aggiunge ritardo. Il cursore è filtrato **in pixel di schermo**, così la regolazione vale uguale
su ogni risoluzione. Il cursore **raggiunge sempre gli angoli** (c'è una "calamita" del 2% ai bordi dell'area).

## 7. Privacy

* Nessuna richiesta di rete: ogni indirizzo che non sia locale viene **cancellato** prima di partire (e contato,
  vedi la riga "Richieste di rete bloccate" nell'app), più una regola CSP nella pagina.
* La fotocamera si apre solo con l'app avviata, c'è sempre un **indicatore**: pallino rosso "CAMERA" nel
  badge sempre in primo piano in alto + nome nella barra di sistema. Si può spegnere dal pulsante.
* I fotogrammi non vengono salvati: sono guardati e subito scartati. Le "misure" salvano **solo numeri**.
* Solo la finestra dell'app può chiedere la fotocamera, solo video (mai il microfono).
* Si salvano soltanto le impostazioni (`settings.json` in `%APPDATA%\Hand Control`).

## 8. Perché "non toccare" JARVIS

Il codice di JARVIS è stato **solo letto** per capire il suo cursore "air-tap". Il nuovo progetto è
indipendente (cartella e repository suoi). Cose che qui sono diverse di proposito:
motore e modello locali (non da CDN), un solo canale per il mouse con filtri e sicurezza nel processo
principale, SendInput diretto invece di PowerShell, smorzamento, area attiva calibrabile, gesti di pausa/blocco.
