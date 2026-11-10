# Overclock

Un gioco arcade in pixel art 3D: **sei tu il clock** del processore. Ogni tocco è un colpo di clock. Dopo ogni colpo i bit corrono verso il registro successivo e tu devi dare il colpo seguente quando sono arrivati tutti.

- **Troppo presto**: i latch catturano bit che non sono ancora arrivati. È un glitch: perdi una vita e il valore sbagliato prosegue *davvero* nella pipeline, fino ai registri o alla memoria, che diventano rossi.
- **Appena in tempo**: `PERFETTO!` (entro 0,1 s da quando l'ultimo bit è arrivato) o `BUONO` (entro 0,3 s). La combo sale e con lei il moltiplicatore, fino a ×4.
- **Troppo tardi**: `LENTO`, pochi punti e la combo si azzera.

Tre glitch e il processore va in `CRASH!`. Ogni 20 colpi di fila in tempo (perfetti o buoni) recuperi una vita.

## Processori

Ci sono cinque processori, ognuno con il suo chip e una regola presa da come funziona davvero. Si sceglie dopo *Gioca*, e il chip dietro al menu cambia mentre si passano.

| Processore | Com'è davvero | Cosa cambia nel gioco | Il chip |
|---|---|---|---|
| **Ciclo singolo** | un'istruzione intera per colpo di clock, senza registri tra gli stadi | a ogni colpo un'onda sola attraversa tutto il chip, e l'occhio di bue la segue. Il ritmo è lento e irregolare (da 0,5 a 1,1 s, la LOAD con il `MISS` di più). A fine partita: quanto ci avrebbe messo un clock fisso, tarato sull'istruzione più lenta | DIP di ceramica bianca, die dorato |
| **Multi-ciclo** | l'istruzione è spezzata in passi; una sola memoria per istruzioni e dati e una sola ALU, riusate; il controllo è una macchina a stati | un colpo per passo: 4 per le operazioni (IF ID EX WB), 5 per la LOAD, 4 per la STORE. Le 5 spie sull'unità di controllo mostrano il percorso dell'istruzione e il passo in corso; l'accordo si chiude solo all'ultimo passo. A fine partita il CPI | PGA di ceramica grigia, die verde acqua |
| **Pipeline** | cinque istruzioni insieme, una per stadio | il gioco originale, invariato (anche le classifiche di prima sono le sue) | QFP, die blu |
| **Microcontrollore** | dorme quasi sempre, va a batteria, si sveglia con gli interrupt | un piedino si accende (`IRQ!`), l'oscillatore riparte e dai il clock alla routine di interrupt (la prima battuta preleva il vettore, poi 4 istruzioni) entro la scadenza, se no `OVERRUN!` e perdi una vita. Dopo `RETI` torna a dormire: un colpo dato mentre dorme (`DORME!`) spreca batteria e azzera la combo. Al posto del calore c'è la batteria: ogni colpo consuma, di più se corri; quasi scarica rallenta il chip, a zero è `BROWN-OUT!`. Se arriva un interrupt durante un altro, la routine dopo parte subito (tail-chaining) | DIP di plastica nera, periferiche sul bordo |
| **GPU** | tante corsie semplici eseguono la stessa istruzione su dati diversi; si aspetta sempre la più lenta | ogni colpo manda un'istruzione a 16 corsie, che finiscono in momenti diversi: tocchi quando sono verdi tutte. Lo shader colora una riga di un'immagine (un'astronave al tramonto) e la scrive nel framebuffer sul chip; otto righe fanno un `FRAME!` (bonus). Con l'"if" le corsie che non lo eseguono restano spente (divergenza). Un glitch lascia pixel sbagliati: gli artefatti | BGA con quattro pile di memoria HBM, senza fili d'oro |

Le frequenze in alto sono equivalenze giocose, ognuna nell'unità del suo processore (MHz per i più vecchi e per il microcontrollore, GHz per pipeline e GPU).

## Modalità

| Modalità | Regole | In classifica |
|---|---|---|
| **Classica** | 60 secondi, 3 vite | i punti |
| **Sprint 50** | 50 istruzioni corrette, 3 vite | il tempo, solo se arrivi in fondo |
| **Sopravvivenza** | niente tempo limite. Il *watchdog* concede un ritardo massimo dopo l'arrivo dei bit, che parte da 1 s e scende fino a 0,28 s: se lo superi dà lui il colpo di clock e perdi una vita | i punti |
| **Allenamento** | niente vite né tempo, con le spie degli stadi in basso | non si salva |
| **Sfida del giorno** | una Classica con lo stesso programma per tutti, che cambia ogni giorno; anche il processore cambia ogni giorno (dall'11/11/2026: GPU, microcontrollore, ciclo singolo, multi-ciclo, pipeline, e da capo) | il miglior punteggio di oggi |
| **Sfide tra amici** | chi crea la sfida sceglie processore e modalità e riceve un codice di 5 caratteri (o un link `?sfida=CODICE`). Tutti giocano lo stesso programma | il migliore di ognuno nella sfida |

Tutte le modalità funzionano su tutti i processori, e ogni processore ha le sue classifiche: i tempi sono troppo diversi per confrontarli.

"Lo stesso programma" vuol dire stesso seme: stesse istruzioni, stessi dati iniziali e stessi `MISS` della memoria. Dopo un glitch i dati cambiano davvero, quindi le partite si allontanano.

## Account, classifiche e sfide

Con `server.py` acceso ci si registra con un nome e una password e ogni partita delle modalità da classifica viene salvata: punti, tempo, istruzioni corrette, perfetti, buoni, lenti, glitch, combo massima e picco di GHz. Ci sono:

- le **classifiche** per processore e modalità, di sempre o degli ultimi 7 giorni, più quella della sfida del giorno;
- il **profilo** di ogni giocatore (si apre toccando il nome in classifica), con totali, record e posizione per ogni processore provato, e ultime partite;
- le **sfide**: dopo una partita, *Sfida un amico su questa partita* crea una sfida sullo stesso programma e ci mette dentro il tuo risultato. Ogni sfida ha codice, link e QR code;
- **Invita amici** nel menu: un QR code da far inquadrare con il telefono, che apre il gioco.

I QR code (nel menu e nel terminale) contengono sempre l'indirizzo di rete del server, anche se il gioco è aperto da `localhost`.

Chi gioca come ospite può fare tutto tranne salvare. Alla fine della partita può accedere e salvarla lo stesso. Il record resta comunque nel browser, per processore.

Le partite di prima dei processori sono finite tutte sotto la pipeline: il server aggiunge da solo la colonna `cpu` al database la prima volta che parte. Un browser con la pagina nuova e un server ancora vecchio (non riavviato) gioca a tutto, ma salva solo le partite della pipeline e lo dice.

Senza server (per esempio con `python3 -m http.server`) il gioco funziona lo stesso, solo come ospite.

## Cosa rende il ritmo difficile (ed è tutto vero)

Vale per tutti i processori, con la geometria di ognuno.


| Cosa | Perché |
|---|---|
| Le **somme** con tanti riporti sono più lente | l'ALU è un sommatore a propagazione del riporto: ogni fetta aspetta il riporto da quella sotto. `0x7F + 1` è molto più lenta di `0x10 + 0x01`. XOR, AND e OR invece sono rapide. |
| Le **LOAD** dipendono da dove sta il dato | le colonne lontane della memoria hanno fili più lunghi. Dopo 20 secondi a volte la memoria "manca" il dato (`MISS!`) e bisogna aspettare 0,7 secondi in più. |
| Il **calore** rallenta tutto | più alta è la frequenza, più il chip scalda (diventa arancio e rosso), e il silicio caldo è più lento. Se corri troppo, i bit arrivano sempre più tardi. |
| Anche le istruzioni e i registri contano | l'istruzione da prelevare e il registro da leggere stanno più o meno lontano dai latch. |
| Nella GPU, la corsia più lontana | ogni corsia ha i suoi riporti, e quelle lontane dalla cache delle texture o dalla ROP ricevono e scrivono più tardi. |
| Nel microcontrollore, la periferica | `IN` e `OUT` viaggiano sul bus delle periferiche: il pulsante e il timer stanno più lontano dell'ADC. |

## Si gioca guardando il chip

Non ci sono spie riassuntive: tutto quello che serve per decidere quando toccare sta sul processore.

- **I registri di pipeline**: quattro file di latch, una alla fine di ogni stadio. Mentre lo stadio lavora la fila è rossa, e ogni spia sopra un latch passa da ambra a verde quando arriva il suo bit. Quando il registro ha ricevuto tutti i bit **la fila intera diventa verde**. Al colpo di clock i latch lampeggiano bianchi (catturato) o rossi (catturato male).
- **Il registro scritto dal write-back**: la sua colonna nel banco dei registri pulsa ambra mentre aspetta il risultato e diventa verde quando è arrivato.
- **L'occhio di bue**: gli stadi che hanno finito si abbassano di luce, quello ancora al lavoro resta acceso. Se ne resta uno solo si accende un po' di più. Il chip si "spegne" a ondate, e quando è tutto in penombra è il momento di toccare.
- **Le note**: ogni stadio che finisce suona la sua nota (IF, ID, EX, MEM e WB hanno note diverse), e quando finisce l'ultimo l'accordo si chiude. Si può giocare anche a orecchio, lasciando gli occhi sul chip.
- **La scritta sopra l'ALU**: l'istruzione in esecuzione. `ADD!` e `SUB!` vogliono dire che probabilmente serve più tempo.
- **GHz in alto**: la frequenza a cui stai suonando il clock. È un'equivalenza giocosa, non una misura vera.

Per i `PERFETTO!` non basta reagire: bisogna *anticipare*, guardando i bit che si avvicinano ai registri e il riporto che sale nell'ALU.

Con `?aiuto` nell'indirizzo tornano le spie degli stadi in basso (IF ID EX MEM WB, o quelle del processore scelto), utili per imparare.

Gli altri processori hanno i loro segnali: nel ciclo singolo diventa verde la colonna del registro (o della memoria) che sta per essere scritta, nel multi-ciclo le file di IR, A, B, ALUOut e MDR, nella GPU i 16 latch delle corsie, nel microcontrollore l'IR e il registro di destinazione. Il microcontrollore che dorme è in penombra, con una `Z` che sale e l'oscillatore spento; il piedino che ha chiamato lampeggia sempre più in fretta mentre la scadenza si avvicina.

## Avvio

```bash
cd overclock
python3 server.py
```

Il server stampa i due indirizzi, `http://localhost:8765/` per questo computer e `http://<indirizzo-del-mac>:8765/` per gli altri dispositivi della rete, e sotto un QR code con il secondo: lo si inquadra con la fotocamera del telefono e si apre il gioco. Serve solo Python 3 (niente da installare) e, per chi gioca, l'accesso a internet, perché Three.js e il font del menu arrivano da CDN. Si ferma con Ctrl+C.

Opzioni: `--port 8080`, `--host 127.0.0.1` (solo da questo computer), `--db percorso/altro.db`, `--qr` (stampa solo il QR code ed esce: utile quando il server gira già in background).

Se su un dispositivo il gioco non parte, la pagina lo dice e controlla da sola cosa non raggiunge: il server del gioco o Three.js su internet.

### Lasciarlo acceso senza terminale

Per farlo girare anche a terminale chiuso, senza che il Mac vada in stop mentre il server è acceso:

```bash
cd overclock
nohup caffeinate -i python3 -u server.py >> data/server.log 2>&1 &   # avvio; il registro va in data/server.log
kill $(lsof -tiTCP:8765 -sTCP:LISTEN)                                 # spegnimento
```

`caffeinate -i` blocca solo lo stop per inattività e si chiude da solo quando si spegne il server. Lo schermo si spegne comunque. Chiudendo il coperchio del portatile il Mac va in stop lo stesso. Dopo un riavvio del Mac il server va lanciato di nuovo.

I dati stanno in `data/overclock.db` (SQLite). Per fare una copia basta copiare il file a server fermo. Per ricominciare da zero si cancella. Le password sono salvate come hash PBKDF2 con sale, mai in chiaro. Il server pubblica solo `index.html` e `js/*.js`: il database e gli script Python non si possono scaricare. I vecchi link `/overclock/...` vengono girati sui nuovi.

## Comandi

- **tocco, clic, spazio o invio**: colpo di clock. Nei menu, spazio e invio premono il pulsante selezionato
- `P` o `Esc`: pausa, con Riprendi, Ricomincia ed Esci al menu (la partita va in pausa da sola anche se cambi scheda). Nei menu `Esc` torna indietro
- `M`: audio sì/no
- `F`: schermo intero

Parametri nell'indirizzo:
- `?sfida=ABCDE`: apre direttamente quella sfida
- `?cpu=gpu`: parte con quel processore (`singolo`, `multiciclo`, `pipeline`, `mcu`, `gpu`)
- `?durata=90`: secondi della Classica (solo per provare: con una durata diversa la partita non si salva)
- `?px=3`: grandezza dei pixel
- `?aiuto`: spie degli stadi in basso in tutte le modalità
- `?debug`: espone `window.__dbg` nella console (con `__dbg.freeze(true)` il tempo si ferma senza velo, utile per gli screenshot)

## Dove si regola la difficoltà

| Cosa | Dove |
|---|---|
| Finestre di `PERFETTO` e `BUONO` (0,1 s e 0,3 s), punti, moltiplicatore, vite | `js/main.js`, funzione `clockEdge` |
| Quanto rallenta il calore (o la batteria scarica), quanto scalda o consuma un colpo | `power` nel `meta` di ogni processore (`js/proc-*.js`); il raffreddamento nel ciclo `frame` di `js/main.js` |
| Tempo per fetta di riporto (`SLICE`), attesa del `MISS`, velocità dei bit su ogni percorso | in cima a ogni `js/proc-*.js` e nella sua funzione `schedule` |
| Scadenze degli interrupt, ogni quanto arrivano, quanto spesso arrivano a coppie | `js/proc-mcu.js`, `SRC` e `createCPU` |
| L'immagine della GPU (texture, cielo, tavolozza) | `js/proc-gpu.js`, `SHIP`, `SKY` e `hexes` |
| Durata della Classica, istruzioni dello Sprint, vite | `js/modes.js` (e `SPRINT_TARGET` in `server.py`) |
| Watchdog della Sopravvivenza (da 1 s a 0,28 s, −0,012 s per istruzione) | `js/main.js`, costante `WD` |
| Da quando arrivano i `MISS` in ogni modalità | `js/main.js`, funzione `missP` |
| Il processore della sfida del giorno | `server.py`, `ROTATION` e `ROTATION_START` |

## Struttura

```
server.py          server per la rete locale: file del gioco più API per account, partite, classifiche e sfide
qr.py              generatore di QR code (solo libreria standard), per il terminale e per il menu
data/              il database SQLite (lo crea il server)
index.html         pagina, canvas, stile del menu e import map di Three.js
js/main.js         stati di gioco (menu, conto alla rovescia, partita, fine), input, punteggio, HUD, telecamera
js/menu.js         le schermate HTML: benvenuto, processori, modalità, classifiche, sfide, profilo, accesso, risultati, pausa
js/modes.js        le regole delle modalità e i record del browser
js/procs.js        l'elenco dei processori e quello scelto l'ultima volta
js/proc-*.js       un file per processore: geometria del core, processore simulato, tempi dei bit, luci e scritte sue
js/isa.js          le istruzioni comuni a ciclo singolo, multi-ciclo e pipeline, con il sommatore a propagazione del riporto
js/api.js          le chiamate al server; senza server si gioca come ospite
js/engine.js       regia comune: bit in viaggio, fronte di clock, chi è arrivato in tempo, luci degli array e dei latch
js/sfx.js          suoni 8 bit sintetizzati con Web Audio, comprese le note degli stadi
js/pixel.js        il look 8 bit, più i colori ravvivati, l'occhio di bue per zone, il calore e il lampo rosso del glitch
js/scene.js        il chip in 3D, con i quattro contenitori (QFP, DIP, PGA, BGA con le HBM)
js/font.js         font bitmap 5×7 (con vocali accentate)
js/route.js        percorsi dei bit, generatore pseudo-casuale e attrezzi per disegnare un core
```

Per aggiungere un processore basta un nuovo `js/proc-*.js` con `meta`, `buildCore`, `createCPU`, `initView`, `syncView`, `anchors`, `spots` e `schedule` (più, se servono, `update`, `write`, `results`), registrarlo in `js/procs.js` e aggiungerlo a `CPUS` in `server.py`.

È nato da un progetto fratello, un'animazione dello stesso processore, ed è indipendente: non importa niente da fuori da questa cartella.

## Semplificazioni

- Un bit arrivato tardi viene catturato sempre invertito. In un chip vero il latch terrebbe il valore vecchio, oppure finirebbe in uno stato metastabile.
- Il programma evita le dipendenze tra istruzioni vicine, quindi non ci sono stalli né inoltri (forwarding). Sarebbe una buona "era" successiva del gioco.
- Un registro rosso non "contagia" chi lo legge: il rosso segna solo chi ha ricevuto una scrittura sbagliata.
- I risultati li calcola il browser e il server si fida: chi apre la console può barare. Tra amici va bene; per una classifica pubblica il server dovrebbe rigiocare la partita dai tocchi registrati.
- Il gioco viaggia in HTTP semplice sulla rete locale, quindi anche le password: meglio sceglierne una usata solo per Overclock.
- Ciclo singolo: solo PC, banco dei registri e memoria ricevono il clock, e un bit in ritardo viene scritto invertito lì; i ritardi degli stadi in mezzo si vedono e si sentono ma non si catturano.
- Multi-ciclo: il PC ha un incrementatore suo (come il 6502), così l'ALU resta una sola per i calcoli; il dato della STORE passa sotto l'ALU come nella pipeline.
- Microcontrollore: la routine principale è solo un `SLEEP` con *sleep-on-exit*, quindi dopo `RETI` dorme subito; gli interrupt arrivano a un intervallo dalla fine della routine precedente, così la durata dipende da chi gioca e lo Sprint resta giusto. Il buffer della seriale non ha controllo di traboccamento, come in tanti firmware veri.
- GPU: un solo warp per volta, che è anche una riga dell'immagine: nelle GPU vere tanti warp si alternano per nascondere l'attesa della memoria. Gli 8 bit di una corsia viaggiano su una pista sola, uno dietro l'altro.
