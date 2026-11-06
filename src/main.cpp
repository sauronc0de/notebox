#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;
namespace fs = std::filesystem;

struct Error : std::runtime_error {
    int status;
    Error(int code, const std::string &msg) : std::runtime_error(msg), status(code) {}
};

void check(int rc, sqlite3 *db) {
    if (rc != SQLITE_OK && rc != SQLITE_DONE && rc != SQLITE_ROW) throw std::runtime_error(sqlite3_errmsg(db));
}

class Statement {
public:
    sqlite3_stmt *stmt = nullptr;
    sqlite3 *db;
    Statement(sqlite3 *d, const std::string &sql) : db(d) { check(sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr), db); }
    ~Statement() { sqlite3_finalize(stmt); }
    void text(int i, const std::string &s) { check(sqlite3_bind_text(stmt, i, s.c_str(), -1, SQLITE_TRANSIENT), db); }
    void integer(int i, int64_t n) { check(sqlite3_bind_int64(stmt, i, n), db); }
    void null(int i) { check(sqlite3_bind_null(stmt, i), db); }
    bool next() { int rc = sqlite3_step(stmt); check(rc, db); return rc == SQLITE_ROW; }
    int64_t col(int i) const { return sqlite3_column_int64(stmt, i); }
    bool isNull(int i) const { return sqlite3_column_type(stmt, i) == SQLITE_NULL; }
    std::string str(int i) const {
        const auto *p = sqlite3_column_text(stmt, i);
        return p ? reinterpret_cast<const char *>(p) : "";
    }
    Statement(const Statement &) = delete;
    Statement &operator=(const Statement &) = delete;
};

// A value bound to a dynamically built query.
struct Bind {
    bool isInt = false;
    int64_t i = 0;
    std::string s;
    static Bind of(int64_t v) { Bind b; b.isInt = true; b.i = v; return b; }
    static Bind of(const std::string &v) { Bind b; b.s = v; return b; }
};

void bindAll(Statement &s, const std::vector<Bind> &binds) {
    for (size_t k = 0; k < binds.size(); ++k) {
        int idx = static_cast<int>(k + 1);
        if (binds[k].isInt) s.integer(idx, binds[k].i); else s.text(idx, binds[k].s);
    }
}

const std::vector<std::string> ICONS = {
    "folder","briefcase","home","cpu","star","book","lightbulb","gaming","football","barbell","food","gift","cat",
    "heart","plane","music","wallet","code","users","leaf","camera","car","school","health"};

bool blank(const std::string &s) { return s.find_first_not_of(" \t\r\n") == std::string::npos; }
std::string trim(const std::string &s) {
    auto a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    auto b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}
bool isDate(const std::string &s) {
    static const std::regex re(R"(\d{4}-\d{2}-\d{2})");
    return std::regex_match(s, re);
}
std::string requireDate(const std::string &s, const char *what) {
    if (!isDate(s)) throw Error(400, std::string("Invalid ") + what);
    return s;
}
bool parseBool(const std::string &v, const char *what) {
    if (v == "true" || v == "1") return true;
    if (v == "false" || v == "0") return false;
    throw Error(400, std::string("Invalid ") + what);
}
int64_t parseInt(const std::string &v, const char *what) {
    try { size_t pos; int64_t n = std::stoll(v, &pos); if (pos != v.size()) throw 0; return n; }
    catch (...) { throw Error(400, std::string("Invalid ") + what); }
}

// Columns shared by every note query; tags come back as one string separated by U+001F.
const std::string NOTE_COLUMNS =
    "n.id,n.title,n.description,n.date,n.group_id,g.name,g.icon,n.pinned,n.done,n.archived,n.created_at,n.updated_at,"
    "(SELECT group_concat(name, char(31)) FROM (SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id=t.id "
    "WHERE nt.note_id=n.id ORDER BY t.name COLLATE NOCASE))";
const std::string NOTE_FROM = " FROM notes n LEFT JOIN groups g ON g.id=n.group_id";

