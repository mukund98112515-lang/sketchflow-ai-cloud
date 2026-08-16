"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Artist',
  profile_image TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tutorials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  title TEXT NOT NULL,
  subject_label TEXT,
  original_image_url TEXT NOT NULL,
  final_image_url TEXT,
  thumbnail_url TEXT,
  mode TEXT NOT NULL,
  step_count INTEGER NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 1,
  shading INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'generating',
  saved INTEGER NOT NULL DEFAULT 1,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tutorial_steps (
  id TEXT PRIMARY KEY,
  tutorial_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  artist_tip TEXT,
  image_url TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tutorial_progress (
  user_id TEXT NOT NULL,
  tutorial_id TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 1,
  completed INTEGER NOT NULL DEFAULT 0,
  last_opened_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tutorial_id),
  FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  tutorial_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'queued',
  error_message TEXT,
  error_code TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tutorials_user ON tutorials(user_id);
CREATE INDEX IF NOT EXISTS idx_steps_tutorial ON tutorial_steps(tutorial_id, step_number);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);
`;

function createSqliteDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  return {
    isPostgres: false,
    async init() {
      return this;
    },
    async get(sql, ...params) {
      return db.prepare(sql).get(...params);
    },
    async all(sql, ...params) {
      return db.prepare(sql).all(...params);
    },
    async run(sql, ...params) {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes || 0) };
    },
    async close() {
      db.close();
    },
  };
}

module.exports = { createSqliteDb };
