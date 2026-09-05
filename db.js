// db.js
// Minimal file-based datastore so the app runs with zero external setup.
// This is fine to launch a small campaign with, but it is NOT safe for
// high concurrency or long-term production use — swap this module for a
// real database (Postgres/MySQL) before the campaign scales up. Every
// function below is written so that swap only touches this one file.

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
  ? path.join('/tmp', 'opsiys-nepal-db.json')
  : path.join(__dirname, 'data', 'db.json');

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      donations: [],
      settings: {
        goalPaise: 10000000, // ₹1,00,000
        opsiysContributionPaise: 0,
        transferredPaise: 0,
        adminChargesPaise: 0,
      },
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function createDonation(record) {
  const data = readDb();
  data.donations.push(record);
  writeDb(data);
  return record;
}

function findDonationByOrderId(orderId) {
  const data = readDb();
  return data.donations.find((d) => d.razorpayOrderId === orderId);
}

function findDonationByPaymentId(paymentId) {
  const data = readDb();
  return data.donations.find((d) => d.razorpayPaymentId === paymentId);
}

function updateDonation(id, patch) {
  const data = readDb();
  const idx = data.donations.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  data.donations[idx] = { ...data.donations[idx], ...patch };
  writeDb(data);
  return data.donations[idx];
}

function getSettings() {
  return readDb().settings;
}

function updateSettings(patch) {
  const data = readDb();
  data.settings = { ...data.settings, ...patch };
  writeDb(data);
  return data.settings;
}

function getAllDonations() {
  return readDb().donations;
}

function getPaidDonations() {
  return getAllDonations().filter((d) => d.status === 'paid');
}

module.exports = {
  createDonation,
  findDonationByOrderId,
  findDonationByPaymentId,
  updateDonation,
  getSettings,
  updateSettings,
  getAllDonations,
  getPaidDonations,
};
