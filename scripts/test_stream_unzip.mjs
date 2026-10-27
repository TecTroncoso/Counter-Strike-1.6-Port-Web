// Quick sanity test of the same streaming-unzip logic used in loader.ts
import { Unzip, UnzipInflate } from "fflate";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

const zipPath = "/tmp/valve_check.zip";
const unzip = new Unzip((file) => {
  if (file.name.endsWith("/")) { file.ondata = () => {}; file.start(); return; }
  const chunks = [];
  let bytes = 0;
  file.ondata = (err, data, final) => {
    if (err) throw err;
    if (data) { chunks.push(data); bytes += data.length; }
    if (final) {
      count++;
      if (file.name.endsWith("cstrike/maps/de_dust2.bsp")) {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        console.log("de_dust2.bsp decompressed bytes:", total);
      }
      chunks.length = 0;
    }
  };
  file.start();
});
unzip.register(UnzipInflate);

let count = 0;
const nodeStream = createReadStream(zipPath, { highWaterMark: 1 << 20 });
for await (const chunk of Readable.toWeb(nodeStream)) {
  unzip.push(chunk, false);
  if (count > 0 && count % 2000 === 0) { /* yield */ }
}
unzip.push(new Uint8Array(0), true);
console.log("total files:", count);
