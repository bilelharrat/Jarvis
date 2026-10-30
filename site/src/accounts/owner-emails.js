// The owner's own sign-in addresses (Bilel and Malik): Plus for good (Account.unlimitedEmail) and the
// EVES reviewers (eden/eves.js). Exact addresses only: a pattern like /\bbilel/ let anyone who signed
// in as bilel.anything@… take both (Exterminator site sweep, 2026-10-24).
export const OWNER_EMAILS = new Set([
  'harratmalik25@gmail.com',
  'bilel@harratglobalholdings.com',
  'bilel@askeden.com',
  'bilel.harrat04@gmail.com',
  'bilel.harrat36@gmail.com',
  'bilel@harrat.org',
]);

export const isOwnerEmail = (email) => typeof email === 'string' && OWNER_EMAILS.has(email.trim().toLowerCase());
