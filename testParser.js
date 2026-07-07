/**
 * testParser.js
 * Test runner to verify the regex SMS parser against bank credit notifications.
 */

const { parseCreditSMS } = require('./smsParser');

const testCases = [
  {
    name: 'SBI Credit SMS',
    sms: 'Dear UPI User, A/C X1234 credited by Rs. 500.23 on 06-07-2026. UPI Ref No 618273948501. Info: P2P transfer - SBI',
    expectedAmount: 500.23,
    expectedUtr: '618273948501',
    expectedBank: 'SBI'
  },
  {
    name: 'HDFC Credit SMS',
    sms: 'HDFC Bank: Rs. 1,500.45 credited to a/c XXXXXX4567 on 06-07-26 by UPI Ref No 601928374650.',
    expectedAmount: 1500.45,
    expectedUtr: '601928374650',
    expectedBank: 'HDFC'
  },
  {
    name: 'ICICI Credit SMS',
    sms: 'ICICI Bank: Rs 250.00 credited to a/c ...1234. UPI/UTR Ref: 698765432101.',
    expectedAmount: 250.00,
    expectedUtr: '698765432101',
    expectedBank: 'ICICI'
  },
  {
    name: 'Axis Credit SMS',
    sms: 'Axis Bank Account XX1234 credited with INR 5.05. UPI Ref: 610293847561.',
    expectedAmount: 5.05,
    expectedUtr: '610293847561',
    expectedBank: 'AXIS'
  },
  {
    name: 'Kotak Bank with Rupee Symbol',
    sms: 'Dear Customer, your Kotak Bank A/c X1234 credited with ₹1200.03 on 06-07-26 by UPI Ref 123456789012.',
    expectedAmount: 1200.03,
    expectedUtr: '123456789012',
    expectedBank: 'KOTAK'
  },
  {
    name: 'PNB Bank with no Currency Symbol (Omitted)',
    sms: 'PNB Alert: A/c X1234 credited with 150.01 via UPI Ref No 987654321012.',
    expectedAmount: 150.01,
    expectedUtr: '987654321012',
    expectedBank: 'PNB'
  },
  {
    name: 'Federal Bank Credit SMS',
    sms: 'Federal Bank: Rs 500.03 credited to A/c XXXXXX1234 on 06-07-26 by UPI Ref 123456789012.',
    expectedAmount: 500.03,
    expectedUtr: '123456789012',
    expectedBank: 'FEDERAL'
  },
  {
    name: 'YES Bank Credit SMS',
    sms: 'YES BANK: ₹500.03 received via UPI from payee. Ref ID 123456789012.',
    expectedAmount: 500.03,
    expectedUtr: '123456789012',
    expectedBank: 'YESBANK'
  },
  {
    name: 'Union Bank Credit SMS',
    sms: 'Union Bank Alert: A/c X1234 credited by Rs. 500.03. UPI Ref no 123456789012.',
    expectedAmount: 500.03,
    expectedUtr: '123456789012',
    expectedBank: 'UNIONBANK'
  },
  {
    name: 'IDFC First Bank Credit SMS',
    sms: 'IDFC FIRST Bank: Received Rs 500.03. Ref: UPI/123456789012/Transfer.',
    expectedAmount: 500.03,
    expectedUtr: '123456789012',
    expectedBank: 'IDFC'
  },
  {
    name: 'Forwarding Typo Credit SMS',
    sms: 'your a/c was Creadited with Rs. 500.03 upi-ref 123456789012.',
    expectedAmount: 500.03,
    expectedUtr: '123456789012',
    expectedBank: 'GENERIC'
  },
  {
    name: 'Generic Credit SMS with space/case variations',
    sms: 'your a/c was credited with inr 100.99 by upi ref 611223344556.',
    expectedAmount: 100.99,
    expectedUtr: '611223344556',
    expectedBank: 'GENERIC'
  },
  {
    name: 'Negative: Debit notification (should return null)',
    sms: 'Dear Customer, your A/C X1234 was debited by Rs. 500.00 on 06-07-26. UPI Ref 618273948501.',
    shouldBeNull: true
  },
  {
    name: 'Negative: Random text SMS (should return null)',
    sms: 'Hi there, your OTP for login is 123456. Do not share this with anyone.',
    shouldBeNull: true
  }
];

let failed = 0;

console.log('Starting regex SMS parser test suite...\n');

testCases.forEach((tc) => {
  const result = parseCreditSMS(tc.sms);

  if (tc.shouldBeNull) {
    if (result === null) {
      console.log(`[PASS] ${tc.name}`);
    } else {
      console.error(`[FAIL] ${tc.name}. Expected null, got:`, result);
      failed++;
    }
  } else {
    if (!result) {
      console.error(`[FAIL] ${tc.name}. Parsing failed, got null.`);
      failed++;
    } else {
      const amountMatch = result.amount === tc.expectedAmount;
      const utrMatch = result.utr === tc.expectedUtr;
      const bankMatch = result.bank === tc.expectedBank;

      if (amountMatch && utrMatch && bankMatch) {
        console.log(`[PASS] ${tc.name}`);
      } else {
        console.error(`[FAIL] ${tc.name}.`);
        if (!amountMatch) console.error(`  Expected Amount: ${tc.expectedAmount}, Got: ${result.amount}`);
        if (!utrMatch) console.error(`  Expected UTR: ${tc.expectedUtr}, Got: ${result.utr}`);
        if (!bankMatch) console.error(`  Expected Bank: ${tc.expectedBank}, Got: ${result.bank}`);
        failed++;
      }
    }
  }
});

console.log('\n----------------------------------------');
if (failed === 0) {
  console.log('All tests PASSED successfully!');
  process.exit(0);
} else {
  console.error(`${failed} test(s) FAILED.`);
  process.exit(1);
}
