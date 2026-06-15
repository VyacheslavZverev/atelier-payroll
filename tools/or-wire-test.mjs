const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
process.env.VISION_MODEL = 'google/gemini-3.5-flash';
delete process.env.OPENROUTER_API_KEY;
const { readInvoicesFromImage, isVisionConfigured } = await import('file:///F:/invoices/server/vision.js');
console.log('no key: vision_ready =', isVisionConfigured());
try { await readInvoicesFromImage(tinyPng, 'image/png'); console.log('FAIL'); }
catch (e) { console.log('no key error code:', e.code); }
process.env.OPENROUTER_API_KEY = 'sk-or-fake';
console.log('fake key: vision_ready =', isVisionConfigured());
try { await readInvoicesFromImage(tinyPng, 'image/png'); console.log('FAIL: expected rejection'); }
catch (e) { console.log('openrouter response:', e.message.slice(0, 140)); }
