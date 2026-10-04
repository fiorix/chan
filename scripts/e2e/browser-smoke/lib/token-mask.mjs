export function maskTokens(value) {
  return String(value).replace(/([?&#]t=)[^&#\s]+/g, "$1<token>")
    .replace(/(%3[fF]t%3[dD]|%26t%3[dD])(?:(?!%26|%23)[^&#\s])+/gi, "$1<token>")
    .replace(/(CHAN_DEVSERVER_TOKEN=)[^\s]+/g, "$1<token>");
}
