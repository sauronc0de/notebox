<div align="center">

# Notebox

**Self-hosted notes & reminders. One C++ binary, one SQLite file, zero frameworks.**

![C++17](https://img.shields.io/badge/C%2B%2B-17-00599C?logo=cplusplus&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-FTS5-003B57?logo=sqlite&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

</div>

---

Notebox is a mobile-first notes app served by a single C++17 executable. The backend is ~500 lines of plain C++ on top of [cpp-httplib](https://github.com/yhirose/cpp-httplib), [nlohmann/json](https://github.com/nlohmann/json) and SQLite. The frontend is vanilla HTML/CSS/JS, installable as a PWA.

## Features

- **Instant search**: SQLite FTS5 full-text search with prefix matching as you type.
- **Agenda**: dated notes become reminders, with a weekly strip, overdue and upcoming lists.
- **Markdown-lite**: checklists, lists, headings, quotes, bold, code and links.
- **Offline-ready**: a service worker keeps the last snapshot available when the server is down.

## Build

```sh
sudo apt-get install cmake g++ libsqlite3-dev nlohmann-json3-dev
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"
```

## Run

```sh
./build/notebox
```

Open `http://127.0.0.1:8080`. Configure with `NOTEBOX_HOST`, `NOTEBOX_PORT`, `NOTEBOX_DATA` and `NOTEBOX_WEB`.

To install it as a systemd service published on your Tailnet:

```sh
sudo ./install-service.sh
```

> [!WARNING]
> Notebox has no authentication. Keep it on localhost or behind a private network such as Tailscale.

## License

[MIT](LICENSE) © sauronc0de
