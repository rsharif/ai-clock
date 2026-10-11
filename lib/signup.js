"use strict";

/* Pure helpers for program signup emails: normalization and validation.
 * Kept free of I/O so tests can require this file directly. validateEmail
 * returns the normalized address or null — never throw, never trust input.
 */

function normalizeEmail(v) {
  if (typeof v !== "string") return null;
  const email = v.trim().toLowerCase();
  return email || null;
}

function validateEmail(v) {
  const email = normalizeEmail(v);
  if (!email || email.length > 254) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@") || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length === 0 || local.length > 64 || domain.length === 0 || domain.length > 253) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null;
  if (local.indexOf("..") !== -1 || local[0] === "." || local[local.length - 1] === ".") return null;
  if (domain.indexOf("..") !== -1 || domain.indexOf(".") === -1) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain)) return null;
  const labels = domain.split(".");
  for (const label of labels) {
    if (!label || label.length > 63 || label[0] === "-" || label[label.length - 1] === "-") return null;
  }
  if (labels[labels.length - 1].length < 2) return null;
  return email;
}

module.exports = { normalizeEmail, validateEmail };
