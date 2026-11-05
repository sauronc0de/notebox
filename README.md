# Notebox

Aplicació personal de notes, mobile-first. Backend C++17 + cpp-httplib (header versionat), nlohmann/json, SQLite amb FTS5; frontend HTML/CSS/JS sense framework. API i UI separades. Sense autenticació integrada: **no exposis el port a Internet**.

## Estructura

- `src/main.cpp`: servidor HTTP, repositori SQLite, validació i migració v1.
- `third_party/httplib.h`: cpp-httplib 0.18.7 (MIT, https://github.com/yhirose/cpp-httplib).
- `web/`: frontend responsive, icones SVG predefinides (carpeta, feina, casa, tecnologia, estrella, llibre, idea, gaming, futbol, barra de peses, alimentació, regals i gats).
- `data/`: SQLite local (ignorada per Git); `build/`: artefactes (ignorats).

## Instal·lació (Debian / Raspberry Pi OS)

```sh
sudo apt-get install cmake g++ libsqlite3-dev nlohmann-json3-dev
cmake -S . -B build
cmake --build build -j1
NOTEBOX_HOST=127.0.0.1 ./build/notebox
```

En una Raspberry Pi amb poca RAM, evita inicialment `Release -j2`: compilar nlohmann/json i cpp-httplib pot consumir molta memòria. Des de l'arrel del projecte obre `http://127.0.0.1:8080`. Variables: `NOTEBOX_HOST`, `NOTEBOX_PORT` (8080), `NOTEBOX_DATA` (`./data`), `NOTEBOX_WEB` (`./web`). Per Tailnet, vincula el servei **només a la IP Tailscale** (obtinguda amb `tailscale ip -4`):

```sh
NOTEBOX_HOST="$(tailscale ip -4)" ./build/notebox
```

Accedeix a `http://<MagicDNS-o-IP-Tailscale>:8080` des de dispositius autoritzats. Configura ACL de Tailscale per restringir el port; la xarxa privada no substitueix l'autenticació contra altres membres de la Tailnet. No facis servir `0.0.0.0` si només vols accés privat. Per HTTPS, considera Tailscale Serve. En aquesta Raspberry Pi hi ha `/etc/systemd/system/notebox.service`, habilitat amb `WorkingDirectory=/home/pi/workspace/notebox` i `NOTEBOX_HOST=100.125.179.24`. Usa `sudo systemctl restart notebox` després de recompilar i `sudo systemctl status notebox` per consultar-ne l'estat. Si canvia la IP Tailscale, actualitza `NOTEBOX_HOST` al servei, fes `sudo systemctl daemon-reload` i reinicia'l.

## API

`GET /api/notes` amb paràmetres combinables `date=YYYY-MM-DD`, `tag=nom`, `group=nom`, `pinned=true|false`, `has_date=true|false`, `search=paraules`, `sort=updated|created|date|title`; `GET /api/search` accepta els mateixos paràmetres. Resultat limitat a 200 notes per consulta en aquesta primera versió (paginació pendent).

`GET /api/notes/:id`, `POST /api/notes`, `PUT /api/notes/:id`, `DELETE /api/notes/:id`; `GET /api/tags`, `GET /api/groups`, `POST /api/groups`, `PUT /api/groups/:id` (nom i icona). PUT de notes reemplaça tots els camps editables. Tags a l'API són noms; els IDs reutilitzables es gestionen internament. Les dates són independents de pinned.

```sh
curl -X POST http://127.0.0.1:8080/api/notes -H 'Content-Type: application/json' \
  -d '{"title":"Provar RS485","description":"Raspberry ethernet","date":null,"tags":["work","rs485"],"group_id":null,"pinned":false}'
curl 'http://127.0.0.1:8080/api/notes?search=raspberry%20ethernet&tag=work'
```

## Dades i evolució

La migració v1 és transaccional i es controla amb `PRAGMA user_version`. `notes`, `tags`, `note_tags`, `groups`; les claus externes són actives. FTS5 (`note_fts`) replica títol, descripció i tags amb triggers; els termes de cerca es combinen amb AND i poden coincidir en camps diferents. La cerca actual és literal per termes (sense prefix ni sintaxi avançada), ordenada per últim canvi; ranking, paginació i tokenització es poden ampliar. Per una migració v2, afegeix un bloc transaccional condicionat a `user_version == 1` i incrementa la versió. Fes còpia del fitxer SQLite amb l'API de backup de SQLite o `VACUUM INTO` (amb el servei aturat també pots copiar els fitxers WAL). Els attachments futurs haurien de tenir taula pròpia i fitxers optimitzats al disc; no inclosos en aquesta versió.

Els grups es poden crear i editar des de «Grups» a Totes les notes o des de l'editor; eliminar-los, l'autenticació, les imatges i el mode offline/PWA queden fora del MVP. El Daily accepta gestos horitzontals per canviar de dia (a més dels botons). Les notes noves no tenen data per defecte; «Aquest dia» l'assigna expressament i «Sense data» l'esborra.
