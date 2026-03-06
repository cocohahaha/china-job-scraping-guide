const { ScrapeCN } = require('./lib/scraper');
const presets = require('./lib/presets');
const http = require('./lib/http');

module.exports = { ScrapeCN, presets, ...http };
