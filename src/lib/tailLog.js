"use strict";

const fs = require("fs");

const MAX_READ_BYTES = 256 * 1024; // never load more than this from a log file, however large it's grown

// Returns the last `maxLines` lines of `filePath`, reading at most the final
// MAX_READ_BYTES of the file so an unrotated multi-GB log can't be pulled
// fully into memory. Missing file (e.g. before the app has logged anything
// yet) returns an empty array rather than throwing.
function tailFile(filePath, maxLines = 200) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return [];
  }

  const start = Math.max(0, stat.size - MAX_READ_BYTES);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);

  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  const text = buffer.toString("utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.slice(-maxLines);
}

module.exports = { tailFile };
