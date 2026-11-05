// Sözleşme (aktarım S fazı): gövdesi sonraki fazlarda yazılacak stub'ların ortak hatası.
export class NotImplemented extends Error {
  constructor(public what: string) { super(`henüz gerçeklenmedi: ${what}`); this.name = "NotImplemented"; }
}
export const notImplemented = (what: string): never => { throw new NotImplemented(what); };
