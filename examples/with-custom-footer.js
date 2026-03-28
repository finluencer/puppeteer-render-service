const puppeteer = require('puppeteer');
const fs = require('fs');
const { createRenderService } = require('../src');

async function main() {
  const renderer = createRenderService({
    puppeteer,
    pool: { min: 1, max: 2 },
    footerTemplate: (meta) => `
      <div style="display:flex;justify-content:space-between;width:100%;padding:0 20px;
        font-size:8px;font-family:Arial;color:#555;">
        <div><strong>${meta.companyName || ''}</strong>${meta.email ? ` | ${meta.email}` : ''}</div>
        <div>Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
      </div>
    `,
    pdf: { margin: { bottom: '80px' } },
  });

  try {
    const html = `
      <h1>Invoice #12345</h1>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
      <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
        <tr><th>Item</th><th>Qty</th><th>Price</th></tr>
        <tr><td>Widget A</td><td>10</td><td>$100</td></tr>
        <tr><td>Widget B</td><td>5</td><td>$250</td></tr>
      </table>
    `;

    const pdfBuffer = await renderer.pdf(html, {
      metadata: {
        companyName: 'Acme Corp',
        email: 'billing@acme.com',
      },
    });

    fs.writeFileSync('invoice.pdf', pdfBuffer);
    console.log('Invoice saved to invoice.pdf');
  } finally {
    await renderer.destroy();
  }
}

main().catch(console.error);
