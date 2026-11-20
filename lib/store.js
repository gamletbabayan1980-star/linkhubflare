// In-memory store (replace with PostgreSQL later)
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data.json');

let db = {
  users: [],
  listings: [],
  orders: [],
  notifications: [],
  metricHistory: [],
  candidates: [],
};

function load() {
  try {
    if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {}
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  } catch (e) {}
}

load();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = { db, save, uid, load };
