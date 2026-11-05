#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <iostream>
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
    Statement(const Statement &) = delete;
    Statement &operator=(const Statement &) = delete;
};

std::string str(sqlite3_stmt *s, int i) {
    const auto *p = sqlite3_column_text(s, i);
    return p ? reinterpret_cast<const char *>(p) : "";
}

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
    void migrate() {
        Statement ver(db, "PRAGMA user_version");
        ver.next();
        int version = sqlite3_column_int(ver.stmt, 0);
        if (version > 1) throw std::runtime_error("Database schema is newer than this application");
        if (version == 1) return;
        exec("BEGIN IMMEDIATE");
        try {
            exec(R"SQL(
                CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    icon TEXT NOT NULL DEFAULT 'folder');
                CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
                CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL CHECK(length(trim(title))>0),
                    description TEXT NOT NULL DEFAULT '', date TEXT CHECK(date IS NULL OR
                    (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date)=date)),
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
            )SQL");
            exec("COMMIT");
        } catch (...) { exec("ROLLBACK"); throw; }
    }
    json tags(int64_t id) {
        json result = json::array();
        Statement s(db, "SELECT t.name FROM tags t JOIN note_tags nt ON t.id=nt.tag_id WHERE nt.note_id=? ORDER BY t.name");
        s.integer(1, id);
        while (s.next()) result.push_back(str(s.stmt, 0));
        return result;
    }
    json row(sqlite3_stmt *s) {
        int64_t id = sqlite3_column_int64(s, 0);
        return {{"id",id},{"title",str(s,1)},{"description",str(s,2)},
            {"date",sqlite3_column_type(s,3)==SQLITE_NULL ? json(nullptr) : json(str(s,3))},
            {"group_id",sqlite3_column_type(s,4)==SQLITE_NULL ? json(nullptr) : json(sqlite3_column_int64(s,4))},
            {"group_name",sqlite3_column_type(s,5)==SQLITE_NULL ? json(nullptr) : json(str(s,5))},
            {"group_icon",sqlite3_column_type(s,6)==SQLITE_NULL ? json(nullptr) : json(str(s,6))},
            {"pinned",sqlite3_column_int(s,7)!=0},{"created_at",str(s,8)},
            {"updated_at",str(s,9)},{"tags",tags(id)}};
    }
