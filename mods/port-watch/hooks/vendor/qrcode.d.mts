// QR Code Generator for JavaScript: types for the part port-watch uses.
// qrcode.mjs is qrcode-generator 2.0.4, Copyright (c) 2009 Kazuhiko Arase, MIT license
// (http://www.opensource.org/licenses/mit-license.php). The word 'QR Code' is a registered
// trademark of DENSO WAVE INCORPORATED.

export interface QRCode {
  addData(data: string, mode?: 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji'): void
  make(): void
  getModuleCount(): number
  isDark(row: number, col: number): boolean
}

export declare const qrcode: (typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H') => QRCode
export default qrcode
