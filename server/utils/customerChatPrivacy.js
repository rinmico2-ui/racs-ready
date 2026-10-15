"use strict";
function externalChatHistory(history) {
  return (Array.isArray(history) ? history : []).filter(item => {
    if (item?.privateAccount === true) return false;
    const text = String(item?.content || "");
    // Client history can echo a local account response without its server flag.
    const accountSummary = /\b(?:Reference:|Project progress:)/i.test(text)
      && /\b(?:Balance:|Schedule:)/i.test(text) && /\/tracking\b/i.test(text);
    return !accountSummary;
  });
}
module.exports = { externalChatHistory };
