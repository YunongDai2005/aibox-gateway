// 假的媒体下载：图片给一个 1x1 PNG
export async function downloadMediaFromItem(item, { saveMedia }) {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  if (item.type === 2) { const r = await saveMedia(png, 'image/png', null, 0, null); return { decryptedPicPath: r.path }; }
  if (item.type === 4) { const r = await saveMedia(Buffer.from('hello'), 'text/plain', null, 0, item.file_item.file_name || 'a.txt'); return { decryptedFilePath: r.path, fileMediaType: 'text/plain' }; }
  return {};
}
