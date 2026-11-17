/** 网页分享模板的布局快照；图片按需从官方静态地址读取，不随包复制美术资源。 */
export const shareTemplates = [
  {
    id: 'retro-window',
    background: 'retro-window.webp',
    model: [6, 26, 55],
    qr: [69, 60, 24.3],
    qrBackground: '#FFE632',
  },
  { id: 'modern-game', background: 'modern-game.webp', model: [30, 2.3, 63.5], qr: [1.8, 36.6, 21] },
  {
    id: 'blister',
    background: 'normal.webp',
    model: [13.5, 35, 49],
    qr: [70, 65, 21],
    sticker: 'normal-sticker.webp',
  },
  {
    id: 'pixel-game',
    background: 'pixel-game.webp',
    model: [26, 16.5, 48],
    qr: [31.1, 75.4, 19],
    logo: true,
  },
  {
    id: 'classic-game',
    background: 'classic-game.webp',
    model: [22, 31, 51.5],
    qr: [69.3, 68, 23],
    logo: true,
    qrBox: 'code_bg.webp',
  },
  { id: 'germany', background: '3.webp', model: [18, 22, 62], qr: [67, 11.8, 20.8], logo: true },
] as const;