class Store {
    sqlite3 *db = nullptr;
    void exec(const std::string &sql) {
        char *err = nullptr;
        if (sqlite3_exec(db, sql.c_str(), nullptr, nullptr, &err) != SQLITE_OK) {
            std::string msg = err ? err : "SQLite error";
            sqlite3_free(err);
            throw std::runtime_error(msg);
        }
    }
    template <typename F> void transaction(F fn) {
        exec("BEGIN IMMEDIATE");
        try { fn(); exec("COMMIT"); }
        catch (...) { exec("ROLLBACK"); throw; }
    }
    int scalar(const std::string &sql, const std::vector<Bind> &binds = {}) {
        Statement s(db, sql); bindAll(s, binds); s.next();
        return static_cast<int>(s.col(0));
    }
    void migrate() {
        int version = scalar("PRAGMA user_version");
        if (version > 2) throw std::runtime_error("Database schema is newer than this application");
        if (version < 1) transaction([&] { exec(R"SQL(
            CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                icon TEXT NOT NULL DEFAULT 'folder');
            CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
            CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL CHECK(length(trim(title))>0),
                description TEXT NOT NULL DEFAULT '', date TEXT CHECK(date IS NULL OR
                (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date,'+0 days')=date)),
                group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL, pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
            CREATE TABLE note_tags (note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(note_id, tag_id));
            CREATE INDEX notes_date ON notes(date);
            CREATE INDEX notes_updated ON notes(updated_at);
            CREATE INDEX notes_group ON notes(group_id);
            CREATE INDEX note_tags_tag ON note_tags(tag_id);
            CREATE VIRTUAL TABLE note_fts USING fts5(title, description, tags, tokenize='unicode61 remove_diacritics 2');
            CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
                INSERT INTO note_fts(rowid,title,description,tags) VALUES(new.id,new.title,new.description,''); END;
            CREATE TRIGGER notes_fts_update AFTER UPDATE OF title, description ON notes BEGIN
                UPDATE note_fts SET title=new.title,description=new.description WHERE rowid=new.id; END;
            CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
                DELETE FROM note_fts WHERE rowid=old.id; END;
            CREATE TRIGGER note_tags_insert AFTER INSERT ON note_tags BEGIN
                UPDATE note_fts SET tags=coalesce((SELECT group_concat(t.name,' ') FROM tags t
                    JOIN note_tags nt ON nt.tag_id=t.id WHERE nt.note_id=new.note_id),'') WHERE rowid=new.note_id; END;
            CREATE TRIGGER note_tags_delete AFTER DELETE ON note_tags BEGIN
                UPDATE note_fts SET tags=coalesce((SELECT group_concat(t.name,' ') FROM tags t
                    JOIN note_tags nt ON nt.tag_id=t.id WHERE nt.note_id=old.note_id),'') WHERE rowid=old.note_id; END;
            CREATE TRIGGER tags_fts_rename AFTER UPDATE OF name ON tags BEGIN
                UPDATE note_fts SET tags=coalesce((SELECT group_concat(t.name,' ') FROM tags t
                    JOIN note_tags nt ON nt.tag_id=t.id WHERE nt.note_id=note_fts.rowid),'')
                WHERE rowid IN (SELECT note_id FROM note_tags WHERE tag_id=new.id); END;
            PRAGMA user_version=1;
        )SQL"); });
        // v2: reminders can be marked done; any note can be archived.
        if (version < 2) transaction([&] { exec(R"SQL(
            ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
            CREATE INDEX notes_active_date ON notes(archived, date);
            PRAGMA user_version=2;
        )SQL"); });
    }
    void dropOrphanTags() { exec("DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM note_tags WHERE tag_id=tags.id)"); }
    static json row(const Statement &s) {
        json tags = json::array();
        std::string joined = s.str(12);
        size_t start = 0;
        while (!joined.empty()) {
            size_t pos = joined.find('\x1f', start);
            tags.push_back(joined.substr(start, pos == std::string::npos ? std::string::npos : pos - start));
            if (pos == std::string::npos) break;
            start = pos + 1;
        }
        return {{"id",s.col(0)},{"title",s.str(1)},{"description",s.str(2)},
            {"date",s.isNull(3) ? json(nullptr) : json(s.str(3))},
            {"group_id",s.isNull(4) ? json(nullptr) : json(s.col(4))},
            {"group_name",s.isNull(5) ? json(nullptr) : json(s.str(5))},
            {"group_icon",s.isNull(6) ? json(nullptr) : json(s.str(6))},
            {"pinned",s.col(7)!=0},{"done",s.col(8)!=0},{"archived",s.col(9)!=0},
            {"created_at",s.str(10)},{"updated_at",s.str(11)},{"tags",tags}};
    }
    json query(const std::string &where, const std::vector<Bind> &binds, const std::string &tail) {
        Statement s(db, "SELECT " + NOTE_COLUMNS + NOTE_FROM + " WHERE " + where + tail);
        bindAll(s, binds);
        json out = json::array();
        while (s.next()) out.push_back(row(s));
        return out;
    }
    static void validateIcon(const std::string &icon) {
        if (std::find(ICONS.begin(), ICONS.end(), icon) == ICONS.end()) throw Error(400, "Invalid icon");
    }
    static std::string validGroupName(const json &body) {
        if (!body.is_object() || !body.contains("name") || !body["name"].is_string()) throw Error(400, "Group name is required");
        std::string name = trim(body["name"].get<std::string>());
        if (name.empty() || name.size() > 100) throw Error(400, "Invalid group name");
        return name;
    }
    static std::string validTagName(const json &value) {
        if (!value.is_string()) throw Error(400, "Invalid tag");
        std::string name = trim(value.get<std::string>());
        if (!name.empty() && name[0] == '#') name = trim(name.substr(1));
        if (name.empty() || name.size() > 60 || name.find(',') != std::string::npos || name.find('\x1f') != std::string::npos)
            throw Error(400, "Invalid tag");
        return name;
    }
public:
    explicit Store(const std::string &path) {
        if (sqlite3_open(path.c_str(), &db) != SQLITE_OK) {
            std::string msg = sqlite3_errmsg(db); sqlite3_close(db); db = nullptr; throw std::runtime_error(msg);
        }
        try {
            exec("PRAGMA foreign_keys=ON"); exec("PRAGMA journal_mode=WAL");
            // Safe with WAL: a power cut can lose the last commit, never corrupt the file. Fewer fsyncs on SD cards.
            exec("PRAGMA synchronous=NORMAL"); exec("PRAGMA busy_timeout=5000");
            migrate();
        } catch (...) { sqlite3_close(db); db = nullptr; throw; }
    }
    ~Store() { sqlite3_close(db); }

    json get(int64_t id) {
        json r = query("n.id=?", {Bind::of(id)}, "");
        if (r.empty()) throw Error(404, "Note not found");
        return r[0];
    }

    json list(const httplib::Request &req) {
        auto has = [&](const char *k) { return req.has_param(k) && !req.get_param_value(k).empty(); };
        auto param = [&](const char *k) { return req.get_param_value(k); };
        std::string where = "1=1";
        std::vector<Bind> binds;
        std::string archived = has("archived") ? param("archived") : "false";
        if (archived != "all") { where += " AND n.archived=?"; binds.push_back(Bind::of(parseBool(archived, "archived filter") ? 1 : 0)); }
        if (has("date")) { where += " AND n.date=?"; binds.push_back(Bind::of(requireDate(param("date"), "date"))); }
        if (has("from")) { where += " AND n.date>=?"; binds.push_back(Bind::of(requireDate(param("from"), "from"))); }
        if (has("to")) { where += " AND n.date<=?"; binds.push_back(Bind::of(requireDate(param("to"), "to"))); }
        if (has("tag")) {
            where += " AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=n.id AND t.name=? COLLATE NOCASE)";
            binds.push_back(Bind::of(param("tag")));
        }
        if (has("group")) {
            if (param("group") == "none") where += " AND n.group_id IS NULL";
            else { where += " AND n.group_id=?"; binds.push_back(Bind::of(parseInt(param("group"), "group filter"))); }
        }
        if (has("pinned")) { where += " AND n.pinned=?"; binds.push_back(Bind::of(parseBool(param("pinned"), "pinned filter") ? 1 : 0)); }
        if (has("done")) { where += " AND n.done=?"; binds.push_back(Bind::of(parseBool(param("done"), "done filter") ? 1 : 0)); }
        if (has("has_date")) where += parseBool(param("has_date"), "has_date filter") ? " AND n.date IS NOT NULL" : " AND n.date IS NULL";
        if (has("search")) {
            // Each term is quoted (no FTS syntax exposed) and matched as a prefix, so results appear while typing.
            std::string match, word;
            auto flush = [&] {
                if (word.empty()) return;
                if (!match.empty()) match += " AND ";
                match += "\"" + word + "\"*";
                word.clear();
            };
            for (unsigned char c : param("search")) {
                if (std::isspace(c)) flush();
                else if (c == '"') word += "\"\"";
                else word += static_cast<char>(c);
            }
            flush();
            if (!match.empty()) { where += " AND n.id IN (SELECT rowid FROM note_fts WHERE note_fts MATCH ?)"; binds.push_back(Bind::of(match)); }
        }
        std::string sort = has("sort") ? param("sort") : "updated", order;
        if (sort == "updated") order = " ORDER BY n.updated_at DESC,n.id DESC";
        else if (sort == "created") order = " ORDER BY n.created_at DESC,n.id DESC";
        else if (sort == "title") order = " ORDER BY n.title COLLATE NOCASE ASC,n.id DESC";
        else if (sort == "date") order = " ORDER BY n.date IS NULL,n.date ASC,n.id DESC";
        else throw Error(400, "Invalid sort");
        int64_t limit = has("limit") ? parseInt(param("limit"), "limit") : 50;
        int64_t offset = has("offset") ? parseInt(param("offset"), "offset") : 0;
        if (limit < 1 || limit > 200 || offset < 0) throw Error(400, "Invalid limit or offset");
        int total = scalar("SELECT count(*)" + NOTE_FROM + " WHERE " + where, binds);
        json items = query(where, binds, order + " LIMIT " + std::to_string(limit) + " OFFSET " + std::to_string(offset));
        return {{"items", items}, {"total", total}};
    }

    // Everything the agenda screen needs in one round trip.
    json agenda(const httplib::Request &req) {
        auto p = [&](const char *k) { return req.has_param(k) ? req.get_param_value(k) : std::string(); };
        std::string today = requireDate(p("today"), "today");
        std::string day = p("day").empty() ? today : requireDate(p("day"), "day");
        std::string from = p("from").empty() ? day : requireDate(p("from"), "from");
        std::string to = p("to").empty() ? day : requireDate(p("to"), "to");
        json days = json::object();
        {
            Statement s(db, "SELECT date,count(*),sum(done=0) FROM notes WHERE archived=0 AND date BETWEEN ? AND ? GROUP BY date");
            s.text(1, from); s.text(2, to);
            while (s.next()) days[s.str(0)] = {{"total", s.col(1)}, {"pending", s.col(2)}};
        }
        return {
            {"overdue", query("n.archived=0 AND n.done=0 AND n.date<?", {Bind::of(today)}, " ORDER BY n.date ASC,n.id ASC")},
            {"day", query("n.archived=0 AND n.date=?", {Bind::of(day)}, " ORDER BY n.done ASC,n.pinned DESC,n.updated_at DESC")},
            {"upcoming", query("n.archived=0 AND n.done=0 AND n.date>?", {Bind::of(today)}, " ORDER BY n.date ASC,n.id ASC LIMIT 8")},
            {"days", days}};
    }

    // Counters for badges, sidebar and the explore screen.
    json summary(const httplib::Request &req) {
        std::string today = requireDate(req.has_param("today") ? req.get_param_value("today") : "", "today");
        json groups = json::array(), tags = json::array();
        {
            Statement s(db, "SELECT g.id,g.name,g.icon,(SELECT count(*) FROM notes n WHERE n.group_id=g.id AND n.archived=0) "
                            "FROM groups g ORDER BY g.name COLLATE NOCASE");
            while (s.next()) groups.push_back({{"id",s.col(0)},{"name",s.str(1)},{"icon",s.str(2)},{"count",s.col(3)}});
        }
        {
            Statement s(db, "SELECT t.id,t.name,(SELECT count(*) FROM note_tags nt JOIN notes n ON n.id=nt.note_id "
                            "WHERE nt.tag_id=t.id AND n.archived=0) FROM tags t ORDER BY t.name COLLATE NOCASE");
            while (s.next()) tags.push_back({{"id",s.col(0)},{"name",s.str(1)},{"count",s.col(2)}});
        }
        auto count = [&](const std::string &where, std::vector<Bind> b = {}) { return scalar("SELECT count(*) FROM notes WHERE " + where, b); };
        return {
            {"pending", count("archived=0 AND done=0 AND date<=?", {Bind::of(today)})},
            {"overdue", count("archived=0 AND done=0 AND date<?", {Bind::of(today)})},
            {"today", count("archived=0 AND done=0 AND date=?", {Bind::of(today)})},
            {"upcoming", count("archived=0 AND done=0 AND date>?", {Bind::of(today)})},
            {"total", count("archived=0")},
            {"pinned", count("archived=0 AND pinned=1")},
            {"archived", count("archived=1")},
            {"ungrouped", count("archived=0 AND group_id IS NULL")},
            {"groups", groups}, {"tags", tags}};
    }

    json groups() {
        json out = json::array();
        Statement s(db, "SELECT id,name,icon FROM groups ORDER BY name COLLATE NOCASE");
        while (s.next()) out.push_back({{"id",s.col(0)},{"name",s.str(1)},{"icon",s.str(2)}});
        return out;
    }
    json createGroup(const json &body) {
        std::string name = validGroupName(body);
        std::string icon = body.value("icon", std::string("folder"));
        validateIcon(icon);
        Statement s(db, "INSERT INTO groups(name,icon) VALUES(?,?)"); s.text(1,name); s.text(2,icon); s.next();
        return {{"id",sqlite3_last_insert_rowid(db)},{"name",name},{"icon",icon}};
    }
    json updateGroup(int64_t id, const json &body) {
        std::string name = validGroupName(body);
        if (!body.contains("icon") || !body["icon"].is_string()) throw Error(400, "Invalid icon");
        std::string icon = body["icon"].get<std::string>();
        validateIcon(icon);
        if (!scalar("SELECT count(*) FROM groups WHERE id=?", {Bind::of(id)})) throw Error(404, "Group not found");
        Statement s(db, "UPDATE groups SET name=?,icon=? WHERE id=?");
        s.text(1,name); s.text(2,icon); s.integer(3,id); s.next();
        return {{"id",id},{"name",name},{"icon",icon}};
    }
    void deleteGroup(int64_t id) {
        Statement s(db, "DELETE FROM groups WHERE id=?"); s.integer(1,id); s.next();
        if (!sqlite3_changes(db)) throw Error(404, "Group not found");
    }

    json tags() {
        json out = json::array();
        Statement s(db, "SELECT id,name FROM tags ORDER BY name COLLATE NOCASE");
        while (s.next()) out.push_back({{"id",s.col(0)},{"name",s.str(1)}});
        return out;
    }
    // Renaming onto an existing tag merges both.
    json renameTag(int64_t id, const json &body) {
        if (!body.is_object() || !body.contains("name")) throw Error(400, "Tag name is required");
        std::string name = validTagName(body["name"]);
        if (!scalar("SELECT count(*) FROM tags WHERE id=?", {Bind::of(id)})) throw Error(404, "Tag not found");
        int64_t target = id;
        transaction([&] {
            Statement find(db, "SELECT id FROM tags WHERE name=? COLLATE NOCASE AND id<>?");
            find.text(1, name); find.integer(2, id);
            if (find.next()) {
                target = find.col(0);
                Statement move(db, "INSERT OR IGNORE INTO note_tags(note_id,tag_id) SELECT note_id,? FROM note_tags WHERE tag_id=?");
                move.integer(1, target); move.integer(2, id); move.next();
                Statement drop(db, "DELETE FROM note_tags WHERE tag_id=?"); drop.integer(1, id); drop.next();
                Statement del(db, "DELETE FROM tags WHERE id=?"); del.integer(1, id); del.next();
            }
            Statement up(db, "UPDATE tags SET name=? WHERE id=?"); up.text(1, name); up.integer(2, target); up.next();
        });
        return {{"id",target},{"name",name}};
    }
    void deleteTag(int64_t id) {
        transaction([&] {
            Statement links(db, "DELETE FROM note_tags WHERE tag_id=?"); links.integer(1,id); links.next();
            Statement s(db, "DELETE FROM tags WHERE id=?"); s.integer(1,id); s.next();
            if (!sqlite3_changes(db)) throw Error(404, "Tag not found");
        });
    }

    json save(const json &body, int64_t id = 0) {
        if (!body.is_object() || !body.contains("title") || !body["title"].is_string()) throw Error(400, "Title is required");
        std::string title = trim(body["title"].get<std::string>());
        if (title.empty() || title.size() > 500) throw Error(400, "Invalid title");
        json descValue = body.value("description", json(""));
        if (!descValue.is_string()) throw Error(400, "Invalid description");
        std::string description = descValue.get<std::string>();
        if (description.size() > 100000) throw Error(400, "Description too long");
        json date = body.value("date", json(nullptr));
        if (date == "") date = nullptr;
        if (!date.is_null() && (!date.is_string() || !isDate(date.get<std::string>()))) throw Error(400, "Invalid date");
        json group = body.value("group_id", json(nullptr));
        if (!group.is_null() && (!group.is_number_integer() || group.get<int64_t>() <= 0)) throw Error(400, "Invalid group_id");
        auto flag = [&](const char *key) {
            json v = body.value(key, json(false));
            if (!v.is_boolean()) throw Error(400, std::string("Invalid ") + key);
            return v.get<bool>();
        };
        bool pinned = flag("pinned"), done = flag("done") && !date.is_null(), archived = flag("archived");
        json names = body.value("tags", json::array());
        if (!names.is_array() || names.size() > 30) throw Error(400, "Invalid tags");
        std::vector<std::string> tagNames;
        for (const auto &n : names) tagNames.push_back(validTagName(n));
        if (id) get(id);
        transaction([&] {
            Statement s(db, id
                ? "UPDATE notes SET title=?,description=?,date=?,group_id=?,pinned=?,done=?,archived=?,"
                  "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
                : "INSERT INTO notes(title,description,date,group_id,pinned,done,archived) VALUES(?,?,?,?,?,?,?)");
            s.text(1,title); s.text(2,description);
            if (date.is_null()) s.null(3); else s.text(3,date.get<std::string>());
            if (group.is_null()) s.null(4); else s.integer(4,group.get<int64_t>());
            s.integer(5,pinned); s.integer(6,done); s.integer(7,archived);
            if (id) s.integer(8,id);
            s.next();
            if (!id) id = sqlite3_last_insert_rowid(db);
            { Statement clear(db, "DELETE FROM note_tags WHERE note_id=?"); clear.integer(1,id); clear.next(); }
            for (const auto &name : tagNames) {
                Statement insert(db, "INSERT INTO tags(name) VALUES(?) ON CONFLICT(name) DO NOTHING"); insert.text(1,name); insert.next();
                Statement link(db, "INSERT OR IGNORE INTO note_tags(note_id,tag_id) SELECT ?,id FROM tags WHERE name=? COLLATE NOCASE");
                link.integer(1,id); link.text(2,name); link.next();
            }
            dropOrphanTags();
        });
        return get(id);
    }
    // Partial update: only the fields present in the body change.
    json patch(int64_t id, const json &body) {
        if (!body.is_object()) throw Error(400, "Invalid body");
        json current = get(id), merged = {
            {"title",current["title"]},{"description",current["description"]},{"date",current["date"]},
            {"group_id",current["group_id"]},{"pinned",current["pinned"]},{"done",current["done"]},
            {"archived",current["archived"]},{"tags",current["tags"]}};
        for (auto it = body.begin(); it != body.end(); ++it) {
            if (!merged.contains(it.key())) throw Error(400, "Unknown field: " + it.key());
            merged[it.key()] = it.value();
        }
        return save(merged, id);
    }
    // Full backup in a portable format.
    json exportAll() {
        Statement now(db, "SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')"); now.next();
        return {{"app","notebox"},{"schema",2},{"exported_at",now.str(0)},{"groups",groups()},
                {"notes",query("1=1", {}, " ORDER BY n.id")}};
    }
    void remove(int64_t id) {
        transaction([&] {
            Statement s(db, "DELETE FROM notes WHERE id=?"); s.integer(1,id); s.next();
            if (!sqlite3_changes(db)) throw Error(404, "Note not found");
            dropOrphanTags();
        });
    }
};

int main() {
    try {
        std::string data = std::getenv("NOTEBOX_DATA") ? std::getenv("NOTEBOX_DATA") : "./data";
        std::string web = std::getenv("NOTEBOX_WEB") ? std::getenv("NOTEBOX_WEB") : "./web";
        std::string host = std::getenv("NOTEBOX_HOST") ? std::getenv("NOTEBOX_HOST") : "127.0.0.1";
        int port = std::getenv("NOTEBOX_PORT") ? std::stoi(std::getenv("NOTEBOX_PORT")) : 8080;
        if (port < 1 || port > 65535) throw std::runtime_error("Invalid port");
        fs::create_directories(data);
        Store store((fs::path(data) / "notebox.sqlite3").string());
        httplib::Server server;
        // Several workers so an idle keep-alive connection can't block other requests;
        // the single SQLite connection is protected by db_mutex in route().
        server.new_task_queue = [] { return new httplib::ThreadPool(8); };
        std::mutex db_mutex;
        server.set_payload_max_length(1024 * 1024);
        server.set_read_timeout(10, 0);
        server.set_write_timeout(10, 0);
        server.set_default_headers({
            {"X-Content-Type-Options", "nosniff"},
            {"Referrer-Policy", "no-referrer"},
            {"Content-Security-Policy", "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"}});
        server.set_file_extension_and_mimetype_mapping("webmanifest", "application/manifest+json");
        auto send = [](httplib::Response &res, const json &j, int status = 200) {
            res.status = status;
            res.set_header("Cache-Control", "no-store");
            res.set_content(j.dump(), "application/json; charset=utf-8");
        };
        auto route = [&](auto fn) { return [&, fn](const httplib::Request &req, httplib::Response &res) {
            try { std::lock_guard<std::mutex> lock(db_mutex); fn(req, res); }
            catch (const Error &e) { send(res, {{"error", e.what()}}, e.status); }
            catch (const json::exception &) { send(res, {{"error", "Invalid JSON or field type"}}, 400); }
            catch (const std::exception &e) {
                std::string msg = e.what();
                std::cerr << "API error: " << msg << '\n';
                int status = msg.find("UNIQUE constraint") != std::string::npos ? 409
                    : (msg.find("constraint") != std::string::npos || msg.find("fts5") != std::string::npos ? 400 : 500);
                send(res, {{"error", status == 409 ? "Already exists" : status == 500 ? "Internal server error" : msg}}, status);
            }
        }; };
        auto body = [](const httplib::Request &req) { return json::parse(req.body); };
        auto id = [](const httplib::Request &req) { return std::stoll(req.matches[1].str()); };
        server.Get("/api/notes", route([&](const auto &req, auto &res) { send(res, store.list(req)); }));
        server.Get(R"(/api/notes/(\d+))", route([&](const auto &req, auto &res) { send(res, store.get(id(req))); }));
        server.Post("/api/notes", route([&](const auto &req, auto &res) { send(res, store.save(body(req)), 201); }));
        server.Put(R"(/api/notes/(\d+))", route([&](const auto &req, auto &res) { send(res, store.save(body(req), id(req))); }));
        server.Patch(R"(/api/notes/(\d+))", route([&](const auto &req, auto &res) { send(res, store.patch(id(req), body(req))); }));
        server.Delete(R"(/api/notes/(\d+))", route([&](const auto &req, auto &res) { store.remove(id(req)); res.status = 204; }));
        server.Get("/api/agenda", route([&](const auto &req, auto &res) { send(res, store.agenda(req)); }));
        server.Get("/api/summary", route([&](const auto &req, auto &res) { send(res, store.summary(req)); }));
        server.Get("/api/groups", route([&](const auto &, auto &res) { send(res, store.groups()); }));
        server.Post("/api/groups", route([&](const auto &req, auto &res) { send(res, store.createGroup(body(req)), 201); }));
        server.Put(R"(/api/groups/(\d+))", route([&](const auto &req, auto &res) { send(res, store.updateGroup(id(req), body(req))); }));
        server.Delete(R"(/api/groups/(\d+))", route([&](const auto &req, auto &res) { store.deleteGroup(id(req)); res.status = 204; }));
        server.Get("/api/tags", route([&](const auto &, auto &res) { send(res, store.tags()); }));
        server.Put(R"(/api/tags/(\d+))", route([&](const auto &req, auto &res) { send(res, store.renameTag(id(req), body(req))); }));
        server.Delete(R"(/api/tags/(\d+))", route([&](const auto &req, auto &res) { store.deleteTag(id(req)); res.status = 204; }));
        server.Get("/api/export", route([&](const auto &, auto &res) {
            send(res, store.exportAll());
            res.set_header("Content-Disposition", "attachment; filename=\"notebox-backup.json\"");
        }));
        server.Get(R"(/api/.*)", [&](const auto &, auto &res) { send(res, {{"error", "Not found"}}, 404); });
        // Static files are revalidated on every load; the service worker handles offline use.
        server.set_mount_point("/", web, {{"Cache-Control", "no-cache"}});
        std::cout << "Notebox listening on " << host << ':' << port << std::endl;
        if (!server.listen(host, port)) throw std::runtime_error("Failed to bind host/port");
    } catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}
