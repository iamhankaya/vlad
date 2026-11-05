// macOS pano yardımcısı: kalıcı JXA (osascript -l JavaScript) NSPasteboard döngüsü; aynı satır protokolü (backend-win32.ts başlığı).
// B1 spike (Mac): kalıcı döngüde changeCount çağrısı ~0.1 ms (süreç başına tek ~40-60 ms açılış), yoklama CPU'su ihmal edilir → Mac'te de 500 ms.
// Resim: önce public.png, yoksa public.tiff → NSBitmapImageRep → PNG (ekran görüntüsü araçları TIFF bırakabilir).
// `pasteboard: "unique"` yalnız doğrulama/test içindir (özel, geçici pano; gerçek panoya dokunmaz).
export function darwinHelperScript(o: { pasteboard?: "general" | "unique" } = {}): string {
  const pb = o.pasteboard === "unique" ? "$.NSPasteboard.pasteboardWithUniqueName" : "$.NSPasteboard.generalPasteboard";
  return `ObjC.import('AppKit'); ObjC.import('Foundation');
const pb = ${pb};
const out = $.NSFileHandle.fileHandleWithStandardOutput, inp = $.NSFileHandle.fileHandleWithStandardInput;
function reply(o) { out.writeData($(JSON.stringify(o) + '\\n').dataUsingEncoding(4)); }
let buf = '';
function readLine() {
  for (;;) {
    const i = buf.indexOf('\\n');
    if (i >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); return l; }
    const d = inp.availableData;
    if (Number(d.length) === 0) return null;
    buf += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(d, 4));
  }
}
function dat(d) { return d && ObjC.unwrap(d) !== null && Number(d.length) > 0 ? d : null; }
function b64(d) { return ObjC.unwrap(d.base64EncodedStringWithOptions(0)); }
function seq() { return Number(pb.changeCount); }
for (let l; (l = readLine()) !== null;) {
  const p = l.split('\\t'); const id = Number(p[0]);
  try {
    if (p[1] === 'count') reply({ id, ok: true, n: seq() });
    else if (p[1] === 'read') {
      const n = seq();
      let t = dat(pb.dataForType('public.utf8-plain-text')), g = null;
      if (!t) {
        g = dat(pb.dataForType('public.png'));
        if (!g) { const tf = dat(pb.dataForType('public.tiff')); if (tf) { const rep = $.NSBitmapImageRep.imageRepWithData(tf); if (rep) g = dat(rep.representationUsingTypeProperties(4, $())); } }
      }
      reply({ id, ok: true, n, after: seq(), text: t ? b64(t) : null, png: g ? b64(g) : null });
    } else if (p[1] === 'write') {
      const n = seq();
      if (n !== Number(p[3])) { reply({ id, ok: true, written: false, n }); continue; }
      const data = $.NSData.alloc.initWithBase64EncodedStringOptions(p[4], 0);
      pb.clearContents;
      const ok = pb.setDataForType(data, p[2] === 'text' ? 'public.utf8-plain-text' : 'public.png');
      reply({ id, ok: true, written: !!ok, n: seq() });
    } else reply({ id, ok: false, err: 'bilinmeyen komut' });
  } catch (e) { reply({ id, ok: false, err: String(e) }); }
}
`;
}

/** osascript argv'si: betik sabit `-e` argümanıdır; içerik stdin'den gelir. */
export function darwinHelperArgs(): string[] {
  return ["-l", "JavaScript", "-e", darwinHelperScript()];
}
