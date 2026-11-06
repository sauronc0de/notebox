# Notebox

Aplicació personal de notes i recordatoris, pensada sobretot per al mòbil. Backend en C++17 (cpp-httplib, nlohmann/json, SQLite amb FTS5) i frontend HTML/CSS/JS sense framework, instal·lable com a PWA. No té autenticació pròpia: **no exposis el port a Internet**. Publica-la només a la teva Tailnet.

## Com funciona

- **Notes**: és la vista principal. Té cerca de text complet que troba resultats mentre escrius (per prefix), xips de grup i un full de filtres (etiqueta, amb o sense recordatori, arxivades, ordre). Quan no hi ha cap filtre, les notes fixades surten a dalt.
- **Agenda**: aquí surten les notes amb data, que fan de recordatoris. Té una tira setmanal (es pot fer lliscar), els recordatoris endarrerits, els del dia seleccionat i els propers. Es poden marcar com a fets.
- **Avís de pendents**: hi ha un comptador a la campana, a la pestanya Agenda, al títol de la pestanya i a la icona de l'app instal·lada (Badging API). També surt una franja d'avís a Notes i un toast un cop per sessió.
- **Explora**: estadístiques, grups (crear, editar, eliminar), etiquetes (reanomenar o fusionar, eliminar) i exportació de totes les dades a JSON.
- **Editor**: ocupa tota la pantalla al mòbil. Avisa abans de descartar canvis i el botó enrere del mòbil el tanca. Ctrl+Enter desa. Si no hi ha títol, s'agafa la primera línia del text.
- **Format del text**: `- [ ]` per a caselles (es poden marcar des de la targeta), `- ` i `1.` per a llistes, `#` per a títols, `>` per a cites, `**negreta**`, `` `codi` `` i enllaços clicables.
- **Eliminar i arxivar** es poden desfer des del toast.
- **Fora de línia**: el service worker deixa veure l'última còpia de les dades si el servidor no respon.
- Dreceres d'escriptori: `N` crea una nota nova i `/` porta a la cerca.

## Estructura

- `src/main.cpp`: servidor HTTP, repositori SQLite, validació i migracions (v1 i v2).
- `third_party/httplib.h`: cpp-httplib 0.18.7 (MIT).
- `web/`: `index.html`, `style.css`, `js/` (mòduls ES: `app`, `api`, `ui`, `md`, `util`), `sw.js`, `manifest.webmanifest`, `icons/` i `fonts/` (Space Grotesk i JetBrains Mono, llicència OFL, allotjades localment).
- `data/`: base de dades SQLite (ignorada per Git). `build/`: artefactes de compilació (ignorats). `backups/`: còpies locals (ignorades).

## Instal·lació (Debian / Ubuntu / Raspberry Pi OS)

```sh
sudo ./install-service.sh
```

L'script instal·la les dependències que falten, compila, crea el servei `notebox.service` (escolta a `127.0.0.1:8080` i arrenca amb l'ordinador) i el publica a la Tailnet amb `tailscale serve --bg --https=8447 http://127.0.0.1:8080`. Torna'l a executar després de canviar el codi. Els canvis que només afecten `web/` es veuen sense reiniciar res.

Manualment:

```sh
sudo apt-get install cmake g++ libsqlite3-dev nlohmann-json3-dev
cmake -S . -B build && cmake --build build -j"$(nproc)"
./build/notebox            # NOTEBOX_HOST, NOTEBOX_PORT (8080), NOTEBOX_DATA (./data), NOTEBOX_WEB (./web)
```

En una Raspberry Pi amb poca RAM, compila amb `-j1`.

Gestió del servei:

- `sudo systemctl restart notebox`: reinicia el servei.
- `sudo systemctl disable --now notebox`: l'atura i fa que no arrenqui amb l'ordinador.
- `sudo systemctl enable --now notebox`: el torna a activar.
- `tailscale serve --https=8447 off`: deixa de publicar-lo a la Tailnet.

La PWA necessita HTTPS. Tailscale Serve ja el proporciona, així que es pot instal·lar des del navegador del mòbil amb «Afegeix a la pantalla d'inici».

## API

Totes les respostes són JSON. Les dates tenen el format `YYYY-MM-DD` i el client envia el seu `today` perquè els recordatoris segueixin la seva zona horària.

| Mètode | Ruta | Descripció |
|---|---|---|
| GET | `/api/notes` | `{items,total}`. Filtres: `search` (prefix, tots els termes), `group` (id o `none`), `tag`, `pinned`, `done`, `has_date`, `date`, `from`, `to`, `archived=false\|true\|all` (per defecte `false`), `sort=updated\|created\|title\|date`, `limit` (≤200, per defecte 50), `offset` |
| GET/PUT/PATCH/DELETE | `/api/notes/:id` | PUT reemplaça tots els camps; PATCH només canvia els camps enviats |
| POST | `/api/notes` | `{title, description, date, group_id, pinned, done, archived, tags[]}` |
| GET | `/api/agenda?today=&day=&from=&to=` | `{overdue, day, upcoming, days:{date:{total,pending}}}` |
| GET | `/api/summary?today=` | Comptadors (`pending`, `overdue`, `today`, `upcoming`, `total`, `pinned`, `archived`, `ungrouped`) i grups i etiquetes amb el seu recompte |
| GET/POST | `/api/groups` | `{name, icon}` |
| PUT/DELETE | `/api/groups/:id` | Si elimines un grup, les seves notes queden sense grup |
| GET | `/api/tags` | |
| PUT/DELETE | `/api/tags/:id` | Reanomenar una etiqueta amb el nom d'una altra que ja existeix les fusiona |
| GET | `/api/export` | Còpia completa en JSON |

```sh
curl -X POST http://127.0.0.1:8080/api/notes -H 'Content-Type: application/json' \
  -d '{"title":"Comprar","description":"- [ ] llet\n- [ ] pa","date":"2026-11-07","tags":["casa"]}'
curl 'http://127.0.0.1:8080/api/notes?search=rasp&tag=feina'
```

## Dades i migració

L'esquema es versiona amb `PRAGMA user_version`. La v1 crea `notes`, `tags`, `note_tags`, `groups` i `note_fts` (FTS5 amb triggers). La v2 afegeix `done` i `archived`. Cada migració és transaccional. Les etiquetes que ja no fa servir cap nota s'eliminen soles. La base de dades fa servir `journal_mode=WAL` amb `synchronous=NORMAL`: en cas de tall de corrent es pot perdre l'última escriptura, però el fitxer no es corromp, i hi ha menys escriptures forçades a la SD.

Per moure les dades a un altre dispositiu, copia `data/notebox.sqlite3` amb el servei aturat, o fes una còpia en calent:

```sh
sqlite3 data/notebox.sqlite3 ".backup /ruta/notebox.sqlite3"
```

El fitxer és portable entre arquitectures (ARM ↔ x86).
