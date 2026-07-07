/**
 * smsParser.js
 * Multi-stage robust parser for Indian Bank credit notifications forwarded via SMS.
 * Designed to achieve 100% success matching across HDFC, SBI, ICICI, Axis, Kotak,
 * PNB, BOB, Canara, IDFC, YES Bank, Federal Bank, Union Bank, and wallet notifications.
 */

/**
 * Normalizes input SMS to handle typo variations, multi-line spacing, and formatting.
 * @param {string} text Raw text input.
 * @returns {string} Normalized lowercase text.
 */
function normalizeSms(text) {
  if (!text) return '';
  return text
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .toLowerCase()
    // Correct common OCR or forwarding spelling errors
    .replace(/\bcreadited\b/g, 'credited')
    .replace(/\bcredted\b/g, 'credited')
    .replace(/\breieved\b/g, 'received')
    .replace(/\brecieved\b/g, 'received')
    .replace(/\bdeposted\b/g, 'deposited')
    .replace(/\bdepoisted\b/g, 'deposited')
    .replace(/\bupi\s*-\s*ref\b/g, 'upi ref')
    .replace(/[\u20b9]/g, '₹'); // Normalize Unicode Rupee symbols
}

/**
 * Parses an incoming SMS text and extracts transaction amount and 12-digit UTR/UPI reference.
 * 
 * @param {string} smsBody The raw content of the SMS.
 * @returns {{amount: number, utr: string, bank: string} | null} Parsed details or null if parsing fails.
 */
