const puppeteer = require('puppeteer');
const fs = require('fs');
const { createRenderService } = require('../src');

async function main() {
  const renderer = createRenderService({
    puppeteer,
    pool: { min: 1, max: 2 },
  });

  try {
    const html = `
      <div style="width:1200px;height:630px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
        display:flex;align-items:center;justify-content:center;font-family:Arial;">
        <h1 style="color:white;font-size:48px;">Open Graph Image</h1>
      </div>
    `;

    // PNG
    const pngBuffer = await renderer.png(html, {
      image: { viewport: { width: 1200, height: 630 } },
    });
    fs.writeFileSync('output.png', pngBuffer);
    console.log('🖼️  PNG saved to output.png');

    // JPEG
    const jpegBuffer = await renderer.jpeg(html, {
      image: { quality: 90, viewport: { width: 1200, height: 630 } },
    });
    fs.writeFileSync('output.jpg', jpegBuffer);
    console.log('🖼️  JPEG saved to output.jpg');

    // WebP
    const webpBuffer = await renderer.webp(html, {
      image: { quality: 85, viewport: { width: 1200, height: 630 } },
    });
    fs.writeFileSync('output.webp', webpBuffer);
    console.log('🖼️  WebP saved to output.webp');
  } finally {
    await renderer.destroy();
  }
}

main().catch(console.error);
