const puppeteer = require('puppeteer');
const fs = require('fs');
const { createRenderService } = require('../src');

async function main() {
  const renderer = createRenderService({
    puppeteer,
    pool: { min: 1, max: 2 },
  });

  // Listen for events
  renderer.on('render', (data) => {
    console.log(`✅ Rendered ${data.type} in ${data.duration}ms (${data.bufferSize} bytes)`);
  });

  try {
    // Generate PDF
    const pdfBuffer = await renderer.pdf('<h1>Hello World</h1><p>Generated with puppeteer-render-service</p>', {
      pdf: {
        format: 'A4',
        margin: { top: '40px', bottom: '40px', left: '40px', right: '40px' },
      },
    });

    fs.writeFileSync('output.pdf', pdfBuffer);
    console.log('📄 PDF saved to output.pdf');

    // Print stats
    console.log('\n📊 Stats:', JSON.stringify(renderer.getStats(), null, 2));
  } finally {
    await renderer.destroy();
    console.log('👋 Service destroyed');
  }
}

main().catch(console.error);