public:
    explicit Store(const std::string &path) {
        if (sqlite3_open(path.c_str(), &db) != SQLITE_OK) {
            std::string msg = sqlite3_errmsg(db); sqlite3_close(db); db = nullptr; throw std::runtime_error(msg);
        }
        try { exec("PRAGMA foreign_keys=ON"); exec("PRAGMA journal_mode=WAL"); exec("PRAGMA busy_timeout=5000"); migrate(); }
        catch (...) { sqlite3_close(db); db = nullptr; throw; }
    }
    ~Store() { sqlite3_close(db); }
    json get(int64_t id) {
        Statement s(db, "SELECT n.id,n.title,n.description,n.date,n.group_id,g.name,g.icon,n.pinned,n.created_at,n.updated_at "
                        "FROM notes n LEFT JOIN groups g ON g.id=n.group_id WHERE n.id=?");
        s.integer(1,id);
        if (!s.next()) throw Error(404, "Note not found");
        return row(s.stmt);
    }
    json list(const httplib::Request &req) {
        std::string sql = "SELECT n.id,n.title,n.description,n.date,n.group_id,g.name,g.icon,n.pinned,n.created_at,n.updated_at "
                          "FROM notes n LEFT JOIN groups g ON g.id=n.group_id WHERE 1=1";
        std::vector<std::string> values;
        auto param = [&](const char *key) { return req.has_param(key) ? req.get_param_value(key) : std::string(); };
        if (req.has_param("date")) { sql += " AND n.date=?"; values.push_back(param("date")); }
        if (req.has_param("tag")) { sql += " AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=n.id AND t.name=? COLLATE NOCASE)"; values.push_back(param("tag")); }
        if (req.has_param("group")) { sql += " AND g.name=? COLLATE NOCASE"; values.push_back(param("group")); }
        if (req.has_param("pinned")) { sql += " AND n.pinned=?"; values.push_back(param("pinned")=="true" ? "1" : "0"); }
        if (req.has_param("has_date")) { sql += param("has_date")=="true" ? " AND n.date IS NOT NULL" : " AND n.date IS NULL"; }
        if (req.has_param("search") && !param("search").empty()) {
            std::string query, word;
            // Quote each term to avoid exposing FTS syntax and match across columns.
            auto flush = [&] { if (!word.empty()) { if (!query.empty()) query += " AND "; query += "\"" + word + "\""; word.clear(); } };
            for (unsigned char c : param("search")) {
                if (std::isspace(c)) flush();
                else if (c == '"') word += "\"\"";
                else word += static_cast<char>(c);
            }
            flush();
            if (!query.empty()) { sql += " AND n.id IN (SELECT rowid FROM note_fts WHERE note_fts MATCH ?)"; values.push_back(query); }
        }
        std::string sort = param("sort");
        if (sort == "created") sql += " ORDER BY n.created_at DESC,n.id DESC";
        else if (sort == "date") sql += " ORDER BY n.date DESC,n.id DESC";
        else if (sort == "title") sql += " ORDER BY n.title COLLATE NOCASE ASC,n.id DESC";
        else sql += " ORDER BY n.updated_at DESC,n.id DESC";
        sql += " LIMIT 200";
        Statement s(db,sql);
        for (size_t i=0; i<values.size(); ++i) s.text(static_cast<int>(i+1),values[i]);
        json out = json::array();
        while (s.next()) out.push_back(row(s.stmt));
        return out;
    }
    json allTags() {
        json out=json::array(); Statement s(db,"SELECT id,name FROM tags ORDER BY name COLLATE NOCASE");
        while(s.next()) out.push_back({{"id",sqlite3_column_int64(s.stmt,0)},{"name",str(s.stmt,1)}});
        return out;
    }
    json groups() {
        json out=json::array(); Statement s(db,"SELECT id,name,icon FROM groups ORDER BY name COLLATE NOCASE");
        while(s.next()) out.push_back({{"id",sqlite3_column_int64(s.stmt,0)},{"name",str(s.stmt,1)},{"icon",str(s.stmt,2)}});
        return out;
    }
    json createGroup(const json &body) {
        std::string name = body.value("name",std::string());
        std::string icon = body.value("icon",std::string("folder"));
        const std::vector<std::string> icons={"folder","briefcase","home","cpu","star","book","lightbulb"};
        if (name.empty() || name.size()>100 || std::find(icons.begin(),icons.end(),icon)==icons.end()) throw Error(400,"Invalid group name or icon");
        Statement s(db,"INSERT INTO groups(name,icon) VALUES(?,?)"); s.text(1,name); s.text(2,icon); s.next();
        return {{"id",sqlite3_last_insert_rowid(db)},{"name",name},{"icon",icon}};
    }
    json save(const json &body, int64_t id=0) {
        if (!body.is_object() || !body.contains("title") || !body["title"].is_string()) throw Error(400,"Title is required");
        std::string title=body["title"].get<std::string>();
        if (title.find_first_not_of(" \t\r\n")==std::string::npos || title.size()>500) throw Error(400,"Invalid title");
        std::string description=body.value("description",std::string());
        if (description.size()>100000) throw Error(400,"Description too long");
        json date=body.value("date",json(nullptr));
        if (date=="") date=nullptr;
        if (!date.is_null() && (!date.is_string() || !std::regex_match(date.get<std::string>(),std::regex(R"(\d{4}-\d{2}-\d{2})")))) throw Error(400,"Invalid date");
        json group=body.value("group_id",json(nullptr));
        if (!group.is_null() && (!group.is_number_integer() || group.get<int64_t>()<=0)) throw Error(400,"Invalid group_id");
        json pinned=body.value("pinned",json(false));
        if (!pinned.is_boolean()) throw Error(400,"Invalid pinned value");
        json names=body.value("tags",json::array());
        if (!names.is_array() || names.size()>30) throw Error(400,"Invalid tags");
        for (const auto &name:names) if (!name.is_string() || name.get<std::string>().empty() || name.get<std::string>().size()>60) throw Error(400,"Invalid tag");
        if (id) get(id);
        exec("BEGIN IMMEDIATE");
        try {
            Statement s(db,id ? "UPDATE notes SET title=?,description=?,date=?,group_id=?,pinned=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
                              : "INSERT INTO notes(title,description,date,group_id,pinned) VALUES(?,?,?,?,?)");
            s.text(1,title); s.text(2,description);
            if(date.is_null()) s.null(3); else s.text(3,date.get<std::string>());
            if(group.is_null()) s.null(4); else s.integer(4,group.get<int64_t>());
            s.integer(5,pinned.get<bool>());
            if(id) s.integer(6,id);
            s.next();
            if(!id) id=sqlite3_last_insert_rowid(db);
            { Statement clear(db,"DELETE FROM note_tags WHERE note_id=?"); clear.integer(1,id); clear.next(); }
            for (const auto &name:names) {
                Statement insert(db,"INSERT INTO tags(name) VALUES(?) ON CONFLICT(name) DO NOTHING"); insert.text(1,name.get<std::string>()); insert.next();
                Statement link(db,"INSERT OR IGNORE INTO note_tags(note_id,tag_id) SELECT ?,id FROM tags WHERE name=? COLLATE NOCASE");
                link.integer(1,id); link.text(2,name.get<std::string>()); link.next();
            }
            exec("COMMIT");
        } catch (...) { exec("ROLLBACK"); throw; }
        return get(id);
    }
    void remove(int64_t id) {
        Statement s(db,"DELETE FROM notes WHERE id=?"); s.integer(1,id); s.next();
        if (!sqlite3_changes(db)) throw Error(404,"Note not found");
    }
};

