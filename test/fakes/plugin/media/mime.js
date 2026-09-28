export function getExtensionFromMime(m) { return { 'image/png': '.png', 'text/plain': '.txt' }[m] || ''; }