function parseCreditSMS(smsBody) {
  if (!smsBody) return null;

  const normalized = normalizeSms(smsBody);

  // 1. Safety check: Ensure this is a credit notification
  const creditVerbs = [
    'credit', 'credited', 'received', 'deposited', 'added to', 'refunded', 
    'inward', 'remittance', 'transferred from', 'credited to', 'funds added',
    'replenished', 'payment of', 'credited with', 'received a credit', 'loaded'
  ];
  
  const isCredit = creditVerbs.some(verb => normalized.includes(verb));
  const isDebit = /\b(?:debit|debited|withdrawn|sent|paid to|transferred to)\b/.test(normalized);

  // Allow "debit" if it explicitly states "credited by" or "received from debited account"
  if (!isCredit || (isDebit && !normalized.includes('credited by') && !normalized.includes('credited with') && !normalized.includes('received via'))) {
    return null;
  }

  // 2. Identify Bank (for reporting & categorization)
  let bank = 'GENERIC';
  if (/\bhdfc\b/i.test(normalized)) bank = 'HDFC';
  else if (/\bsbi\b|\bstate bank\b/i.test(normalized)) bank = 'SBI';
  else if (/\bicici\b/i.test(normalized)) bank = 'ICICI';
  else if (/\baxis\b/i.test(normalized)) bank = 'AXIS';
  else if (/\bkotak\b/i.test(normalized)) bank = 'KOTAK';
  else if (/\bpnb\b|\bpunjab\b/i.test(normalized)) bank = 'PNB';
  else if (/\bbaroda\b|\bbob\b/i.test(normalized)) bank = 'BOB';
  else if (/\bcanara\b/i.test(normalized)) bank = 'CANARA';
  else if (/\bidfc\b/i.test(normalized)) bank = 'IDFC';
  else if (/\byes\s*bank\b/i.test(normalized)) bank = 'YESBANK';
  else if (/\bfederal\b/i.test(normalized)) bank = 'FEDERAL';
  else if (/\bunion\b/i.test(normalized)) bank = 'UNIONBANK';
  else if (/\bindusind\b/i.test(normalized)) bank = 'INDUSIND';

  // 3. Extract 12-digit UPI Ref / UTR / RRN number.
  // Standard UPI references are 12-digit integers.
  const utrRegexes = [
    // Match "UPI Ref: 123456789012" or "UPI/RRN/123456789012"
    /(?:upi\s*ref(?:erence)?(?:\s*no)?|upi\/ref(?:erence)?(?:\s*no)?|ref(?:erence)?(?:\s*no)?|utr(?:\s*no)?|rrn(?:\s*no)?|upi\s*utr|upi\/utr|ref\s*id|transaction\s*id|txn\s*id|txn\s*ref|txn\.?ref|imps\s*ref|imps\/ref|transfer\s*ref|ref\.no\.?)\s*[:#-\/\s=]?\s*(\d{12})\b/i,
    // Match "credited by 123456789012"
    /credited\s+by\s+(\d{12})\b/i,
    // Match "transfer ref 123456789012"
    /transfer\s+ref\s+(\d{12})\b/i,
    // Match "UPI/123456789012" or "RRN/123456789012"
    /(?:upi|rrn|utr|ref)\/(\d{12})\b/i,
    // Fallback to any standalone 12-digit number in the text
    /\b(\d{12})\b/
  ];

  let utr = null;
  for (const regex of utrRegexes) {
    const match = normalized.match(regex);
    if (match && match[1]) {
      utr = match[1];
      break;
    }
  }

  // Backup search in original raw SMS body (in case lowercase mapping stripped formatting digits)
  if (!utr) {
    for (const regex of utrRegexes) {
      const match = smsBody.match(regex);
      if (match && match[1]) {
        utr = match[1];
        break;
      }
    }
  }

  if (!utr) {
    return null; // A valid UTR reference is mandatory for transaction reconciliation
  }

  // 4. Extract Amount
  // Matches Rs., INR, ₹, and currency-less decimal numbers
  const amountRegexes = [
    // Credited with/by Rs. 500.00
    /(?:credited\s+(?:with|by)|received|deposited)\s+(?:rs\.?|inr|inr\.|₹)\s*([\d,]+\.\d{2})\b/i,
    // Rs. 500.00 credited
    /(?:rs\.?|inr|inr\.|₹)\s*([\d,]+\.\d{2})\s*(?:credited|deposited|received)/i,
    // Specific banking variations (e.g. Axis/IDFC "credited with INR 5.05")
    /credited\s+with\s+(?:rs\.?|inr|inr\.|₹)\s*([\d,]+\.\d{2})\b/i,
    // Generic currency prefix matcher
    /(?:rs\.?|inr|inr\.|₹)\s*([\d,]+\.\d{2})\b/i,
    // Amount followed by credit actions without currency symbol
    /([\d,]+\.\d{2})\s*(?:credited|deposited|received|added|ref\.?id)/i,
    // Credited with 500.03 without currency prefix
    /(?:credited\s+(?:with|by|of)?|received|deposited)\s*([\d,]+\.\d{2})\b/i
  ];

  let amountStr = null;
  for (const regex of amountRegexes) {
    const match = normalized.match(regex);
    if (match && match[1]) {
      amountStr = match[1];
      break;
    }
  }

  // Fallback Amount Extractor: Scan for all numbers matching X.XX decimal format.
  // In our UPI routing system, checkout amounts always have unique paise decimal fractions (e.g. .03).
  if (!amountStr) {
    const decimals = normalized.match(/\b\d+\.\d{2}\b/g);
    if (decimals && decimals.length === 1) {
      // If there is exactly one decimal figure, it represents the transaction amount
      amountStr = decimals[0];
    } else if (decimals && decimals.length > 1) {
      // If there are multiple, filter out decimals that correspond to the UTR digits
      const filtered = decimals.filter(d => !utr.includes(d.replace('.', '')));
      if (filtered.length > 0) {
        amountStr = filtered[0];
      } else {
        amountStr = decimals[0];
      }
    }
  }

  if (!amountStr) {
    return null; // Amount is mandatory for verification
  }

  // Clean formatting commas and parse to float
  const cleanAmount = parseFloat(amountStr.replace(/,/g, ''));
  if (isNaN(cleanAmount) || cleanAmount <= 0) {
    return null;
  }

  return {
    amount: cleanAmount,
    utr: utr,
    bank: bank
  };
}

module.exports = {
  parseCreditSMS
};
