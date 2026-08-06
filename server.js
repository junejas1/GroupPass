const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function unpack(sourceName, targetName) {
  const sourcePath = path.join(__dirname, sourceName);
  const targetPath = path.join(__dirname, targetName);
  const encoded = fs.readFileSync(sourcePath, "utf8").trim();
  const decoded = zlib.gunzipSync(Buffer.from(encoded, "base64"));
  fs.writeFileSync(targetPath, decoded);
}

unpack("index.html.gz.b64", "index.html");
unpack("city-rates.json.gz.b64", "city-rates.json");
unpack("app-server.js.gz.b64", ".runtime-server.js");

require("./.runtime-server.js");