int main() {
    try {
        std::string data=std::getenv("NOTEBOX_DATA") ? std::getenv("NOTEBOX_DATA") : "./data";
        std::string web=std::getenv("NOTEBOX_WEB") ? std::getenv("NOTEBOX_WEB") : "./web";
        std::string host=std::getenv("NOTEBOX_HOST") ? std::getenv("NOTEBOX_HOST") : "127.0.0.1";
        int port=std::getenv("NOTEBOX_PORT") ? std::stoi(std::getenv("NOTEBOX_PORT")) : 8080;
        if (port<1 || port>65535) throw std::runtime_error("Invalid port");
        fs::create_directories(data);
        Store store((fs::path(data)/"notebox.sqlite3").string());
        httplib::Server server;
        // One SQLite connection: serialize API handlers instead of sharing it across threads.
        server.new_task_queue = [] { return new httplib::ThreadPool(1); };
        server.set_payload_max_length(1024*1024);
        auto send=[](httplib::Response &res,const json &j,int status=200) {res.status=status;res.set_content(j.dump(),"application/json; charset=utf-8");};
        auto route=[&](auto fn) { return [&,fn](const httplib::Request &req,httplib::Response &res) {
            try { fn(req,res); }
            catch(const Error &e) {send(res,{{"error",e.what()}},e.status);}
            catch(const json::exception &e) {send(res,{{"error","Invalid JSON or field type"}},400);}
            catch(const std::exception &e) {
                std::cerr << "API error: " << e.what() << '\n';
                int status=std::string(e.what()).find("UNIQUE constraint")!=std::string::npos ? 409 :
                    (std::string(e.what()).find("constraint")!=std::string::npos || std::string(e.what()).find("fts5")!=std::string::npos ? 400 : 500);
                send(res,{{"error",status==500 ? "Internal server error" : e.what()}},status);
            }
        }; };
        auto parse=[](const httplib::Request &req) { return json::parse(req.body); };
        auto id=[](const httplib::Request &req) { return std::stoll(req.matches[1].str()); };
        server.Get("/api/notes",route([&](const auto &req,auto &res){send(res,store.list(req));}));
        server.Get("/api/search",route([&](const auto &req,auto &res){send(res,store.list(req));}));
        server.Get(R"(/api/notes/(\d+))",route([&](const auto &req,auto &res){send(res,store.get(id(req)));}));
        server.Post("/api/notes",route([&](const auto &req,auto &res){send(res,store.save(parse(req)),201);}));
        server.Put(R"(/api/notes/(\d+))",route([&](const auto &req,auto &res){send(res,store.save(parse(req),id(req)));}));
        server.Delete(R"(/api/notes/(\d+))",route([&](const auto &req,auto &res){store.remove(id(req));res.status=204;}));
        server.Get("/api/tags",route([&](const auto &,auto &res){send(res,store.allTags());}));
        server.Get("/api/groups",route([&](const auto &,auto &res){send(res,store.groups());}));
        server.Post("/api/groups",route([&](const auto &req,auto &res){send(res,store.createGroup(parse(req)),201);}));
        server.Get("/",[&](const auto &,auto &res){res.set_file_content((fs::path(web)/"index.html").string(),"text/html");});
        server.set_mount_point("/",web);
        std::cout << "Notebox listening on " << host << ':' << port << std::endl;
        if (!server.listen(host,port)) throw std::runtime_error("Failed to bind host/port");
    } catch(const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}
