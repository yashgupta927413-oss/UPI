const fs = require('fs');
const path = require('path');

const gpaySvg = fs.readFileSync(path.join(__dirname, '../public/brand-logos/gpay.svg'));
const phonepeSvg = fs.readFileSync(path.join(__dirname, '../public/brand-logos/phonepe.svg'));
const paytmSvg = fs.readFileSync(path.join(__dirname, '../public/brand-logos/paytm.svg'));
const bhimSvg = fs.readFileSync(path.join(__dirname, '../public/brand-logos/bhim.svg'));

const gpayBase64 = `data:image/svg+xml;base64,${gpaySvg.toString('base64')}`;
const phonepeBase64 = `data:image/svg+xml;base64,${phonepeSvg.toString('base64')}`;
const paytmBase64 = `data:image/svg+xml;base64,${paytmSvg.toString('base64')}`;
const bhimBase64 = `data:image/svg+xml;base64,${bhimSvg.toString('base64')}`;

// 1. Update UpiGatewayExtension.jsx
const extensionPath = path.join(__dirname, '../UpiGatewayExtension.jsx');
let extensionCode = fs.readFileSync(extensionPath, 'utf8');

// Replace GPAY_LOGO_URL
extensionCode = extensionCode.replace(
  /const GPAY_LOGO_URL = 'data:image\/svg\+xml;base64,[^']+';/,
  `const GPAY_LOGO_URL = '${gpayBase64}';`
);
// Replace PHONEPE_LOGO_URL
extensionCode = extensionCode.replace(
  /const PHONEPE_LOGO_URL = 'data:image\/svg\+xml;base64,[^']+';/,
  `const PHONEPE_LOGO_URL = '${phonepeBase64}';`
);
// Replace PAYTM_LOGO_URL
extensionCode = extensionCode.replace(
  /const PAYTM_LOGO_URL = 'data:image\/svg\+xml;base64,[^']+';/,
  `const PAYTM_LOGO_URL = '${paytmBase64}';`
);
// Replace BHIM_LOGO_URL
extensionCode = extensionCode.replace(
  /const BHIM_LOGO_URL = 'data:image\/svg\+xml;base64,[^']+';/,
  `const BHIM_LOGO_URL = '${bhimBase64}';`
);

fs.writeFileSync(extensionPath, extensionCode, 'utf8');
console.log('Successfully updated UpiGatewayExtension.jsx with high-res base64 logos!');

// 2. Update public/index.html
const indexPath = path.join(__dirname, '../public/index.html');
let indexCode = fs.readFileSync(indexPath, 'utf8');

// We can replace the src attributes of Google Pay, PhonePe, Paytm, and BHIM inside the mockup apps section!
// Google Pay logo src replacement
indexCode = indexCode.replace(
  /alt="Google Pay" style="max-height: 18px; max-width: 50px;" src="data:image\/svg\+xml;base64,[^"]*"/,
  `alt="Google Pay" style="max-height: 18px; max-width: 50px;" src="${gpayBase64}"`
);
indexCode = indexCode.replace(
  /src="data:image\/svg\+xml;base64,[^"]*" alt="Google Pay"/,
  `src="${gpayBase64}" alt="Google Pay"`
);

// PhonePe logo src replacement
indexCode = indexCode.replace(
  /alt="PhonePe" style="max-height: 18px; max-width: 50px;" src="data:image\/svg\+xml;base64,[^"]*"/,
  `alt="PhonePe" style="max-height: 18px; max-width: 50px;" src="${phonepeBase64}"`
);
indexCode = indexCode.replace(
  /src="data:image\/svg\+xml;base64,[^"]*" alt="PhonePe"/,
  `src="${phonepeBase64}" alt="PhonePe"`
);

// Paytm logo src replacement
indexCode = indexCode.replace(
  /alt="Paytm" style="max-height: 18px; max-width: 50px;" src="data:image\/svg\+xml;base64,[^"]*"/,
  `alt="Paytm" style="max-height: 18px; max-width: 50px;" src="${paytmBase64}"`
);
indexCode = indexCode.replace(
  /src="data:image\/svg\+xml;base64,[^"]*" alt="Paytm"/,
  `src="${paytmBase64}" alt="Paytm"`
);

// BHIM logo src replacement
indexCode = indexCode.replace(
  /alt="BHIM" style="max-height: 18px; max-width: 50px;" src="data:image\/svg\+xml;base64,[^"]*"/,
  `alt="BHIM" style="max-height: 18px; max-width: 50px;" src="${bhimBase64}"`
);
indexCode = indexCode.replace(
  /src="data:image\/svg\+xml;base64,[^"]*" alt="BHIM"/,
  `src="${bhimBase64}" alt="BHIM"`
);

fs.writeFileSync(indexPath, indexCode, 'utf8');
console.log('Successfully updated public/index.html with high-res base64 logos!');
